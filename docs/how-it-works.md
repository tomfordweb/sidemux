# How sidemux works

This document explains the engineering behind sidemux's token efficiency: the
architecture, the exit-detection sentinel, the idle heuristic, the incremental
read cursor, server-side blocking waits, and pane lifecycle management.

## Architecture

```
agent (Claude Code / Codex / OpenCode)
  │  stdio MCP
  ▼
sidemux server (one process per agent session)
  │  tmux subcommands via execFile — send-keys, capture-pane, display-message
  ▼
tmux server ── panes the human can watch
```

sidemux runs one server process per agent session. All state — jobs, read
cursors, managed panes — lives in memory and is scoped to that session. Two
agents on the same machine run two fully independent servers, and reads can
never conflict because `capture-pane` is a read-only operation.

## Exit detection: the sentinel

`run` types the command with a suffix and presses Enter:

```
pnpm build; printf '\n<<SMUX:%s:%d>>\n' 'j4f2a1' $?
```

- When the command finishes — success, failure, or anything else — the shell
  runs the `printf`, and the pane shows `<<SMUX:j4f2a1:1>>` carrying the real
  exit code.
- The matcher is `<<SMUX:j4f2a1:(\d+)>>`, and it **requires digits**. The
  echoed command line contains the literal `%d`, so the echo can never match.
  No "skip the first occurrence" hacks are needed.
- Fish uses `$status` instead of `$?`. The dialect is auto-detected from
  `pane_current_command`, or can be forced with `SIDEMUX_SHELL`.
- The waiter polls only the last ~15 pane lines per tick. The sentinel always
  appears at the end of output, so scans stay cheap regardless of how much the
  command prints.

Two limits are known and deliberate for v1:

- A trailing `#` comment in your command swallows the sentinel, and the wait
  falls back to timing out. Use `wait until=idle` for unusual commands.
- **Ctrl-C aborts the whole command list**, sentinel included.
  `kill {mode: "interrupt"}` therefore marks the job with a synthetic exit
  code 130 (the shell convention for SIGINT) instead of reading one from the
  pane.

## Idle detection (panes sidemux didn't launch into)

Arbitrary panes — REPLs, TUIs, a command that stopped to ask a question — have
no sentinel. For these, `wait {until: "idle"}` hashes the visible screen on
every poll:

- If the content is unchanged for `idle_ms` **and** the pane's foreground
  process is a shell (bash/zsh/fish/sh/dash/ksh), the pane is declared idle.
- If the foreground process is *not* a shell (a compiler, REPL, or TUI), the
  quiet window is tripled (`idle_ms × 3`) before idle is declared, so a
  compiler pausing on a large translation unit doesn't produce a false
  positive.

## Incremental reads: the cursor

tmux numbers capture coordinates from the visible screen: `0` is the first
visible line, and negative values reach into scrollback. sidemux instead
tracks per-pane absolute positions:

```
totalLines = history_size + cursor_y + 1
```

After every read it stores `totalLines` plus a hash of the ≤3 lines just
*before* the cursor — the **anchor**. The cursor line itself is the live
prompt and mutates in place when the next command is typed, so it is excluded.
The next read then:

1. Re-derives the current `totalLines`.
2. Re-captures the anchor coordinates and compares hashes.
3. On a match, captures exactly the new region `[stored, current)` and returns
   only those lines.
4. On a mismatch (scrollback rotated past `history-limit`, a `clear`, an
   alternate-screen app repainting) or a line count that went backwards, it
   **degrades honestly**: it returns a tail snapshot with `cursor_reset: true`
   so the agent knows continuity broke, and re-anchors.

A server restart loses the cursors, so the first read after a restart is a
`cursor_reset` tail. This is an accepted trade-off for keeping the server
stateless on disk.

## Blocking waits

`wait` (and non-background `run`) polls tmux inside the server: a 100ms
initial interval with ×1.5 backoff, capped at 500ms. The agent spends exactly
one tool call, no matter how long the command runs. Two protections guard
against MCP client timeouts:

