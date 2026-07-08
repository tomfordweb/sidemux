import type { Config, ShellDialect } from "./config.js";
import { loadProjectScripts, type ProjectScript } from "./config-file.js";
import { CursorTracker } from "./core/cursor.js";
import { JobManager, scrubOutput } from "./core/jobs.js";
import { shapeOutput, type ShapedOutput } from "./core/output.js";
import { PaneAllocator } from "./core/panes.js";
import { clampCaptureStart, shellQuote } from "./core/shared.js";
import { StatsTracker } from "./core/stats.js";
import { waitFor, type WaitResult, type WaitUntil } from "./core/waiter.js";
import { listProjects, resolveProject } from "./core/workspace.js";
import type { TmuxClient } from "./tmux/client.js";
import type { Job, JobStatus } from "./types.js";

const TAIL_LINES = 10;
/** Clean exits return a slimmer tail — success output is rarely re-read.
 *  5 lines, not 3: the captured region ends with the echoed prompt line and a
 *  blank, so ~2 lines are shell chrome. */
const SUCCESS_TAIL_LINES = 5;
const TAIL_BYTES = 2048;

export interface RunArgs {
  command: string;
  /** Agent-supplied context: why this command runs. Shown in pane header +
   *  dashboard. Required at the MCP schema layer; optional here so internal
   *  callers (tests, future CLI) aren't forced to invent one. */
  description?: string | undefined;
  pane?: string | undefined;
  name?: string | undefined;
  cwd?: string | undefined;
  /** Monorepo package to target: resolves to its dir (cwd) and names the pane. */
  project?: string | undefined;
  timeout_ms: number;
  background: boolean;
  /** Destroy the pane after a finished foreground run. Defaults to off. */
  close?: boolean | undefined;
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
  job_id?: string | undefined;
  pane?: string | undefined;
  until: WaitUntil;
  pattern?: string | undefined;
  idle_ms: number;
  timeout_ms: number;
}

export interface WaitToolResult {
  status: WaitResult["status"];
  exit_code: number | null;
  matched_line: string | null;
  elapsed_ms: number;
  tail: string;
}

export interface ReadArgs {
  job_id?: string | undefined;
  pane?: string | undefined;
  since: "last-read" | "job" | "screen";
  lines: number;
  grep?: string | undefined;
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
  pane?: string | undefined;
  job_id?: string | undefined;
  text?: string | undefined;
  keys?: string[] | undefined;
  press_enter: boolean;
}

// Kept lean on purpose: every list_panes/status result persists in the agent's
// context for the session. target/title/size were dropped — target is
// reconstructable (`session:window`, pane id), the title duplicates name +
// command, and size is cosmetic.
export interface ListedPane {
  pane: string;
  session: string;
  window: string;
  tab: string;
  name: string | null;
  current_command: string;
  managed: boolean;
  description: string | null;
  job_id: string | null;
  job_status: JobStatus | null;
}

export interface StatusTab {
  session: string;
  window: string;
  tab: string;
  panes: ListedPane[];
  running: number;
  failed: number;
  done: number;
}

export interface KillArgs {
  job_id?: string | undefined;
  pane?: string | undefined;
  mode: "interrupt" | "kill-pane";
}

export interface CloseOwnedArgs {
  force?: boolean | undefined;
}

export interface CloseOwnedResult {
  closed: string[];
  skipped: { pane: string; reason: string }[];
  count: number;
  skipped_count: number;
}

/**
 * Orchestrates the tmux client, job manager, pane allocator, and cursor
 * tracker behind the MCP tools. One instance per server process (stdio
 * transport = one server per agent session).
 */
