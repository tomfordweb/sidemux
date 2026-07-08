import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runBenchmark } from "./bench/run.js";
import { loadConfig } from "./config.js";
import { loadGlobalFileConfig } from "./config-file.js";
import { runDashboard } from "./dashboard.js";
import { runInit } from "./init/install.js";
import { buildServer } from "./server.js";
import { SidemuxService } from "./service.js";
import { TmuxClient } from "./tmux/client.js";
import { createTmuxRunner } from "./tmux/exec.js";

async function serve(): Promise<void> {
  const config = loadConfig(process.env, process.cwd(), loadGlobalFileConfig());
  const runner = createTmuxRunner({ socketName: config.socketName });
  const client = new TmuxClient(runner);
  const service = new SidemuxService(client, config);
  const server = buildServer(service);
  await server.connect(new StdioServerTransport());
}

async function runCloseOwned(argv: string[]): Promise<number> {
  const force = argv.includes("--force");
  const cwdIdIndex = argv.indexOf("--cwd-id");
  const cwdId = cwdIdIndex >= 0 ? argv[cwdIdIndex + 1] : undefined;
  if (cwdIdIndex >= 0 && !cwdId) {
    console.error("sidemux close-owned: --cwd-id requires a value");
    return 2;
  }

  const env = cwdId ? { ...process.env, SIDEMUX_AGENT_ID: cwdId } : process.env;
  const config = loadConfig(env, process.cwd(), loadGlobalFileConfig());
  const runner = createTmuxRunner({ socketName: config.socketName });
  const service = new SidemuxService(new TmuxClient(runner), config, env);
  const result = await service.closeOwned({ force });
  console.log(
    `closed ${result.count} owned pane(s), skipped ${result.skipped_count}`,
  );
  if (result.skipped.length > 0) {
    console.log(
      `skipped running pane(s): ${result.skipped.map((entry) => entry.pane).join(", ")}`,
    );
  }
  return 0;
}

async function main(): Promise<void> {
  // `sidemux init [...]` runs the project installer, `sidemux uninstall`
  // reverts it, and `sidemux benchmark` measures token savings; anything else
  // starts the MCP server on stdio (the default the client launches).
  if (process.argv[2] === "init") {
    const code = await runInit({
      cwd: process.cwd(),
      argv: process.argv.slice(3),
    });
    process.exit(code);
  }
  if (process.argv[2] === "uninstall") {
    const code = await runInit({
      cwd: process.cwd(),
      argv: ["--uninstall", ...process.argv.slice(3)],
    });
    process.exit(code);
  }
  if (process.argv[2] === "benchmark" || process.argv[2] === "bench") {
    const code = await runBenchmark({
      entry: process.argv[1] ?? "sidemux",
      cwd: process.cwd(),
      argv: process.argv.slice(3),
    });
    process.exit(code);
  }
  if (process.argv[2] === "dashboard") {
    const config = loadConfig(
      process.env,
      process.cwd(),
      loadGlobalFileConfig(),
    );
    const runner = createTmuxRunner({ socketName: config.socketName });
    await runDashboard(new TmuxClient(runner), config);
    return;
  }
  if (process.argv[2] === "close-owned" || process.argv[2] === "close") {
    process.exit(await runCloseOwned(process.argv.slice(3)));
  }
  await serve();
}

main().catch((error: unknown) => {
  // stdout belongs to the MCP protocol; diagnostics go to stderr.
  console.error("sidemux fatal:", error);
  process.exit(1);
});