- sidemux's own `timeout_ms` fires first and returns `status: "timeout"`. Job
  state is kept, so the agent simply calls `wait` again ("re-arming").
- When the client sends a `progressToken`, sidemux emits
  `notifications/progress` every ~10s, which keeps progress-aware clients from
  assuming the server has hung.

`tmux wait-for` was considered and rejected for v1: it provides no exit code,
requires a tmux binary inside the pane's command chain, leaks channels on
timeout, and cannot watch panes sidemux didn't launch into. Polling with
backoff costs microseconds per tick and handles every case uniformly.

## Pane lifecycle

- **Inside tmux** (`$TMUX` set): the first delegated pane is a **full-span
  bar** on the configured edge — `split-window -d -f -l <size>` off the
  agent's pane (`$TMUX_PANE`) — so it spans the whole window regardless of
  other splits and the human can watch the work live. `SIDEMUX_LAYOUT`
  (`right`/`left`/`top`/`bottom`, default `bottom`) picks the edge and maps to
  tmux's `-h`/`-v`/`-b`; `-f` makes it full-width (top/bottom) or full-height
  (left/right). `SIDEMUX_PANE_SIZE` (default `30%`) sets the bar's thickness
  via `-l`. Additional concurrent panes are appended *into that bar* (splitting
  the last bar pane along its length, without `-f`), so the bar's thickness —
  and the agent's share of the window — stays constant no matter how many
  panes are running. (A modal `display-popup` is deliberately not supported:
  popup panes aren't addressable by `capture-pane` or `list-panes`, so
  `read`/`wait`/`close` could not work inside one.)
- **No agent pane** (`$TMUX_PANE` unset — e.g. a client that launched the
  server without passing its tmux env): sidemux can't split off the agent's
  pane, so it hosts the bar in its own **window** instead. If a client is
  attached to the tmux server, sidemux finds that session via `list-clients`
  and opens a `smux`-named window *there* — so the work still shows up in your
  tmux, switchable with `prefix + w`, and additional jobs tile within that
  window exactly like the bar. With no client attached (headless/CI), it falls
  back to a detached `smux` session (`SIDEMUX_SESSION`); run `tmux attach -t
  smux` to watch. Either way the token-saving core is unaffected — `capture-pane`
  reads output the same from any session.
- Every created pane is anchored with `-c <cwd>` — the explicit `cwd`
  argument, otherwise the agent's working directory. tmux's `default-path` is
  never relied upon.
- Panes are titled `smux:<name> · <command> · <%id>` (the human-readable id in
  `list_panes`), and sidemux also records the same label in a private
  `@smux_label` pane option. When `SIDEMUX_PANE_HEADER` is on (the default),
  that label is shown as a tmux pane-border header so you can see at a glance
  which pane runs what. Because `pane-border-status` is a *window* option (it
  would otherwise label every pane in the window), the `pane-border-format` is
  conditioned on `@smux_label` being set — the human's own editor and shell
  panes have no such option and keep their normal borders. Keying on the
  option, not `pane_title`, matters: most shells rewrite their pane's title on
  every prompt (an OSC escape setting it to the cwd), which would otherwise
  blank the header — the option is sidemux's alone and can't be clobbered. The
  border is enabled on sidemux's window and restored to the default once the
  last managed pane closes (`SIDEMUX_PANE_HEADER=0` leaves the window
  untouched).
- Idle panes are reused for later runs (`SIDEMUX_REUSE_PANES=0` disables
  this). A rerun prefers the idle pane that last ran the *same command* — so
  `pnpm test` keeps landing in its own pane — then falls back to any idle
  managed pane before splitting a new one. A reused pane sitting in the wrong
  directory gets a `cd '<cwd>' && ` prefix.
- Panes close automatically after a clean exit when
  `SIDEMUX_CLOSE_ON_SUCCESS=1` (off by default): a foreground command exiting
  `0` destroys its pane, while a failed command leaves the pane up for
  inspection. A per-run `close: true` still forces closing regardless of exit
  code. Reuse and close-on-success are mutually exclusive in practice — a
  closed pane can't be reused.
