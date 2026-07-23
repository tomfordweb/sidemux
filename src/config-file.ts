/**
 * Layered file configuration.
 *
 * Two files, two concerns:
 *  - Global `~/.config/sidemux/config.toml` ($XDG_CONFIG_HOME respected):
 *    personal settings — dashboard key/density, session name, TTLs. Applies to
 *    every project so MCP entries don't need per-project env blocks.
 *  - Project `.sidemux.toml` (found by walking up from the server's cwd):
 *    NAMED SCRIPTS ONLY. `run { command: "lint" }` resolves the script before
 *    the command is treated as raw shell. No settings live here.
 *
 * Precedence: built-in defaults < global file < environment variables.
 * A malformed file warns to stderr and is ignored — never fatal.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { errorMessage } from "./core/shared.js";

/** Settings the global config file may provide (all optional). */
export interface FileConfig {
  session?: string | undefined;
  socket?: string | undefined;
  keybinds?: boolean | undefined;
  reusePanes?: boolean | undefined;
  paneShell?: string | undefined;
  paneHeader?: boolean | undefined;
  closeOnSuccess?: boolean | undefined;
  idlePaneTtlMs?: number | undefined;
  maxOutputBytes?: number | undefined;
  /** Directory for per-job logs, or "off" to disable them. */
  logDir?: string | undefined;
  logMaxAgeMs?: number | undefined;
  logMaxTotalBytes?: number | undefined;
  managedOnly?: boolean | undefined;
  shell?: string | undefined;
  dashboardKey?: string | undefined;
  dashboardDensity?: string | undefined;
}

/** One entry in a project's `[scripts]` table. */
export interface ProjectScript {
  name: string;
  command: string;
  /** Launch as a background job (dev servers, watchers). */
  background: boolean;
}

const globalSchema = z
  .object({
    session: z.string().optional(),
    socket: z.string().optional(),
    keybinds: z.boolean().optional(),
    reuse_panes: z.boolean().optional(),
    pane_shell: z.string().optional(),
    pane_header: z.boolean().optional(),
    close_on_success: z.boolean().optional(),
    idle_pane_ttl_ms: z.number().int().nonnegative().optional(),
    max_output_bytes: z.number().int().positive().optional(),
    log_dir: z.string().optional(),
    log_max_age_ms: z.number().int().nonnegative().optional(),
    log_max_total_bytes: z.number().int().nonnegative().optional(),
    managed_only: z.boolean().optional(),
    shell: z.string().optional(),
    dashboard: z
      .object({
        key: z.string().optional(),
        density: z.string().optional(),
      })
      .optional(),
  })
  .passthrough();

const scriptValueSchema = z.union([
  z.string(),
  z
    .object({
      command: z.string(),
      background: z.boolean().optional(),
    })
    .passthrough(),
]);

const projectSchema = z
  .object({ scripts: z.record(scriptValueSchema).optional() })
  .passthrough();

const KNOWN_GLOBAL_KEYS = new Set([
  "session",
  "socket",
  "keybinds",
  "reuse_panes",
  "pane_shell",
  "pane_header",
  "close_on_success",
  "idle_pane_ttl_ms",
  "max_output_bytes",
  "log_dir",
  "log_max_age_ms",
  "log_max_total_bytes",
  "managed_only",
  "shell",
  "dashboard",
]);

/** Path of the global config file, honoring $XDG_CONFIG_HOME. */
export function globalConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "sidemux", "config.toml");
}

function readTomlFile(path: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null; // absent file = no config; never an error
  }
  try {
    return parseToml(text);
  } catch (error) {
    console.error(
      `sidemux: ignoring malformed ${path}: ${errorMessage(error)}`,
    );
    return null;
  }
}

/**
 * Load `~/.config/sidemux/config.toml`. Unknown keys warn and are ignored;
 * a type-invalid file warns and is ignored entirely (env/defaults still apply).
 */
