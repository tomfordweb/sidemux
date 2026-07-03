import { describe, expect, test } from 'vitest';
import type { DelegatedCommand } from '../../src/init/detect.js';
import {
  delegateJson,
  directiveBlock,
  mergeMcpServer,
  mergeSettingsHook,
  removeMarkedBlock,
  removeMcpServer,
  removeSettingsHook,
  upsertMarkedBlock,
} from '../../src/init/templates.js';

const COMMANDS: DelegatedCommand[] = [
  { role: 'test', command: 'pnpm test', longRunning: false },
  { role: 'dev', command: 'pnpm dev', longRunning: true },
];

describe('directive block', () => {
  test('suggests close for one-shot and background for long-running', () => {
    const block = directiveBlock(COMMANDS);
    expect(block).toContain('`run { command: "pnpm test" }`');
    expect(block).not.toContain('close: true }`'); // one-shots no longer auto-close
    expect(block).toContain('background: true');
    expect(block).toContain('BEGIN sidemux-delegate');
    expect(block).toContain('END sidemux-delegate');
  });

  test('includes the generic catch-all alongside the enumerated commands', () => {
    const block = directiveBlock(COMMANDS);
    expect(block).toContain('should also go through `run`');
    expect(block).toContain('e2e runs');
  });

  test('empty command list yields a generic-only block', () => {
    const block = directiveBlock([]);
    expect(block).not.toContain('- `');
    expect(block).toContain('No project-specific commands are wired up yet');
    expect(block).toContain('full test suites, linters, type checkers');
    expect(block).toContain('BEGIN sidemux-delegate');
    expect(block).toContain('END sidemux-delegate');

    const upserted = upsertMarkedBlock('# My Project\n', block);
    expect(removeMarkedBlock(upserted)).not.toContain('sidemux-delegate');
  });

  test('delegateJson serializes an empty selection', () => {
    expect(JSON.parse(delegateJson([]))).toEqual({ commands: [] });
  });
});

describe('upsert / remove marked block', () => {
  test('appends to existing content, then replaces in place (idempotent)', () => {
    const block = directiveBlock(COMMANDS);
    const once = upsertMarkedBlock('# My Project\n\nHello.\n', block);
    expect(once).toContain('# My Project');
    expect(once).toContain('BEGIN sidemux-delegate');

    const twice = upsertMarkedBlock(once, block);
    expect(twice).toBe(once);
    // exactly one managed block
    expect(twice.match(/BEGIN sidemux-delegate/g)).toHaveLength(1);
  });

  test('remove strips the block and leaves the rest', () => {
    const block = directiveBlock(COMMANDS);
    const withBlock = upsertMarkedBlock('# My Project\n\nHello.\n', block);
    const removed = removeMarkedBlock(withBlock);
    expect(removed).toContain('# My Project');
    expect(removed).not.toContain('sidemux-delegate');
  });

  test('creates content when the file was empty', () => {
    const result = upsertMarkedBlock('', directiveBlock(COMMANDS));
    expect(result).toContain('BEGIN sidemux-delegate');
  });
});

describe('settings hook merge', () => {
  test('adds a Bash PreToolUse guard entry, idempotently', () => {
    const first = mergeSettingsHook(null) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    expect(first.hooks.PreToolUse).toHaveLength(1);
    expect(first.hooks.PreToolUse[0]!.matcher).toBe('Bash');
    expect(first.hooks.PreToolUse[0]!.hooks[0]!.command).toContain('delegate-guard.mjs');

    const second = mergeSettingsHook(first) as typeof first;
    expect(second.hooks.PreToolUse).toHaveLength(1);
  });

  test('preserves unrelated settings and existing hooks', () => {
    const existing = {
      model: 'sonnet',
      hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'prettier' }] }] },
    };
    const merged = mergeSettingsHook(existing) as {
      model: string;
      hooks: { PreToolUse: unknown[] };
    };
    expect(merged.model).toBe('sonnet');
    expect(merged.hooks.PreToolUse).toHaveLength(2);
  });

  test('remove drops only the guard entry and empty containers', () => {
    const merged = mergeSettingsHook({ model: 'x' });
    const removed = removeSettingsHook(merged) as Record<string, unknown>;
    expect(removed.model).toBe('x');
    expect(removed.hooks).toBeUndefined();
  });
});

describe('mcp server merge', () => {
  test('adds sidemux server without clobbering others', () => {
    const merged = mergeMcpServer({ mcpServers: { other: { command: 'x' } } }) as {
      mcpServers: Record<string, unknown>;
    };
    expect(merged.mcpServers.other).toEqual({ command: 'x' });
    expect(merged.mcpServers.sidemux).toEqual({ command: 'npx', args: ['-y', 'sidemux'], env: {} });
  });

  test('leaves an existing sidemux entry untouched', () => {
    const custom = { mcpServers: { sidemux: { command: 'node', args: ['dist/index.js'] } } };
    expect(mergeMcpServer(custom)).toEqual(custom);
  });

  test('writes layout/size env into a new entry when provided', () => {
    const merged = mergeMcpServer(null, {
      SIDEMUX_LAYOUT: 'right',
      SIDEMUX_PANE_SIZE: '40%',
    }) as { mcpServers: { sidemux: { env: Record<string, string> } } };
    expect(merged.mcpServers.sidemux.env).toEqual({
      SIDEMUX_LAYOUT: 'right',
      SIDEMUX_PANE_SIZE: '40%',
    });
  });

  test('refreshes managed env keys on an existing entry, preserving the rest', () => {
    const existing = {
      mcpServers: {
        sidemux: {
          command: 'node',
          args: ['dist/index.js'],
          env: { SIDEMUX_LAYOUT: 'bottom', OTHER: 'keep' },
        },
      },
    };
    const merged = mergeMcpServer(existing, { SIDEMUX_LAYOUT: 'left' }) as {
      mcpServers: { sidemux: { command: string; args: string[]; env: Record<string, string> } };
    };
    expect(merged.mcpServers.sidemux).toEqual({
      command: 'node',
      args: ['dist/index.js'],
      env: { SIDEMUX_LAYOUT: 'left', OTHER: 'keep' },
    });
  });

  test('removeMcpServer strips sidemux but keeps other servers', () => {
    const removed = removeMcpServer({
      mcpServers: { sidemux: { command: 'npx' }, other: { command: 'x' } },
    }) as { mcpServers: Record<string, unknown> };
    expect(removed.mcpServers.sidemux).toBeUndefined();
    expect(removed.mcpServers.other).toEqual({ command: 'x' });
  });

  test('removeMcpServer drops an emptied mcpServers container', () => {
    const removed = removeMcpServer({ mcpServers: { sidemux: { command: 'npx' } } });
    expect(removed).toEqual({});
  });

  test('removeMcpServer is a no-op without a sidemux entry', () => {
    const config = { mcpServers: { other: { command: 'x' } } };
    expect(removeMcpServer(config)).toEqual(config);
  });
});
