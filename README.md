# Stop letting your AI agent babysit terminals.

`sidemux` is an MCP server that delegates token-heavy commands to live tmux panes in a dedicated workspace session, giving AI coding agents an efficient `run` / `wait` / `read` loop — with measured token reductions of up to **98.9%** on real-world projects.

![sidemux demo: an agent runs build/test/dev through tmux panes while ingesting only a compact tail](assets/demo.gif)

## Imagine this:

> **You are days away from the deadline.** Remaining budget is slim, and your
> agent keeps breaking the checkout E2E. Time and time again it fires the slop
> cannon at the robust E2E suite you told it to write for the last month while it burns
> 500,000 tokens filling up your context while reading error output from a failed database connection.

Modern coding agents pay for terminal output twice: once in tokens, and again
in degraded context quality. sidemux moves that output out of the model's
context and into a tmux pane you can watch live. The agent gets back exactly
what it needs — an exit code and a short tail — while the full log remains
available on demand: filtered, incremental, and byte-capped.

It works with any stdio MCP client: **Claude Code**, **Codex**, **OpenCode**,
and anything else that speaks the protocol.

## The problem

Agents burn enormous numbers of tokens supervising long-running commands. The
two typical failure modes:

1. The agent runs `npm build` inline, and its context ingests the entire
   output — every progress bar, every warning, every line of noise; or
2. The agent starts the command in a pane and then _polls_: capture pane →
   "still running" → capture pane → "still running" → … Each poll is a full
   model turn, and each capture dumps the whole terminal back into context.

Either way, the agent spends its most valuable resource — context — on output
it almost never needs.

## What sidemux does instead

| Step                     | Tool call                                                           | Tokens spent                                                  |
| ------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| Start the build          | `run {command: "pnpm build"}`                                       | one call; a pane appears in the `smux` workspace, in your cwd |
| Wait for it              | _(none — `run` blocks server-side)_                                 | zero polling turns                                            |
| It succeeded             | _(nothing — `run` already returned the exit code + a 10-line tail)_ | zero                                                          |
| It failed                | `read {grep: "error\|FAIL", context: 3}`                            | only the error lines                                          |
| Check a dev server later | `read {since: "last-read"}`                                         | only the log lines that are new since the last look           |

The waiting happens inside the MCP server — a local process polling tmux with
adaptive backoff — not in the model loop. Reads are incremental: a per-pane
cursor tracks exactly what the agent has already seen, so no output is ever
transmitted twice.

## Measured token savings

