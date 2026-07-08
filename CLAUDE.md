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


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
