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

- sidemux runs commands in the `smux` workspace session. Runs are grouped
  by `name`/`project` into tmux windows; with no attached client, the workspace
  is detached — attach with `tmux attach -t smux` to watch, or press `Prefix e`
  from any tmux session for the dashboard popup (tmux ≥ 3.2).
- Personal settings that should apply to every project (session name,
  dashboard key/density, TTLs, …) belong in the global config file
  `~/.config/sidemux/config.toml` rather than per-project `environment`
  blocks; env vars override the file when both are set. See
  [configuration.md](./configuration.md).
- If you use OpenCode rules files (`AGENTS.md`), the "loop" section of
  [skills/tmux-delegate/SKILL.md](../skills/tmux-delegate/SKILL.md) is a
  ready-made paste that teaches the workflow explicitly.
