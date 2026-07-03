import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MANAGED_TITLE_PREFIX } from '../../src/tmux/formats.js';
import { TmuxFixture, tmuxAvailable } from './helpers/tmux-fixture.js';

describe.skipIf(!tmuxAvailable())('TmuxClient against real tmux', () => {
  const fx = new TmuxFixture();

  beforeAll(async () => {
    await fx.start('/tmp');
  });

  afterAll(async () => {
    await fx.stop();
  });

  test('newSession creates a pane anchored to the requested cwd', async () => {
    expect(fx.firstPane).toMatch(/^%\d+$/);
    const path = await fx.client.panePath(fx.firstPane);
    expect(path).toBe('/tmp');
  });

  test('sendLiteral + Enter round-trips output through capturePane', async () => {
    await fx.client.sendLiteral(fx.firstPane, 'echo smux-roundtrip-ok');
    await fx.client.sendKeys(fx.firstPane, ['Enter']);
    await fx.until(async () => (await fx.screen(fx.firstPane)).includes('smux-roundtrip-ok'));
    const screen = await fx.screen(fx.firstPane);
    expect(screen).toContain('smux-roundtrip-ok');
  });

  test('paneState reports sane geometry', async () => {
    const state = await fx.client.paneState(fx.firstPane);
    expect(state.paneHeight).toBeGreaterThan(0);
    expect(state.historyLimit).toBeGreaterThan(0);
    expect(state.cursorY).toBeGreaterThanOrEqual(0);
    expect(state.currentCommand.length).toBeGreaterThan(0);
  });

  test('splitWindow creates pane in explicit cwd; title marks it managed', async () => {
    const paneId = await fx.newPane('/tmp');
    expect(paneId).toMatch(/^%\d+$/);
    expect(paneId).not.toBe(fx.firstPane);

    expect(await fx.client.panePath(paneId)).toBe('/tmp');

    await fx.client.setPaneTitle(paneId, `${MANAGED_TITLE_PREFIX}test`);
    const panes = await fx.client.listPanes();
    const created = panes.find((p) => p.paneId === paneId);
    expect(created?.managed).toBe(true);

    await fx.client.killPane(paneId);
    expect(await fx.client.paneExists(paneId)).toBe(false);
  });

  test('resolveTarget maps session:window.pane to %id and rejects garbage', async () => {
    const panes = await fx.client.listPanes();
    const first = panes.find((p) => p.paneId === fx.firstPane);
    expect(first).toBeDefined();
    const id = await fx.client.resolveTarget(first!.target);
    expect(id).toBe(fx.firstPane);
    await expect(fx.client.resolveTarget('nope:0.0')).rejects.toThrow(/cannot resolve/);
  });

  test('hasSession true for fixture session, false for missing', async () => {
    expect(await fx.client.hasSession('t')).toBe(true);
    expect(await fx.client.hasSession('nope')).toBe(false);
  });

  test('capturePane with history coordinates returns requested slice', async () => {
    for (let i = 0; i < 5; i++) {
      await fx.client.sendLiteral(fx.firstPane, `echo line-${i}`);
      await fx.client.sendKeys(fx.firstPane, ['Enter']);
    }
    await fx.until(async () => (await fx.screen(fx.firstPane)).includes('line-4'));
    const state = await fx.client.paneState(fx.firstPane);
    // capture everything: from top of history to bottom of screen
    const all = await fx.client.capturePane(
      fx.firstPane,
      -state.historySize,
      state.paneHeight - 1,
    );
    const joined = all.join('\n');
    expect(joined).toContain('line-0');
    expect(joined).toContain('line-4');
  });
});
