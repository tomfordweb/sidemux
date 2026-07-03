import { describe, expect, test } from 'vitest';
import { shapeOutput } from '../../src/core/output.js';

describe('shapeOutput', () => {
  test('strips trailing blank lines, keeps interior ones', () => {
    const result = shapeOutput(['a', '', 'b', '', '  ', '']);
    expect(result.text).toBe('a\n\nb');
    expect(result.linesReturned).toBe(3);
    expect(result.truncated).toBe(false);
  });

  test('tail cap keeps the newest lines and flags truncation', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    const result = shapeOutput(lines, { lines: 3 });
    expect(result.text).toBe('line-7\nline-8\nline-9');
    expect(result.truncated).toBe(true);
  });

  test('grep keeps matches with context and gap markers', () => {
    const lines = [
      'setup',
      'compiling a',
      'ERROR: bad thing',
      'detail line',
      'compiling b',
      'compiling c',
      'compiling d',
      'FAIL: another',
      'teardown',
    ];
    const result = shapeOutput(lines, { grep: 'ERROR|FAIL', context: 1 });
    expect(result.text).toBe(
      ['compiling a', 'ERROR: bad thing', 'detail line', '···', 'compiling d', 'FAIL: another', 'teardown'].join(
        '\n',
      ),
    );
  });

  test('grep with no matches returns empty text', () => {
    const result = shapeOutput(['a', 'b'], { grep: 'nomatch' });
    expect(result.text).toBe('');
    expect(result.linesReturned).toBe(0);
  });

  test('byte cap cuts whole lines from the front — newest output wins', () => {
    const lines = ['old-'.repeat(10), 'mid-'.repeat(10), 'new-'.repeat(10)];
    const result = shapeOutput(lines, { maxBytes: 90 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('new-');
    expect(result.text).not.toContain('old-');
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(90);
  });

  test('single line larger than the byte cap is hard-truncated from the front', () => {
    const result = shapeOutput(['x'.repeat(100)], { maxBytes: 10 });
    expect(result.text).toHaveLength(10);
    expect(result.truncated).toBe(true);
  });

  test('defaults: 100-line tail, 8KB cap', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `l${i}`);
    const result = shapeOutput(lines);
    expect(result.linesReturned).toBe(100);
    expect(result.truncated).toBe(true);
  });
});
