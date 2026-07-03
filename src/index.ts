import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runBenchmark } from './bench/run.js';
import { loadConfig } from './config.js';
import { runInit } from './init/install.js';
import { buildServer } from './server.js';
import { SidemuxService } from './service.js';
import { TmuxClient } from './tmux/client.js';
import { createTmuxRunner } from './tmux/exec.js';

async function serve(): Promise<void> {
  const config = loadConfig();
  const runner = createTmuxRunner({ socketName: config.socketName });
  const client = new TmuxClient(runner);
  const service = new SidemuxService(client, config);
  const server = buildServer(service);
  await server.connect(new StdioServerTransport());
}

async function main(): Promise<void> {
  // `sidemux init [...]` runs the project installer, `sidemux uninstall`
  // reverts it, and `sidemux benchmark` measures token savings; anything else
  // starts the MCP server on stdio (the default the client launches).
  if (process.argv[2] === 'init') {
    const code = await runInit({ cwd: process.cwd(), argv: process.argv.slice(3) });
    process.exit(code);
  }
  if (process.argv[2] === 'uninstall') {
    const code = await runInit({
      cwd: process.cwd(),
      argv: ['--uninstall', ...process.argv.slice(3)],
    });
    process.exit(code);
  }
  if (process.argv[2] === 'benchmark' || process.argv[2] === 'bench') {
    const code = await runBenchmark({
      entry: process.argv[1]!,
      cwd: process.cwd(),
      argv: process.argv.slice(3),
    });
    process.exit(code);
  }
  await serve();
}

main().catch((error: unknown) => {
  // stdout belongs to the MCP protocol; diagnostics go to stderr.
  console.error('sidemux fatal:', error);
  process.exit(1);
});
