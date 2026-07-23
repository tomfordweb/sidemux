import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileConfig } from "./config-file.js";

export type ShellDialect = "posix" | "fish";

/** Dashboard spacing mode. */
export type DashboardDensity = "compact" | "normal" | "spacious";

export interface Config {
  /** Session name hosting the sidemux workspace (one window per agent). */
  sessionName: string;
  /** Install tmux affordances for the sidemux workspace when supported. */
  keybinds: boolean;
  /** tmux key, after prefix, used to open the sidemux workspace chooser. */
  dashboardKey: string;
  /** Presentation density for the hand-rendered dashboard. */
  dashboardDensity: DashboardDensity;
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
  /** How long an idle one-shot pane survives before garbage collection. */
  idlePaneTtlMs: number;
  /**
   * Directory holding per-job output log files (tmux pipe-pane tees every
   * job's full output here, immune to the pane's history-limit). Null
   * disables per-job logging entirely — nothing is written to disk.
   */
  logDir: string | null;
  /** Job logs older than this are pruned. 0 or less disables age pruning. */
  logMaxAgeMs: number;
  /**
   * Total byte budget for the log directory; oldest logs are evicted until
   * the directory fits. 0 or less disables the size cap.
   */
  logMaxTotalBytes: number;
  /** Stable owner id for this MCP server/agent session. */
  agentId: string;
  /** Short owner id used in tmux window names. */
  agentLabel: string;
}

const FISH_LIKE = new Set(["fish"]);
const POSIX_LIKE = new Set([
  "bash",
  "zsh",
  "sh",
  "dash",
  "ksh",
  "ksh93",
  "mksh",
  "yash",
  "posh",
  "ash",
  "busybox",
]);

/**
 * Shells that cannot run sidemux's launch line at all, mapped to the reason.
 *
 * The line is `<command>; printf '\n<<SMUX:id:%d>>\n' $?`. csh-family shells
 * parse `$?` as "is this variable set" and reject the pipefail prefix outright
 * ("Badly placed ()'s"); the newer non-POSIX shells reject the `$?`/quoting
 * syntax for their own reasons. Either way nothing evaluates and no sentinel
 * is ever printed, so the job would sit "running" until its timeout — forever
 * for a background job. Refusing up front turns a silent hang into an error.
 */
const INCOMPATIBLE_SHELLS = new Map([
  ["csh", "csh reads `$?` as a variable-existence test, not an exit status"],
  ["tcsh", "tcsh reads `$?` as a variable-existence test, not an exit status"],
  ["nu", "nushell does not support POSIX `$?` exit-status expansion"],
  ["nushell", "nushell does not support POSIX `$?` exit-status expansion"],
  ["xonsh", "xonsh does not support POSIX `$?` exit-status expansion"],
  ["elvish", "elvish does not support POSIX `$?` exit-status expansion"],
]);

const DASHBOARD_DENSITIES = new Set<DashboardDensity>([
  "compact",
  "normal",
  "spacious",
]);

export const DEFAULT_IDLE_PANE_TTL_MS = 15 * 60 * 1000;

/** Job logs survive a week by default — long enough to outlive a work session. */
export const DEFAULT_LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Default disk budget for job logs. Age alone does not bound the directory:
 * a single chatty job can write gigabytes in minutes, so the size cap is what
 * actually keeps the state dir from eating the disk.
 */
export const DEFAULT_LOG_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/** Parse SIDEMUX_DASHBOARD_DENSITY; unknown values warn and fall back to normal. */
function parseDashboardDensity(raw: string | undefined): DashboardDensity {
  const value = raw?.trim().toLowerCase();
  if (!value) {
    return "normal";
  }
  if (DASHBOARD_DENSITIES.has(value as DashboardDensity)) {
    return value as DashboardDensity;
  }
  console.error(
    `sidemux: ignoring invalid SIDEMUX_DASHBOARD_DENSITY="${raw}" (use compact|normal|spacious); using normal`,
  );
  return "normal";
}

function shortAgentLabel(agentId: string): string {
  const clean = agentId
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const uuidPrefix = /^[0-9a-fA-F]{8}(?=-)/.exec(clean)?.[0];
  return (uuidPrefix ?? clean).slice(0, 12) || `pid-${String(process.pid)}`;
}

/**
 * Stable owner id for this server. Explicit env ids win; the default derives
 * from the server's working directory, so restarting the MCP server in the
 * same project reclaims the panes the previous process created (a pid-based
 * id would orphan them all on every restart).
 */
function parseAgentId(env: NodeJS.ProcessEnv, defaultCwd: string): string {
  const explicit = env.SIDEMUX_AGENT_ID?.trim() || env.CODEX_THREAD_ID?.trim();
  if (explicit) {
    return explicit;
  }
  const hash = createHash("sha256")
    .update(defaultCwd)
    .digest("hex")
    .slice(0, 8);
  return `cwd-${hash}`;
}

/** Values that turn per-job logging off rather than naming a directory. */
const LOG_DIR_OFF = new Set(["off", "0", "false", "none", "disabled"]);

/**
 * Interpret one log-dir setting: a directory path, `null` for "logging off",
 * or `undefined` for "not set, fall through to the next layer". An empty
 * string counts as unset so `SIDEMUX_LOG_DIR=` behaves like every other
 * env var here; use `off` to actually disable logging.
 */
function normalizeLogDir(raw: string | undefined): string | null | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  return LOG_DIR_OFF.has(value.toLowerCase()) ? null : value;
}

