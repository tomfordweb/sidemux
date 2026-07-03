# sidemux + Claude Code

There are two ways to install sidemux in Claude Code: as a plain MCP server,
or as the bundled plugin, which ships the MCP server together with a
`tmux-delegate` skill that teaches Claude the delegation workflow.

## Option A — MCP server only

From a local checkout (pre-publish):

```bash
pnpm build   # once, in the sidemux repo
claude mcp add sidemux -- node /path/to/sidemux/dist/index.js
```

After the npm publish this becomes:

```bash
claude mcp add sidemux -- npx -y sidemux
```

To enable sidemux in every project, add `--scope user`; running the command
inside a project registers it for that project only.

## Option B — Plugin (server + skill)

The plugin ships the MCP server config plus a skill that triggers whenever
Claude is about to run something long-running ("run the build", "start the dev
server") and steers it into the run → wait → read-on-failure loop.

From a local checkout:

```bash
claude plugin marketplace add /path/to/sidemux
claude plugin install sidemux@sidemux
```

Pre-publish note: the bundled `.mcp.json` invokes `npx -y sidemux`, which only
resolves once the package is on npm. Until then, run `npm link` once in the
sidemux repo so that `npx sidemux` resolves to your local build — or use
Option A.

## Auto-delegate a project's test/lint/build

To make Claude route a project's `pnpm test` / build / dev commands through
sidemux automatically — instead of relying on the skill each time — run
`sidemux init` in that project. It installs a PreToolUse guard hook plus a
CLAUDE.md directive. After upgrading sidemux (or adding scripts), `sidemux
init --sync` refreshes the generated files, keeps your selection, and asks
about any newly detected commands. `sidemux uninstall` reverts it all. See
[setup-delegation.md](./setup-delegation.md) for the full walkthrough.

## Long-running commands

Claude Code's per-tool-call timeout (`MCP_TOOL_TIMEOUT`, plus `MCP_TIMEOUT`
for server startup) must exceed your longest `wait`. The defaults are usually
fine, because sidemux's own `timeout_ms` (default 120s for `wait`) returns a
re-armable `status: "timeout"` result first — Claude then simply calls `wait`
again. For a single long `run` call, raise the timeout enough for the command
or use `background: true` plus `wait`. For very long builds you can raise it:

```bash
export MCP_TOOL_TIMEOUT=600000   # 10 min, milliseconds
```

## Verify the installation

Inside a tmux session, ask Claude:

> run `sleep 5 && echo hello from sidemux` in a pane

You should see a pane split below, the command run there, and Claude report
exit 0 with a short tail — with no polling turns in between.
