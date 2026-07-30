# Stop letting your AI agent babysit terminals.

`sidemux` is an MCP server that delegates token-heavy commands to live tmux
panes in a dedicated workspace session. AI coding agents get an efficient
`run` / `wait` / `read` loop instead of a terminal dump, with measured token
reductions of up to **98.9%** on real projects.

![sidemux demo: an agent runs build/test/dev through tmux panes while ingesting only a compact tail](assets/demo.gif)

Modern coding agents pay for terminal output twice: once in tokens, and again
in degraded context quality. sidemux moves that output out of the model's
context and into a tmux pane you can watch live. The agent gets back an exit
code and a short tail. The full log stays available on demand, filtered and
byte-capped, and reads are incremental.

It works with any stdio MCP client: Claude Code, Codex, OpenCode, and anything
else that speaks the protocol.

## The problem

Agents burn a lot of tokens supervising long-running commands. Two failure
modes are typical:

1. The agent runs `npm build` inline, and its context ingests the entire
   output: every progress bar, every warning, every line of noise.
2. The agent starts the command in a pane and then _polls_: capture pane,
   "still running", capture pane, "still running", and on. Each poll is a full
   model turn, and each capture dumps the whole terminal back into context.

Either way the agent spends context, its most valuable resource, on output it
almost never needs.

## What sidemux does instead

| Step                     | Tool call                                                           | Tokens spent                                                  |
| ------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| Start the build          | `run {command: "pnpm build"}`                                       | one call; a pane appears in the `smux` workspace, in your cwd |
| Wait for it              | _(none: `run` blocks server-side)_                                  | zero polling turns                                            |
| It succeeded             | _(nothing: `run` already returned the exit code + a 10-line tail)_  | zero                                                          |
| It failed                | `read {grep: "error\|FAIL", context: 3}`                            | only the error lines                                          |
| Check a dev server later | `read {since: "last-read"}`                                         | only the log lines that are new since the last look           |

The waiting happens inside the MCP server, not in the model loop. It is a
local process polling tmux with adaptive backoff. Reads are incremental too: a
per-pane cursor tracks what the agent has already seen, so no output is ever
sent twice.

## Measured token savings

These are not synthetic numbers. `sidemux benchmark` runs **your project's own
commands** twice. The first run is inline, capturing full stdout and stderr,
exactly what a Bash tool call injects into an agent's context. The second goes
through the sidemux server over real MCP stdio. It then reports the estimated
tokens an agent ingests each way:

```bash
sidemux benchmark --command "pnpm test" --command "pnpm build"
```

For long-running builds or Playwright suites, increase the per-command timeout:

```bash
SIDEMUX_BENCH_TIMEOUT_MS=1800000 sidemux benchmark --command "pnpm e2e"
```

There are two separate timeout layers. `timeout_ms` controls how long sidemux
lets the command run in tmux. Your MCP client also has its own request timeout;
if that client kills tool calls after 60 seconds, it must allow longer requests
or reset its timeout when sidemux sends progress notifications. The benchmark
CLI exposes both layers through `SIDEMUX_BENCH_TIMEOUT_MS` and
`SIDEMUX_BENCH_REQUEST_TIMEOUT_MS`.

On this repository (`pnpm bench`), a small and quiet test suite:

| Command          |  Inline | sidemux | Reduction |
| ---------------- | ------: | ------: | --------: |
| `pnpm test`      | 673 tok | 123 tok |    **5×** |
| `pnpm typecheck` |   4 tok |  36 tok |         — |
| `pnpm build`     |  71 tok |  90 tok |         — |

On a mid-size Angular/Vite app in an Nx monorepo, **97.3% saved overall**:

| Command                 |     Inline | sidemux | Reduction |
| ----------------------- | ---------: | ------: | --------: |
| `pnpm nx run app:test`  |  1,904 tok | 127 tok |   **15×** |
| `pnpm nx run app:build` | 11,210 tok | 113 tok |   **99×** |
| `pnpm nx run app:lint`  |     61 tok | 119 tok |         — |

