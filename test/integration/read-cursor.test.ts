import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { CursorTracker } from '../../src/core/cursor.js';
import { JobManager } from '../../src/core/jobs.js';
import { waitFor } from '../../src/core/waiter.js';
import { TmuxFixture, tmuxAvailable } from './helpers/tmux-fixture.js';

describe.skipIf(!tmuxAvailable())('incremental reads against real tmux', () => {
  const fx = new TmuxFixture();
  let jobs: JobManager;
  let cursor: CursorTracker;

  async function runToCompletion(command: string): Promise<void> {
    const job = await jobs.launch(fx.firstPane, command, null);
    const result = await waitFor(fx.client, fx.firstPane, jobs, job, {
      until: 'exit',
      timeoutMs: 10_000,
    });
    expect(result.status).toBe('exit');
  }

  beforeAll(async () => {
    await fx.start('/tmp');
    jobs = new JobManager(fx.client);
    cursor = new CursorTracker();
  });

  afterAll(async () => {
    await fx.stop();
  });

  test('first read is a reset (tail snapshot), later reads are incremental', async () => {
    await runToCompletion('echo first-batch');
    const first = await cursor.read(fx.client, fx.firstPane);
    expect(first.cursorReset).toBe(true);
    expect(first.lines.join('\n')).toContain('first-batch');

    await runToCompletion('echo second-batch');
    const second = await cursor.read(fx.client, fx.firstPane);
    expect(second.cursorReset).toBe(false);
    const text = second.lines.join('\n');
    expect(text).toContain('second-batch');
    expect(text).not.toContain('first-batch');
  });

  test('read with no new output returns empty, no reset', async () => {
    await cursor.read(fx.client, fx.firstPane); // drain
    const again = await cursor.read(fx.client, fx.firstPane);
    expect(again.cursorReset).toBe(false);
    expect(again.lines).toEqual([]);
  });

  test('three successive writes each surface exactly once', async () => {
    await cursor.read(fx.client, fx.firstPane); // drain
    for (const word of ['alpha', 'beta', 'gamma']) {
      await runToCompletion(`echo tick-${word}`);
      const read = await cursor.read(fx.client, fx.firstPane);
      const text = read.lines.join('\n');
      expect(text).toContain(`tick-${word}`);
      for (const other of ['alpha', 'beta', 'gamma'].filter((w) => w !== word)) {
        expect(text.split(`tick-${word}`).join('')).not.toContain(`echo tick-${other}\n`);
      }
    }
  });

  test('clear screen degrades to a reset read instead of lying', async () => {
    await cursor.read(fx.client, fx.firstPane); // drain
    await runToCompletion('clear && echo after-clear');
    const read = await cursor.read(fx.client, fx.firstPane);
    expect(read.cursorReset).toBe(true);
    expect(read.lines.join('\n')).toContain('after-clear');
  });

  test('scrollback rotation past history-limit triggers a reset', async () => {
    await fx.run(['set-option', '-t', 't', 'history-limit', '50']);
    // history-limit applies to new panes; make one dedicated to this test
    const paneId = await fx.newPane('/tmp');
    const localJobs = new JobManager(fx.client);
    const localCursor = new CursorTracker();

    const seed = await localJobs.launch(paneId, 'echo seed', null);
    await waitFor(fx.client, paneId, localJobs, seed, { until: 'exit', timeoutMs: 10_000 });
    await localCursor.read(fx.client, paneId);

    const flood = await localJobs.launch(paneId, 'seq 1 400', null);
    await waitFor(fx.client, paneId, localJobs, flood, { until: 'exit', timeoutMs: 10_000 });

    const read = await localCursor.read(fx.client, paneId);
    expect(read.cursorReset).toBe(true);
    expect(read.lines.length).toBeGreaterThan(0);
    await fx.client.killPane(paneId);
  });
});
