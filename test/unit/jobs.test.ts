import { describe, expect, test } from 'vitest';
import {
  buildSentinelSuffix,
  makeJobId,
  parseSentinel,
  scrubOutput,
  sentinelRegex,
  stripSentinel,
} from '../../src/core/jobs.js';

describe('sentinel', () => {
  test('job ids are unique and shell-quote safe', () => {
    const a = makeJobId();
    const b = makeJobId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^j[0-9a-f]{6}$/);
  });

  test('posix suffix uses $?, fish uses $status', () => {
    expect(buildSentinelSuffix('j1a2b3', 'posix')).toBe(
      "; printf '\\n<<SMUX:%s:%d>>\\n' 'j1a2b3' $?",
    );
    expect(buildSentinelSuffix('j1a2b3', 'fish')).toBe(
      "; printf '\\n<<SMUX:%s:%d>>\\n' 'j1a2b3' $status",
    );
  });

  test('MANDATORY: the echoed command line can never match the completion regex', () => {
    // What the pane shows when the shell echoes the typed command back:
    const echoedLine = `$ npm test${buildSentinelSuffix('j1a2b3', 'posix')}`;
    expect(sentinelRegex('j1a2b3').test(echoedLine)).toBe(false);
    // ...because the format string holds literal %d where the regex needs digits.
    expect(parseSentinel([echoedLine], 'j1a2b3')).toBeNull();
  });

  test('parses the completed sentinel and returns the exit code', () => {
    const lines = ['npm test output', '<<SMUX:j1a2b3:0>>', ''];
    expect(parseSentinel(lines, 'j1a2b3')).toBe(0);
    expect(parseSentinel(['<<SMUX:j1a2b3:127>>'], 'j1a2b3')).toBe(127);
  });

  test('ignores sentinels belonging to other jobs', () => {
    expect(parseSentinel(['<<SMUX:jffffff:0>>'], 'j1a2b3')).toBeNull();
  });

  test('scans from the end so the latest sentinel wins', () => {
    const lines = ['<<SMUX:j1a2b3:1>>', 'rerun...', '<<SMUX:j1a2b3:0>>'];
    expect(parseSentinel(lines, 'j1a2b3')).toBe(0);
  });

  test('stripSentinel removes completed sentinel lines but keeps the echo', () => {
    const echoed = `$ make${buildSentinelSuffix('j1a2b3', 'posix')}`;
    const lines = [echoed, 'building...', '<<SMUX:j1a2b3:0>>'];
    expect(stripSentinel(lines, 'j1a2b3')).toEqual([echoed, 'building...']);
  });
});

describe('scrubOutput', () => {
  test('drops any completed sentinel line regardless of job id', () => {
    const lines = ['build output', '<<SMUX:jabc123:0>>', 'more', '<<SMUX:jffffff:127>>'];
    expect(scrubOutput(lines)).toEqual(['build output', 'more']);
  });

  test('scrubs the posix echo suffix, leaving the user command intact', () => {
    const echoed = `$ npm test${buildSentinelSuffix('jabc12', 'posix')}`;
    expect(scrubOutput([echoed])).toEqual(['$ npm test']);
  });

  test('scrubs the fish echo suffix ($status)', () => {
    const echoed = `❯ npm test${buildSentinelSuffix('jabc12', 'fish')}`;
    expect(scrubOutput([echoed])).toEqual(['❯ npm test']);
  });

  test('scrubs a prompt-perturbed echo where the shell widened the gaps', () => {
    // A reflowing prompt can insert extra spaces around the suffix tokens.
    const perturbed =
      "$ npm test ;  printf  '\\n<<SMUX:%s:%d>>\\n'  'jabc12'  $?";
    expect(scrubOutput([perturbed])).toEqual(['$ npm test']);
  });

  test('last-resort residue strip catches a marker the echo regex missed', () => {
    const weird = "$ make; printf garbled <<SMUX:%s:%d>> leftovers";
    expect(scrubOutput([weird])).toEqual(['$ make']);
  });

  test('leaves ordinary output containing no marker untouched', () => {
    const lines = ['compiling foo.ts', 'PASS 12 tests', 'done in 3s'];
    expect(scrubOutput(lines)).toEqual(lines);
  });
});
