# sidemux + OpenCode

OpenCode configures MCP servers in `opencode.json` (project scope) or
`~/.config/opencode/opencode.json` (global scope).

## Local checkout (pre-publish)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sidemux": {
      "type": "local",
      "command": ["node", "/path/to/sidemux/dist/index.js"],
      "enabled": true
    }
  }
}
```

## After the npm publish

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "sidemux": {
      "type": "local",
      "command": ["npx", "-y", "sidemux"],
      "enabled": true
    }
  }
}
```

## Environment

Optional configuration is passed through the `environment` key:

```json
"sidemux": {
  "type": "local",
  "command": ["npx", "-y", "sidemux"],
  "environment": {
    "SIDEMUX_SESSION": "smux"
  },
  "enabled": true
}
```

## Notes

- The tmux behavior is the same as everywhere else: inside tmux, sidemux
  splits a sidecar pane; outside tmux, it creates a detached `smux` session.
- If you use OpenCode rules files (`AGENTS.md`), the "loop" section of
  [skills/tmux-delegate/SKILL.md](../skills/tmux-delegate/SKILL.md) is a
  ready-made paste that teaches the workflow explicitly.
