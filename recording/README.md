# Demo recordings

Reproducible pipeline that renders the README demo GIFs/MP4 with
[VHS](https://github.com/charmbracelet/vhs), driving the **real** sidemux
server through a scripted MCP stdio client (`agent-demo.mjs`) — nothing on
screen is mocked except the demo project's command output.

## Render

```bash
pnpm build                       # the tapes run dist/index.js
recording/record.sh              # all tapes
recording/record.sh demo         # just one
```

Outputs: `assets/demo.gif` + `assets/demo.mp4` (hero) and
`assets/usage/<name>.gif` (walkthroughs). Commit the GIFs; nothing here
auto-pushes.

Requires: `vhs`, `tmux ≥ 3.2`, `node ≥ 18`, `pnpm`, and a
"JetBrainsMono Nerd Font" install (the tmux theme uses nerd-font pill glyphs).

## Hermetic where it matters

- Every tape runs on an **isolated tmux socket** (`-L smux-demo`) with the
  recording-only `tmux-demo.conf` — your real tmux server and config are never
  touched or shown.
- `record.sh` points `XDG_CONFIG_HOME` at a scratch dir, so nothing reads
  your real `~/.config/sidemux`.
- The on-screen project is the synthetic `demo-project/` fixture (`acme-web`):
  its build/test/dev scripts print realistic vite/vitest-style output with no
  personal data. A fresh copy is seeded per tape so journeys don't bleed.
- Panes sidemux creates use `panerc` (bare `\W ❯` prompt) instead of the
  recorder's real shell rc.

## Files

| File              | Role                                                             |
| ----------------- | ---------------------------------------------------------------- |
| `record.sh`       | Seed fixture + scratch XDG home, run each tape, emit the GIFs.   |
| `agent-demo.mjs`  | Scripted MCP client — the "agent" whose tool calls you watch.    |
| `tapes/demo.tape` | Hero: build → failing test → grep → dev server, with two Prefix+e dashboard-popup peeks. |
| `tapes/dashboard.tape` | The standalone `sidemux dashboard` TUI over a seeded workspace. |
| `tmux-demo.conf`  | Recording-only tmux theme (pill status line, no external deps).  |
| `demo-project/`   | Synthetic `acme-web` fixture with chatty build/test/dev scripts. |
| `panerc`          | Minimal bash rc for panes created during recordings.             |
