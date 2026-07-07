import { describe, expect, test } from 'vitest';
import {
  MANAGED_TITLE_PREFIX,
  decodeOptionValue,
  encodeOptionValue,
  parsePaneList,
  parsePaneState,
  parseWindowList,
} from '../../src/tmux/formats.js';

describe('parsePaneState', () => {
  test('parses a tab-separated state line', () => {
    const state = parsePaneState('1042\t2000\t12\t50\tzsh\t/home/tom/code\n');
    expect(state).toEqual({
      historySize: 1042,
      historyLimit: 2000,
      cursorY: 12,
      paneHeight: 50,
      currentCommand: 'zsh',
      currentPath: '/home/tom/code',
    });
  });

  test('rejoins paths containing tabs', () => {
    const state = parsePaneState('0\t2000\t0\t50\tbash\t/tmp/a\tb');
    expect(state.currentPath).toBe('/tmp/a\tb');
  });

  test('throws on malformed line', () => {
    expect(() => parsePaneState('garbage')).toThrow(/unexpected pane state/);
  });
});

describe('parsePaneList', () => {
  test('parses multiple panes and flags managed ones by title prefix', () => {
    const out =
      '%0\tmain:1.0\tmain\t1\tcode\tzsh\tzsh\t/home/tom/code\t200x50\t@1\t\t\t\t\t\t\t\t\t\n' +
      `%7\tmain:1.1\tmain\t1\tcode\t${MANAGED_TITLE_PREFIX}build\tnode\t/home/tom/code\t200x15\t@1\t1\tbuild\tpnpm build\t1\toneshot\t123\t0\tagent-1\t4242\tbuild gate\n`;
    const panes = parsePaneList(out);
    expect(panes).toHaveLength(2);
    expect(panes[0]).toMatchObject({
      paneId: '%0',
      target: 'main:1.0',
      sessionName: 'main',
      windowIndex: '1',
      windowName: 'code',
      managed: false,
      width: 200,
      height: 50,
      windowId: '@1',
    });
    expect(panes[1]).toMatchObject({
      paneId: '%7',
      title: `${MANAGED_TITLE_PREFIX}build`,
      currentCommand: 'node',
      currentPath: '/home/tom/code',
      managed: true,
      height: 15,
      managedName: 'build',
      lastCommand: 'pnpm build',
      busy: true,
      paneClass: 'oneshot',
      lastUsedAt: 123,
      lastExitCode: 0,
      agentId: 'agent-1',
      serverPid: 4242,
      description: 'build gate',
    });
  });

  test('decodes base64url-encoded names and commands', () => {
    const command = 'printf "a\tb"\necho done';
    const encoded = `b64:${Buffer.from(command, 'utf8').toString('base64url')}`;
    const out = `%7\tmain:1.1\tmain\t1\tcode\t${MANAGED_TITLE_PREFIX}build\tnode\t/x\t200x15\t@1\t1\tbuild\t${encoded}\t0\toneshot\t123\t0\tagent-1\t\n`;
    expect(parsePaneList(out)[0]).toMatchObject({ lastCommand: command, serverPid: null });
  });

  test('encodeOptionValue round-trips awkward values and passes plain ones through', () => {
    expect(encodeOptionValue('pnpm test')).toBe('pnpm test');
    for (const value of ['a\tb', 'a\nb', 'echo #{pane_id}', ';', 'b64:already']) {
      const encoded = encodeOptionValue(value);
      expect(encoded).not.toMatch(/[\t\n]/);
      expect(decodeOptionValue(encoded)).toBe(value);
    }
  });

  test('returns empty array for empty output', () => {
    expect(parsePaneList('')).toEqual([]);
  });

  test('throws on malformed line', () => {
    expect(() => parsePaneList('%0\tonly-two')).toThrow(/unexpected list-panes/);
  });
});

describe('parseWindowList', () => {
  test('parses tmux window rows', () => {
    const stats = '{"lint":{"ai":8,"smux":4,"responses":1}}';
    expect(parseWindowList(`smux\t0\t@1\tmain\t%1\tagent-1\t123\t456\t${stats}\n`)).toEqual([
      {
        sessionName: 'smux',
        windowIndex: '0',
        windowId: '@1',
        windowName: 'main',
        activePaneId: '%1',
        agentId: 'agent-1',
        serverPid: 123,
        lastSeenAt: 456,
        statsJson: stats,
      },
    ]);
  });

  test('missing stats field reads as null', () => {
    expect(parseWindowList('smux\t0\t@1\tmain\t%1\tagent-1\t123\t456\n')[0]?.statsJson).toBeNull();
  });
});
