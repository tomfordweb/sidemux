# sidemux + Codex

Codex (OpenAI's CLI agent) supports stdio MCP servers via
`~/.codex/config.toml`.

## Local checkout (pre-publish)

```toml
[mcp_servers.sidemux]
command = "node"
args = ["/path/to/sidemux/dist/index.js"]
```

## After the npm publish

```toml
[mcp_servers.sidemux]
command = "npx"
args = ["-y", "sidemux"]
```

## Environment

Optional configuration goes in the same block:

```toml
[mcp_servers.sidemux.env]
SIDEMUX_SESSION = "smux"
# SIDEMUX_MANAGED_ONLY = "1"
```

## Notes

- Run Codex from inside a tmux session and sidemux splits panes beside it.
  Without the agent's tmux env, sidemux hosts a switchable `smux` window in an
  attached tmux session when possible; with no attached client, it creates a
  detached `smux` session instead (`tmux attach -t smux` to watch).
- Codex has its own tool-call timeout (`tool_timeout_sec` in newer releases).
  sidemux's `wait` returns a re-armable `timeout` status before typical
  defaults fire; the agent simply calls `wait` again to keep waiting. For a
  single long `run` call, set Codex's timeout high enough for the command or
  prefer `background: true` plus `wait`.
- Codex has no skill system, but the tool descriptions themselves teach the
  run → wait → read-on-failure loop, which is enough for day-to-day use. If
  you maintain an `AGENTS.md`, paste in the "loop" section from
  [skills/tmux-delegate/SKILL.md](../skills/tmux-delegate/SKILL.md) to make
  the workflow explicit.
