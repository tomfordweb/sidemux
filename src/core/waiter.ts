import { createHash } from 'node:crypto';
import { isKnownShell } from '../config.js';
import type { TmuxClient } from '../tmux/client.js';
import type { Job } from '../types.js';
import { JobManager, SENTINEL_MARKER } from './jobs.js';

export type WaitUntil = 'exit' | 'pattern' | 'idle';

export interface WaitOptions {
  until: WaitUntil;
  /** Regex source, required when until = 'pattern'. */
  pattern?: string;
  /** Stability window for until = 'idle'. */
  idleMs?: number;
  timeoutMs?: number;
  /** Called every ~10s of waiting; hook for MCP progress notifications. */
  onProgress?: (elapsedMs: number) => void;
}

export interface WaitResult {
  status: WaitUntil | 'timeout';
  exitCode: number | null;
  matchedLine: string | null;
  elapsedMs: number;
}

const POLL_INITIAL_MS = 100;
const POLL_MAX_MS = 500;
const POLL_BACKOFF = 1.5;
const PROGRESS_EVERY_MS = 10_000;
/** Non-shell foreground commands must be quiet 3× longer before we call idle
 *  — a compiler pausing for a few seconds is not an interactive prompt. */
const NON_SHELL_IDLE_FACTOR = 3;
/** How many trailing lines to scan for the exit sentinel each poll. */
const SENTINEL_SCAN_LINES = 15;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Server-side blocking wait. The agent spends one tool call; sidemux does
 * the polling (with backoff) against tmux locally.
 */
export async function waitFor(
  client: TmuxClient,
  paneId: string,
  jobs: JobManager,
  job: Job | null,
  options: WaitOptions,
): Promise<WaitResult> {
  const { until, idleMs = 2000, timeoutMs = 120_000, onProgress } = options;
  const regex = options.pattern !== undefined ? new RegExp(options.pattern) : null;
  if (until === 'pattern' && !regex) {
    throw new Error("wait: 'pattern' is required when until = 'pattern'");
  }
  if (until === 'exit' && !job) {
    throw new Error("wait: until = 'exit' requires a job (launch via run first)");
  }

  const startedAt = Date.now();
  let pollMs = POLL_INITIAL_MS;
  let lastProgressAt = startedAt;

  // pattern scans start where the job started, or where the wait started.
  let patternScanFrom: number | null = null;

  let idleHash = '';
  let idleStableSince = Date.now();

  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      return { status: 'timeout', exitCode: job?.exitCode ?? null, matchedLine: null, elapsedMs: elapsed };
    }
    if (onProgress && Date.now() - lastProgressAt >= PROGRESS_EVERY_MS) {
      lastProgressAt = Date.now();
      onProgress(elapsed);
    }

    const state = await client.paneState(paneId);
    const currentTotal = state.historySize + state.cursorY + 1;

    if (until === 'exit') {
      const scanStart = Math.max(-state.historySize, state.cursorY - SENTINEL_SCAN_LINES + 1);
      const tail = await client.capturePane(paneId, scanStart, state.cursorY);
      jobs.applyScan(job!, tail);
      if (job!.status !== 'running') {
        return {
          status: 'exit',
          exitCode: job!.exitCode,
          matchedLine: null,
          elapsedMs: Date.now() - startedAt,
        };
      }
    } else if (until === 'pattern') {
      if (patternScanFrom === null) {
        patternScanFrom = job ? job.baselineLines : currentTotal - state.paneHeight;
      }
      const scanStart = Math.max(-state.historySize, patternScanFrom - state.historySize);
      const lines = await client.capturePane(paneId, scanStart, state.cursorY);
      // Skip the echoed launch line (and any completed sentinel): both carry the
      // SENTINEL_MARKER and neither is real output, so a pattern that also
      // appears in the launched command can't match the echo instead of stdout.
      const matched = lines.find(
        (line) => !line.includes(SENTINEL_MARKER) && regex!.test(line),
      );
      if (matched !== undefined) {
        return {
          status: 'pattern',
          exitCode: null,
          matchedLine: matched,
          elapsedMs: Date.now() - startedAt,
        };
      }
    } else {
      const screen = await client.capturePane(paneId);
      const hash = createHash('sha1')
        .update(screen.join('\n'))
        .update(state.currentCommand)
        .digest('hex');
      if (hash !== idleHash) {
        idleHash = hash;
        idleStableSince = Date.now();
      } else {
        const required = isKnownShell(state.currentCommand)
          ? idleMs
          : idleMs * NON_SHELL_IDLE_FACTOR;
        if (Date.now() - idleStableSince >= required) {
          return {
            status: 'idle',
            exitCode: null,
            matchedLine: null,
            elapsedMs: Date.now() - startedAt,
          };
        }
      }
    }

    await sleep(Math.min(pollMs, timeoutMs - (Date.now() - startedAt)));
    pollMs = Math.min(POLL_MAX_MS, pollMs * POLL_BACKOFF);
  }
}
