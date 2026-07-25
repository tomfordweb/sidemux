import { createHash } from "node:crypto";
import { isKnownShell } from "../config.js";
import type { TmuxClient } from "../tmux/client.js";
import type { Job } from "../types.js";
import { JobManager, SENTINEL_MARKER } from "./jobs.js";
import { clampCaptureStart, totalLines } from "./shared.js";

export type WaitUntil = "exit" | "pattern" | "idle";

/** Where pattern scans begin: the job's start, or the wait call itself. */
export type WaitSince = "job" | "now";

export interface WaitOptions {
  until: WaitUntil;
  /** Regex source, required when until = 'pattern'. */
  pattern?: string | undefined;
  /**
   * Scan scope for until = 'pattern'. Default 'job' scans everything since the
   * job started (or the visible screen without a job) — right for the common
   * run-then-wait flow where the wanted line may already have printed. 'now'
   * matches only output produced after this wait starts, so a re-wait on a
   * long-running job cannot instantly re-match a stale line from earlier
   * output (github#27).
   */
  since?: WaitSince | undefined;
  /** Stability window for until = 'idle'. */
  idleMs?: number | undefined;
  timeoutMs?: number | undefined;
  /** Called every ~10s of waiting; hook for MCP progress notifications. */
  onProgress?: ((elapsedMs: number) => void) | undefined;
}

export interface WaitResult {
  status: WaitUntil | "timeout";
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

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

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
  const {
    until,
    idleMs = 2000,
    timeoutMs = 120_000,
    since = "job",
    onProgress,
  } = options;
  const regex =
    options.pattern !== undefined ? new RegExp(options.pattern) : null;
  if (until === "pattern" && !regex) {
    throw new Error("wait: 'pattern' is required when until = 'pattern'");
  }
  if (until === "exit" && !job) {
    throw new Error(
      "wait: until = 'exit' requires a job (launch via run first)",
    );
  }
  const exitJob = job;

  const startedAt = Date.now();
  let pollMs = POLL_INITIAL_MS;
  let lastProgressAt = startedAt;

  // pattern scans start where the job started (since='job'), or at the pane's
  // line count when the wait began (since='now'). Fixed on the first poll so
  // the window never slides as output accumulates.
  let patternScanFrom: number | null = null;

  let idleHash = "";
  let idleStableSince = Date.now();

  for (;;) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= timeoutMs) {
      return {
        status: "timeout",
        exitCode: job?.exitCode ?? null,
        matchedLine: null,
        elapsedMs: elapsed,
      };
    }
    if (onProgress && Date.now() - lastProgressAt >= PROGRESS_EVERY_MS) {
      lastProgressAt = Date.now();
      onProgress(elapsed);
    }

    const state = await client.paneState(paneId);
    const currentTotal = totalLines(state);

    if (until === "exit") {
      const scanStart = clampCaptureStart(
        state,
        state.cursorY - SENTINEL_SCAN_LINES + 1,
      );
      const tail = await client.capturePane(paneId, scanStart, state.cursorY);
      if (!exitJob) {
        throw new Error("wait: until = 'exit' requires a job");
      }
      jobs.applyScan(exitJob, tail);
      if (exitJob.status !== "running") {
        return {
          status: "exit",
          exitCode: exitJob.exitCode,
          matchedLine: null,
          elapsedMs: Date.now() - startedAt,
        };
      }
    } else if (until === "pattern") {
      // 'now' includes the current cursor row (currentTotal counts it): the
      // next output lands there, not on the row below. The row's stale
      // content is at worst a blank/partial prompt line, never a completed
      // output line from earlier in the job.
      patternScanFrom ??=
        since === "now"
          ? currentTotal - 1
          : job
            ? job.baselineLines
            : currentTotal - state.paneHeight;
      const scanStart = clampCaptureStart(
        state,
        patternScanFrom - state.historySize,
      );
      const lines = await client.capturePane(paneId, scanStart, state.cursorY);
      // Skip the echoed launch line (and any completed sentinel): both carry the
      // SENTINEL_MARKER and neither is real output, so a pattern that also
      // appears in the launched command can't match the echo instead of stdout.
      const matched = lines.find(
        (line) =>
          !line.includes(SENTINEL_MARKER) && (regex?.test(line) ?? false),
      );
      if (matched !== undefined) {
        return {
          status: "pattern",
          exitCode: null,
          matchedLine: matched,
          elapsedMs: Date.now() - startedAt,
        };
      }
    } else {
      const screen = await client.capturePane(paneId);
      const hash = createHash("sha1")
        .update(screen.join("\n"))
        .update(state.currentCommand)
        .digest("hex");
      if (hash !== idleHash) {
        idleHash = hash;
        idleStableSince = Date.now();
      } else {
        const required = isKnownShell(state.currentCommand)
          ? idleMs
          : idleMs * NON_SHELL_IDLE_FACTOR;
        if (Date.now() - idleStableSince >= required) {
          return {
            status: "idle",
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