On six anonymized targets from a larger Nx monorepo (Astro SSR and static
sites, an Analog/Vite app, and an Angular app, all run with the Nx cache
disabled), **98.1% saved overall**:

| Target                                  |     Inline | sidemux | Reduction |
| --------------------------------------- | ---------: | ------: | --------: |
| Verbose Astro content site build        | 32,589 tok | 132 tok |  **247×** |
| Small Astro static site build           |    334 tok | 124 tok |    **3×** |
| Astro data-heavy static site build      |    504 tok | 123 tok |    **4×** |
| Astro content-commerce site build       |    557 tok | 122 tok |    **5×** |
| Analog/Vite SSR app build               |  2,547 tok | 114 tok |   **22×** |
| Angular app build with asset generation |  2,089 tok | 126 tok |   **17×** |

On five anonymized headless Playwright E2E targets from the same monorepo,
**98.9% saved overall**. Each target builds its app first, then runs browser
tests:

| Target                           |     Inline | sidemux | Reduction |
| -------------------------------- | ---------: | ------: | --------: |
| Verbose Astro E2E suite          | 33,042 tok |  90 tok |  **369×** |
| Small Astro E2E suite            |  1,628 tok |  90 tok |   **18×** |
| Data-heavy Astro E2E suite       |  1,790 tok |  90 tok |   **20×** |
| Content-commerce Astro E2E suite |  2,044 tok |  90 tok |   **23×** |
| Angular app E2E suite            |  3,557 tok |  90 tok |   **40×** |

Savings scale with output volume. Chatty commands like test suites, verbose
builds and dev-server logs collapse to an exit code plus a 10-line tail. Quiet
commands have nothing to save, and the rows with no reduction cost slightly
_more_ than inline because of the tool-result envelope. Tokens are estimated as
chars ÷ 4. The benchmark runs on a throwaway tmux socket, never your real tmux
server.

## Tools

Eight tools cover the lifecycle and status of delegated commands:

