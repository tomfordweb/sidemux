import type { Config } from "../config.js";
import type { ManagedPaneClass, PaneInfo } from "../types.js";
import type { TmuxClient } from "../tmux/client.js";
import { errorMessage, shellQuote } from "./shared.js";
import {
  BUSY_OPTION,
  CLASS_OPTION,
  AGENT_ID_OPTION,
  DESCRIPTION_OPTION,
  HEADER_LABEL_OPTION,
  LAST_COMMAND_OPTION,
  LAST_EXIT_CODE_OPTION,
  LAST_SEEN_AT_OPTION,
  LAST_USED_AT_OPTION,
  MANAGED_OPTION,
  MANAGED_TITLE_PREFIX,
  NAME_OPTION,
  SERVER_PID_OPTION,
  STATS_OPTION,
  encodeOptionValue,
} from "../tmux/formats.js";

export interface AcquireOptions {
  /** Explicit pane target (%id | session:win.pane | managed-pane name). */
  pane?: string | undefined;
  /** Friendly name for a managed pane (used in title and future targeting). */
  name?: string | undefined;
  /** Working directory; every created pane is anchored here via -c. */
  cwd?: string | undefined;
  /** The command about to run — used to reuse the pane that last ran it, and
   *  to label the pane header. */
  command?: string | undefined;
  /** Agent-supplied context: why this command runs. Shown in header + dashboard. */
  description?: string | undefined;
}

export interface AcquiredPane {
  paneId: string;
  created: boolean;
  /** The pane's actual current path (differs from requested cwd on reuse). */
  currentPath: string;
}

interface ManagedPane {
  paneId: string;
  windowId: string;
  name: string;
  busy: boolean;
  lastCommand: string | null;
  paneClass: ManagedPaneClass;
  lastUsedAt: number;
  lastExitCode: number | null;
  agentId: string | null;
  serverPid: number | null;
  description: string | null;
}

export interface OwnedManagedPane {
  paneId: string;
  busy: boolean;
  paneClass: ManagedPaneClass;
  lastExitCode: number | null;
  name: string;
}

const DEFAULT_TAB_NAME = "main";
const GC_MIN_INTERVAL_MS = 30_000;
/** Reuse one list-panes scan for tightly clustered calls within a request. */
const SYNC_FRESH_MS = 250;

/**
 * tmux pane-border-format for the header. pane-border-status is a *window*
 * option, so enabling it would otherwise draw a title on every pane in the
 * agent's window — including the human's own editor/shell panes. The
 * conditional renders the reversed label only for panes that carry sidemux's
 * `@smux_label` option (set on every pane it creates); all other panes render
 * an empty border. Keying on the option, not pane_title, keeps the header alive
 * under a shell that rewrites its title on every prompt.
 */
const HEADER_FORMAT =
  `#{?#{${HEADER_LABEL_OPTION}},` +
  `#{?pane_active,#[fg=colour45#,reverse],#[fg=colour245#,reverse]}` +
  ` #{${HEADER_LABEL_OPTION}} #[default],}`;

/** Border chrome matching the dashboard theme: dim frames, accent on the active pane. */
const BORDER_LINES = "double";
const BORDER_STYLE = "fg=colour240";
const ACTIVE_BORDER_STYLE = "fg=colour45";

/** Trim a command for a one-line pane header. */
function shortCommand(command: string, max = 48): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function fallbackName(pane: PaneInfo): string {
  if (pane.managedName) {
    return pane.managedName;
  }
  const stripped = pane.title.startsWith(MANAGED_TITLE_PREFIX)
    ? pane.title.slice(MANAGED_TITLE_PREFIX.length)
    : "";
  return stripped.split(" · ")[0] || pane.paneId.replace("%", "p");
}