/**
 * Where per-job log files live. SIDEMUX_LOG_DIR wins, then the config file,
 * then the XDG state dir (`~/.local/state/sidemux/logs`) — logs are runtime
 * state, not config. Either layer may say `off` to disable logging outright,
 * for callers who would rather not have command output on disk at all.
 */
function parseLogDir(env: NodeJS.ProcessEnv, file: FileConfig): string | null {
  const fromEnv = normalizeLogDir(env.SIDEMUX_LOG_DIR);
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const fromFile = normalizeLogDir(file.logDir);
  if (fromFile !== undefined) {
    return fromFile;
  }
  const stateHome =
    env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(stateHome, "sidemux", "logs");
}

/**
 * Numeric setting with env > file > default precedence. Negative values are
 * clamped to 0, which every log-retention knob reads as "no limit".
 */
function parseRetention(
  raw: string | undefined,
  fileValue: number | undefined,
  fallback: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (Number.isFinite(parsed)) {
    return Math.max(0, parsed);
  }
  return fileValue !== undefined ? Math.max(0, fileValue) : fallback;
}

/** Bare shell name: strips any path, and the `-` a login shell prepends. */
function shellName(command: string): string {
  return (command.split("/").pop() ?? command).replace(/^-/, "");
}

export function shellDialectFromCommand(command: string): ShellDialect | null {
  const name = shellName(command);
  if (FISH_LIKE.has(name)) {
    return "fish";
  }
  if (POSIX_LIKE.has(name)) {
    return "posix";
  }
  return null;
}

export function isKnownShell(command: string): boolean {
  return shellDialectFromCommand(command) !== null;
}

/**
 * Why this shell cannot run the launch line, or null if it can (or if it is
 * simply unrecognized — an unknown foreground command is usually a wrapper or
 * a running program, and POSIX stays the safe default for those).
 */
export function incompatibleShellReason(command: string): string | null {
  return INCOMPATIBLE_SHELLS.get(shellName(command)) ?? null;
}

/**
 * Resolve the effective configuration. Precedence, lowest to highest:
 * built-in defaults < global config file (`~/.config/sidemux/config.toml`,
 * passed in as `file`) < environment variables. Env stays authoritative so
 * existing per-project MCP env blocks keep working unchanged.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  defaultCwd: string = process.cwd(),
  file: FileConfig = {},
): Config {
  const shellRaw = (env.SIDEMUX_SHELL ?? file.shell ?? "").trim().toLowerCase();
  let shell: ShellDialect | null = null;
  if (shellRaw === "fish") {
    shell = "fish";
  } else if (shellRaw !== "") {
    shell = "posix";
  }

  const maxBytes = Number.parseInt(env.SIDEMUX_MAX_OUTPUT_BYTES ?? "", 10);
  const idleTtl = Number.parseInt(env.SIDEMUX_IDLE_PANE_TTL_MS ?? "", 10);
  const fileTtl = file.idlePaneTtlMs;
  const agentId = parseAgentId(env, defaultCwd);

  const boolSetting = (
    raw: string | undefined,
    fileValue: boolean | undefined,
    fallback: boolean,
    truthy: (value: string) => boolean,
  ): boolean => {
    if (raw !== undefined) {
      return truthy(raw);
    }
    return fileValue ?? fallback;
  };

  return {
    sessionName: env.SIDEMUX_SESSION?.trim() || file.session?.trim() || "smux",
    keybinds: boolSetting(
      env.SIDEMUX_KEYBINDS,
      file.keybinds,
      true,
      (v) => v !== "0",
    ),
    dashboardKey:
      env.SIDEMUX_DASHBOARD_KEY?.trim() || file.dashboardKey?.trim() || "e",
    dashboardDensity: parseDashboardDensity(
      env.SIDEMUX_DASHBOARD_DENSITY ?? file.dashboardDensity,
    ),
    managedOnly: boolSetting(
      env.SIDEMUX_MANAGED_ONLY,
      file.managedOnly,
      false,
      (v) => v === "1",
    ),
    shell,
    socketName: env.SIDEMUX_TMUX_SOCKET?.trim() || file.socket?.trim() || null,
    maxOutputBytes:
      Number.isFinite(maxBytes) && maxBytes > 0
        ? maxBytes
        : (file.maxOutputBytes ?? 8192),
    reusePanes: boolSetting(
      env.SIDEMUX_REUSE_PANES,
      file.reusePanes,
      true,
      (v) => v !== "0",
    ),
    paneShell: env.SIDEMUX_PANE_SHELL?.trim() || file.paneShell?.trim() || null,
    paneHeader: boolSetting(
      env.SIDEMUX_PANE_HEADER,
      file.paneHeader,
      true,
      (v) => v !== "0",
    ),
    closeOnSuccess: boolSetting(
      env.SIDEMUX_CLOSE_ON_SUCCESS,
      file.closeOnSuccess,
      false,
      (v) => v === "1",
    ),
    idlePaneTtlMs:
      Number.isFinite(idleTtl) && idleTtl >= 0
        ? idleTtl
        : fileTtl !== undefined && fileTtl >= 0
          ? fileTtl
          : DEFAULT_IDLE_PANE_TTL_MS,
    logDir: parseLogDir(env, file),
    logMaxAgeMs: parseRetention(
      env.SIDEMUX_LOG_MAX_AGE_MS,
      file.logMaxAgeMs,
      DEFAULT_LOG_MAX_AGE_MS,
    ),
    logMaxTotalBytes: parseRetention(
      env.SIDEMUX_LOG_MAX_TOTAL_BYTES,
      file.logMaxTotalBytes,
      DEFAULT_LOG_MAX_TOTAL_BYTES,
    ),
    agentId,
    agentLabel: shortAgentLabel(agentId),
  };
}
