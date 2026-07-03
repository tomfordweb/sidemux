export type ShellDialect = 'posix' | 'fish';

/** Which side of the agent's pane new panes split toward. */
export type PaneLayout = 'right' | 'left' | 'top' | 'bottom';

export interface Config {
  /** Session name used when sidemux must create a detached session. */
  sessionName: string;
  /** Restrict write operations (run into existing pane, send_keys, kill) to sidemux-managed panes. */
  managedOnly: boolean;
  /** Force a shell dialect for the exit-code sentinel instead of auto-detecting. */
  shell: ShellDialect | null;
  /** tmux socket name (tmux -L). Null = default socket. */
  socketName: string | null;
  /** Hard cap on bytes returned by a single read. */
  maxOutputBytes: number;
  /** Reuse finished managed panes for subsequent runs. */
  reusePanes: boolean;
  /**
   * Shell command for panes sidemux creates. Null = tmux default (the user's
   * login shell). Tests set "sh" to keep oh-my-zsh-style prompts out.
   */
  paneShell: string | null;
  /** Direction created panes split toward relative to the agent's pane. */
  layout: PaneLayout;
  /** Size of created panes: an "NN%" percentage or an integer cell count (tmux -l). */
  paneSize: string;
  /**
   * Show a per-pane header (command + pane id) by enabling tmux's
   * pane-border-status on sidemux's window. Restored when the last managed
   * pane is closed. Default on; SIDEMUX_PANE_HEADER=0 leaves the window as-is.
   */
  paneHeader: boolean;
  /**
   * Auto-destroy a managed pane after a foreground command that exits 0, so
   * successful runs leave no pane behind (failed runs stay for inspection).
   * Off by default; SIDEMUX_CLOSE_ON_SUCCESS=1 turns it on. A per-run
   * `close: true` still forces closing regardless of exit code.
   */
  closeOnSuccess: boolean;
}

const FISH_LIKE = new Set(['fish']);
const POSIX_LIKE = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh']);

const LAYOUTS = new Set<PaneLayout>(['right', 'left', 'top', 'bottom']);

/**
 * Where additional panes are appended within an existing layout bar. They sit
 * side-by-side along the bar — perpendicular to its thickness — so horizontal
 * bars (top/bottom) grow rightward and vertical bars (left/right) grow downward.
 * Reuses the PaneLayout→split-flag mapping by naming the append direction.
 */
export function subdivideDirection(layout: PaneLayout): PaneLayout {
  return layout === 'left' || layout === 'right' ? 'bottom' : 'right';
}

/** True when a string is one of the accepted SIDEMUX_LAYOUT values. */
export function isValidLayout(value: string): value is PaneLayout {
  return LAYOUTS.has(value as PaneLayout);
}

/** True when a string is an accepted SIDEMUX_PANE_SIZE ("NN%" or a cell count). */
export function isValidPaneSize(value: string): boolean {
  return /^\d+%$/.test(value) || /^\d+$/.test(value);
}

/** Parse SIDEMUX_LAYOUT; unknown values warn to stderr and fall back to bottom. */
function parseLayout(raw: string | undefined): PaneLayout {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'bottom';
  if (isValidLayout(value)) return value;
  console.error(
    `sidemux: ignoring invalid SIDEMUX_LAYOUT="${raw}" (use right|left|top|bottom); using bottom`,
  );
  return 'bottom';
}

/** Parse SIDEMUX_PANE_SIZE; accepts "NN%" or an integer cell count. */
function parsePaneSize(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return '30%';
  if (isValidPaneSize(value)) return value;
  console.error(
    `sidemux: ignoring invalid SIDEMUX_PANE_SIZE="${raw}" (use "30%" or a cell count); using 30%`,
  );
  return '30%';
}

export function shellDialectFromCommand(command: string): ShellDialect | null {
  const name = command.split('/').pop() ?? command;
  if (FISH_LIKE.has(name)) return 'fish';
  if (POSIX_LIKE.has(name)) return 'posix';
  return null;
}

export function isKnownShell(command: string): boolean {
  return shellDialectFromCommand(command) !== null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const shellRaw = env.SIDEMUX_SHELL?.trim().toLowerCase() ?? '';
  let shell: ShellDialect | null = null;
  if (shellRaw === 'fish') shell = 'fish';
  else if (shellRaw !== '') shell = 'posix';

  const maxBytes = Number.parseInt(env.SIDEMUX_MAX_OUTPUT_BYTES ?? '', 10);

  return {
    sessionName: env.SIDEMUX_SESSION?.trim() || 'smux',
    managedOnly: env.SIDEMUX_MANAGED_ONLY === '1',
    shell,
    socketName: env.SIDEMUX_TMUX_SOCKET?.trim() || null,
    maxOutputBytes: Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 8192,
    reusePanes: env.SIDEMUX_REUSE_PANES !== '0',
    paneShell: env.SIDEMUX_PANE_SHELL?.trim() || null,
    layout: parseLayout(env.SIDEMUX_LAYOUT),
    paneSize: parsePaneSize(env.SIDEMUX_PANE_SIZE),
    paneHeader: env.SIDEMUX_PANE_HEADER !== '0',
    closeOnSuccess: env.SIDEMUX_CLOSE_ON_SUCCESS === '1',
  };
}
