import { type Config, subdivideDirection } from '../config.js';
import type { TmuxClient } from '../tmux/client.js';
import { HEADER_LABEL_OPTION, MANAGED_TITLE_PREFIX } from '../tmux/formats.js';

export interface AcquireOptions {
  /** Explicit pane target (%id | session:win.pane | managed-pane name). */
  pane?: string;
  /** Friendly name for a managed pane (used in title and future targeting). */
  name?: string;
  /** Working directory; every created pane is anchored here via -c. */
  cwd?: string;
  /** The command about to run — used to reuse the pane that last ran it, and
   *  to label the pane header. */
  command?: string;
}

export interface AcquiredPane {
  paneId: string;
  created: boolean;
  /** The pane's actual current path (differs from requested cwd on reuse). */
  currentPath: string;
}

interface ManagedPane {
  name: string;
  busy: boolean;
  /** The last command run in this pane (raw, pre-`cd`), for rerun reuse. */
  lastCommand?: string;
}

/**
 * tmux pane-border-format for the header. pane-border-status is a *window*
 * option, so enabling it would otherwise draw a title on every pane in the
 * agent's window — including the human's own editor/shell panes. The
 * conditional renders the reversed label only for panes that carry sidemux's
 * `@smux_label` option (set on every pane it creates); all other panes render
 * an empty border. Keying on the option, not pane_title, keeps the header alive
 * under a shell that rewrites its title on every prompt.
 */
const HEADER_FORMAT = `#{?#{${HEADER_LABEL_OPTION}},#[reverse] #{${HEADER_LABEL_OPTION}} #[default],}`;

