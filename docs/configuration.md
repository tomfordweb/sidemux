# Configuration reference

Everything in sidemux is optional and layered. Settings come from three
sources; when the same setting appears in more than one, the higher layer
wins:

```
built-in defaults  <  global config file  <  environment variables
```

Environment variables stay authoritative so existing per-project MCP `env`
blocks keep working unchanged. A malformed config file warns to stderr and is
ignored — it is never fatal. Unknown keys in the global file warn and are
ignored individually.

There are **two files with two distinct concerns**:

| File                            | Scope             | Holds                                                               |
| ------------------------------- | ----------------- | ------------------------------------------------------------------- |
| `~/.config/sidemux/config.toml` | Global (per user) | Personal settings — session name, dashboard key/density, TTLs, caps |
| `./.sidemux.toml`               | Per project       | **Named scripts only** (a `[scripts]` table); no settings live here |

## Global file: `~/.config/sidemux/config.toml`

The location honors `$XDG_CONFIG_HOME` (i.e.
`$XDG_CONFIG_HOME/sidemux/config.toml` when set). `sidemux init` (interactive,
on a TTY) offers to scaffold this file with a fully commented template.

Every key, its environment-variable equivalent, and its default:

| Key                     | Type    | Env var                               | Default           | Meaning                                                                                               |
| ----------------------- | ------- | ------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------- |
| `session`               | string  | `SIDEMUX_SESSION`                     | `"smux"`          | Name of the tmux session hosting the sidemux workspace (one window per agent)                         |
| `socket`                | string  | `SIDEMUX_TMUX_SOCKET`                 | default socket    | tmux socket name, as in `tmux -L <socket>`                                                            |
| `keybinds`              | bool    | `SIDEMUX_KEYBINDS` (`0` = off)        | `true`            | Install the `Prefix+<key>` dashboard keybind when a tmux client is attached                           |
| `reuse_panes`           | bool    | `SIDEMUX_REUSE_PANES` (`0` = off)     | `true`            | Reuse the idle pane that last ran the same command (strict affinity); off = new pane per run          |
| `pane_shell`            | string  | `SIDEMUX_PANE_SHELL`                  | login shell       | Shell command for panes sidemux creates (e.g. `"sh"`); empty = tmux default                           |
| `pane_header`           | bool    | `SIDEMUX_PANE_HEADER` (`0` = off)     | `true`            | Show a `command · %id` header on sidemux panes (tmux pane border)                                     |
| `close_on_success`      | bool    | `SIDEMUX_CLOSE_ON_SUCCESS` (`1` = on) | `false`           | Auto-close a pane after its foreground command exits `0` (failed panes stay up)                       |
| `idle_pane_ttl_ms`      | int ≥ 0 | `SIDEMUX_IDLE_PANE_TTL_MS`            | `900000` (15 min) | How long an idle finished one-shot pane survives before garbage collection                            |
| `max_output_bytes`      | int > 0 | `SIDEMUX_MAX_OUTPUT_BYTES`            | `8192`            | Hard cap on bytes returned by a single `read`                                                         |
| `log_dir`               | string  | `SIDEMUX_LOG_DIR`                     | XDG state dir     | Directory for per-job full-output logs; `"off"` disables job logging entirely                         |
| `log_max_age_ms`        | int ≥ 0 | `SIDEMUX_LOG_MAX_AGE_MS`              | `604800000` (7 d) | How long a job log survives before pruning; `0` = never prune by age                                  |
| `log_max_total_bytes`   | int ≥ 0 | `SIDEMUX_LOG_MAX_TOTAL_BYTES`         | `268435456` (256 MiB) | Disk budget for the log directory, oldest logs evicted first; `0` = no size cap                   |
| `managed_only`          | bool    | `SIDEMUX_MANAGED_ONLY` (`1` = on)     | `false`           | Restrict write operations (`run` into an existing pane, `send_keys`, `kill`) to sidemux-created panes |
| `shell`                 | string  | `SIDEMUX_SHELL`                       | auto-detect       | Force the exit-sentinel dialect: `"fish"`, or any other value for POSIX                               |
| `[dashboard]` `key`     | string  | `SIDEMUX_DASHBOARD_KEY`               | `"e"`             | Key after the tmux prefix that opens the workspace dashboard popup                                    |
| `[dashboard]` `density` | string  | `SIDEMUX_DASHBOARD_DENSITY`           | `"normal"`        | Dashboard spacing: `compact` \| `normal` \| `spacious`                                                |

Example:

