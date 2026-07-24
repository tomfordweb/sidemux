#!/usr/bin/env node
// Scripted "agent" for the README recordings: a real MCP stdio client driving
// the real sidemux server, printing each tool call and its compact result the
// way a coding agent would see them. Journeys:
//
//   node agent-demo.mjs hero   # build → failing test → grep the error → dev server
//   node agent-demo.mjs seed   # populate the workspace for the dashboard tape
//
// Env (set by record.sh): SIDEMUX_REPO, SIDEMUX_TMUX_SOCKET, DEMO_DIR.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repo = process.env.SIDEMUX_REPO ?? new URL("..", import.meta.url).pathname;
const demoDir = process.env.DEMO_DIR ?? process.cwd();
const journey = process.argv[2] ?? "hero";

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const mauve = (s) => `\x1b[35m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${repo}/dist/index.js`],
  cwd: demoDir,
  env: {
    ...process.env,
    SIDEMUX_TMUX_SOCKET: process.env.SIDEMUX_TMUX_SOCKET ?? "smux-demo",
    SIDEMUX_AGENT_ID: "demo",
    SIDEMUX_PANE_SHELL: `bash --rcfile ${repo}/recording/panerc`,
  },
});
const client = new Client({ name: "agent-demo", version: "0.0.0" });
await client.connect(transport);

let contextLines = 0;
let paneLines = 0;

function fmtArgs(args) {
  const parts = Object.entries(args)
    .filter(([k]) => k !== "description")
    .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v}"` : v}`);
  return `{ ${parts.join(", ")} }`;
}

async function call(name, args, note) {
  console.log(`${mauve("●")} ${bold(name)} ${dim(fmtArgs(args))}`);
  const res = await client.callTool({ name, arguments: args });
  const s = res.structuredContent ?? {};
  const text = s.tail ?? s.text ?? "";
  const lines = text ? text.trimEnd().split("\n") : [];
  contextLines += lines.length;
  if (name === "run" && typeof s.exit_code === "number") {
    const ok = s.exit_code === 0;
    const mark = ok ? green("✓") : red("✗");
    console.log(
      `  ${dim("⎿")} ${mark} exit ${s.exit_code} ${dim(`in ${(s.duration_ms / 1000).toFixed(1)}s · pane ${s.pane} · tail ${lines.length} lines`)}`,
    );
  } else if (name === "wait") {
    console.log(
      `  ${dim("⎿")} ${green("✓")} ${s.status}${s.matched_line ? `: ${cyan(s.matched_line.trim())}` : ""} ${dim(`after ${(s.elapsed_ms / 1000).toFixed(1)}s`)}`,
    );
  } else if (name === "read") {
    console.log(`  ${dim("⎿")} ${s.lines_returned} lines${s.truncated ? dim(" (truncated)") : ""}`);
  } else {
    console.log(`  ${dim("⎿")} ok`);
  }
  for (const l of lines.slice(-8)) console.log(`    ${dim("│")} ${l}`);
  if (note) console.log(`  ${dim(note)}`);
  console.log();
  return s;
}

if (journey === "hero") {
  console.log(dim("agent session — every command below runs in a visible tmux pane;"));
  console.log(dim("the agent sees only what is printed here.\n"));
  await sleep(600);

  const build = await call("run", {
    command: "pnpm build",
    description: "production build",
    timeout_ms: 60_000,
  });
  paneLines += 170;
  await sleep(800);

  const test = await call("run", {
    command: "pnpm test:broken",
    description: "test gate",
    timeout_ms: 60_000,
  });
  paneLines += 40;
  await sleep(600);

  if (test.exit_code !== 0) {
    await call("read", {
      job_id: test.job_id,
      grep: "FAIL|✗|AssertionError",
      context: 2,
    });
  }
  await sleep(800);

  const dev = await call("run", {
    command: "pnpm dev",
    description: "dev server",
    background: true,
  });
  await call("wait", {
    job_id: dev.job_id,
    until: "pattern",
    pattern: "Local:.*http",
  });
  await sleep(5000); // leave the dev server streaming for the second popup peek

  await call("close_all", {});
  console.log(
    `${bold("Σ")} ~${paneLines + 60} lines of output stayed in tmux — the agent ingested ${bold(String(contextLines))}.`,
  );
  void build;
} else if (journey === "seed") {
  // Populate the workspace for the dashboard tape: a running dev server, a
  // passing test run, and a build still in flight. Panes outlive this process.
  const dev = await call("run", { command: "pnpm dev", description: "dev server", background: true });
  await call("wait", { job_id: dev.job_id, until: "pattern", pattern: "Local:.*http" });
  await call("run", { command: "pnpm test", description: "test gate", timeout_ms: 60_000 });
  await call("run", { command: "pnpm build", description: "production build", background: true });
  console.log(dim("workspace seeded."));
} else {
  console.error(`unknown journey: ${journey}`);
  process.exitCode = 1;
}

await client.close();