export class SidemuxService {
  readonly jobs: JobManager;
  readonly allocator: PaneAllocator;
  readonly cursor: CursorTracker;
  private readonly stats = new StatsTracker();
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
    void this.allocator.ensureWorkspaceKeybinds().catch(() => undefined);
  }

  private readonly defaultCwd: string;
  private readonly scriptsCache = new Map<
    string,
    { at: number; scripts: Map<string, ProjectScript> }
  >();

  /**
   * Named scripts from a project's `.sidemux.toml`, re-read at most every
   * couple of seconds so edits apply without restarting the server. Keyed by
   * directory: a run with an explicit cwd resolves against THAT project's
   * scripts, not the server's own.
   */
  private projectScripts(dir: string): Map<string, ProjectScript> {
    const now = Date.now();
    const cached = this.scriptsCache.get(dir);
    if (cached && now - cached.at <= 2000) {
      return cached.scripts;
    }
    const entry = { at: now, scripts: loadProjectScripts(dir) };
    this.scriptsCache.set(dir, entry);
    return entry.scripts;
  }

  /**
   * Resolve `run { command: "lint" }` against the target project's `[scripts]`
   * table (the run's cwd, falling back to the server's). A matching name
   * substitutes the script's command (and background flag) and names the pane
   * after the script; anything else passes through as raw shell — globs and
   * arguments in script bodies are never reinterpreted.
   */
  private applyProjectScript(args: RunArgs): RunArgs {
    const script = this.projectScripts(args.cwd ?? this.defaultCwd).get(
      args.command.trim(),
    );
    if (!script) {
      return args;
    }
    return {
      ...args,
      command: script.command,
      name: args.name ?? script.name,
      background: args.background || script.background,
    };
  }

  private async ensureDashboardKeybind(): Promise<void> {
    try {
      await this.allocator.ensureWorkspaceKeybinds();
    } catch {
      // Keybind setup is a tmux UI affordance. Tool calls should still work
      // when tmux is momentarily busy or the client is headless; later calls
      // retry because PaneAllocator only marks successful installs.
    }
  }

  /**
   * Turn a `project` into a concrete (cwd, name) for a run. Without a project,
   * the caller's own cwd/name pass through unchanged. With one, resolve it to
   * the package directory against the server's root cwd; explicit cwd/name win.
   */
  private async resolveProjectTarget(
    args: RunArgs,
  ): Promise<{ cwd: string | undefined; name: string | undefined }> {
    if (!args.project) {
      return { cwd: args.cwd, name: args.name };
    }
    const dir = await resolveProject(this.defaultCwd, args.project);
    if (!dir) {
      const names = [...(await listProjects(this.defaultCwd)).keys()].sort();
      throw new Error(
        `unknown project "${args.project}"` +
          (names.length
            ? ` — available: ${names.join(", ")}`
            : " — no workspace packages found (expected pnpm-workspace.yaml or nx.json at the repo root)"),
      );
    }
    return { cwd: args.cwd ?? dir, name: args.name ?? args.project };
  }

  async run(
    rawArgs: RunArgs,
    onProgress?: (elapsedMs: number) => void,
  ): Promise<RunResult> {
    await this.ensureDashboardKeybind();
    const args = this.applyProjectScript(rawArgs);
    // A `project` targets a monorepo package: run in its directory and give the
    // pane a stable name (the project) so package runs never share a pane. An
    // explicit cwd/name still wins over the resolved defaults.
    const { cwd: runCwd, name: runName } =
      await this.resolveProjectTarget(args);

    const acquired = await this.allocator.acquire({
      pane: args.pane,
      name: runName,
      cwd: runCwd,
      command: args.command,
      description: args.description,
    });
    this.allocator.guardWrite(acquired.paneId);
    const managedPane = await this.allocator.hasManagedPane(acquired.paneId);

    // cwd rule: created panes are already anchored via split-window -c.
    // For reused/explicit panes, cd first when a cwd applies and differs.
    let command = args.command;
    const targetCwd = runCwd ?? this.defaultCwd;
    const wantsCd =
      !acquired.created &&
      acquired.currentPath !== targetCwd &&
      (runCwd !== undefined || this.allocator.isManaged(acquired.paneId));
    if (wantsCd) {
      command = `cd ${shellQuote(targetCwd)} && ${command}`;
    }

    let job: Job;
    try {
      job = await this.jobs.launch(acquired.paneId, command, this.config.shell);
    } catch (error) {
      // acquire() claimed the pane (busy=1); a failed launch must release it
      // or the pane stays unusable until this server exits.
      if (managedPane) {
        await this.allocator.release(acquired.paneId);
      }
      throw error;
    }
    if (managedPane) {
      try {
        await this.allocator.noteLaunch(acquired.paneId, {
          name:
            this.allocator.managedName(acquired.paneId) ??
            runName ??
            acquired.paneId,
          command: args.command,
          paneClass: args.background ? "persistent" : "oneshot",
        });
      } catch (error) {
        if (await this.client.paneExists(acquired.paneId)) {
          throw error;
        }
      }
    }

    if (args.background) {
      return {
        job_id: job.jobId,
        pane: job.paneId,
        status: "running",
        exit_code: null,
        duration_ms: 0,
        tail: "",
        closed: false,
      };
    }

    try {
      const result = await waitFor(this.client, job.paneId, this.jobs, job, {
        until: "exit",
        timeoutMs: args.timeout_ms,
        onProgress,
      });
      if (managedPane && job.status !== "running") {
        await this.allocator.noteFinished(job.paneId, job.exitCode);
      }

      // Capture the tail *before* any teardown — the pane may be about to close.
      const shapedTail = await this.jobTail(
        job,
        job.status === "done" && job.exitCode === 0
          ? SUCCESS_TAIL_LINES
          : TAIL_LINES,
      );
      this.recordStats(args.command, job.paneId, shapedTail);
      const tail = shapedTail.text;
      const closed = await this.maybeClose(args.close, job);
      const trimmed =
        managedPane && !closed && job.status !== "running"
          ? await this.allocator.trimIdlePanes(
              this.config.idlePaneTtlMs,
              job.paneId,
            )
          : [];

      return {
        job_id: job.jobId,
        pane: job.paneId,
        status: job.status,
        exit_code: job.exitCode,
        duration_ms: result.elapsedMs,
        tail,
        closed: closed || trimmed.includes(job.paneId),
      };
    } catch (error) {
      // The pane can vanish mid-run: a command that exits the shell (`exit`,
      // `exec …`) takes the sentinel with it, or the human closes the split.
      // tmux then throws on the next capture. Only swallow that exact case —
      // report an unknown outcome and drop the dead pane from the registry so a
      // stale busy entry can't shadow a name or brick a later close_all.
      if (await this.client.paneExists(job.paneId)) {
        throw error;
      }
      job.status = "unknown";
      job.exitCode = null;
      await this.allocator.remove(job.paneId);
      this.cursor.forget(job.paneId);
      return {
        job_id: job.jobId,
        pane: job.paneId,
        status: "unknown",
        exit_code: null,
        duration_ms: Date.now() - job.startedAt,
        tail: "",
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
  private async maybeClose(
    close: boolean | undefined,
    job: Job,
  ): Promise<boolean> {
    const wantClose =
      close ?? (this.config.closeOnSuccess && job.exitCode === 0);
    if (
      !wantClose ||
      job.status === "running" ||
      !(await this.allocator.hasManagedPane(job.paneId))
    ) {
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
    if (args.until === "exit" && !job) {
      throw new Error(
        "wait until=exit needs a job — pass job_id from run, or use until=idle/pattern for arbitrary panes",
      );
    }

    const result = await waitFor(this.client, paneId, this.jobs, job, {
      until: args.until,
      pattern: args.pattern,
      idleMs: args.idle_ms,
      timeoutMs: args.timeout_ms,
      onProgress,
    });
    if (
      job &&
      job.status !== "running" &&
      (await this.allocator.hasManagedPane(paneId))
    ) {
      await this.allocator.noteFinished(paneId, job.exitCode);
    }

    const tail = job
      ? await this.jobTail(
          job,
          result.status === "exit" && job.exitCode === 0
            ? SUCCESS_TAIL_LINES
            : TAIL_LINES,
        )
      : await this.screenTail(paneId);
    if (job) {
      this.recordStats(job.command, paneId, tail);
    }
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

    if (args.since === "job") {
      if (!job) {
        throw new Error(
          "read since='job' needs a job_id (or a pane with a known job)",
        );
      }
      rawLines = await this.captureJobRegion(job);
    } else if (args.since === "screen") {
      rawLines = await this.client.capturePane(paneId);
    } else {
      const incremental = await this.cursor.read(
        this.client,
        paneId,
        args.lines,
      );
      rawLines = incremental.lines;
      cursorReset = incremental.cursorReset;
    }

    // A read may be the first thing to observe a finished job.
    if (job?.status === "running") {
      const scanned = this.jobs.applyScan(job, rawLines);
      if (
        scanned.status !== "running" &&
        (await this.allocator.hasManagedPane(paneId))
      ) {
        await this.allocator.noteFinished(paneId, scanned.exitCode);
      }
    }

    const shaped = shapeOutput(scrubOutput(rawLines), shapeOptions);
    if (job) {
      this.recordStats(job.command, paneId, shaped);
    }
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
    if (
      args.text === undefined &&
      (!args.keys || args.keys.length === 0) &&
      !args.press_enter
    ) {
      throw new Error("send_keys: provide text, keys, or press_enter");
    }
    const { paneId } = await this.locate(args.job_id, args.pane);
    this.allocator.guardWrite(paneId);

    if (args.text !== undefined) {
      await this.client.sendLiteral(paneId, args.text);
    }
    if (args.keys && args.keys.length > 0) {
      await this.client.sendKeys(paneId, args.keys);
    }
    if (args.press_enter) {
      await this.client.sendKeys(paneId, ["Enter"]);
    }
    return { ok: true, pane: paneId };
  }

  async listPanes(all: boolean): Promise<ListedPane[]> {
    await this.ensureDashboardKeybind();
    const panes = await this.client.listPanes();
    const selfSession = this.selfPane
      ? panes.find((p) => p.paneId === this.selfPane)?.target.split(":")[0]
      : undefined;

    const visible = panes.filter((pane) => {
      if (all) {
        return true;
      }
      if (this.allocator.isManaged(pane.paneId) || pane.managed) {
        return true;
      }
      return (
        selfSession !== undefined && pane.target.startsWith(`${selfSession}:`)
      );
    });
    const listed: ListedPane[] = [];
    for (const pane of visible) {
      let job = this.jobs.findByPane(pane.paneId);
      // status/list may be the first call to observe a finished job (a
      // background run's sentinel lands with nobody reading the pane), so
      // running jobs get a sentinel scan here — same as read/wait do.
      if (job?.status === "running") {
        job = await this.refreshRunningJob(job);
      }
      listed.push({
        pane: pane.paneId,
        session: pane.sessionName,
        window: pane.windowIndex,
        tab: pane.windowName,
        name: pane.managedName,
        current_command: pane.currentCommand,
        managed: pane.managed,
        description: pane.description,
        job_id: job?.jobId ?? null,
        job_status: job?.status ?? null,
      });
    }
    return listed;
  }

  /**
   * Scan a running job's pane tail for its exit sentinel and settle the job
   * (and the pane's busy/exit metadata) when found. Best-effort: a vanished
   * pane leaves the job as-is for read/wait to reconcile.
   */
  private async refreshRunningJob(job: Job): Promise<Job> {
    try {
      const lines = await this.client.capturePane(job.paneId, -100);
      const scanned = this.jobs.applyScan(job, lines);
      if (
        scanned.status !== "running" &&
        (await this.allocator.hasManagedPane(job.paneId))
      ) {
        await this.allocator.noteFinished(job.paneId, scanned.exitCode);
      }
      return scanned;
    } catch {
      return job;
    }
  }

  async status(): Promise<{ tabs: StatusTab[] }> {
    const panes = await this.listPanes(false);
    const tabs = new Map<string, StatusTab>();
    for (const pane of panes.filter((p) => p.managed)) {
      const key = `${pane.session}:${pane.window}`;
      let tab = tabs.get(key);
      if (!tab) {
        tab = {
          session: pane.session,
          window: pane.window,
          tab: pane.tab,
          panes: [],
          running: 0,
          failed: 0,
          done: 0,
        };
        tabs.set(key, tab);
      }
      tab.panes.push(pane);
      if (pane.job_status === "running") {
        tab.running += 1;
      } else if (pane.job_status === "failed") {
        tab.failed += 1;
      } else if (pane.job_status === "done") {
        tab.done += 1;
      }
    }
    return { tabs: [...tabs.values()] };
  }

  async kill(
    args: KillArgs,
  ): Promise<{ ok: true; pane: string; mode: string }> {
    const { job, paneId } = await this.locate(args.job_id, args.pane);
    this.allocator.guardWrite(paneId);

    if (args.mode === "kill-pane") {
      if (!(await this.allocator.hasManagedPane(paneId))) {
        throw new Error(
          `kill-pane refused: ${paneId} was not created by sidemux — ` +
            "use mode=interrupt to Ctrl-C it instead",
        );
      }
      await this.client.killPane(paneId);
      await this.allocator.remove(paneId);
      this.cursor.forget(paneId);
    } else {
      await this.client.sendKeys(paneId, ["C-c"]);
      if (job) {
        this.jobs.markInterrupted(job);
      }
      if (job) {
        await this.allocator.noteFinished(paneId, job.exitCode);
      } else if (await this.allocator.hasManagedPane(paneId)) {
        await this.allocator.setBusy(paneId, false);
      }
    }
    return { ok: true, pane: paneId, mode: args.mode };
  }

  /**
   * Destroy panes owned by this agent/cwd id. Safe by default: running/busy
   * panes are skipped so session-close hooks don't kill long-running servers or
   * gates. force=true preserves the historical close_all behavior and kills all
   * owned panes, marking running jobs interrupted first.
   */
  async closeOwned(args: CloseOwnedArgs = {}): Promise<CloseOwnedResult> {
    const closed: string[] = [];
    const skipped: { pane: string; reason: string }[] = [];
    for (const pane of await this.allocator.ownedManagedPanes()) {
      const paneId = pane.paneId;
      const job = this.jobs.findByPane(paneId);
      if (!args.force && (pane.busy || job?.status === "running")) {
        skipped.push({ pane: paneId, reason: "running" });
        continue;
      }
      if (job?.status === "running") {
        this.jobs.markInterrupted(job);
      }
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
    return { closed, skipped, count: closed.length, skipped_count: skipped.length };
  }

  /** Historical force-close API, retained for existing clients. */
  async closeAll(): Promise<CloseOwnedResult> {
    return this.closeOwned({ force: true });
  }

  /**
   * Count one agent-facing tail response toward the workspace token-savings
   * stats (full region vs returned tail) and mirror the running totals onto
   * the agent's window for the dashboard. Fire-and-forget: a tmux hiccup here
   * must never fail the run/read that produced the output.
   */
  private recordStats(
    command: string,
    paneId: string,
    shaped: ShapedOutput,
  ): void {
    this.stats.record(command, shaped.bytesTotal, shaped.bytesReturned);
    void this.allocator
      .publishStats(paneId, this.stats.encoded())
      .catch(() => undefined);
  }

  /** Resolve job_id and/or pane into a concrete job + pane id. */
  private async locate(
    jobId?: string,
    pane?: string,
  ): Promise<{ job: Job | null; paneId: string }> {
    if (jobId) {
      const job = this.jobs.get(jobId);
      if (!job) {
        throw new Error(`unknown job_id: ${jobId}`);
      }
      return { job, paneId: job.paneId };
    }
    if (pane) {
      const paneId = await this.allocator.resolve(pane);
      return { job: this.jobs.findByPane(paneId) ?? null, paneId };
    }
    throw new Error("provide job_id or pane");
  }

  /** Everything the job printed (echo line included, sentinel stripped). */
  private async captureJobRegion(job: Job): Promise<string[]> {
    const state = await this.client.paneState(job.paneId);
    const start = clampCaptureStart(
      state,
      job.baselineLines - 1 - state.historySize,
    );
    return this.client.capturePane(job.paneId, start, state.cursorY);
  }

  private async jobTail(
    job: Job,
    tailLines = TAIL_LINES,
  ): Promise<ShapedOutput> {
    const lines = await this.captureJobRegion(job);
    return shapeOutput(scrubOutput(lines), {
      lines: tailLines,
      maxBytes: TAIL_BYTES,
    });
  }

  private async screenTail(paneId: string): Promise<ShapedOutput> {
    const lines = await this.client.capturePane(paneId);
    // Scrub like jobTail: the visible screen may still show a completed
    // sentinel from an earlier command, which must not leak into the tail.
    return shapeOutput(scrubOutput(lines), {
      lines: TAIL_LINES,
      maxBytes: TAIL_BYTES,
    });
  }
}

export type { ShellDialect };
