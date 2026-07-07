import { describe, expect, test } from 'vitest';
import {
  estimateTokens,
  mergeStats,
  parseStats,
  StatsTracker,
} from '../../src/core/stats.js';
import { formatTokens, renderStats } from '../../src/dashboard.js';

describe('StatsTracker', () => {
  test('accumulates per role and round-trips through encode/parse', () => {
    const tracker = new StatsTracker();
    tracker.record('pnpm lint', 4000, 400);
    tracker.record('pnpm lint', 2000, 100);
    tracker.record('pnpm vitest run', 8000, 2048);
    expect(parseStats(tracker.encoded())).toEqual({
      lint: { ai: 6000, smux: 500, responses: 2 },
      test: { ai: 8000, smux: 2048, responses: 1 },
    });
  });

  test('classifies via the shared role classifier', () => {
    const tracker = new StatsTracker();
    tracker.record('pnpm exec nx run web:e2e', 10, 5);
    tracker.record('some-unknown-tool', 10, 5);
    const stats = parseStats(tracker.encoded());
    expect(Object.keys(stats).sort()).toEqual(['e2e', 'other']);
  });
});

describe('parseStats', () => {
  test('malformed or empty input reads as empty', () => {
    expect(parseStats(null)).toEqual({});
    expect(parseStats('')).toEqual({});
    expect(parseStats('not json')).toEqual({});
    expect(parseStats('[1,2]')).toEqual({});
    expect(parseStats('{"lint":{"ai":"NaN"}}')).toEqual({});
  });

  test('unknown roles are dropped', () => {
    expect(parseStats('{"bogus":{"ai":1,"smux":1,"responses":1}}')).toEqual({});
  });
});

describe('mergeStats', () => {
  test('sums the same role across windows and skips nulls', () => {
    const a = '{"lint":{"ai":100,"smux":10,"responses":1}}';
    const b = '{"lint":{"ai":50,"smux":5,"responses":2},"build":{"ai":8,"smux":8,"responses":1}}';
    expect(mergeStats([a, null, b])).toEqual({
      lint: { ai: 150, smux: 15, responses: 3 },
      build: { ai: 8, smux: 8, responses: 1 },
    });
  });
});

describe('estimateTokens / formatTokens', () => {
  test('estimates ~4 bytes per token, rounding up', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(1)).toBe(1);
    expect(estimateTokens(4096)).toBe(1024);
  });

  test('formats counts compactly', () => {
    expect(formatTokens(812)).toBe('812');
    expect(formatTokens(4200)).toBe('4.2k');
    expect(formatTokens(1_300_000)).toBe('1.3M');
  });
});

describe('renderStats', () => {
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
  const strip = (line: string): string => line.replace(ansiPattern, '');

  test('empty stats render nothing', () => {
    expect(renderStats({}, 80)).toEqual([]);
  });

  test('renders a header, one row per role in role order, and a total', () => {
    const lines = renderStats(
      {
        lint: { ai: 40_000, smux: 4_000, responses: 3 },
        test: { ai: 80_000, smux: 8_000, responses: 2 },
      },
      80,
    ).map(strip);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('tokens');
    expect(lines[0]).toContain('SAVED');
    expect(lines[1]).toMatch(/^test\s+20\.0k\s+2\.0k\s+90%/);
    expect(lines[2]).toMatch(/^lint\s+10\.0k\s+1\.0k\s+90%/);
    expect(lines[3]).toMatch(/^total\s+30\.0k\s+3\.0k\s+90%/);
  });

  test('a single role skips the total row', () => {
    const lines = renderStats({ lint: { ai: 8, smux: 4, responses: 1 } }, 80);
    expect(lines).toHaveLength(2);
  });
});
