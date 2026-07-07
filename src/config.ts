import { createHash } from "node:crypto";
import { basename } from "node:path";
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
  /** Stable owner id for this MCP server/agent session. */
  agentId: string;
  /** Short owner id used in tmux window names. */
  agentLabel: string;
}

const FISH_LIKE = new Set(["fish"]);
const POSIX_LIKE = new Set(["bash", "zsh", "sh", "dash", "ksh"]);

const DASHBOARD_DENSITIES = new Set<DashboardDensity>([
  "compact",
  "normal",
  "spacious",
]);

export const DEFAULT_IDLE_PANE_TTL_MS = 15 * 60 * 1000;

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
 * Human label for the workspace window. A cwd-derived agent id is an opaque
 * hash, so label those by the project directory's name instead; explicit ids
 * (SIDEMUX_AGENT_ID et al.) keep the id-based short label.
 */
function agentLabelFor(agentId: string, cwd: string): string {
  if (/^cwd-[0-9a-f]{8}$/.test(agentId)) {
    const dir = basename(cwd)
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 12);
    if (dir) {
      return dir;
    }
  }
  return shortAgentLabel(agentId);
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

export function shellDialectFromCommand(command: string): ShellDialect | null {
  const name = command.split("/").pop() ?? command;
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
    agentId,
    agentLabel: agentLabelFor(agentId, defaultCwd),
  };
}
