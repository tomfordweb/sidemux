# sidemux

> **Stop letting your AI agent babysit terminals.** sidemux is an MCP server
> that delegates token-heavy commands to live tmux sidecar panes, giving AI
> coding agents an efficient `run` / `wait` / `read` loop — with measured
> token reductions of up to **97%** on real-world projects.

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
2. The agent starts the command in a pane and then *polls*: capture pane →
   "still running" → capture pane → "still running" → … Each poll is a full
   model turn, and each capture dumps the whole terminal back into context.

Either way, the agent spends its most valuable resource — context — on output
it almost never needs.

## What sidemux does instead

| Step | Tool call | Tokens spent |
|------|-----------|--------------|
| Start the build | `run {command: "pnpm build"}` | one call; a pane appears beside you, in your cwd |
| Wait for it | *(none — `run` blocks server-side)* | zero polling turns |
| It succeeded | *(nothing — `run` already returned the exit code + a 10-line tail)* | zero |
| It failed | `read {grep: "error\|FAIL", context: 3}` | only the error lines |
| Check a dev server later | `read {since: "last-read"}` | only the log lines that are new since the last look |

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

On this repository (`pnpm bench`) — a small, quiet test suite:

| Command | Inline | sidemux | Reduction |
|---------|-------:|--------:|----------:|
| `pnpm test` | 673 tok | 123 tok | **5×** |
| `pnpm typecheck` | 4 tok | 36 tok | — |
| `pnpm build` | 71 tok | 90 tok | — |

On a mid-size Angular/Vite app in an Nx monorepo — **97.3% saved overall**:

| Command | Inline | sidemux | Reduction |
|---------|-------:|--------:|----------:|
| `pnpm nx run app:test` | 1,904 tok | 127 tok | **15×** |
| `pnpm nx run app:build` | 11,210 tok | 113 tok | **99×** |
| `pnpm nx run app:lint` | 61 tok | 119 tok | — |

Savings scale with output volume. Chatty commands — test suites, verbose
builds, dev-server logs — collapse to an exit code plus a 10-line tail, while
quiet commands have nothing to save: the `—` rows cost slightly *more* than
inline because of the tool-result envelope. Tokens are estimated as chars ÷ 4,
and the benchmark runs on a throwaway tmux socket, never your real tmux
server.

## Tools

Seven tools cover the entire lifecycle of a delegated command:

| Tool | What it does |
|------|--------------|
| `run` | Runs a command in a tmux pane (auto-created in the agent's cwd). Blocks until exit or timeout; returns `job_id`, `exit_code`, and a short tail. Use `background: true` for servers and watchers. |
| `wait` | Blocks until a job exits, output matches a regex (`until: "pattern"` — ideal for server-ready lines), or the pane goes idle (`until: "idle"` — for interactive prompts). Timeouts are re-armable: simply call `wait` again. |
| `read` | Token-lean output retrieval. `since: "last-read"` returns only new lines; `grep` + `context` filters; `lines` caps the tail; `max_bytes` is a hard ceiling. |
| `send_keys` | Types into a pane — answer prompts, send `C-c`. Always refuses the agent's own pane. |
| `list_panes` | Lists panes together with their sidemux job status. |
| `kill` | `interrupt` (Ctrl-C) or `kill-pane` (managed panes only). |
| `close_all` | Destroys every pane sidemux created this session in one call — tidy up all sidecar panes when you're done. Leaves your own editor/shell panes untouched. |

## Reliable completion detection

When sidemux launches a command, it appends an exit-code sentinel:

```
your-command; printf '\n<<SMUX:%s:%d>>\n' 'j4f2a1' $?
```

The completed sentinel (`<<SMUX:j4f2a1:0>>`) carries the real exit code. The
*echoed* command line can never produce a false positive — it contains the
literal `%d`, and the matcher requires digits. For panes sidemux didn't launch
into (REPLs, TUIs, interactive prompts), a content-stability heuristic detects
idleness instead. The full design is described in
[docs/how-it-works.md](docs/how-it-works.md).

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

Details: [docs/setup-delegation.md](docs/setup-delegation.md).

## Configuration

Everything is optional, controlled through environment variables in the MCP
server config:

| Variable | Default | Meaning |
|----------|---------|---------|
| `SIDEMUX_SESSION` | `smux` | Session name when the agent runs outside tmux |
| `SIDEMUX_MANAGED_ONLY` | off | `1` = write operations restricted to sidemux-created panes |
| `SIDEMUX_SHELL` | auto | Force the sentinel dialect (`fish` or anything POSIX) |
| `SIDEMUX_TMUX_SOCKET` | default | tmux `-L` socket name |
| `SIDEMUX_MAX_OUTPUT_BYTES` | `8192` | Base cap on read sizes |
| `SIDEMUX_REUSE_PANES` | on | Reruns reuse the pane that last ran the command (else any idle pane); `0` = new pane per run |
| `SIDEMUX_PANE_SHELL` | login shell | Shell command for created panes (e.g. `sh`) |
| `SIDEMUX_LAYOUT` | `bottom` | Edge for the full-span pane bar: `right`/`left`/`top`/`bottom` |
| `SIDEMUX_PANE_SIZE` | `30%` | Size of created panes: `NN%` or an integer cell count |
| `SIDEMUX_PANE_HEADER` | on | Show a `command · %id` header on sidemux panes only (tmux pane border); `0` = off |
| `SIDEMUX_CLOSE_ON_SUCCESS` | off | `1` = auto-close a pane after its command exits `0` (failed panes stay up) |

## Designed-in behavior

- **Panes open in the agent's working directory.** Every pane sidemux creates
  is anchored with `split-window -c <cwd>`; reused panes get a `cd` prefix
  when the target directory differs.
- **Inside tmux** (the usual case), sidemux opens a full-span bar on one edge
  so you can watch the work live — a full-width strip below by default, or set
  `SIDEMUX_LAYOUT` to `right`/`left`/`top` (and `SIDEMUX_PANE_SIZE` for the
  thickness). The bar spans the whole window regardless of other splits, and
  additional concurrent panes tile within it rather than shrinking the agent
  further. When the server is launched without the agent's tmux env (`$TMUX_PANE`
  unset) but a client is attached, sidemux finds that session via `list-clients`
  and hosts a switchable `smux` window there instead; with nothing attached
  (headless/CI) it falls back to a detached `smux` session you can `tmux attach
  -t smux` to watch. The token-saving `run`/`wait`/`read` loop works the same in
  every case.
- **Ctrl-C has no exit code.** Interrupting aborts the shell's entire command
  list, sentinel included, so interrupted jobs receive a synthetic `130`.
- **Long waits vs. client timeouts:** `wait` returns `status: "timeout"`
  before most client tool timeouts fire, and the agent simply calls `wait`
  again. sidemux also emits MCP progress notifications for clients that pass a
  progress token.

## How sidemux compares

sidemux is, to our knowledge, the only tmux MCP server with server-side
blocking waits, incremental new-output-only reads, and grep/tail/byte-cap
output shaping — the three capabilities that actually save tokens:

| | sidemux | nickgnd/tmux-mcp | lox/tmux-mcp-server |
|---|---|---|---|
| Blocking wait (exit / pattern / idle) | ✅ | ❌ | ❌ |
| Exit-code detection | ✅ sentinel | ✅ shell-config | ❌ |
| Incremental "new output only" reads | ✅ | ❌ | ❌ |
| grep/tail/byte-cap output shaping | ✅ | ❌ | ❌ |
| Agent-safety guards (own pane, managed-only) | ✅ | ❌ | ❌ |
| Claude plugin + workflow skill | ✅ | ❌ | ❌ |
| Full session/window CRUD | scoped to what `run` needs | ✅ | partial |

## Development

```bash
pnpm test        # unit + integration (real tmux on a throwaway socket) + e2e
pnpm coverage    # 80% thresholds enforced
pnpm lint        # eslint (typescript-eslint recommended)
pnpm typecheck   # tsc --noEmit
pnpm build       # tsup → dist/
pnpm bench       # token-savings benchmark of this repo's own commands (needs tmux)
```

Integration tests never touch your real tmux server — they run on isolated
`-L smux-test-*` sockets with `-f /dev/null`.

## License

[MIT](LICENSE)