These are not synthetic numbers. `sidemux benchmark` runs **your project's own
commands** twice — once inline (full stdout+stderr, exactly what a Bash tool
call injects into an agent's context) and once through the sidemux server over
real MCP stdio — and reports the estimated tokens an agent ingests each way:

```bash
sidemux benchmark --command "pnpm test" --command "pnpm build"
```

![sidemux benchmark run ending on the savings table](assets/usage/benchmark.gif)

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

On this repository (`pnpm bench`) — a small, quiet test suite:

| Command          |  Inline | sidemux | Reduction |
| ---------------- | ------: | ------: | --------: |
| `pnpm test`      | 673 tok | 123 tok |    **5×** |
| `pnpm typecheck` |   4 tok |  36 tok |         — |
| `pnpm build`     |  71 tok |  90 tok |         — |

On a mid-size Angular/Vite app in an Nx monorepo — **97.3% saved overall**:

| Command                 |     Inline | sidemux | Reduction |
| ----------------------- | ---------: | ------: | --------: |
| `pnpm nx run app:test`  |  1,904 tok | 127 tok |   **15×** |
| `pnpm nx run app:build` | 11,210 tok | 113 tok |   **99×** |
| `pnpm nx run app:lint`  |     61 tok | 119 tok |         — |

On six anonymized targets from a larger Nx monorepo — Astro SSR/static sites,
an Analog/Vite app, and an Angular app, all run with Nx cache disabled —
**98.1% saved overall**:

| Target                                  |     Inline | sidemux | Reduction |
| --------------------------------------- | ---------: | ------: | --------: |
| Verbose Astro content site build        | 32,589 tok | 132 tok |  **247×** |
| Small Astro static site build           |    334 tok | 124 tok |    **3×** |
| Astro data-heavy static site build      |    504 tok | 123 tok |    **4×** |
| Astro content-commerce site build       |    557 tok | 122 tok |    **5×** |
| Analog/Vite SSR app build               |  2,547 tok | 114 tok |   **22×** |
| Angular app build with asset generation |  2,089 tok | 126 tok |   **17×** |

On five anonymized headless Playwright E2E targets from the same monorepo —
each target builds its app first, then runs browser tests — **98.9% saved
overall**:

| Target                           |     Inline | sidemux | Reduction |
| -------------------------------- | ---------: | ------: | --------: |
| Verbose Astro E2E suite          | 33,042 tok |  90 tok |  **369×** |
| Small Astro E2E suite            |  1,628 tok |  90 tok |   **18×** |
| Data-heavy Astro E2E suite       |  1,790 tok |  90 tok |   **20×** |
| Content-commerce Astro E2E suite |  2,044 tok |  90 tok |   **23×** |
| Angular app E2E suite            |  3,557 tok |  90 tok |   **40×** |

Savings scale with output volume. Chatty commands — test suites, verbose
builds, dev-server logs — collapse to an exit code plus a 10-line tail, while
quiet commands have nothing to save: the `—` rows cost slightly _more_ than
inline because of the tool-result envelope. Tokens are estimated as chars ÷ 4,
and the benchmark runs on a throwaway tmux socket, never your real tmux
server.

## Tools

Eight tools cover the lifecycle and status of delegated commands:

| Tool         | What it does                                                                                                                                                                                                                |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run`        | Runs a command in a tmux pane (auto-created in the agent's cwd). Blocks until exit or timeout; returns `job_id`, `exit_code`, a short tail, and the job's `log_file` path. Use `background: true` for servers and watchers. |
| `wait`       | Blocks until a job exits, output matches a regex (`until: "pattern"` — ideal for server-ready lines), or the pane goes idle (`until: "idle"` — for interactive prompts). Timeouts are re-armable: simply call `wait` again. |
| `read`       | Token-lean output retrieval. `since: "last-read"` returns only new lines; `since: "job"` returns everything a job printed (served from its log file once scrollback overflows); `grep` + `context` filters; `lines` caps the tail; `max_bytes` is a hard ceiling. |
| `send_keys`  | Types into a pane — answer prompts, send `C-c`. Always refuses the agent's own pane.                                                                                                                                        |
| `list_panes` | Lists panes together with their sidemux job status.                                                                                                                                                                         |
| `status`     | Summarizes the sidemux workspace grouped by tmux window/tab.                                                                                                                                                                |
| `kill`       | `interrupt` (Ctrl-C) or `kill-pane` (managed panes only).                                                                                                                                                                   |
| `close_all`  | Destroys every live sidemux-managed pane in one call — tidy up the workspace when you're done. Leaves your own editor/shell panes untouched.                                                                                |

## Reliable completion detection

When sidemux launches a command, it appends an exit-code sentinel:

```
(set -o pipefail) 2>/dev/null && set -o pipefail; your-command; printf '\n<<SMUX:%s:%d>>\n' 'j4f2a1' $?
```

The `pipefail` prefix makes a failing stage anywhere in a pipeline surface as
the job's exit code (`cmd | tee log` reports `cmd`'s failure, not tee's 0). The
option is probed in a subshell first because `set` is a POSIX _special_
builtin: in a shell that rejects `-o pipefail` (dash, i.e. `/bin/sh` on
Debian/Ubuntu) the failure is fatal and would take the rest of the line —
command and sentinel included — with it. Inside `( … )` that stays contained,
the `&&` short-circuits, and such shells keep tail-of-pipe semantics. fish has
no pipefail, so the prefix is skipped there.

The completed sentinel (`<<SMUX:j4f2a1:0>>`) carries the real exit code. The
_echoed_ command line can never produce a false positive — it contains the
literal `%d`, and the matcher requires digits. For panes sidemux didn't launch
into (REPLs, TUIs, interactive prompts), a content-stability heuristic detects
idleness instead. The full design is described in
[docs/how-it-works.md](docs/how-it-works.md).

## Requirements

- **tmux ≥ 3.2** on your `PATH` — sidemux drives real tmux panes; without tmux
  every tool returns `tmux is not installed or not on PATH`, and the built-in
  dashboard popup uses `display-popup` (introduced in tmux 3.2).
- **Node ≥ 18** — the server targets node18 and uses the modern `node:` APIs.

## Watching the output

Four ways to look at what sidemux is running:

1. **Attach to the workspace session** — `tmux attach -t smux` (or switch to it
   from inside tmux). One window per agent, one pane per command, each pane
   headed with the command and pane id.
2. **Press `Prefix e` from any tmux session** — opens the built-in dashboard
   popup showing every workspace pane, live. The key is configurable via
   `SIDEMUX_DASHBOARD_KEY` or the config file.
3. **Run `sidemux dashboard`** — the same dashboard as a standalone TTY
   program, for a terminal outside tmux.
4. **Tail the job log** — every job's complete output is teed to a per-job
   file (`~/.local/state/sidemux/logs/<job_id>.log`; the `run` result includes
   the path), so `tail -f`/`grep` work even after the pane's scrollback has
   rotated. Retention is configurable; `SIDEMUX_LOG_DIR=off` disables it.

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

`sidemux init` wires a project so the agent routes its `test` / `lint` /
`build` / dev commands through sidemux automatically — a PreToolUse guard hook
(Claude Code) plus a `CLAUDE.md`/`AGENTS.md` directive. Detection covers
`package.json` scripts, `composer.json` scripts, `pyproject.toml`
(pytest/ruff/mypy under uv or poetry), `go.mod` and `Cargo.toml` conventions,
and `Makefile` / `justfile` targets — commands are just strings, so any
language works. Run it in the project and pick which commands to delegate:

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

Everything is optional. Settings layer as **built-in defaults < global config
file < environment variables** — full reference in
[docs/configuration.md](docs/configuration.md).

Two config files, two concerns:

```toml
# ~/.config/sidemux/config.toml — personal settings, applies everywhere
session = "smux"
idle_pane_ttl_ms = 900000

[dashboard]
key = "e"            # Prefix+e opens the workspace dashboard popup
density = "normal"   # compact | normal | spacious
```

```toml
# ./.sidemux.toml — project-named scripts only (found walking up from cwd)
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

Every variable except `SIDEMUX_AGENT_ID` has a config-file equivalent — see
[docs/configuration.md](docs/configuration.md) for the mapping.

## Designed-in behavior

- **Panes open in the agent's working directory.** Every pane sidemux creates
  is anchored with `split-window -c <cwd>`; reused panes get a `cd` prefix
  when the target directory differs.
- **Panes live in a dedicated sidemux workspace.** `run` creates or
  reuses one window per AI agent session in `SIDEMUX_SESSION` (`smux`). The
  window tab is a short owner id; `name`/`project` remains the pane label and
  reusable target. Concurrent jobs from the same agent split inside that owner
  window. With no attached client (headless/CI), the workspace is detached and
  can be watched with `tmux attach -t smux`.
- **Pane reuse is strict affinity.** A run with a `name` reuses that named
  pane; an unnamed run reuses only the idle pane that last ran the exact same
  command (most-recently-used wins). No match means a new pane — sidemux never
  steals another command's pane and never touches other agents' panes.
- **Finished panes garbage-collect themselves.** Idle one-shot panes
  (including failed ones) are collected once older than
  `SIDEMUX_IDLE_PANE_TTL_MS` (default 15 minutes); background panes and busy
  panes are never collected. Windows belonging to dead sidemux servers are
  swept opportunistically. GC is event-driven — it piggybacks on tool calls,
  no timers. Restarting the MCP server in the same project reclaims its
  previous panes (the default agent id is derived from the working directory).
- **Passive status is visible in tmux and via MCP.** Pane headers show the
  command and pane id; window names get compact status markers; `status`
  returns the same workspace grouped by tab. When a human tmux client is
  attached, `SIDEMUX_KEYBINDS=1` makes `Prefix e` open the sidemux dashboard
  popup. If no sidemux workspace exists yet, the popup says so; otherwise it
  switches only after you select an item with Enter. The dashboard table shows
  the current script, cwd, owner metadata, and ids when there is room; narrower
  layouts keep script, cwd basename, and ids visible.
- **Ctrl-C has no exit code.** Interrupting aborts the shell's entire command
  list, sentinel included, so interrupted jobs receive a synthetic `130`.
- **Long waits vs. client timeouts:** `wait` returns `status: "timeout"`
  before most client tool timeouts fire, and the agent simply calls `wait`
  again. For a single long `run` call, the MCP client must allow a request long
  enough for the command, or reset its timeout on sidemux progress
  notifications. sidemux emits those notifications for clients that pass a
  progress token.

## Development

```bash
pnpm test        # unit + integration (real tmux on a throwaway socket) + E2E
pnpm coverage    # 80% thresholds enforced
pnpm lint        # eslint (typescript-eslint recommended)
pnpm typecheck   # tsc --noEmit
pnpm build       # tsup → dist/
pnpm bench       # token-savings benchmark of this repo's own commands (needs tmux)
```

Integration tests never touch your real tmux server — they run on isolated
`-L smux-test-*` sockets with `-f /dev/null`.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for setup,
commands, code standards, and the PR/release flow. All participation is
covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[GNU GPLv3](LICENSE)
