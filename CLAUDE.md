<!-- BEGIN sidemux-delegate (managed by `sidemux init` — re-run to update) -->

## Delegate heavy commands to sidemux

Run these through the sidemux **`run`** MCP tool, not the Bash tool — long output stays in a tmux pane and you get an incremental tail:

- `pnpm test` → `run { command: "pnpm test", description: "<why>" }`
- `pnpm lint` → `run { command: "pnpm lint", description: "<why>" }`
- `pnpm typecheck` → `run { command: "pnpm typecheck", description: "<why>" }`
- `pnpm build` → `run { command: "pnpm build", description: "<why>" }`
- `pnpm dev` → `run { command: "pnpm dev", description: "<why>", background: true }` then `wait { until: "pattern", … }`

Any other heavy or long-output command — full test suites, linters, type checkers, builds, e2e runs, dev servers — should also go through `run`, even when it isn't listed above (`background: true` for servers/watchers you keep alive).

Every `run` requires a `description` — one line of context for the human watching the panes: "<stage> due to <reason>" (e.g. "typecheck gate before release", "run scripts at user request"). It shows in the pane header and dashboard.

Panes are reused across runs — rerun a command and it lands back in the same pane (its header shows the command and pane id). `background: true` is for servers/watchers you keep alive and later `kill`; add `close: true` only when you truly want the pane gone afterward.

<!-- END sidemux-delegate -->
