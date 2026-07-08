---
description: Close this cwd/agent's completed sidemux panes
---

Close completed tmux panes owned by this cwd/agent by calling the sidemux
`close_owned` MCP tool. Do not force-close running panes unless the user
explicitly asks for force cleanup. Then report, in one line, how many panes were
closed and how many were skipped.
