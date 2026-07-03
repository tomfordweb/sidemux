/**
 * `sidemux benchmark`: measure how many tokens an agent's context ingests when
 * your project's commands run inline (all output lands in context) versus
 * through sidemux (run returns exit code + a 10-line tail). Each --command is
 * run twice — once locally as the inline baseline, once in a tmux pane through
 * the sidemux server — and the result is a markdown table.
 *
 * The benchmark spawns the sidemux server itself (the same entry script that
 * is running this command) over real MCP stdio, against a throwaway tmux
 * socket — the user's tmux server is never touched.
 *
 * Tokens are estimated as ceil(chars / 4) — the usual rough rate for
 * English/code text.
 */
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export interface BenchOptions {
  /** Path to the sidemux entry script (spawned with no args to serve MCP). */
  entry: string;
  /** Directory the commands run in (both inline and in the pane). */
  cwd: string;
  argv: string[];
  out?: NodeJS.WritableStream;
}

const HELP = `sidemux benchmark — measure token savings of the sidemux flow vs inline runs.

Usage: sidemux benchmark --command "cmd" [--command "cmd"]...

  --command "cmd"      A real command from the current directory to bench
                        (repeatable, e.g. --command "pnpm test")
  --help, -h           Show this help

Environment:
  SIDEMUX_BENCH_TIMEOUT_MS          Per-command sidemux run timeout (default: 900000)
  SIDEMUX_BENCH_REQUEST_TIMEOUT_MS  MCP request timeout (default: run timeout + 60000)

Each command runs twice: once inline (its full output is the baseline — what a
Bash tool call would inject into an agent's context) and once through the
sidemux server over real MCP stdio on a throwaway tmux socket. The table shows
the estimated tokens an agent ingests each way. Requires tmux.
`;

interface ToolResult {
  structuredContent?: unknown;
  content?: unknown;
}

interface Measurement {
  inline: number;
  sidemux: number;
}

const tokens = (chars: number): number => Math.ceil(chars / 4);
const fmt = (n: number): string => n.toLocaleString('en-US');
const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;

function envDurationMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Chars the agent actually ingests from one MCP tool result. */
function resultChars(result: unknown): number {
  const r = result as ToolResult;
  return JSON.stringify(r.structuredContent ?? r.content).length;
}

/** Run a command locally and return the chars of its combined output (inline baseline). */
function inlineChars(command: string, cwd: string): number {
  return execFileSync('sh', ['-c', `${command} 2>&1 || true`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd,
  }).length;
}

async function benchCommand(client: Client, command: string, cwd: string): Promise<Measurement> {
  const runTimeoutMs = envDurationMs('SIDEMUX_BENCH_TIMEOUT_MS', DEFAULT_RUN_TIMEOUT_MS);
  const requestTimeoutMs = envDurationMs('SIDEMUX_BENCH_REQUEST_TIMEOUT_MS', runTimeoutMs + 60_000);
  const run = await client.callTool({
    name: 'run',
    arguments: { command, timeout_ms: runTimeoutMs, close: true },
  }, undefined, {
    // Long builds/e2e runs are exactly what the benchmark is meant to measure.
    timeout: requestTimeoutMs,
    resetTimeoutOnProgress: true,
    maxTotalTimeout: requestTimeoutMs,
  });
  return { inline: inlineChars(command, cwd), sidemux: resultChars(run) };
}

function parseCommands(argv: string[]): { commands: string[]; help: boolean } {
  const commands: string[] = [];
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--command') {
      const value = argv[++i];
      if (value) commands.push(value);
    } else if (arg.startsWith('--command=')) {
      const value = arg.slice('--command='.length);
      if (value) commands.push(value);
    }
  }
  return { commands, help };
}

/** Entry point for `sidemux benchmark`. Returns a process exit code. */
export async function runBenchmark(options: BenchOptions): Promise<number> {
  const out = options.out ?? process.stdout;
  const { commands, help } = parseCommands(options.argv);
  if (help) {
    out.write(HELP);
    return 0;
  }
  if (commands.length === 0) {
    out.write(HELP);
    out.write('\nsidemux benchmark: pass at least one --command to bench.\n');
    return 1;
  }
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
  } catch {
    out.write('sidemux benchmark: tmux not found on PATH — install tmux first.\n');
    return 1;
  }

  const socket = `smux-bench-${process.pid}`;
  const client = new Client({ name: 'sidemux-bench', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [options.entry],
      env: {
        ...process.env,
        SIDEMUX_TMUX_SOCKET: socket,
        SIDEMUX_PANE_SHELL: 'sh',
        SIDEMUX_SESSION: 'bench',
        // Force the detached-session path so the bench never splits the
        // user's real window, even when run from inside tmux.
        TMUX: '',
        TMUX_PANE: '',
      },
      cwd: options.cwd,
    }),
  );

  try {
    out.write(
      `sidemux benchmark: running ${commands.length} command(s) twice each ` +
        '(inline baseline + sidemux pane, throwaway tmux socket)…\n\n',
    );
    const rows: Array<[string, Measurement]> = [];
    for (const command of commands) {
      rows.push([`\`${command}\``, await benchCommand(client, command, options.cwd)]);
    }

    let totalInline = 0;
    let totalSidemux = 0;
    let anyQuiet = false;
    out.write('| Command | Inline | sidemux | Reduction |\n');
    out.write('|---------|-------:|--------:|----------:|\n');
    for (const [name, m] of rows) {
      totalInline += m.inline;
      totalSidemux += m.sidemux;
      const ratio = m.inline / m.sidemux;
      const reduction = ratio >= 2 ? `${ratio.toFixed(0)}×` : ratio >= 1 ? `${ratio.toFixed(1)}×` : '—';
      if (ratio < 1) anyQuiet = true;
      out.write(
        `| ${name} | ${fmt(tokens(m.inline))} tok | ${fmt(tokens(m.sidemux))} tok | ${reduction} |\n`,
      );
    }
    const pct = (100 * (1 - totalSidemux / totalInline)).toFixed(1);
    out.write(
      `\nTotal: ${fmt(tokens(totalInline))} → ${fmt(tokens(totalSidemux))} estimated tokens ` +
        `(${pct}% saved). Tokens ≈ chars / 4.\n`,
    );
    if (anyQuiet) {
      out.write(
        '— = the command printed less than the tool-result envelope; savings scale ' +
          'with output volume, so quiet commands have nothing to save.\n',
      );
    }
    return 0;
  } finally {
    await client.close();
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], { stdio: 'ignore' });
    } catch {
      // no server left — fine
    }
  }
}
