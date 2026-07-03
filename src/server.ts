import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SidemuxService } from './service.js';

const VERSION = '0.1.0';

type Extra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number };
  }) => Promise<void>;
};

/**
 * Wire a progress reporter so MCP clients with long tool timeouts see
 * heartbeats during blocking waits instead of assuming the server hung.
 */
function progressReporter(extra: Extra): ((elapsedMs: number) => void) | undefined {
  const token = extra._meta?.progressToken;
  if (token === undefined) return undefined;
  return (elapsedMs) => {
    void extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: Math.round(elapsedMs / 1000) },
      })
      .catch(() => undefined);
  };
}

function toResult(structured: Record<string, unknown>, summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
    structuredContent: structured,
  };
}

const paneField = z
  .string()
  .optional()
  .describe(
    'Target pane: tmux pane id ("%5"), tmux target ("session:1.2"), or the name of a pane sidemux created',
  );

export function buildServer(service: SidemuxService): McpServer {
  const server = new McpServer({ name: 'sidemux', version: VERSION });

  server.registerTool(
    'run',
    {
      title: 'Run a command in a tmux pane',
      description:
        'Run a shell command in a tmux pane and wait for it to finish. Creates a visible ' +
        'pane automatically (in your current working directory) if none is given. Blocks up ' +
        'to timeout_ms; if the command is still running you get status="running" — call wait ' +
        'next, do NOT poll with read. The returned tail is usually all you need on success; ' +
        'only read more on failure. Use background=true for dev servers and watchers.',
      inputSchema: {
        command: z.string().describe('Shell command to run'),
        pane: paneField,
        name: z
          .string()
          .optional()
          .describe('Friendly name for the pane (title becomes "smux:<name>"; reusable target)'),
        cwd: z
          .string()
          .optional()
          .describe('Working directory; defaults to the agent\'s current working directory'),
        project: z
          .string()
          .optional()
          .describe(
            'Monorepo package to target (pnpm-workspace/nx): runs in that package\'s ' +
              'directory with a pane named after it. Errors listing valid names if unknown.',
          ),
        timeout_ms: z.number().int().positive().max(600_000).default(60_000),
        background: z
          .boolean()
          .default(false)
          .describe('Return immediately without waiting (dev servers, watch mode)'),
        close: z
          .boolean()
          .default(false)
          .describe(
            'Destroy the pane once the command exits (one-shot test/lint/build — keeps ' +
              'the terminal tidy). The tail is captured first. Ignored for background runs, ' +
              "timeouts, and panes sidemux didn't create.",
          ),
      },
      outputSchema: {
        job_id: z.string(),
        pane: z.string(),
        status: z.enum(['running', 'done', 'failed', 'unknown']),
        exit_code: z.number().nullable(),
        duration_ms: z.number(),
        tail: z.string(),
        closed: z.boolean(),
      },
    },
    async (args, extra) => {
      const result = await service.run(args, progressReporter(extra as unknown as Extra));
      const summary =
        result.status === 'running'
          ? `[${result.job_id}] still running in ${result.pane} — call wait with this job_id`
          : `[${result.job_id}] ${result.status} (exit ${result.exit_code}) in ${result.duration_ms}ms\n${result.tail}`;
      return toResult({ ...result }, summary);
    },
  );

  server.registerTool(
    'wait',
    {
      title: 'Wait for a job, pattern, or idle pane',
      description:
        'Block until a job exits, output matches a regex, or the pane goes idle. One call ' +
        'replaces polling — sidemux polls tmux locally. On timeout you get status="timeout" ' +
        'and can simply call wait again (the job keeps its state). Use until="pattern" for ' +
        'server-ready lines, until="idle" before answering interactive prompts.',
      inputSchema: {
        job_id: z.string().optional().describe('Job id returned by run'),
        pane: paneField,
        until: z.enum(['exit', 'pattern', 'idle']).default('exit'),
        pattern: z
          .string()
          .optional()
          .describe('Regex to watch for (required when until="pattern")'),
        idle_ms: z
          .number()
          .int()
          .positive()
          .default(2000)
          .describe('Quiet time that counts as idle (3x for non-shell foreground commands)'),
        timeout_ms: z.number().int().positive().max(600_000).default(120_000),
      },
      outputSchema: {
        status: z.enum(['exit', 'pattern', 'idle', 'timeout']),
        exit_code: z.number().nullable(),
        matched_line: z.string().nullable(),
        elapsed_ms: z.number(),
        tail: z.string(),
      },
    },
    async (args, extra) => {
      const result = await service.wait(args, progressReporter(extra as unknown as Extra));
      const head =
        result.status === 'pattern'
          ? `matched: ${result.matched_line}`
          : result.status === 'exit'
            ? `exit ${result.exit_code}`
            : result.status;
      return toResult({ ...result }, `${head} after ${result.elapsed_ms}ms\n${result.tail}`);
    },
  );

  server.registerTool(
    'read',
    {
      title: 'Read pane output token-efficiently',
      description:
        'Read output from a pane. Default since="last-read" returns only NEW output since ' +
        'your previous read — cheap to call repeatedly. When investigating a failure, grep ' +
        'first (e.g. grep="error|FAIL" with context), tail second; never dump full scrollback. ' +
        'since="job" returns everything a job printed; since="screen" the visible pane.',
      inputSchema: {
        job_id: z.string().optional(),
        pane: paneField,
        since: z.enum(['last-read', 'job', 'screen']).default('last-read'),
        lines: z.number().int().positive().max(2000).default(100).describe('Tail cap after filtering'),
        grep: z.string().optional().describe('Regex filter; only matching lines (plus context) return'),
        context: z.number().int().min(0).max(10).default(2),
        max_bytes: z.number().int().positive().max(65_536).default(8192),
      },
      outputSchema: {
        text: z.string(),
        lines_returned: z.number(),
        truncated: z.boolean(),
        cursor_reset: z.boolean(),
        job_status: z.enum(['running', 'done', 'failed', 'unknown']).nullable(),
        exit_code: z.number().nullable(),
      },
    },
    async (args) => {
      const result = await service.read(args);
      const notes = [
        result.truncated ? 'truncated' : null,
        result.cursor_reset ? 'cursor reset (continuity broke; this is a tail snapshot)' : null,
        result.job_status ? `job ${result.job_status}` : null,
      ]
        .filter(Boolean)
        .join(', ');
      return toResult(
        { ...result },
        `${result.lines_returned} lines${notes ? ` (${notes})` : ''}\n${result.text}`,
      );
    },
  );

  server.registerTool(
    'send_keys',
    {
      title: 'Type into a pane',
      description:
        'Type into a pane: answer interactive prompts or send control keys. text is sent ' +
        'literally; special keys go in keys (tmux names: "Enter", "C-c", "Up", "Escape", ' +
        '"Tab"). Read the pane first so you know what you are answering. Refuses the ' +
        "agent's own pane.",
      inputSchema: {
        pane: paneField,
        job_id: z.string().optional(),
        text: z.string().optional().describe('Literal text (not interpreted as key names)'),
        keys: z.array(z.string()).optional().describe('tmux key names, sent after text'),
        press_enter: z.boolean().default(false).describe('Press Enter after text/keys'),
      },
      outputSchema: { ok: z.boolean(), pane: z.string() },
    },
    async (args) => {
      const result = await service.sendKeys(args);
      return toResult({ ...result }, `sent to ${result.pane}`);
    },
  );

  server.registerTool(
    'list_panes',
    {
      title: 'List tmux panes with job status',
      description:
        'List tmux panes with sidemux job status. Default scope: panes sidemux created plus ' +
        "the agent's own session. all=true lists every pane on the server.",
      inputSchema: {
        all: z.boolean().default(false),
      },
      outputSchema: {
        panes: z.array(
          z.object({
            pane: z.string(),
            target: z.string(),
            title: z.string(),
            current_command: z.string(),
            size: z.string(),
            managed: z.boolean(),
            job_id: z.string().nullable(),
            job_status: z.enum(['running', 'done', 'failed', 'unknown']).nullable(),
          }),
        ),
      },
    },
    async (args) => {
      const panes = await service.listPanes(args.all);
      const summary =
        panes.length === 0
          ? 'no panes'
          : panes
              .map(
                (p) =>
                  `${p.pane} ${p.target} ${p.title || p.current_command}` +
                  (p.job_id ? ` [${p.job_id}: ${p.job_status}]` : ''),
              )
              .join('\n');
      return toResult({ panes }, summary);
    },
  );

  server.registerTool(
    'kill',
    {
      title: 'Interrupt a job or destroy a managed pane',
      description:
        'Interrupt or terminate. mode="interrupt" sends Ctrl-C (stops dev servers, stuck ' +
        'commands — the pane survives). mode="kill-pane" destroys the pane itself and only ' +
        'works on panes sidemux created.',
      inputSchema: {
        job_id: z.string().optional(),
        pane: paneField,
        mode: z.enum(['interrupt', 'kill-pane']).default('interrupt'),
      },
      outputSchema: { ok: z.boolean(), pane: z.string(), mode: z.string() },
    },
    async (args) => {
      const result = await service.kill(args);
      return toResult({ ...result }, `${result.mode} → ${result.pane}`);
    },
  );

  server.registerTool(
    'close_all',
    {
      title: 'Close all sidemux panes',
      description:
        'Destroy every pane sidemux created this session (kill-pane on each), including ' +
        'ones with a command still running. Leaves your own editor/shell panes untouched. ' +
        'Use to tidy up sidecar panes in one call when you are done.',
      inputSchema: {},
      outputSchema: { closed: z.array(z.string()), count: z.number() },
    },
    async () => {
      const result = await service.closeAll();
      return toResult(
        { ...result },
        result.count === 0 ? 'no sidemux panes to close' : `closed ${result.count} pane(s)`,
      );
    },
  );

  return server;
}