/** Trim a command for a one-line pane header. */
function shortCommand(command: string, max = 48): string {
  const oneLine = command.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/**
 * Creates, reuses, and guards tmux panes. Every pane sidemux creates is
 * anchored to an explicit cwd (the agent's working directory by default —
 * never tmux's default-path) and titled "smux:<name>" so humans and
 * list_panes can identify it.
 */
export class PaneAllocator {
  private readonly managed = new Map<string, ManagedPane>();
  private readonly selfPane: string | null;
  private readonly insideTmux: boolean;
  /** The window whose pane-border header sidemux enabled (to restore later). */
  private borderWindow: string | null = null;

  constructor(
    private readonly client: TmuxClient,
    private readonly config: Config,
    env: NodeJS.ProcessEnv = process.env,
    private readonly defaultCwd: string = process.cwd(),
  ) {
    this.selfPane = env.TMUX_PANE ?? null;
    this.insideTmux = Boolean(env.TMUX);
  }

  isManaged(paneId: string): boolean {
    return this.managed.has(paneId);
  }

  /** Every pane id sidemux currently tracks (for bulk teardown). */
  managedPaneIds(): string[] {
    return [...this.managed.keys()];
  }

  managedName(paneId: string): string | null {
    return this.managed.get(paneId)?.name ?? null;
  }

  setBusy(paneId: string, busy: boolean): void {
    const entry = this.managed.get(paneId);
    if (entry) entry.busy = busy;
  }

  /** Forget a managed pane (after kill-pane); restore the header once none remain. */
  async remove(paneId: string): Promise<void> {
    this.managed.delete(paneId);
    if (this.managed.size === 0) await this.restoreHeaderBorder();
  }

  /**
   * Refuse writes to the agent's own pane (feedback-loop footgun) and, when
   * SIDEMUX_MANAGED_ONLY=1, to any pane sidemux did not create.
   */
  guardWrite(paneId: string): void {
    if (this.selfPane && paneId === this.selfPane) {
      throw new Error(
        `refusing to write to ${paneId}: that is the agent's own pane — ` +
          'typing into it would feed keystrokes back to the agent session',
      );
    }
    if (this.config.managedOnly && !this.isManaged(paneId)) {
      throw new Error(
        `refusing to write to ${paneId}: SIDEMUX_MANAGED_ONLY=1 restricts ` +
          'writes to panes sidemux created',
      );
    }
  }

  /** Resolve a name/target/id to a pane, or create a managed pane. */
  async acquire(options: AcquireOptions = {}): Promise<AcquiredPane> {
    const cwd = options.cwd ?? this.defaultCwd;

    if (options.pane) {
      const paneId = await this.resolve(options.pane);
      this.guardWrite(paneId);
      const entry = this.managed.get(paneId);
      if (entry) {
        entry.lastCommand = options.command;
        await this.applyHeader(paneId, entry.name, options.command);
      }
      return { paneId, created: false, currentPath: await this.client.panePath(paneId) };
    }

    const reusable = await this.findReusable(options.name, options.command);
    if (reusable) {
      const entry = this.managed.get(reusable)!;
      if (options.name !== undefined) entry.name = options.name;
      entry.lastCommand = options.command;
      await this.applyHeader(reusable, entry.name, options.command);
      return {
        paneId: reusable,
        created: false,
        currentPath: await this.client.panePath(reusable),
      };
    }

    const paneId = await this.create(cwd);
    const name = options.name ?? paneId.replace('%', 'p');
    this.managed.set(paneId, { name, busy: false, lastCommand: options.command });
    await this.applyHeader(paneId, name, options.command);
    if (this.insideTmux) await this.enableHeaderBorder(paneId);
    return { paneId, created: true, currentPath: cwd };
  }

  /** Label a managed pane with its name, current command, and id. */
  private async applyHeader(paneId: string, name: string, command?: string): Promise<void> {
    const label = command ? `${name} · ${shortCommand(command)} · ${paneId}` : name;
    // pane_title stays the human-readable id (list_panes, tmux's own displays),
    // but the border header reads @smux_label — which only sidemux sets, so it
    // isn't clobbered by a shell that retitles its pane on every prompt.
    await this.client.setPaneTitle(paneId, `${MANAGED_TITLE_PREFIX}${label}`);
    await this.client.setPaneOption(paneId, HEADER_LABEL_OPTION, label);
  }

  /** Turn on tmux's pane-border header for sidemux's window (once). */
  private async enableHeaderBorder(paneId: string): Promise<void> {
    if (!this.config.paneHeader || this.borderWindow) return;
    const window = await this.client.paneWindow(paneId);
    await this.client.setWindowOption(window, 'pane-border-status', 'top');
    await this.client.setWindowOption(window, 'pane-border-format', HEADER_FORMAT);
    this.borderWindow = window;
  }

  /** Undo enableHeaderBorder: clear the window overrides back to the defaults. */
  private async restoreHeaderBorder(): Promise<void> {
    if (!this.borderWindow) return;
    const window = this.borderWindow;
    this.borderWindow = null;
    await this.client.unsetWindowOption(window, 'pane-border-status');
    await this.client.unsetWindowOption(window, 'pane-border-format');
  }

  /** Resolve %id / session:win.pane / managed-pane name to a live %id. */
  async resolve(target: string): Promise<string> {
    for (const [paneId, entry] of this.managed) {
      if (entry.name !== target) continue;
      if (await this.client.paneExists(paneId)) return paneId;
      // Dead pane with this name: forget it and keep scanning — another live
      // pane may share the name (names are reusable, and a pane can die while a
      // duplicate exists), so a dead entry must never shadow a live one.
      this.managed.delete(paneId);
    }
    return this.client.resolveTarget(target);
  }

  /**
   * Pick a pane to reuse. An explicit `name` binds to that named pane only. An
   * unnamed run prefers the idle pane that last ran this same command (so a
   * rerun lands back in its pane), then falls back to any idle managed pane
   * (so a free pane is used instead of spawning a new one).
   */
  private async findReusable(name?: string, command?: string): Promise<string | null> {
    if (!this.config.reusePanes) return null;
    if (name !== undefined) return this.firstIdle((entry) => entry.name === name);
    if (command !== undefined) {
      const sameCommand = await this.firstIdle((entry) => entry.lastCommand === command);
      if (sameCommand) return sameCommand;
    }
    return this.firstIdle(() => true);
  }

  /** First idle, still-alive managed pane matching `match`, pruning dead ones. */
  private async firstIdle(match: (entry: ManagedPane) => boolean): Promise<string | null> {
    for (const [paneId, entry] of this.managed) {
      if (entry.busy) continue;
      if (!match(entry)) continue;
      if (await this.client.paneExists(paneId)) return paneId;
      this.managed.delete(paneId);
    }
    return null;
  }

  /** Most-recently-created live managed pane (the bar), pruning dead entries. */
  private async liveBarPane(): Promise<string | null> {
    let last: string | null = null;
    for (const [paneId] of this.managed) {
      if (await this.client.paneExists(paneId)) last = paneId;
      else this.managed.delete(paneId);
    }
    return last;
  }

  private async create(cwd: string): Promise<string> {
    const shell = this.config.paneShell ?? undefined;

    // A bar already exists (any mode): append a column/row into it — split the
    // last bar pane along the bar so its thickness stays constant as jobs tile.
    const barPane = await this.liveBarPane();
    if (barPane) {
      return this.client.splitWindow(
        cwd,
        barPane,
        '50%',
        shell,
        subdivideDirection(this.config.layout),
      );
    }

    // First bar pane. With the agent's own pane in hand (normal in-tmux launch),
    // anchor a full-span strip beside it so the human sees work live.
    if (this.insideTmux && this.selfPane) {
      return this.client.splitWindow(
        cwd,
        this.selfPane,
        this.config.paneSize,
        shell,
        this.config.layout,
        true,
      );
    }

    // No agent pane to split (the launching client stripped TMUX/TMUX_PANE).
    // Host the bar in its own window: in a human's *attached* session when one
    // is discoverable — so it shows up as a switchable `smux` window — otherwise
    // in the dedicated detached session (headless/CI), created on first use.
    return this.createHostWindow(cwd, shell);
  }

  /** Create the first bar pane as a window when there is no agent pane to split. */
  private async createHostWindow(cwd: string, shell?: string): Promise<string> {
    const session = this.config.sessionName;
    const attached = await this.client.attachedSession();
    if (attached) {
      // Name the window after the session so the human can find it (prefix + w).
      return this.client.newWindow(attached, cwd, shell, session);
    }
    if (await this.client.hasSession(session)) {
      return this.client.newWindow(session, cwd, shell);
    }
    return this.client.newSession(session, cwd, shell);
  }
}
