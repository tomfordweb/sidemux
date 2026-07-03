---
name: tmux-delegate
description: Delegate long-running or observable commands to a tmux sidecar pane via the sidemux MCP tools (run/wait/read) instead of running them inline. USE WHEN about to run anything long-running or observable — builds, test suites, dev servers, DB migrations, watch mode, interactive CLIs — or when the user says "run it in a pane", "run it in the background", or "run it in tmux".
---

# Delegate commands to tmux with sidemux

sidemux moves command execution into a tmux pane the user can watch, and moves
the *waiting* into the MCP server. You spend one tool call where a polling loop
would spend ten, and you read output incrementally instead of dumping terminals.

## When to delegate

- Expected runtime over ~30 seconds: builds, test suites (`pnpm test`,
  `pytest`, `go test ./...`, `cargo test`, `composer test`), migrations, installs
- Anything that never exits: dev servers, watchers, tail -f
- Anything the user would want to see live in their tmux session
- Commands that may ask interactive questions

Quick one-shot commands (`ls`, `git status`) are cheaper inline — don't delegate those.

## The loop

1. **`run`** `{command, name?}` — one call. It creates a pane in your working
   directory, runs the command, and usually returns finished with `exit_code`
   and a `tail`.
2. If it returns `status: "running"` → **`wait`** `{job_id}`. Never poll with
   repeated `read` calls. If `wait` times out, call `wait` again — state is kept.
3. **On success: stop.** The tail you already have is enough. Do not re-read.
4. **On failure:** `read {job_id, since: "job", grep: "error|Error|FAIL|✗", context: 3}`
   first. Only if grep returns nothing: `read {job_id, since: "job", lines: 50}`.

## Dev servers and watchers

```
run  {command: "pnpm dev", name: "dev", background: true}
wait {job_id, until: "pattern", pattern: "Listening on|ready in|Local:"}
```

Same shape for any stack — `uv run uvicorn app:app`, `php artisan serve`,
`cargo run`, `air`: start with `background: true`, then `wait` for the
listening line.

Later, stop it with `kill {job_id, mode: "interrupt"}` (Ctrl-C). Check on it any
time with `read {job_id, since: "last-read"}` — that returns only new log lines.

## Monorepos

In a pnpm-workspace / Nx monorepo, target one package with `project` instead of
running the whole repo. It runs in that package's directory and gives the pane a
stable name (the project), so package runs never collide in a shared pane:

```
run {project: "bevvi", command: "pnpm test"}   → cwd apps/bevvi, pane "bevvi"
run {project: "bevvi", command: "nx test bevvi"}
```

A bare `run {command: "pnpm test"}` still runs the root script (whole-repo
`nx run-many`). An unknown project name errors with the list of valid names.

## Interactive prompts

```
wait {pane, until: "idle"}         → the command is sitting at a prompt
read {pane, lines: 15}             → see what it is asking
send_keys {pane, text: "answer", press_enter: true}
wait {job_id, until: "exit"}       → resume normal completion
```

## Token rules

- Default `read` is incremental (`since: "last-read"`) — returns only new output.
- grep before tail; never request full scrollback.
- `run`/`wait` already return a tail — reading again after success wastes tokens.

## Safety

- Only `send_keys` into panes sidemux created, unless the user explicitly
  pointed you at another pane.
- sidemux refuses to type into the agent's own pane — that is intentional.
- `kill {mode: "kill-pane"}` only works on sidemux-created panes; use
  `interrupt` for everything else.
- `close_all` tears down every sidemux pane at once (in Claude Code the
  `/sidemux-close` command does the same) — running commands included; your own
  editor/shell panes are never touched.
