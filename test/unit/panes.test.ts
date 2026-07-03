import { describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { PaneAllocator } from '../../src/core/panes.js';
import type { TmuxClient } from '../../src/tmux/client.js';

function stubClient(overrides: Partial<TmuxClient> = {}): TmuxClient {
  return {
    resolveTarget: vi.fn(async (t: string) => t),
    paneExists: vi.fn(async () => true),
    panePath: vi.fn(async () => '/somewhere'),
    splitWindow: vi.fn(async () => '%10'),
    newSession: vi.fn(async () => '%0'),
    newWindow: vi.fn(async () => '%5'),
    attachedSession: vi.fn(async () => null),
    hasSession: vi.fn(async () => false),
    setPaneTitle: vi.fn(async () => undefined),
    setPaneOption: vi.fn(async () => undefined),
    paneWindow: vi.fn(async () => '@1'),
    setWindowOption: vi.fn(async () => undefined),
    unsetWindowOption: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as TmuxClient;
}

describe('PaneAllocator', () => {
  test('refuses to write to the agent\'s own pane', async () => {
    const allocator = new PaneAllocator(
      stubClient(),
      loadConfig({}),
      { TMUX: '/tmp/tmux-1000/default,123,0', TMUX_PANE: '%1' },
      '/proj',
    );
    expect(() => allocator.guardWrite('%1')).toThrow(/agent's own pane/);
    expect(() => allocator.guardWrite('%2')).not.toThrow();
  });

  test('managed-only mode refuses foreign panes but allows managed ones', async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_MANAGED_ONLY: '1' }),
      { TMUX: 'x', TMUX_PANE: '%1' },
      '/proj',
    );
    expect(() => allocator.guardWrite('%9')).toThrow(/SIDEMUX_MANAGED_ONLY/);
    const acquired = await allocator.acquire({ name: 'build' });
    expect(() => allocator.guardWrite(acquired.paneId)).not.toThrow();
  });

  test('inside tmux: first pane is a full-span bar off the agent pane', async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(
      client,
      loadConfig({}),
      { TMUX: 'x', TMUX_PANE: '%1' },
      '/proj',
    );
    const acquired = await allocator.acquire({ name: 'build' });
    expect(acquired).toMatchObject({ paneId: '%10', created: true, currentPath: '/proj' });
    // trailing `true` = -f full-span anchor
    expect(client.splitWindow).toHaveBeenCalledWith('/proj', '%1', '30%', undefined, 'bottom', true);
    expect(client.setPaneTitle).toHaveBeenCalledWith('%10', 'smux:build');
  });

  test('layout and size config flow through to the anchor split', async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_LAYOUT: 'right', SIDEMUX_PANE_SIZE: '40%' }),
      { TMUX: 'x', TMUX_PANE: '%1' },
      '/proj',
    );
    await allocator.acquire({ name: 'build' });
    expect(client.splitWindow).toHaveBeenCalledWith('/proj', '%1', '40%', undefined, 'right', true);
  });

  test('additional panes subdivide the bar perpendicular, not full-span', async () => {
    let counter = 10;
    const split = vi.fn(async () => `%${counter++}`);
    const client = stubClient({ splitWindow: split as never });
    const allocator = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_LAYOUT: 'bottom' }),
      { TMUX: 'x', TMUX_PANE: '%1' },
      '/proj',
    );
    const first = await allocator.acquire({ name: 'a' });
    allocator.setBusy(first.paneId, true); // keep it out of reuse → force a 2nd pane
    const second = await allocator.acquire({ name: 'b' });

    // anchor: full-span off the agent pane
    expect(split).toHaveBeenNthCalledWith(1, '/proj', '%1', '30%', undefined, 'bottom', true);
    // subdivision: split the last bar pane along the bar (bottom → right), no -f
    expect(split).toHaveBeenNthCalledWith(2, '/proj', first.paneId, '50%', undefined, 'right');
    expect(second.paneId).toBe('%11');
  });

  test('a rerun reuses the idle pane that last ran the same command', async () => {
    let counter = 10;
    const split = vi.fn(async () => `%${counter++}`);
    const client = stubClient({ splitWindow: split as never });
    const allocator = new PaneAllocator(client, loadConfig({}), { TMUX: 'x', TMUX_PANE: '%1' }, '/proj');

    // two concurrent panes running different commands
    const a = await allocator.acquire({ command: 'pnpm test' }); // %10
    allocator.setBusy(a.paneId, true);
    const b = await allocator.acquire({ command: 'pnpm build' }); // %11
    allocator.setBusy(b.paneId, true);
    // both finish
    allocator.setBusy(a.paneId, false);
    allocator.setBusy(b.paneId, false);

    // rerun 'pnpm test' → lands back in pane A, not B, and no new split
    const rerun = await allocator.acquire({ command: 'pnpm test' });
    expect(rerun.paneId).toBe(a.paneId);
    expect(rerun.created).toBe(false);
    expect(split).toHaveBeenCalledTimes(2);
  });

  test('pane header title carries the command and pane id', async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(client, loadConfig({}), { TMUX: 'x', TMUX_PANE: '%1' }, '/proj');
    await allocator.acquire({ name: 'test', command: 'pnpm test' });
    expect(client.setPaneTitle).toHaveBeenCalledWith('%10', 'smux:test · pnpm test · %10');
    // The border header reads this option (clobber-proof), not pane_title.
    expect(client.setPaneOption).toHaveBeenCalledWith('%10', '@smux_label', 'test · pnpm test · %10');
  });

  test('enables the pane-border header on first create and restores it when empty', async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(client, loadConfig({}), { TMUX: 'x', TMUX_PANE: '%1' }, '/proj');
    const { paneId } = await allocator.acquire({ name: 'test', command: 'pnpm test' });
    expect(client.setWindowOption).toHaveBeenCalledWith('@1', 'pane-border-status', 'top');
    // Format is conditional on sidemux's own @smux_label pane option so it does
    // not label the human's panes — and survives a shell that rewrites pane_title.
    expect(client.setWindowOption).toHaveBeenCalledWith(
      '@1',
      'pane-border-format',
      expect.stringMatching(/#\{\?#\{@smux_label\}/),
    );

    await allocator.remove(paneId); // last managed pane gone → restore
    expect(client.unsetWindowOption).toHaveBeenCalledWith('@1', 'pane-border-status');
    expect(client.unsetWindowOption).toHaveBeenCalledWith('@1', 'pane-border-format');
  });

  test('SIDEMUX_PANE_HEADER=0 leaves the window border untouched', async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_PANE_HEADER: '0' }),
      { TMUX: 'x', TMUX_PANE: '%1' },
      '/proj',
    );
    await allocator.acquire({ name: 'test', command: 'pnpm test' });
    expect(client.setWindowOption).not.toHaveBeenCalled();
  });

  test('outside tmux: creates the configured detached session', async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(client, loadConfig({}), {}, '/proj');
    const acquired = await allocator.acquire({});
    expect(acquired.created).toBe(true);
    expect(client.newSession).toHaveBeenCalledWith('smux', '/proj', undefined);
  });

  test('outside tmux with existing session: adds a window instead', async () => {
    const client = stubClient({ hasSession: vi.fn(async () => true) });
    const allocator = new PaneAllocator(client, loadConfig({}), {}, '/proj');
    await allocator.acquire({});
    expect(client.newWindow).toHaveBeenCalledWith('smux', '/proj', undefined);
  });

  test('no agent pane but a client attached: hosts a named window in that session', async () => {
    // The launching client stripped TMUX/TMUX_PANE, so there is no pane to split.
    // sidemux discovers the human's attached session and puts its work there
    // (visible + switchable), rather than orphaning it in a detached session.
    const client = stubClient({
      attachedSession: vi.fn(async () => '0'),
      newWindow: vi.fn(async () => '%20'),
    });
    const allocator = new PaneAllocator(client, loadConfig({}), {}, '/proj');
    const acquired = await allocator.acquire({ name: 'test', command: 'pnpm test' });
    expect(acquired).toMatchObject({ paneId: '%20', created: true });
    expect(client.newWindow).toHaveBeenCalledWith('0', '/proj', undefined, 'smux');
    expect(client.newSession).not.toHaveBeenCalled();
  });

  test('hosted window tiles additional jobs instead of spawning more windows', async () => {
    let counter = 21; // newWindow already claimed %20; splits start after it
    const split = vi.fn(async () => `%${counter++}`);
    const client = stubClient({
      attachedSession: vi.fn(async () => '0'),
      newWindow: vi.fn(async () => '%20'),
      splitWindow: split as never,
    });
    const allocator = new PaneAllocator(client, loadConfig({ SIDEMUX_LAYOUT: 'bottom' }), {}, '/proj');
    const first = await allocator.acquire({ name: 'a' }); // %20 via newWindow
    allocator.setBusy(first.paneId, true); // busy → force a second pane
    const second = await allocator.acquire({ name: 'b' }); // subdivide the hosted window

    expect(first.paneId).toBe('%20');
    expect(client.newWindow).toHaveBeenCalledTimes(1);
    // bottom bar → subdivide rightward, no -f (tiles within the hosted window)
    expect(split).toHaveBeenCalledWith('/proj', '%20', '50%', undefined, 'right');
    expect(second.paneId).toBe('%21');
  });

  test('explicit cwd param beats the default', async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(client, loadConfig({}), { TMUX: 'x', TMUX_PANE: '%1' }, '/proj');
    await allocator.acquire({ cwd: '/elsewhere' });
    expect(client.splitWindow).toHaveBeenCalledWith('/elsewhere', '%1', '30%', undefined, 'bottom', true);
  });

  test('reuses an idle managed pane instead of creating another', async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(client, loadConfig({}), { TMUX: 'x', TMUX_PANE: '%1' }, '/proj');
    const first = await allocator.acquire({ name: 'build' });
    allocator.setBusy(first.paneId, false);
    const second = await allocator.acquire({ name: 'build' });
    expect(second.paneId).toBe(first.paneId);
    expect(second.created).toBe(false);
    expect(client.splitWindow).toHaveBeenCalledTimes(1);
  });

  test('busy managed panes are not reused', async () => {
    const split = vi.fn(async () => '%10');
    let counter = 10;
    split.mockImplementation(async () => `%${counter++}`);
    const client = stubClient({ splitWindow: split as never });
    const allocator = new PaneAllocator(client, loadConfig({}), { TMUX: 'x', TMUX_PANE: '%1' }, '/proj');
    const first = await allocator.acquire({ name: 'a' });
    allocator.setBusy(first.paneId, true);
    const second = await allocator.acquire({ name: 'b' });
    expect(second.paneId).not.toBe(first.paneId);
  });

  test('reuse disabled via config always creates', async () => {
    const split = vi.fn(async () => '%10');
    let counter = 10;
    split.mockImplementation(async () => `%${counter++}`);
    const client = stubClient({ splitWindow: split as never });
    const allocator = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_REUSE_PANES: '0' }),
      { TMUX: 'x', TMUX_PANE: '%1' },
      '/proj',
    );
    await allocator.acquire({});
    await allocator.acquire({});
    expect(split).toHaveBeenCalledTimes(2);
  });

  test('resolve maps managed name to pane id, falls back to tmux targets', async () => {
    const client = stubClient({ resolveTarget: vi.fn(async () => '%42') });
    const allocator = new PaneAllocator(client, loadConfig({}), { TMUX: 'x', TMUX_PANE: '%1' }, '/proj');
    const acquired = await allocator.acquire({ name: 'build' });
    expect(await allocator.resolve('build')).toBe(acquired.paneId);
    expect(await allocator.resolve('main:1.0')).toBe('%42');
  });

  test('resolve skips a dead pane and still finds a live one with the same name', async () => {
    // Two managed panes end up sharing a name after the first dies while busy
    // (so firstIdle never pruned it). resolve must not let the dead entry — first
    // in insertion order — shadow the live pane behind it.
    const alive = new Set(['%10', '%11']);
    let counter = 10;
    const client = stubClient({
      splitWindow: vi.fn(async () => `%${counter++}`) as never,
      paneExists: vi.fn(async (t: string) => alive.has(t)),
      resolveTarget: vi.fn(async (t: string) => {
        if (alive.has(t)) return t;
        throw new Error(`no such pane: ${t}`);
      }),
    });
    const allocator = new PaneAllocator(client, loadConfig({}), { TMUX: 'x', TMUX_PANE: '%1' }, '/proj');

    const first = await allocator.acquire({ name: 'dev' }); // %10
    allocator.setBusy(first.paneId, true); // busy → forces a second same-named pane
    const second = await allocator.acquire({ name: 'dev' }); // %11
    expect(second.paneId).toBe('%11');

    alive.delete('%10'); // the older 'dev' pane dies out-of-band, still marked busy
    expect(await allocator.resolve('dev')).toBe('%11');
  });
});