```toml
# ~/.config/sidemux/config.toml
session = "smux"
reuse_panes = true
idle_pane_ttl_ms = 900000
managed_only = false

[dashboard]
key = "e"
density = "normal"
```

Not in the file: `SIDEMUX_AGENT_ID` (and its fallback `CODEX_THREAD_ID`) is
env-only, because an owner id is inherently per agent session, not a personal
preference. When neither is set, the id is a stable hash of the server's
working directory (`cwd-<8hex>`), so restarting the MCP server in the same
project reclaims the panes the previous process created.

## Project file: `./.sidemux.toml`

Found by walking **up** from the MCP server's working directory (like
`.mcp.json` discovery), so it works from any subdirectory of the project. It
holds exactly one thing — a `[scripts]` table of named commands. No settings
belong here.

Two value forms:

```toml
[scripts]
# 1. Plain string — a foreground one-shot command
lint = "nx run *:lint"
test = "pnpm test"

# 2. Table — when you need the background flag (dev servers, watchers)
dev = { command = "pnpm dev", background = true }
```

How scripts behave:

- **Resolution.** `run { command: "lint" }` first checks the scripts table; a
  match runs the script's command instead of treating `lint` as raw shell.
  Non-matching commands pass through unchanged.
- **Glob passthrough.** Commands are opaque strings handed to the shell — a
  `*` in `nx run *:lint` is passed through untouched for the tool (here Nx) to
  expand; sidemux does no globbing of its own.
- **Pane naming.** A resolved script names its pane after the script
  (`lint`, `dev`, …), so reruns of the script land back in the same pane via
  named-pane affinity, and the pane header shows a recognizable label.
- **Background flag.** `background = true` makes the run behave as if the
  agent had passed `background: true`: the pane is persistent (never
  garbage-collected) and is meant to be watched with `wait`/`read` and ended
  with `kill`.
- **`sidemux init` integration.** Script entries are offered as delegation
  candidates alongside `package.json` scripts, Makefile targets, etc. — see
  [setup-delegation.md](./setup-delegation.md).

A missing or malformed `.sidemux.toml` simply means no scripts.

## Environment variables

The complete set, for MCP `env` blocks (highest-precedence layer):

| Variable                    | Default     | Meaning                                                                                         |
| --------------------------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `SIDEMUX_SESSION`           | `smux`      | Workspace session name                                                                          |
| `SIDEMUX_AGENT_ID`          | auto        | Owner id for this agent session; falls back to `CODEX_THREAD_ID`, then a hash of the server cwd |
| `SIDEMUX_KEYBINDS`          | on          | `0` disables the dashboard keybind                                                              |
| `SIDEMUX_DASHBOARD_KEY`     | `e`         | Prefix key that opens the dashboard popup                                                       |
| `SIDEMUX_DASHBOARD_DENSITY` | `normal`    | `compact` \| `normal` \| `spacious`                                                             |
| `SIDEMUX_MANAGED_ONLY`      | off         | `1` restricts writes to sidemux-created panes                                                   |
| `SIDEMUX_SHELL`             | auto        | Force sentinel dialect (`fish` or anything POSIX)                                               |
| `SIDEMUX_TMUX_SOCKET`       | default     | tmux `-L` socket name                                                                           |
| `SIDEMUX_MAX_OUTPUT_BYTES`  | `8192`      | Hard cap on read sizes                                                                          |
| `SIDEMUX_REUSE_PANES`       | on          | `0` = new pane per run (disables strict-affinity reuse)                                         |
| `SIDEMUX_PANE_SHELL`        | login shell | Shell command for created panes                                                                 |
| `SIDEMUX_PANE_HEADER`       | on          | `0` hides the per-pane header                                                                   |
| `SIDEMUX_CLOSE_ON_SUCCESS`  | off         | `1` auto-closes panes after exit `0`                                                            |
| `SIDEMUX_IDLE_PANE_TTL_MS`  | `900000`    | Idle-pane garbage-collection TTL in ms                                                          |
| `SIDEMUX_LOG_DIR`           | XDG state   | Directory for per-job full-output log files (default `$XDG_STATE_HOME/sidemux/logs`, i.e. `~/.local/state/sidemux/logs`); `off` disables job logging |
| `SIDEMUX_LOG_MAX_AGE_MS`    | `604800000` | Job-log retention in ms (7 days); `0` = never prune by age                                      |
| `SIDEMUX_LOG_MAX_TOTAL_BYTES` | `268435456` | Disk budget for the log dir (256 MiB), oldest evicted first; `0` = no size cap                 |

Rule of thumb: put personal, machine-wide preferences in the global file; use
env vars only for per-project or per-client overrides.
