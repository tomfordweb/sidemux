import type { Config, ShellDialect } from './config.js';
import { CursorTracker } from './core/cursor.js';
import { JobManager, scrubOutput } from './core/jobs.js';
import { shapeOutput, type ShapedOutput } from './core/output.js';
import { PaneAllocator } from './core/panes.js';
import { waitFor, type WaitResult, type WaitUntil } from './core/waiter.js';
import { listProjects, resolveProject } from './core/workspace.js';
import type { TmuxClient } from './tmux/client.js';
import type { Job, JobStatus } from './types.js';

const TAIL_LINES = 10;
const TAIL_BYTES = 2048;

export interface RunArgs {
  command: string;
  pane?: string;
  name?: string;
  cwd?: string;
  /** Monorepo package to target: resolves to its dir (cwd) and names the pane. */
  project?: string;
  timeout_ms: number;
  background: boolean;
  /** Destroy the pane after a finished foreground run. Defaults to off. */
  close?: boolean;
}

export interface RunResult {
  job_id: string;
  pane: string;
  status: JobStatus;
  exit_code: number | null;
  duration_ms: number;
  tail: string;
  closed: boolean;
}

export interface WaitArgs {
  job_id?: string;
  pane?: string;
  until: WaitUntil;
  pattern?: string;
  idle_ms: number;
  timeout_ms: number;
}

export interface WaitToolResult {
  status: WaitResult['status'];
  exit_code: number | null;
  matched_line: string | null;
  elapsed_ms: number;
  tail: string;
}

export interface ReadArgs {
  job_id?: string;
  pane?: string;
  since: 'last-read' | 'job' | 'screen';
  lines: number;
  grep?: string;
  context: number;
  max_bytes: number;
}

export interface ReadResult {
  text: string;
  lines_returned: number;
  truncated: boolean;
  cursor_reset: boolean;
  job_status: JobStatus | null;
  exit_code: number | null;
}

export interface SendKeysArgs {
  pane?: string;
  job_id?: string;
  text?: string;
  keys?: string[];
  press_enter: boolean;
}

export interface ListedPane {
  pane: string;
  target: string;
  title: string;
  current_command: string;
  size: string;
  managed: boolean;
  job_id: string | null;
  job_status: JobStatus | null;
}

export interface KillArgs {
  job_id?: string;
  pane?: string;
  mode: 'interrupt' | 'kill-pane';
}

