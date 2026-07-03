<!-- BEGIN sidemux-delegate (managed by `sidemux init` — re-run to update) -->
## Delegate heavy commands to sidemux

Run these through the sidemux **`run`** MCP tool, not the Bash tool — long output stays in a tmux pane and you get an incremental tail:

- `pnpm test` → `run { command: "pnpm test" }`
- `pnpm lint` → `run { command: "pnpm lint" }`
- `pnpm typecheck` → `run { command: "pnpm typecheck" }`
- `pnpm build` → `run { command: "pnpm build" }`
- `pnpm dev` → `run { command: "pnpm dev", background: true }` then `wait { until: "pattern", … }`

Any other heavy or long-output command — full test suites, linters, type checkers, builds, e2e runs, dev servers — should also go through `run`, even when it isn't listed above (`background: true` for servers/watchers you keep alive).

Prefer the current visible tmux session/window when one is available. If the tool can target an existing pane there, reuse it instead of creating a fresh pane. Panes are reused across runs — rerun a command and it lands back in the same pane (its header shows the command and pane id). `background: true` is for servers/watchers you keep alive and later `kill`; add `close: true` only when you truly want the pane gone afterward.
<!-- END sidemux-delegate -->
