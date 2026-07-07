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
- If the foreground process is _not_ a shell (a compiler, REPL, or TUI), the
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
_before_ the cursor — the **anchor**. The cursor line itself is the live
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

- **All panes live in the sidemux workspace session** (`SIDEMUX_SESSION`,
  default `smux`): sidemux creates or reuses one window per AI agent session.
  The window tab is a short owner id from `SIDEMUX_AGENT_ID`,
  `CODEX_THREAD_ID`, or — by default — a stable hash of the server's working
  directory (`cwd-<8hex>`). The cwd-derived default means restarting the MCP
  server in the same project produces the same owner id, so the new process
  reclaims the panes the previous one created (a pid-based id would orphan
  them all on every restart). The run `name` or `project` remains the pane
  label and reusable target. Concurrent jobs from the same agent split inside
  that owner window; when a window fills up, sidemux retiles it
  (`select-layout tiled`) and retries the split. With no attached client
  (headless/CI), the workspace is detached; run `tmux attach -t smux` to
  watch, or press `Prefix e` (configurable) for the dashboard popup.
- A modal `display-popup` (tmux ≥ 3.2) is used only for the dashboard and
  transient status/navigation helpers.
  Jobs do not run in popups because popup panes are not durable targets for
  `capture-pane`, `list-panes`, `read`, `wait`, or `close`.
- Every created pane is anchored with `-c <cwd>` — the explicit `cwd`
  argument, otherwise the agent's working directory. tmux's `default-path` is
  never relied upon.
- Panes are titled `smux:<name> · <command> · <%id>` (the human-readable id in
  `list_panes`), and sidemux also records the same label in a private
  `@smux_label` pane option. When `SIDEMUX_PANE_HEADER` is on (the default),
  that label is shown as a tmux pane-border header so you can see at a glance
  which pane runs what. Because `pane-border-status` is a _window_ option (it
  would otherwise label every pane in the window), the `pane-border-format` is
  conditioned on `@smux_label` being set — the human's own editor and shell
  panes have no such option and keep their normal borders. Keying on the
  option, not `pane_title`, matters: most shells rewrite their pane's title on
  every prompt (an OSC escape setting it to the cwd), which would otherwise
  blank the header — the option is sidemux's alone and can't be clobbered. The
  border is enabled per owner window, and each window's `pane-border-status`
  is restored to the default when the last managed pane _in that window_ is
  removed — whether it exited and closed, was killed, or was garbage-collected
  (`SIDEMUX_PANE_HEADER=0` leaves windows untouched).
- External workspace window names include compact status markers, and the
  `status` tool returns the same view grouped by session/window/tab. When a
  human tmux client is attached, sidemux makes `Prefix e` open a local
  dashboard popup for the sidemux workspace. If no sidemux workspace exists
  yet, the popup says so; otherwise it switches only after you select an item
  with Enter. `SIDEMUX_DASHBOARD_DENSITY=compact|normal|spacious` changes only
  dashboard spacing. The dashboard redraws on terminal resize and uses a table:
  full metadata columns when width allows, compact script/cwd/id columns when it
  does not. Headless detached sessions skip key bindings.
- **Reuse is strict affinity** (`SIDEMUX_REUSE_PANES=0` disables it). A run
  with a `name` reuses that named pane. An unnamed run reuses only the idle
  pane that last ran the _exact same command_ — so `pnpm test` keeps landing
  in its own pane — with the most-recently-used pane winning when several
  match. No match means a new pane: grabbing an arbitrary idle pane would
  steal another command's pane and destroy the rerun-lands-in-the-same-pane
  property. sidemux never reuses a busy pane and never touches panes owned by
  other agents. A reused pane sitting in the wrong directory gets a
  `cd '<cwd>' && ` prefix.
- Panes close automatically after a clean exit when
  `SIDEMUX_CLOSE_ON_SUCCESS=1` (off by default): a foreground command exiting
  `0` destroys its pane, while a failed command leaves the pane up for
  inspection. A per-run `close: true` still forces closing regardless of exit
  code.

## Garbage collection

Cleanup is **event-driven**: it piggybacks on tool calls (throttled to at most
once per short interval) — there are no timers, and an idle server does no
background work.

- **Idle-pane TTL.** A finished one-shot pane — including a _failed_ one, whose
  output stays inspectable until then — is collected once its last use is older
  than `SIDEMUX_IDLE_PANE_TTL_MS` (default 15 minutes). Busy panes,
  persistent (background) panes, and other agents' panes are never touched.
- **Dead-server window sweep.** Owner windows carry `@smux_agent_id`,
  `@smux_server_pid`, and `@smux_last_seen_at`. Each sweep does one tmux
  inventory pass, checks pid liveness locally, and kills idle owner windows
  whose sidemux server process is gone. Windows with busy panes are skipped.
  (A recycled pid can make a dead server look alive; that merely delays
  collection.)
- **Stale-busy recovery.** If a server crashes mid-run, its pane would be
  marked busy forever; the dead server pid is detected and the pane becomes
  reusable and collectable again.

Ownership survives restarts: because the default agent id is derived from the
server's working directory, a restarted MCP server in the same project has the
same id and adopts — rather than orphans — the panes its predecessor created.
