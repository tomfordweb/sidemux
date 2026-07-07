# Safety model

## What sidemux can do

`run` and `send_keys` inject keystrokes into live terminals. That is the
feature — and the risk. A terminal is an execution surface: anything typed
into a shell pane runs with your user's privileges. sidemux is designed around
that reality, with layered guards rather than wishful thinking.

## Threat model

The realistic concern is not sidemux itself but **what drives it**: a
prompt-injected or confused agent asking to type into the wrong pane. Concrete
examples:

- typing into the pane where _the agent itself_ runs, creating a feedback
  loop;
- "answering" a prompt in a pane the user was actively working in;
- interrupting or killing something unrelated.

## Built-in guards

1. **Self-pane refusal (always on).** Write operations (`run`, `send_keys`,
   `kill`) against the agent's own pane (`$TMUX_PANE`) are hard errors.
2. **Strict target resolution.** tmux's `display-message` silently falls back
   to the _active pane_ for unknown targets, which means a typo'd target would
   misroute keystrokes. sidemux cross-checks every target against
   `list-panes` and errors out instead.
3. **`SIDEMUX_MANAGED_ONLY=1` (opt-in).** Restricts all write operations to
   panes sidemux created. Reads stay unrestricted. Recommended for untrusted
   or highly autonomous workloads. To enable it everywhere without per-project
   env blocks, set `managed_only = true` in `~/.config/sidemux/config.toml`
   (see [configuration.md](./configuration.md)).
4. **`kill-pane` / `close_all` scope.** Destroying panes only works on
   sidemux-created panes, regardless of mode. `close_all` is the same story in
   bulk — it only ever destroys panes marked as sidemux-managed, so the
   agent's own pane and the user's shells are untouched. Foreign panes
   can only be sent Ctrl-C — and only when the managed-only guard allows writes
   at all.

## The primary control is your MCP client

Tool-level permission gates — Claude Code's approval prompts, Codex
approvals — are the real boundary. sidemux keeps that boundary easy to
enforce: its write tools are exactly four (`run`, `send_keys`, `kill`,
`close_all`), so scoping approval rules is simple. `read`, `list_panes`, and
`wait` are read-only and safe to auto-approve.

## Recommendations

- Run agents in their own tmux window and keep personal shells in another
  session, or enable `SIDEMUX_MANAGED_ONLY=1` (env var, or `managed_only` in
  the global config file).
- Don't auto-approve `send_keys` if you keep sensitive interactive sessions
  (ssh, database consoles) in the same tmux server.
- Remember that pane content returned by `read` enters the agent's context —
  don't point it at panes displaying secrets.