export function loadGlobalFileConfig(
  env: NodeJS.ProcessEnv = process.env,
): FileConfig {
  const path = globalConfigPath(env);
  const raw = readTomlFile(path);
  if (!raw) {
    return {};
  }
  const parsed = globalSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(
      `sidemux: ignoring invalid ${path}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
    return {};
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_GLOBAL_KEYS.has(key)) {
      console.error(`sidemux: unknown key "${key}" in ${path} (ignored)`);
    }
  }
  const data = parsed.data;
  return {
    session: data.session,
    socket: data.socket,
    keybinds: data.keybinds,
    reusePanes: data.reuse_panes,
    paneShell: data.pane_shell,
    paneHeader: data.pane_header,
    closeOnSuccess: data.close_on_success,
    idlePaneTtlMs: data.idle_pane_ttl_ms,
    maxOutputBytes: data.max_output_bytes,
    logDir: data.log_dir,
    logMaxAgeMs: data.log_max_age_ms,
    logMaxTotalBytes: data.log_max_total_bytes,
    managedOnly: data.managed_only,
    shell: data.shell,
    dashboardKey: data.dashboard?.key,
    dashboardDensity: data.dashboard?.density,
  };
}

/**
 * Find `.sidemux.toml` by walking up from `startDir` (like `.mcp.json`
 * discovery) and return its `[scripts]` table. Missing or malformed file =
 * empty map. Script values are either a plain command string or
 * `{ command, background }` for long-running jobs.
 */
export function loadProjectScripts(
  startDir: string,
): Map<string, ProjectScript> {
  const scripts = new Map<string, ProjectScript>();
  let dir = resolve(startDir);
  for (;;) {
    const path = join(dir, ".sidemux.toml");
    const raw = readTomlFile(path);
    if (raw) {
      const parsed = projectSchema.safeParse(raw);
      if (!parsed.success) {
        console.error(
          `sidemux: ignoring invalid ${path}: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        );
        return scripts;
      }
      for (const [name, value] of Object.entries(parsed.data.scripts ?? {})) {
        if (typeof value === "string") {
          scripts.set(name, { name, command: value, background: false });
        } else {
          scripts.set(name, {
            name,
            command: value.command,
            background: value.background ?? false,
          });
        }
      }
      return scripts;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return scripts;
    }
    dir = parent;
  }
}

/** Commented scaffold written by `sidemux init` when the user opts in. */
export function globalConfigTemplate(): string {
  return `# sidemux global configuration (~/.config/sidemux/config.toml)
# Every key is optional; environment variables still win over this file.
# See https://github.com/tomfordweb/sidemux/blob/main/docs/configuration.md

# Workspace tmux session name (SIDEMUX_SESSION)
#session = "smux"

# tmux socket name, as in \`tmux -L <socket>\` (SIDEMUX_TMUX_SOCKET)
#socket = ""

# Install the Prefix+<key> dashboard keybind (SIDEMUX_KEYBINDS=0 to disable)
#keybinds = true

# Reuse the pane that last ran the same command (SIDEMUX_REUSE_PANES=0 to disable)
#reuse_panes = true

# Shell for created panes; empty = your login shell (SIDEMUX_PANE_SHELL)
#pane_shell = ""

# Per-pane header showing command + pane id (SIDEMUX_PANE_HEADER=0 to disable)
#pane_header = true

# Auto-close a pane after its command exits 0 (SIDEMUX_CLOSE_ON_SUCCESS=1)
#close_on_success = false

# How long an idle finished pane survives before garbage collection, in ms
# (SIDEMUX_IDLE_PANE_TTL_MS; default 15 minutes)
#idle_pane_ttl_ms = 900000

# Hard cap on bytes returned by a single read (SIDEMUX_MAX_OUTPUT_BYTES)
#max_output_bytes = 8192

# Where per-job full-output logs are written (SIDEMUX_LOG_DIR).
# Empty = $XDG_STATE_HOME/sidemux/logs; "off" disables job logging entirely.
#log_dir = ""

# How long a job log survives, in ms; 0 = never prune by age
# (SIDEMUX_LOG_MAX_AGE_MS; default 7 days)
#log_max_age_ms = 604800000

# Disk budget for the log directory, in bytes; oldest logs are evicted first,
# 0 = no size cap (SIDEMUX_LOG_MAX_TOTAL_BYTES; default 256 MiB)
#log_max_total_bytes = 268435456

# Restrict writes to panes sidemux created (SIDEMUX_MANAGED_ONLY=1)
#managed_only = false

[dashboard]
# Key after tmux prefix that opens the workspace dashboard (SIDEMUX_DASHBOARD_KEY)
#key = "e"
# Dashboard spacing: compact | normal | spacious (SIDEMUX_DASHBOARD_DENSITY)
#density = "normal"
`;
}