| Tool         | What it does                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`        | Runs a command in a tmux pane (auto-created in the agent's cwd). Blocks until exit or timeout; returns `job_id`, `exit_code`, a short tail, and the job's `log_file` path. Use `background: true` for servers and watchers. |
| `wait`       | Blocks until a job exits, output matches a regex (`until: "pattern"`, ideal for server-ready lines), or the pane goes idle (`until: "idle"`, for interactive prompts). Pattern waits scan the job's whole output by default; `since: "now"` matches only output produced after the call, so re-waits on long jobs can't re-match stale lines. Timeouts are re-armable: simply call `wait` again. |
| `read`       | Token-lean output retrieval. `since: "last-read"` returns only new lines; `since: "job"` returns everything a job printed (served from its log file once scrollback overflows); `grep` + `context` filters; `lines` caps the tail; `max_bytes` is a hard ceiling. |
| `send_keys`  | Types into a pane to answer prompts or send `C-c`. Always refuses the agent's own pane.                                                                                                                                     |
| `list_panes` | Lists panes together with their sidemux job status.                                                                                                                                                                         |
| `status`     | Summarizes the sidemux workspace grouped by tmux window/tab.                                                                                                                                                                |
| `kill`       | `interrupt` (Ctrl-C) or `kill-pane` (managed panes only).                                                                                                                                                                   |
| `close_all`  | Destroys every live sidemux-managed pane in one call, to tidy up the workspace when you're done. Leaves your own editor and shell panes untouched.                                                                          |

`run`, `send_keys` and `kill` write to live terminals. The guards around that,
and what your MCP client should still gate, are in
[docs/safety.md](docs/safety.md).

## Reliable completion detection

When sidemux launches a command, it appends an exit-code sentinel:

```
(set -o pipefail) 2>/dev/null && set -o pipefail; your-command; printf '\n<<SMUX:%s:%d>>\n' 'j4f2a1' $?
```

The `pipefail` prefix makes a failing stage anywhere in a pipeline surface as
the job's exit code, so `cmd | tee log` reports `cmd`'s failure rather than
tee's 0. The option is probed in a subshell first because `set` is a POSIX
_special_ builtin. In a shell that rejects `-o pipefail` (dash, which is
`/bin/sh` on Debian and Ubuntu) that failure is fatal, and it would take the
rest of the line with it, command and sentinel included. Inside `( … )` it
stays contained, the `&&` short-circuits, and those shells keep tail-of-pipe
semantics anyway. fish has no pipefail, so the prefix is skipped there.

The completed sentinel (`<<SMUX:j4f2a1:0>>`) carries the real exit code. The
_echoed_ command line can never produce a false positive: it contains the
literal `%d`, and the matcher requires digits. For panes sidemux didn't launch
into (REPLs, TUIs, interactive prompts), a content-stability heuristic detects
idleness instead. The full design is described in
[docs/how-it-works.md](docs/how-it-works.md).

## Requirements

- **tmux ≥ 3.2** on your `PATH`. sidemux drives real tmux panes, and without
  tmux every tool fails with an error starting `tmux is not installed or not
  on PATH`. The built-in dashboard popup uses `display-popup`, introduced in
  tmux 3.2.
- **Node ≥ 18**. The server targets node18 and uses the modern `node:` APIs.

## Watching the output

Four ways to look at what sidemux is running:

1. **Attach to the workspace session** with `tmux attach -t smux`, or switch to
   it from inside tmux. One window per agent, one pane per command, each pane
   headed with the command and pane id.
2. **Press `Prefix e` from any tmux session** to open the built-in dashboard
   popup, showing every workspace pane live. The key is configurable via
   `SIDEMUX_DASHBOARD_KEY` or the config file.
3. **Run `sidemux dashboard`** for the same dashboard as a standalone TTY
   program, when your terminal is outside tmux.
4. **Tail the job log.** Every job's complete output is teed to a per-job file
   (`~/.local/state/sidemux/logs/<job_id>.log`, and the `run` result includes
   the path), so `tail -f` and `grep` keep working after the pane's scrollback
   has rotated. Retention is configurable, and `SIDEMUX_LOG_DIR=off` disables
   it.

![sidemux dashboard TUI over a workspace with a dev server, test run, and build](assets/usage/dashboard.gif)

## Install (local, pre-publish)

```bash
git clone <this repo> && cd sidemux
pnpm install && pnpm build
```

Then point your agent at `node <repo>/dist/index.js`. Per-client instructions:

- [Claude Code](docs/setup-claude-code.md) (MCP server, or plugin + skill)
- [Codex](docs/setup-codex.md)
- [OpenCode](docs/setup-opencode.md)

Once published, installation becomes `npx -y sidemux` everywhere.

## Auto-delegate a project's commands

`sidemux init` wires a project so the agent routes its `test`, `lint`, `build`
and dev commands through sidemux automatically. It writes a PreToolUse guard
hook (Claude Code) plus a `CLAUDE.md`/`AGENTS.md` directive. Detection covers
`package.json` scripts, `composer.json` scripts, `pyproject.toml` (pytest,
ruff and mypy under uv or poetry), `go.mod` and `Cargo.toml` conventions, and
`Makefile` / `justfile` targets. Commands are just strings, so any language
works. Run it in the project and pick which commands to delegate:

```bash
sidemux init                       # interactive
sidemux init --yes                 # delegate everything detected
sidemux init --commands "pnpm test,pnpm build"
sidemux init --commands "pytest,composer test"   # any stack
sidemux init --sync                # refresh generated files + ask about new scripts
sidemux uninstall                  # revert everything init added (alias: init --uninstall)
```

To make a custom script default to sidemux, pass the exact command string:

```bash
sidemux init --commands "pnpm db:migrate,pnpm e2e:checkout,pnpm import:big-csv"
```

The guard blocks those commands when an agent tries to run them inline and feeds
back the sidemux `run` call instead. Clients without hooks still get the same
instruction through `AGENTS.md` / `CLAUDE.md`.

Details: [docs/setup-delegation.md](docs/setup-delegation.md).

## Configuration

Everything is optional. Settings layer as built-in defaults < global config
file < environment variables. Full reference in
[docs/configuration.md](docs/configuration.md).

Two config files, two concerns:

```toml
# ~/.config/sidemux/config.toml: personal settings, applies everywhere
session = "smux"
idle_pane_ttl_ms = 900000