function asManagedPane(pane: PaneInfo): ManagedPane {
  return {
    paneId: pane.paneId,
    windowId: pane.windowId,
    name: fallbackName(pane),
    busy: pane.busy,
    lastCommand: pane.lastCommand,
    paneClass: pane.paneClass ?? "oneshot",
    lastUsedAt: pane.lastUsedAt ?? 0,
    lastExitCode: pane.lastExitCode,
    agentId: pane.agentId,
    serverPid: pane.serverPid,
    description: pane.description,
  };
}

function processIsAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Creates, reuses, and guards tmux panes in the external sidemux workspace:
 * one window per agent inside the workspace session, panes keyed by owner
 * (`@smux_agent_id`). Every pane sidemux creates is anchored to an explicit
 * cwd (the agent's working directory by default — never tmux's default-path)
 * and titled "smux:<name>" so humans and list_panes can identify it.
 */
export class PaneAllocator {
  private readonly managed = new Map<string, ManagedPane>();
  /**
   * Last window each managed pane was seen in. Survives syncManaged() rebuilds
   * so a pane killed out-of-band (or pruned by a concurrent GC sync) can still
   * have its window's border header restored on remove().
   */
  private readonly lastKnownWindow = new Map<string, string>();
  private readonly selfPane: string | null;
  private keybindsInstalled = false;
  private gcInFlight: Promise<void> | null = null;
  private lastGcAt = 0;
  private lastSyncAt = 0;
  /**
   * Serializes every operation that reads or mutates the managed-pane map.
   * Garbage collection runs unawaited in the background; without the lock its
   * syncManaged() can rebuild the map from a list-panes snapshot taken BEFORE
   * a concurrent acquire wrote its metadata — silently dropping the new pane.
   */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: TmuxClient,
    private readonly config: Config,
    env: NodeJS.ProcessEnv = process.env,
    private readonly defaultCwd: string = process.cwd(),
  ) {
    this.selfPane = env.TMUX_PANE ?? null;
  }

  /** Run `fn` exclusively; operations queue in call order. NOT re-entrant. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lock.then(fn, fn);
    this.lock = next.catch(() => undefined);
    return next;
  }

  async ensureWorkspaceKeybinds(): Promise<void> {
    await this.installWorkspaceKeybinds(this.config.sessionName);
    this.scheduleGarbageCollect();
  }

  isManaged(paneId: string): boolean {
    return this.isOwned(this.managed.get(paneId));
  }

  async hasManagedPane(paneId: string): Promise<boolean> {
    return this.withLock(async () => {
      await this.syncManaged();
      return this.isOwned(this.managed.get(paneId));
    });
  }

  /** Every pane id sidemux currently tracks (for bulk teardown). */
  async managedPaneIds(): Promise<string[]> {
    return (await this.ownedManagedPanes()).map((entry) => entry.paneId);
  }

  /** Every sidemux-managed pane owned by this agent/cwd id. */
  async ownedManagedPanes(): Promise<OwnedManagedPane[]> {
    return this.withLock(async () => {
      await this.syncManaged({ force: true });
      return [...this.managed.values()]
        .filter((entry) => this.isOwned(entry))
        .map((entry) => ({
          paneId: entry.paneId,
          busy: entry.busy,
          paneClass: entry.paneClass,
          lastExitCode: entry.lastExitCode,
          name: entry.name,
        }));
    });
  }

  managedName(paneId: string): string | null {
    const entry = this.managed.get(paneId);
    return entry && this.isOwned(entry) ? entry.name : null;
  }

  async setBusy(paneId: string, busy: boolean): Promise<void> {
    return this.withLock(async () => {
      const entry = await this.requireManaged(paneId);
      entry.busy = busy;
      await this.client.setPaneOption(paneId, BUSY_OPTION, busy ? "1" : "0");
    });
  }

  async noteLaunch(
    paneId: string,
    options: { name: string; command: string; paneClass: ManagedPaneClass },
  ): Promise<void> {
    return this.withLock(async () => {
      await this.noteLaunchUnlocked(paneId, options);
    });
  }

  private async noteLaunchUnlocked(
    paneId: string,
    options: { name: string; command: string; paneClass: ManagedPaneClass },
  ): Promise<void> {
    const entry = await this.requireManaged(paneId);
    entry.name = options.name;
    entry.busy = true;
    entry.lastCommand = options.command;
    entry.paneClass = options.paneClass;
    entry.lastUsedAt = Date.now();
    entry.lastExitCode = null;
    await this.writeMetadata(entry);
    await this.refreshWindowStatus(entry.windowId);
  }

  async noteFinished(paneId: string, exitCode: number | null): Promise<void> {
    return this.withLock(async () => {
      const entry = await this.requireManaged(paneId);
      entry.busy = false;
      entry.lastUsedAt = Date.now();
      entry.lastExitCode = exitCode;
      await this.writeMetadata(entry);
      await this.refreshWindowStatus(entry.windowId);
    });
  }

  /** Forget a managed pane (after kill-pane); restore the header once none remain. */
  async remove(paneId: string): Promise<void> {
    return this.withLock(() => this.removeUnlocked(paneId));
  }

  private async removeUnlocked(paneId: string): Promise<void> {
    const cachedWindow =
      this.managed.get(paneId)?.windowId ??
      this.lastKnownWindow.get(paneId) ??
      null;
    await this.syncManaged({ force: true });
    const window = this.managed.get(paneId)?.windowId ?? cachedWindow;
    this.managed.delete(paneId);
    this.lastKnownWindow.delete(paneId);
    if (!window || !this.config.paneHeader) {
      return;
    }
    if ([...this.managed.values()].some((entry) => entry.windowId === window)) {
      return;
    }
    try {
      await this.client.unsetWindowOption(window, "pane-border-status");
      await this.client.unsetWindowOption(window, "pane-border-format");
      await this.client.unsetWindowOption(window, "pane-border-lines");
      await this.client.unsetWindowOption(window, "pane-border-style");
      await this.client.unsetWindowOption(window, "pane-active-border-style");
    } catch {
      // Killing the last pane also destroys its window; no options remain to restore.
    }
  }

  /**
   * Refuse writes to the agent's own pane (feedback-loop footgun) and, when
   * SIDEMUX_MANAGED_ONLY=1, to any pane sidemux did not create.
   */
  guardWrite(paneId: string): void {
    if (this.selfPane && paneId === this.selfPane) {
      throw new Error(
        `refusing to write to ${paneId}: that is the agent's own pane — ` +
          "typing into it would feed keystrokes back to the agent session",
      );
    }
    if (this.config.managedOnly && !this.isManaged(paneId)) {
      throw new Error(
        `refusing to write to ${paneId}: SIDEMUX_MANAGED_ONLY=1 restricts ` +
          "writes to panes sidemux created",
      );
    }
    const entry = this.managed.get(paneId);
    if (entry && !this.isOwned(entry)) {
      throw new Error(
        `refusing to write to ${paneId}: pane belongs to sidemux agent ${entry.agentId ?? "unknown"}`,
      );
    }
  }

  /** Resolve a name/target/id to a pane, or create a managed pane. */
  async acquire(options: AcquireOptions = {}): Promise<AcquiredPane> {
    return this.withLock(() => this.acquireUnlocked(options));
  }

  private async acquireUnlocked(
    options: AcquireOptions,
  ): Promise<AcquiredPane> {
    const cwd = options.cwd ?? this.defaultCwd;

    if (options.pane) {
      const paneId = await this.resolveUnlocked(options.pane);
      this.guardWrite(paneId);
      const entry = this.managed.get(paneId);
      if (entry) {
        if (options.name !== undefined) {
          entry.name = options.name;
        }
        if (options.command !== undefined) {
          entry.lastCommand = options.command;
        }
        if (options.description !== undefined) {
          entry.description = options.description;
        }
        entry.busy = true;
        await this.writeMetadata(entry);
      }
      return {
        paneId,
        created: false,
        currentPath: await this.client.panePath(paneId),
      };
    }

    const reusable = await this.findReusable(options.name, options.command);
    const reused = reusable ? this.managed.get(reusable) : undefined;
    if (reusable && reused) {
      if (options.name !== undefined) {
        reused.name = options.name;
      }
      if (options.command !== undefined) {
        reused.lastCommand = options.command;
      }
      if (options.description !== undefined) {
        reused.description = options.description;
      }
      // Claim the pane immediately: a concurrent run's TTL trim between this
      // acquire and the eventual noteLaunch must see it as busy, not idle.
      reused.busy = true;
      await this.writeMetadata(reused);
      return {
        paneId: reusable,
        created: false,
        currentPath: await this.client.panePath(reusable),
      };
    }

    const name = options.name ?? DEFAULT_TAB_NAME;
    const paneId = await this.createExternalTab(
      cwd,
      this.config.paneShell ?? undefined,
    );
    const entry: ManagedPane = {
      paneId,
      windowId: await this.client.paneWindow(paneId),
      name,
      busy: true,
      lastCommand: options.command ?? null,
      paneClass: "oneshot",
      lastUsedAt: Date.now(),
      lastExitCode: null,
      agentId: this.config.agentId,
      serverPid: process.pid,
      description: options.description ?? null,
    };
    this.managed.set(paneId, entry);
    this.lastKnownWindow.set(paneId, entry.windowId);
    await this.writeMetadata(entry);
    await this.enableHeaderBorder(entry.windowId);
    await this.refreshWindowStatus(entry.windowId);
    return { paneId, created: true, currentPath: cwd };
  }

  /**
   * Mirror this server's encoded token-savings stats onto the window that
   * holds `paneId` (the agent's own window) so the dashboard popup — a
   * separate process — can read them via list-windows. Best-effort: an
   * unmanaged pane or a vanished window is a no-op.
   */
  async publishStats(paneId: string, encoded: string): Promise<void> {
    const entry = this.managed.get(paneId);
    if (!entry || !this.isOwned(entry)) {
      return;
    }
    try {
      await this.client.setWindowOption(
        entry.windowId,
        STATS_OPTION,
        encodeOptionValue(encoded),
      );
    } catch {
      // Stats are a display gauge — never let them fail a run/read.
    }
  }

  /** Release a claimed pane that never launched (its run failed before typing). */
  async release(paneId: string): Promise<void> {
    return this.withLock(async () => {
      const entry = this.managed.get(paneId);
      if (!entry || !this.isOwned(entry)) {
        return;
      }
      entry.busy = false;
      try {
        await this.client.setPaneOption(paneId, BUSY_OPTION, "0");
      } catch {
        // The pane may already be gone; nothing to release.
      }
    });
  }

  /**
   * Garbage-collect this agent's idle one-shot panes whose last use is older
   * than `ttlMs`. Busy panes, persistent (background) panes, and other agents'
   * panes are never touched. Failed panes are collected too — their output
   * stays inspectable until the TTL expires.
   */
  async trimIdlePanes(ttlMs: number, keepPaneId?: string): Promise<string[]> {
    return this.withLock(() => this.trimIdlePanesUnlocked(ttlMs, keepPaneId));
  }

  private async trimIdlePanesUnlocked(
    ttlMs: number,
    keepPaneId?: string,
  ): Promise<string[]> {
    await this.syncManaged({ force: true });
    const cutoff = Date.now() - ttlMs;
    const doomed = [...this.managed.values()].filter(
      (entry) =>
        this.isOwned(entry) &&
        !entry.busy &&
        entry.paneClass === "oneshot" &&
        entry.paneId !== keepPaneId &&
        entry.lastUsedAt <= cutoff,
    );
    const closed: string[] = [];
    for (const entry of doomed) {
      try {
        await this.client.killPane(entry.paneId);
      } catch {
        // Already gone (human closed it, or another process trimmed first).
      }
      await this.removeUnlocked(entry.paneId);
      closed.push(entry.paneId);
    }
    return closed;
  }

  /** Resolve %id / session:win.pane / managed-pane name to a live %id. */
  async resolve(target: string): Promise<string> {
    return this.withLock(() => this.resolveUnlocked(target));
  }

  private async resolveUnlocked(target: string): Promise<string> {
    await this.syncManaged({ force: true });
    const named = [...this.managed.values()]
      .filter((entry) => entry.name === target)
      .sort((a, b) => {
        if (a.busy !== b.busy) {
          return a.busy ? 1 : -1;
        }
        return b.lastUsedAt - a.lastUsedAt;
      });
    const bestNamed = named[0];
    if (bestNamed) {
      return bestNamed.paneId;
    }
    return this.client.resolveTarget(target);
  }

  /**
   * Pick a pane to reuse — strict affinity only. An explicit `name` binds to
   * that named pane; an unnamed run reuses the idle pane that last ran this
   * exact command. No match means a new pane: grabbing an arbitrary idle pane
   * would steal another command's pane and destroy the rerun-lands-in-the-
   * same-pane property.
   */
  private async findReusable(
    name?: string,
    command?: string,
  ): Promise<string | null> {
    if (!this.config.reusePanes) {
      return null;
    }
    await this.syncManaged();
    if (name !== undefined) {
      return this.bestIdle((entry) => entry.name === name);
    }
    if (command !== undefined) {
      return this.bestIdle((entry) => entry.lastCommand === command);
    }
    return null;
  }

  /** Most-recently-used idle owned pane matching `match`. */
  private bestIdle(match: (entry: ManagedPane) => boolean): string | null {
    let best: ManagedPane | null = null;
    for (const entry of this.managed.values()) {
      if (!this.isOwned(entry)) {
        continue;
      }
      if (entry.busy) {
        continue;
      }
      if (!match(entry)) {
        continue;
      }
      if (!best || entry.lastUsedAt > best.lastUsedAt) {
        best = entry;
      }
    }
    return best?.paneId ?? null;
  }

  /** Turn on tmux's pane-border header + themed frames for sidemux's window. */
  private async enableHeaderBorder(window: string): Promise<void> {
    if (!this.config.paneHeader) {
      return;
    }
    await this.client.setWindowOption(window, "pane-border-status", "top");
    await this.client.setWindowOption(
      window,
      "pane-border-format",
      HEADER_FORMAT,
    );
    await this.client.setWindowOption(
      window,
      "pane-border-lines",
      BORDER_LINES,
    );
    await this.client.setWindowOption(
      window,
      "pane-border-style",
      BORDER_STYLE,
    );
    await this.client.setWindowOption(
      window,
      "pane-active-border-style",
      ACTIVE_BORDER_STYLE,
    );
  }

  /**
   * Write a pane's full sidemux state (title, header label, and every
   * `@smux_*` option) in one batched tmux invocation.
   */
  private async writeMetadata(entry: ManagedPane): Promise<void> {
    entry.serverPid = process.pid;
    const base = entry.lastCommand
      ? `${entry.name} · ${shortCommand(entry.lastCommand)} · ${entry.paneId}`
      : entry.name;
    const label = entry.description
      ? `${base} — ${shortCommand(entry.description, 40)}`
      : base;
    await this.client.updatePane(
      entry.paneId,
      `${MANAGED_TITLE_PREFIX}${label}`,
      [
        { name: HEADER_LABEL_OPTION, value: label },
        { name: MANAGED_OPTION, value: "1" },
        { name: NAME_OPTION, value: encodeOptionValue(entry.name) },
        { name: AGENT_ID_OPTION, value: entry.agentId ?? this.config.agentId },
        { name: SERVER_PID_OPTION, value: String(process.pid) },
        { name: BUSY_OPTION, value: entry.busy ? "1" : "0" },
        { name: CLASS_OPTION, value: entry.paneClass },
        { name: LAST_USED_AT_OPTION, value: String(entry.lastUsedAt) },
        {
          name: LAST_COMMAND_OPTION,
          value:
            entry.lastCommand === null
              ? null
              : encodeOptionValue(entry.lastCommand),
        },
        {
          name: LAST_EXIT_CODE_OPTION,
          value:
            entry.lastExitCode === null ? null : String(entry.lastExitCode),
        },
        {
          name: DESCRIPTION_OPTION,
          value: entry.description
            ? encodeOptionValue(entry.description)
            : null,
        },
      ],
    );
  }

  private async syncManaged(options: { force?: boolean } = {}): Promise<void> {
    const now = Date.now();
    if (!options.force && now - this.lastSyncAt < SYNC_FRESH_MS) {
      return;
    }
    const panes = await this.client.listPanes();
    this.lastSyncAt = now;
    this.managed.clear();
    let sawWorkspacePane = false;
    for (const pane of panes) {
      if (!pane.managed) {
        continue;
      }
      const entry = asManagedPane(pane);
      // Stale-busy recovery: a server that crashed mid-run leaves its pane
      // marked busy forever. If the recorded server pid is dead, the run can
      // no longer finish — treat the pane as idle so it can be reused/trimmed.
      if (
        entry.busy &&
        entry.serverPid !== null &&
        !processIsAlive(entry.serverPid)
      ) {
        entry.busy = false;
      }
      this.managed.set(entry.paneId, entry);
      this.lastKnownWindow.set(entry.paneId, entry.windowId);
      if (pane.sessionName === this.config.sessionName) {
        sawWorkspacePane = true;
      }
    }
    if (sawWorkspacePane) {
      await this.ensureWorkspaceKeybinds();
    }
  }

  private async refreshWindowStatus(windowId: string): Promise<void> {
    const panes = [...this.managed.values()].filter(
      (entry) => entry.windowId === windowId,
    );
    if (panes.length === 0) {
      return;
    }
    const marker = panes.some((entry) => entry.busy)
      ? "*"
      : panes.some(
            (entry) => entry.lastExitCode !== null && entry.lastExitCode !== 0,
          )
        ? "!"
        : panes.some((entry) => entry.lastExitCode === 0)
          ? "+"
          : "-";
    try {
      await this.client.renameWindow(
        windowId,
        `${marker} ${this.config.agentLabel}`,
      );
    } catch {
      // The pane/window may have disappeared between command completion and status refresh.
    }
  }

  private isOwned(entry: ManagedPane | undefined | null): boolean {
    return entry?.agentId === this.config.agentId;
  }

  private async createExternalTab(
    cwd: string,
    shell: string | undefined,
  ): Promise<string> {
    const session = this.config.sessionName;
    this.scheduleGarbageCollect();
    const windows = await this.client.listWindows(session);
    const existing = windows.find(
      (window) => window.agentId === this.config.agentId,
    );
    if (existing) {
      await this.installWorkspaceKeybinds(session);
      await this.writeOwnerWindowMetadata(existing.windowId);
      return this.client.splitWindowInWindow(
        session,
        existing.windowIndex,
        cwd,
        shell,
      );
    }

    if (await this.client.hasSession(session)) {
      const paneId = await this.client.newWindow(
        session,
        cwd,
        shell,
        this.config.agentLabel,
      );
      await this.installWorkspaceKeybinds(session);
      await this.writeOwnerWindowMetadata(await this.client.paneWindow(paneId));
      return paneId;
    }

    const paneId = await this.client.newSession(
      session,
      cwd,
      shell,
      this.config.agentLabel,
    );
    await this.installWorkspaceKeybinds(session);
    await this.writeOwnerWindowMetadata(await this.client.paneWindow(paneId));
    return paneId;
  }

  private async writeOwnerWindowMetadata(windowId: string): Promise<void> {
    await this.client.setWindowOptions(windowId, [
      { name: AGENT_ID_OPTION, value: this.config.agentId },
      { name: SERVER_PID_OPTION, value: String(process.pid) },
      { name: LAST_SEEN_AT_OPTION, value: String(Date.now()) },
    ]);
  }

  private scheduleGarbageCollect(): void {
    const now = Date.now();
    if (this.gcInFlight || now - this.lastGcAt < GC_MIN_INTERVAL_MS) {
      return;
    }
    this.lastGcAt = now;
    this.gcInFlight = this.withLock(() => this.garbageCollect())
      .catch((error: unknown) => {
        console.error(`sidemux gc: ${errorMessage(error)}`);
      })
      .finally(() => {
        this.gcInFlight = null;
      });
  }

  private async garbageCollect(): Promise<void> {
    const [windows, panes] = await Promise.all([
      this.client.listWindows(this.config.sessionName),
      this.client.listPanes(),
    ]);
    for (const window of windows) {
      if (!window.agentId) {
        continue;
      }
      if (window.agentId === this.config.agentId) {
        // Heartbeat: keep this window's ownership fresh so humans (and future
        // staleness checks) can tell live windows from abandoned ones.
        await this.writeOwnerWindowMetadata(window.windowId);
        continue;
      }
      // Pid liveness is the kill signal. Caveat: a recycled pid makes a dead
      // server look alive, which merely delays collection until the impostor
      // exits — the safe failure direction.
      if (processIsAlive(window.serverPid)) {
        continue;
      }
      const windowPanes = panes.filter(
        (pane) => pane.windowId === window.windowId && pane.managed,
      );
      if (windowPanes.length === 0) {
        continue;
      }
      if (
        windowPanes.some((pane) => pane.busy && processIsAlive(pane.serverPid))
      ) {
        continue;
      }
      try {
        await this.client.killWindow(window.windowId);
      } catch {
        // GC is opportunistic: a human or another sidemux process may already
        // have removed this stale window after our inventory pass.
      }
    }
    await this.trimIdlePanesUnlocked(this.config.idlePaneTtlMs);
  }

  private async installWorkspaceKeybinds(session: string): Promise<void> {
    if (!this.config.keybinds || this.keybindsInstalled) {
      return;
    }
    const chooserCommand = [
      // #{client_tty} names the client that pressed the key. The dashboard
      // needs it to retarget switch-client after its popup closes — tmux
      // ignores a bare switch-client for a client whose popup is open, and a
      // detached retry without -c may grab a different client entirely.
      "SIDEMUX_CLIENT_TTY='#{client_tty}'",
      `SIDEMUX_SESSION=${shellQuote(session)}`,
      this.config.socketName
        ? `SIDEMUX_TMUX_SOCKET=${shellQuote(this.config.socketName)}`
        : "",
      shellQuote(process.execPath),
      shellQuote(process.argv[1] ?? "sidemux"),
      "dashboard",
    ]
      .filter(Boolean)
      .join(" ");

    // display-popup does not format-expand its shell command, so the binding
    // goes through run-shell (which does) to resolve #{client_tty} at
    // keypress time before opening the popup.
    const socketFlags = this.config.socketName
      ? `-L ${shellQuote(this.config.socketName)} `
      : "";
    // -c pins the popup to the pressing client: run-shell detaches from the
    // client context, so an unqualified display-popup could pick another one.
    const popupCommand =
      `tmux ${socketFlags}display-popup -c '#{client_tty}' ` +
      `-E -w 96% -h 92% -x C -y C "${chooserCommand}"`;

    await this.client.bindKey([
      "-T",
      "prefix",
      this.config.dashboardKey,
      "run-shell",
      "-b",
      popupCommand,
    ]);
    this.keybindsInstalled = true;
  }

  private async requireManaged(paneId: string): Promise<ManagedPane> {
    const known = this.managed.get(paneId);
    if (known) {
      return known;
    }
    await this.syncManaged({ force: true });
    const entry = this.managed.get(paneId);
    if (!entry) {
      throw new Error(`pane is not managed by sidemux: ${paneId}`);
    }
    return entry;
  }
}
