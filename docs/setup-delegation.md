# Auto-delegating test/lint/build with `sidemux init`

By default, sidemux only runs a command in a pane when the agent chooses to
call the `run` tool. `sidemux init` makes that automatic for a project: it
wires up a guard that intercepts inline `pnpm test` / `npm run build` /
dev-server commands and redirects the agent to the sidemux `run` tool instead
— so heavy output stays in a tmux pane and out of the agent's context, on
every run, without the agent having to remember.

![sidemux init wiring a project, then the guard blocking an inline pnpm test](../assets/usage/init.gif)

## Run it

In the project you want to wire up:

```bash
npx sidemux init            # interactive: pick which commands to delegate
# or, pre-publish, from a local checkout:
node /path/to/sidemux/dist/index.js init
```

Non-interactive / CI:

```bash
sidemux init --yes                              # delegate every detected command
sidemux init --commands "pnpm test,pnpm build"  # delegate exactly these
sidemux init --commands "pytest,composer test"  # any language — commands are just strings
sidemux init --yes --mcp                         # also register the MCP server
```

## Make a custom script default to sidemux

Pass the exact command string with `--commands`. The generated guard blocks that
inline command and tells the agent to use sidemux instead:

```bash
sidemux init --commands "pnpm db:migrate,pnpm e2e:checkout"
```

For package-manager scripts, use the command the agent would normally type:

```bash
sidemux init --commands "pnpm run import:big-csv,npm run storybook"
```

To add more custom commands later, re-run with the full desired list or edit
`.sidemux/delegate.json`, then refresh generated docs/hooks:

```bash
sidemux init --commands "pnpm test,pnpm e2e:checkout,pnpm import:big-csv"
sidemux init --sync --yes
```

Clients without hook enforcement (Codex, OpenCode) still rely on instructions.
Add the custom command to the managed block in `AGENTS.md` / `CLAUDE.md`, or
re-run `sidemux init --commands ...` so sidemux writes that block for you.

`init` detects candidates from, grouped as test / lint / build / dev:

- `package.json` scripts (mapped to your package manager via the lockfile)
- `composer.json` scripts (PHP) → `composer test`, `composer lint`, …
- `pyproject.toml` (Python) → `pytest` / `ruff check .` / `mypy .`, prefixed
  with `uv run` or `poetry run` when the matching lockfile is present
- `go.mod` → `go test ./...`, `go vet ./...`, `go build ./...`
- `Cargo.toml` → `cargo test`, `cargo clippy`, `cargo build`
- `Makefile` and `justfile` targets → `make test`, `just test`, …
- `.sidemux.toml` `[scripts]` entries (see
  [configuration.md](./configuration.md)) — project-named sidemux scripts are
  offered as delegation candidates too

When run interactively, `init` also offers to scaffold the global config file
`~/.config/sidemux/config.toml` if it doesn't exist yet.

**Nothing detected?** Init still offers to install a _generic_ directive block
that tells the agent to route heavy commands — test suites, linters, type
checkers, builds, E2E runs, dev servers — through sidemux by theme. The guard
has nothing to block until you add commands (`--commands`, or `sidemux init
--sync` once the project grows recognizable ones).

## What it writes

| Path                          | Purpose                                                       |
| ----------------------------- | ------------------------------------------------------------- |
| `.sidemux/delegate-guard.mjs` | Self-contained PreToolUse guard (plain Node, no dependencies) |
| `.sidemux/delegate.json`      | The list of delegated commands the guard reads                |
| `.claude/settings.json`       | A `PreToolUse` Bash matcher that runs the guard               |
| `CLAUDE.md`, `AGENTS.md`      | A marked delegation block (for clients without hooks)         |
| `.mcp.json`                   | _(with `--mcp`)_ the sidemux MCP server entry                 |

All writes are idempotent and marker-delimited: re-running updates them in
place, and `sidemux uninstall` removes exactly what was added — nothing more.

## Refreshing after a sidemux upgrade (or new scripts)

The guard script and directive block are generated copies, so they go stale
when sidemux's templates change or when your project grows new scripts.
`sidemux init --sync` rewrites all of them from the selection already recorded
in `.sidemux/delegate.json`:

```bash
sidemux init --sync          # refresh + ask about newly detected commands
sidemux init --sync --yes    # refresh only; new candidates are listed, not added
```

Sync keeps your recorded command list (including anything added via
`--commands`), asks only about commands detected since the last init, touches
`.mcp.json` only if a sidemux entry already exists, and leaves that entry's
`env` block alone.

## Uninstalling

```bash
sidemux uninstall            # alias for: sidemux init --uninstall
```

This removes everything init added: the `.sidemux/` directory (guard +
`delegate.json`), the PreToolUse hook from `.claude/settings.json`, the marked
blocks in `CLAUDE.md` / `AGENTS.md`, and the `sidemux` entry in `.mcp.json`
(other MCP servers in that file are untouched).

## How the enforcement works

The guard is registered as a Claude Code **PreToolUse** hook on the `Bash`
tool. When the agent tries to run a delegated command inline, the guard exits
with status **2** — Claude Code's convention for "block this tool call and
feed the message back to the model" — along with an actionable note:

```
[sidemux] Delegate "pnpm test" to a tmux pane instead of running it inline.
Use the sidemux MCP tool:
  run { command: "pnpm test", close: true }
```

One-shot commands (test/lint/build) are suggested with `close: true`;
long-running ones (dev/watch/serve) with `background: true`. The guard is
**fail-open**: any parse error, a non-Bash tool, or a non-matching command
exits 0, so it can never brick your Bash tool. Set `SIDEMUX_DELEGATE_OFF=1` to
bypass it in an emergency.

Clients without a hook system (Codex, OpenCode) don't get enforcement, but
they do get the `CLAUDE.md` / `AGENTS.md` directive block, which tells the
agent the same thing.

## Verify the wiring

```bash
# a delegated command is blocked with guidance (exit 2):
echo '{"tool_name":"Bash","tool_input":{"command":"pnpm test"}}' \
  | node .sidemux/delegate-guard.mjs; echo "exit=$?"

# an unrelated command passes (exit 0):
echo '{"tool_name":"Bash","tool_input":{"command":"ls"}}' \
  | node .sidemux/delegate-guard.mjs; echo "exit=$?"
```

Then, in a Claude Code session in that project, ask Claude to run the test
suite — it should route through the sidemux `run` tool instead of Bash.