[dashboard]
key = "e"            # Prefix+e opens the workspace dashboard popup
density = "normal"   # compact | normal | spacious
```

```toml
# ./.sidemux.toml: project-named scripts only (found walking up from cwd)
[scripts]
lint = "nx run *:lint"
dev = { command = "pnpm dev", background = true }
```

`run { command: "lint" }` resolves the script, names the pane after it, and
honors its `background` flag. `sidemux init` offers to scaffold the global
file and picks up scripts as delegation candidates.

Environment variables (in the MCP server config) override both files:

| Variable                    | Default     | Meaning                                                                                                                  |
| --------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `SIDEMUX_SESSION`           | `smux`      | Workspace session name                                                                                                   |
| `SIDEMUX_AGENT_ID`          | auto        | Owner id for this MCP agent session; defaults to `CODEX_THREAD_ID`, then a stable hash of the server's working directory |
| `SIDEMUX_KEYBINDS`          | on          | Install the dashboard keybind when a client is attached; `0` = off                                                       |
| `SIDEMUX_DASHBOARD_KEY`     | `e`         | tmux prefix key that opens the sidemux workspace dashboard popup                                                         |
| `SIDEMUX_DASHBOARD_DENSITY` | `normal`    | Dashboard spacing: `compact`, `normal`, or `spacious`                                                                    |
| `SIDEMUX_MANAGED_ONLY`      | off         | `1` = write operations restricted to sidemux-created panes                                                               |
| `SIDEMUX_SHELL`             | auto        | Force the sentinel dialect (`fish` or anything POSIX)                                                                    |
| `SIDEMUX_TMUX_SOCKET`       | default     | tmux `-L` socket name                                                                                                    |
| `SIDEMUX_MAX_OUTPUT_BYTES`  | `8192`      | Base cap on read sizes                                                                                                   |
| `SIDEMUX_REUSE_PANES`       | on          | Reruns reuse the pane that last ran the same command (strict affinity); `0` = new pane per run                           |
| `SIDEMUX_PANE_SHELL`        | login shell | Shell command for created panes (e.g. `sh`)                                                                              |
| `SIDEMUX_PANE_HEADER`       | on          | Show a `command · %id` header on sidemux panes only (tmux pane border); `0` = off                                        |
| `SIDEMUX_CLOSE_ON_SUCCESS`  | off         | `1` = auto-close a pane after its command exits `0` (failed panes stay up)                                               |
| `SIDEMUX_IDLE_PANE_TTL_MS`  | `900000`    | How long an idle finished one-shot pane survives before garbage collection (15 min)                                      |
| `SIDEMUX_LOG_DIR`           | XDG state   | Where per-job full-output logs are written (`~/.local/state/sidemux/logs`); `off` disables job logging                    |
| `SIDEMUX_LOG_MAX_AGE_MS`    | `604800000` | How long a job log survives before pruning (7 days); `0` = never prune by age                                            |
| `SIDEMUX_LOG_MAX_TOTAL_BYTES` | `268435456` | Disk budget for the log directory (256 MiB); oldest logs are evicted first, `0` = no size cap                          |

Every variable except `SIDEMUX_AGENT_ID` has a config-file equivalent. See
[docs/configuration.md](docs/configuration.md) for the mapping.

## Designed-in behavior

**Panes open in the agent's working directory.** Every pane sidemux creates is
anchored with `split-window -c <cwd>`. A reused pane gets a `cd` prefix when
the target directory differs.

**Panes live in a dedicated sidemux workspace.** `run` creates or reuses one
window per AI agent session in `SIDEMUX_SESSION` (`smux`). The window tab is a
short owner id, while `name`/`project` stays the pane label and reusable
target. Concurrent jobs from the same agent split inside that owner window.
With no attached client (headless or CI) the workspace is detached, and you can
watch it with `tmux attach -t smux`.

**Pane reuse is strict affinity.** A run with a `name` reuses that named pane.
An unnamed run reuses only the idle pane that last ran the exact same command,
most recently used first. No match means a new pane. sidemux never steals
another command's pane and never touches other agents' panes.

**Finished panes garbage-collect themselves.** Idle one-shot panes, including
failed ones, are collected once they are older than
`SIDEMUX_IDLE_PANE_TTL_MS` (15 minutes by default). Background panes and busy
panes are never collected, and windows belonging to dead sidemux servers are
swept opportunistically. GC is event-driven: it piggybacks on tool calls, with
no timers. Restarting the MCP server in the same project reclaims its previous
panes, because the default agent id is derived from the working directory.

**Passive status is visible in tmux and via MCP.** Pane headers carry the
command and pane id, window names get compact status markers, and `status`
returns the same workspace grouped by tab. When a human tmux client is
attached, `SIDEMUX_KEYBINDS=1` makes `Prefix e` open the sidemux dashboard
popup. If no sidemux workspace exists yet the popup says so; otherwise it
switches only after you select an item with Enter. The dashboard table shows
the current script, cwd, owner metadata and ids when there is room, and
narrower layouts keep script, cwd basename and ids visible.

**Ctrl-C has no exit code.** Interrupting aborts the shell's entire command
list, sentinel included, so interrupted jobs receive a synthetic `130`.

**`log_file` starts with the echoed command line.** Grepping the log for a
completion string your own command prints (`...; echo "DONE"`) matches the
echo immediately, at 0% progress. Anchor completion detection on the job's exit
marker `<<SMUX:<job_id>:<digits>>` instead. It only ever prints when the job
exits, because the echoed line carries a literal `%d` where the digits go.

**`log_file` holds raw terminal bytes.** ANSI colors, OSC titles, and one
spinner frame per repaint — a direct `grep` on a failed job returns spinner
lines, not the error. Use `read` with `since: "job"` and `grep` (sanitized
before matching), or `sidemux log <job_id>` to print the log as display-ready
text that greps like plain output.

**`close: true` destroys the evidence on failure.** The pane is gone, so
follow-up `read` calls error; only the returned tail and the `log_file`
survive. Leave `close` off for the first run of a typecheck/lint/build/test
where failures are likely and full diagnostics matter; reach for `close: true`
once a command is known stable or the tail is all you need.

**Long waits vs. client timeouts.** `wait` returns `status: "timeout"` before
most client tool timeouts fire, and the agent simply calls `wait` again. For a
single long `run` call, the MCP client must allow a request long enough for the
command, or reset its timeout on sidemux progress notifications. sidemux emits
those notifications for clients that pass a progress token.

**Multi-hour jobs.** `timeout_ms` on `run` and `wait` accepts up to 24 hours.
Launch with `background: true`, then issue one `wait` with a `timeout_ms`
covering the whole job. Hosts that background long tool calls surface a single
completion event, instead of a re-armable timeout every few minutes.

## Development

```bash
pnpm test        # unit + integration (real tmux on a throwaway socket) + E2E
pnpm coverage    # 80% thresholds enforced
pnpm lint        # eslint (typescript-eslint recommended)
pnpm typecheck   # tsc --noEmit
pnpm build       # tsup → dist/
pnpm bench       # token-savings benchmark of this repo's own commands (needs tmux)
```

Integration tests never touch your real tmux server. They run on isolated
`-L smux-test-*` sockets with `-f /dev/null`.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
commands, code standards, and the PR and release flow. All participation is
covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[GNU GPLv3](LICENSE)
