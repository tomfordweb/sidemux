import { describe, expect, test } from 'vitest';
import {
  MANAGED_TITLE_PREFIX,
  parsePaneList,
  parsePaneState,
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
      '%0\tmain:1.0\tzsh\tzsh\t200x50\n' +
      `%7\tmain:1.1\t${MANAGED_TITLE_PREFIX}build\tnode\t200x15\n`;
    const panes = parsePaneList(out);
    expect(panes).toHaveLength(2);
    expect(panes[0]).toMatchObject({
      paneId: '%0',
      target: 'main:1.0',
      managed: false,
      width: 200,
      height: 50,
    });
    expect(panes[1]).toMatchObject({
      paneId: '%7',
      title: `${MANAGED_TITLE_PREFIX}build`,
      currentCommand: 'node',
      managed: true,
      height: 15,
    });
  });

  test('returns empty array for empty output', () => {
    expect(parsePaneList('')).toEqual([]);
  });

  test('throws on malformed line', () => {
    expect(() => parsePaneList('%0\tonly-two')).toThrow(/unexpected list-panes/);
  });
});