function escapeSingleQuotes(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/**
 * Orchestrates the tmux client, job manager, pane allocator, and cursor
 * tracker behind the seven MCP tools. One instance per server process (stdio
 * transport = one server per agent session).
 */
export class SidemuxService {
  readonly jobs: JobManager;
  readonly allocator: PaneAllocator;
  readonly cursor: CursorTracker;
  private readonly selfPane: string | null;

  constructor(
    private readonly client: TmuxClient,
    private readonly config: Config,
    env: NodeJS.ProcessEnv = process.env,
    defaultCwd: string = process.cwd(),
  ) {
    this.jobs = new JobManager(client);
    this.allocator = new PaneAllocator(client, config, env, defaultCwd);
    this.cursor = new CursorTracker();
    this.selfPane = env.TMUX_PANE ?? null;
    this.defaultCwd = defaultCwd;
  }

  private readonly defaultCwd: string;

  /**
   * Turn a `project` into a concrete (cwd, name) for a run. Without a project,
   * the caller's own cwd/name pass through unchanged. With one, resolve it to
   * the package directory against the server's root cwd; explicit cwd/name win.
   */
  private async resolveProjectTarget(
    args: RunArgs,
  ): Promise<{ cwd: string | undefined; name: string | undefined }> {
    if (!args.project) return { cwd: args.cwd, name: args.name };
    const dir = await resolveProject(this.defaultCwd, args.project);
    if (!dir) {
      const names = [...(await listProjects(this.defaultCwd)).keys()].sort();
      throw new Error(
        `unknown project "${args.project}"` +
          (names.length
            ? ` — available: ${names.join(', ')}`
            : ' — no workspace packages found (expected pnpm-workspace.yaml or nx.json at the repo root)'),
      );
    }
    return { cwd: args.cwd ?? dir, name: args.name ?? args.project };
  }

  async run(args: RunArgs, onProgress?: (elapsedMs: number) => void): Promise<RunResult> {
    // A `project` targets a monorepo package: run in its directory and give the
    // pane a stable name (the project) so package runs never share a pane. An
    // explicit cwd/name still wins over the resolved defaults.
    const { cwd: runCwd, name: runName } = await this.resolveProjectTarget(args);

    const acquired = await this.allocator.acquire({
      pane: args.pane,
      name: runName,
      cwd: runCwd,
      command: args.command,
    });
    this.allocator.guardWrite(acquired.paneId);

    // cwd rule: created panes are already anchored via split-window -c.
    // For reused/explicit panes, cd first when a cwd applies and differs.
    let command = args.command;
    const targetCwd = runCwd ?? this.defaultCwd;
    const wantsCd =
      !acquired.created &&
      acquired.currentPath !== targetCwd &&
      (runCwd !== undefined || this.allocator.isManaged(acquired.paneId));
    if (wantsCd) {
      command = `cd '${escapeSingleQuotes(targetCwd)}' && ${command}`;
    }

    const job = await this.jobs.launch(acquired.paneId, command, this.config.shell);
    this.allocator.setBusy(acquired.paneId, true);

    if (args.background) {
      return {
        job_id: job.jobId,
        pane: job.paneId,
        status: 'running',
        exit_code: null,
        duration_ms: 0,
        tail: '',
        closed: false,
      };
    }

    try {
      const result = await waitFor(this.client, job.paneId, this.jobs, job, {
        until: 'exit',
        timeoutMs: args.timeout_ms,
        onProgress,
      });
      if (job.status !== 'running') this.allocator.setBusy(job.paneId, false);

      // Capture the tail *before* any teardown — the pane may be about to close.
      const tail = (await this.jobTail(job)).text;
      const closed = await this.maybeClose(args.close, job);

      return {
        job_id: job.jobId,
        pane: job.paneId,
        status: job.status,
        exit_code: job.exitCode,
        duration_ms: result.elapsedMs,
        tail,
        closed,
      };
    } catch (error) {
      // The pane can vanish mid-run: a command that exits the shell (`exit`,
      // `exec …`) takes the sentinel with it, or the human closes the split.
      // tmux then throws on the next capture. Only swallow that exact case —
      // report an unknown outcome and drop the dead pane from the registry so a
      // stale busy entry can't shadow a name or brick a later close_all.
      if (await this.client.paneExists(job.paneId)) throw error;
      job.status = 'unknown';
      job.exitCode = null;
      await this.allocator.remove(job.paneId);
      this.cursor.forget(job.paneId);
      return {
        job_id: job.jobId,
        pane: job.paneId,
        status: 'unknown',
        exit_code: null,
        duration_ms: Date.now() - job.startedAt,
        tail: '',
        closed: true,
      };
    }
  }

  /**
   * Destroy the pane after a run when closing was requested — but only for a
   * managed pane whose job actually finished. Never closes a still-running
   * (timed-out) job or a pane sidemux did not create.
   *
   * A per-run `close` wins when given (true closes on any exit, false keeps).
   * With no per-run flag, SIDEMUX_CLOSE_ON_SUCCESS closes only on a clean exit
   * (0), leaving failed panes up for inspection.
   */
  private async maybeClose(close: boolean | undefined, job: Job): Promise<boolean> {
    const wantClose = close ?? (this.config.closeOnSuccess && job.exitCode === 0);
    if (!wantClose || job.status === 'running' || !this.allocator.isManaged(job.paneId)) {
      return false;
    }
    await this.client.killPane(job.paneId);
    await this.allocator.remove(job.paneId);
    this.cursor.forget(job.paneId);
    return true;
  }

  async wait(
    args: WaitArgs,
    onProgress?: (elapsedMs: number) => void,
  ): Promise<WaitToolResult> {
    const { job, paneId } = await this.locate(args.job_id, args.pane);
    if (args.until === 'exit' && !job) {
      throw new Error(
        'wait until=exit needs a job — pass job_id from run, or use until=idle/pattern for arbitrary panes',
      );
    }

    const result = await waitFor(this.client, paneId, this.jobs, job, {
      until: args.until,
      pattern: args.pattern,
      idleMs: args.idle_ms,
      timeoutMs: args.timeout_ms,
      onProgress,
    });
    if (job && job.status !== 'running') this.allocator.setBusy(paneId, false);

    const tail = job ? await this.jobTail(job) : await this.screenTail(paneId);
    return {
      status: result.status,
      exit_code: job?.exitCode ?? null,
      matched_line: result.matchedLine,
      elapsed_ms: result.elapsedMs,
      tail: tail.text,
    };
  }

  async read(args: ReadArgs): Promise<ReadResult> {
    const { job, paneId } = await this.locate(args.job_id, args.pane);
    const shapeOptions = {
      lines: args.lines,
      grep: args.grep,
      context: args.context,
      maxBytes: Math.min(args.max_bytes, this.config.maxOutputBytes * 8),
    };

    let rawLines: string[];
    let cursorReset = false;

    if (args.since === 'job') {
      if (!job) throw new Error("read since='job' needs a job_id (or a pane with a known job)");
      rawLines = await this.captureJobRegion(job);
    } else if (args.since === 'screen') {
      rawLines = await this.client.capturePane(paneId);
    } else {
      const incremental = await this.cursor.read(this.client, paneId, args.lines);
      rawLines = incremental.lines;
      cursorReset = incremental.cursorReset;
    }

    // A read may be the first thing to observe a finished job.
    if (job && job.status === 'running') {
      this.jobs.applyScan(job, rawLines);
      if (job.status !== 'running') this.allocator.setBusy(paneId, false);
    }

    const shaped = shapeOutput(scrubOutput(rawLines), shapeOptions);
    return {
      text: shaped.text,
      lines_returned: shaped.linesReturned,
      truncated: shaped.truncated,
      cursor_reset: cursorReset,
      job_status: job?.status ?? null,
      exit_code: job?.exitCode ?? null,
    };
  }

  async sendKeys(args: SendKeysArgs): Promise<{ ok: true; pane: string }> {
    if (args.text === undefined && (!args.keys || args.keys.length === 0) && !args.press_enter) {
      throw new Error('send_keys: provide text, keys, or press_enter');
    }
    const { paneId } = await this.locate(args.job_id, args.pane);
    this.allocator.guardWrite(paneId);

    if (args.text !== undefined) await this.client.sendLiteral(paneId, args.text);
    if (args.keys && args.keys.length > 0) await this.client.sendKeys(paneId, args.keys);
    if (args.press_enter) await this.client.sendKeys(paneId, ['Enter']);
    return { ok: true, pane: paneId };
  }

  async listPanes(all: boolean): Promise<ListedPane[]> {
    const panes = await this.client.listPanes();
    const selfSession = this.selfPane
      ? panes.find((p) => p.paneId === this.selfPane)?.target.split(':')[0]
      : undefined;

    return panes
      .filter((pane) => {
        if (all) return true;
        if (this.allocator.isManaged(pane.paneId) || pane.managed) return true;
        return selfSession !== undefined && pane.target.startsWith(`${selfSession}:`);
      })
      .map((pane) => {
        const job = this.jobs.findByPane(pane.paneId);
        return {
          pane: pane.paneId,
          target: pane.target,
          title: pane.title,
          current_command: pane.currentCommand,
          size: `${pane.width}x${pane.height}`,
          managed: pane.managed || this.allocator.isManaged(pane.paneId),
          job_id: job?.jobId ?? null,
          job_status: job?.status ?? null,
        };
      });
  }

  async kill(args: KillArgs): Promise<{ ok: true; pane: string; mode: string }> {
    const { job, paneId } = await this.locate(args.job_id, args.pane);
    this.allocator.guardWrite(paneId);

    if (args.mode === 'kill-pane') {
      if (!this.allocator.isManaged(paneId)) {
        throw new Error(
          `kill-pane refused: ${paneId} was not created by sidemux — ` +
            'use mode=interrupt to Ctrl-C it instead',
        );
      }
      await this.client.killPane(paneId);
      await this.allocator.remove(paneId);
      this.cursor.forget(paneId);
    } else {
      await this.client.sendKeys(paneId, ['C-c']);
      if (job) this.jobs.markInterrupted(job);
      this.allocator.setBusy(paneId, false);
    }
    return { ok: true, pane: paneId, mode: args.mode };
  }

  /**
   * Destroy every pane sidemux created this session — including ones with a
   * command still running (kill-pane takes the process with it). Panes sidemux
   * did not create (the agent's own pane, the human's shells) are never in the
   * registry, so they are untouched. Mirrors the single-pane kill-pane teardown.
   */
  async closeAll(): Promise<{ closed: string[]; count: number }> {
    const closed: string[] = [];
    for (const paneId of this.allocator.managedPaneIds()) {
      const job = this.jobs.findByPane(paneId);
      if (job && job.status === 'running') this.jobs.markInterrupted(job);
      try {
        await this.client.killPane(paneId);
      } catch {
        // Pane already gone (user closed it, or a command exited the shell).
        // Swallow so one dead pane can't abort the whole sweep — still forget it.
      }
      await this.allocator.remove(paneId);
      this.cursor.forget(paneId);
      closed.push(paneId);
    }
    return { closed, count: closed.length };
  }

  /** Resolve job_id and/or pane into a concrete job + pane id. */
  private async locate(
    jobId?: string,
    pane?: string,
  ): Promise<{ job: Job | null; paneId: string }> {
    if (jobId) {
      const job = this.jobs.get(jobId);
      if (!job) throw new Error(`unknown job_id: ${jobId}`);
      return { job, paneId: job.paneId };
    }
    if (pane) {
      const paneId = await this.allocator.resolve(pane);
      return { job: this.jobs.findByPane(paneId) ?? null, paneId };
    }
    throw new Error('provide job_id or pane');
  }

  /** Everything the job printed (echo line included, sentinel stripped). */
  private async captureJobRegion(job: Job): Promise<string[]> {
    const state = await this.client.paneState(job.paneId);
    const start = Math.max(
      -state.historySize,
      job.baselineLines - 1 - state.historySize,
    );
    return this.client.capturePane(job.paneId, start, state.cursorY);
  }

  private async jobTail(job: Job): Promise<ShapedOutput> {
    const lines = await this.captureJobRegion(job);
    return shapeOutput(scrubOutput(lines), { lines: TAIL_LINES, maxBytes: TAIL_BYTES });
  }

  private async screenTail(paneId: string): Promise<ShapedOutput> {
    const lines = await this.client.capturePane(paneId);
    // Scrub like jobTail: the visible screen may still show a completed
    // sentinel from an earlier command, which must not leak into the tail.
    return shapeOutput(scrubOutput(lines), { lines: TAIL_LINES, maxBytes: TAIL_BYTES });
  }
}

export type { ShellDialect };
