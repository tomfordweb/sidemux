import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { loadConfig } from '../../src/config.js';
import {
  EMPTY_MESSAGE,
  buildRows,
  dashboardReducer,
  filteredRows,
  initialDashboardState,
  renderDashboard,
  renderDetailBar,
  runDashboard,
  selectedRow,
  type DashboardDeps,
  type DashboardRow,
} from '../../src/dashboard.js';
import type { TmuxClient } from '../../src/tmux/client.js';
import type { WatcherEvent } from '../../src/tmux/watcher.js';
import type { PaneInfo, WindowInfo } from '../../src/types.js';

const rows: DashboardRow[] = [
  {
    kind: 'agent',
    sessionName: 'smux',
    windowIndex: '0',
    windowId: '@1',
    windowName: 'lint',
    activePaneId: '%10',
  },
  {
    kind: 'agent',
    sessionName: 'smux',
    windowIndex: '1',
    windowId: '@2',
    windowName: 'build',
    activePaneId: '%11',
  },
  {
    kind: 'agent',
    sessionName: 'smux',
    windowIndex: '2',
    windowId: '@3',
    windowName: 'test',
    activePaneId: '%12',
  },
];

describe('dashboard state', () => {
  test('normal navigation clamps to row bounds', () => {
    let state = initialDashboardState(rows);
    state = dashboardReducer(state, { type: 'move', delta: 1 });
    expect(selectedRow(state)?.windowId).toBe('@2');
    state = dashboardReducer(state, { type: 'move', delta: 99 });
    expect(selectedRow(state)?.windowId).toBe('@3');
    state = dashboardReducer(state, { type: 'move', delta: -99 });
    expect(selectedRow(state)?.windowId).toBe('@1');
  });

  test('insert mode filters rows and escape returns to normal mode', () => {
    let state = initialDashboardState(rows);
    state = dashboardReducer(state, { type: 'enterInsert' });
    state = dashboardReducer(state, { type: 'input', text: 'b' });
    state = dashboardReducer(state, { type: 'input', text: 'u' });
    expect(state.mode).toBe('insert');
    expect(filteredRows(state).map((row) => row.windowName)).toEqual(['build']);
    state = dashboardReducer(state, { type: 'escape' });
    expect(state.mode).toBe('normal');
  });

  test('backspace edits filter query', () => {
    let state = initialDashboardState(rows);
    state = dashboardReducer(state, { type: 'input', text: 'te' });
    expect(filteredRows(state).map((row) => row.windowName)).toEqual(['test']);
    state = dashboardReducer(state, { type: 'backspace' });
    expect(state.query).toBe('t');
    expect(filteredRows(state).map((row) => row.windowName)).toEqual(['lint', 'test']);
  });

  test('delete removes highlighted row and keeps nearest valid cursor', () => {
    let state = initialDashboardState(rows);
    state = dashboardReducer(state, { type: 'move', delta: 2 });
    state = dashboardReducer(state, { type: 'deleteSelected' });
    expect(state.rows.map((row) => row.windowId)).toEqual(['@1', '@2']);
    expect(state.cursor).toBe(1);
    expect(selectedRow(state)?.windowId).toBe('@2');
  });

  test('empty list rendering shows empty state', () => {
    const state = dashboardReducer(initialDashboardState(), {
      type: 'setRows',
      rows: [],
      message: EMPTY_MESSAGE,
    });
    const output = renderDashboard(state, '', 80, 12);
    expect(output).toContain(EMPTY_MESSAGE);
  });

  test('wide rendering shows top bar, list panel, and preview panel', () => {
    const output = renderDashboard(initialDashboardState(rows), 'build output\nok', 120, 18);
    const plain = stripAnsi(output);
    expect(plain).toContain('SIDEMUX');
    expect(plain).toContain('NORMAL');
    expect(plain).toContain('/ search');
    expect(plain).not.toContain('i search');
    expect(plain).toContain('panes 3/3');
    expect(plain).toContain('preview %10');
    expect(plain).toContain('lint');
    expect(plain).toContain('build output');
  });

  test('wide table uses script, full dir, and owner metadata when there is room', () => {
    const output = renderDashboard(initialDashboardState([
      {
        kind: 'agent' as const,
        sessionName: 'smux',
        windowIndex: '3',
        windowId: '@19',
        windowName: '* andromeda-lint',
        activePaneId: '%19',
        script: 'pnpm lint',
        dir: '/home/tomford/code/tomfordweb/andromeda',
        managedName: 'andromeda-lint',
        agentId: 'agent-abcdef123456',
        serverPid: 4242,
        busy: true,
        lastExitCode: null,
      },
    ]), '', 320, 14);
    const plain = stripAnsi(output);

    expect(plain).toContain('SCRIPT');
    expect(plain).toContain('STATUS');
    expect(plain).toContain('AGENT');
    expect(plain).toContain('PID');
    expect(plain).toContain('DESC');
    expect(plain).toContain('● run');
    expect(plain).toContain('pnpm lint');
    // Full paths land in the detail bar (home-abbreviated); the DIR column truncates.
    expect(plain).toContain('~/code/tomfordweb/andromeda');
    expect(plain).toContain('agent-abcdef');
    expect(plain).toContain('4242');
    expect(plain).toContain('@19 %19');
  });

  test('small table keeps script, dir basename, and ids without full metadata columns', () => {
    const output = renderDashboard(initialDashboardState([
      {
        kind: 'agent' as const,
        sessionName: 'smux',
        windowIndex: '3',
        windowId: '@19',
        windowName: '* andromeda-lint',
        activePaneId: '%19',
        script: 'pnpm lint',
        dir: '/home/tomford/code/tomfordweb/andromeda',
        managedName: 'andromeda-lint',
        agentId: 'agent-abcdef123456',
        serverPid: 4242,
      },
    ]), '', 120, 14);
    const plain = stripAnsi(output);

    expect(plain).toContain('SCRIPT');
    expect(plain).toContain('S');
    expect(plain).toContain('·');
    expect(plain).toContain('pnpm lint');
    expect(plain).toContain('andromeda');
    expect(plain).toContain('@19 %19');
    // The compact table drops the metadata columns; the detail bar still carries
    // agent id + pid for the selected row, so only the headers must be absent.
    expect(plain).not.toContain('AGENT');
    expect(plain).not.toContain('PID');
  });

  test('status icons distinguish success and failure', () => {
    const output = renderDashboard(initialDashboardState([
      {
        kind: 'agent' as const,
        sessionName: 'smux',
        windowIndex: '1',
        windowId: '@1',
        windowName: 'ok',
        activePaneId: '%1',
        script: 'pnpm lint',
        lastExitCode: 0,
      },
      {
        kind: 'agent' as const,
        sessionName: 'smux',
        windowIndex: '2',
        windowId: '@2',
        windowName: 'bad',
        activePaneId: '%2',
        script: 'pnpm build',
        lastExitCode: 1,
      },
    ]), '', 260, 14);
    const plain = stripAnsi(output);

    expect(plain).toContain('✓ ok');
    expect(plain).toContain('✕ fail');
  });

  test('narrow rendering stacks windows above preview', () => {
    const output = renderDashboard(initialDashboardState(rows), 'preview text', 70, 16);
    const plain = stripAnsi(output);
    expect(plain.indexOf('panes 3/3')).toBeLessThan(plain.indexOf('preview %10'));
    expect(plain).toContain('preview text');
  });

  test('selected row uses highlight and accent glyph', () => {
    let state = initialDashboardState(rows);
    state = dashboardReducer(state, { type: 'move', delta: 1 });
    const output = renderDashboard(state, '', 120, 12);
    expect(output).toContain('\x1b[48;5;238m');
    expect(stripAnsi(output)).toContain('▌ 1');
  });

  test('no-match rendering distinguishes empty filter results', () => {
    let state = initialDashboardState(rows);
    state = dashboardReducer(state, { type: 'input', text: 'missing' });
    const output = renderDashboard(state, '', 80, 12);
    expect(stripAnsi(output)).toContain('No matches for "missing"');
  });

  test('error message renders in footer without throwing', () => {
    const state = dashboardReducer(initialDashboardState(), {
      type: 'setRows',
      rows: [],
      message: "can't find session: smux",
    });
    const output = renderDashboard(state, '', 90, 12);
    expect(stripAnsi(output)).toContain("can't find session: smux");
  });

  test('row data carries safe pane and window ids for preview/delete callers', () => {
    const state = initialDashboardState(rows);
    const row = selectedRow(state);
    expect(row?.activePaneId).toBe('%10');
    expect(row?.windowId).toBe('@1');
  });

  test('normal density is the default render mode', () => {
    const state = initialDashboardState(rows);
    expect(renderDashboard(state, 'preview text', 100, 14)).toBe(
      renderDashboard(state, 'preview text', 100, 14, { density: 'normal' }),
    );
  });

  test('compact density shows more rows than spacious at the same size', () => {
    const manyRows = Array.from({ length: 9 }, (_, index): DashboardRow => ({
      kind: 'agent',
      sessionName: 'smux',
      windowIndex: String(index),
      windowId: `@${index + 1}`,
      windowName: `job-${index}`,
      activePaneId: `%${index + 10}`,
    }));
    const state = initialDashboardState(manyRows);
    const compact = stripAnsi(renderDashboard(state, '', 120, 12, { density: 'compact' }));
    const spacious = stripAnsi(renderDashboard(state, '', 120, 12, { density: 'spacious' }));

    expect(countRenderedJobs(compact)).toBeGreaterThan(countRenderedJobs(spacious));
    expect(compact).toContain('pane 9/9');
    expect(spacious).toContain('panes 9/9');
  });

  test('spacious density adds blank padding while keeping selected row semantics', () => {
    let state = initialDashboardState(rows);
    state = dashboardReducer(state, { type: 'move', delta: 1 });
    const spacious = renderDashboard(state, '', 120, 14, { density: 'spacious' });
    const normal = renderDashboard(state, '', 120, 14, { density: 'normal' });

    expect(stripAnsi(spacious)).toContain('▌ 1');
    expect(blankLineCount(stripAnsi(spacious))).toBeGreaterThan(blankLineCount(stripAnsi(normal)));
  });
});

class FakeStdin extends EventEmitter {
  isTTY = true;
  setRawMode = vi.fn((_mode: boolean) => this);
  resume = vi.fn(() => this);
  pause = vi.fn(() => this);
}

class FakeStdout {
  isTTY = true;
  columns = 120;
  rows = 20;
  chunks: string[] = [];
  write = vi.fn((chunk: string): boolean => {
    this.chunks.push(chunk);
    return true;
  });

  get text(): string {
    return this.chunks.join('');
  }
}

const realStdin = process.stdin;
const realStdout = process.stdout;

function installFakeTty(): { stdin: FakeStdin; stdout: FakeStdout } {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
  Object.defineProperty(process, 'stdout', { value: stdout, configurable: true });
  return { stdin, stdout };
}

function window(index: number, name: string): WindowInfo {
  return {
    sessionName: 'smux',
    windowIndex: String(index),
    windowId: `@${index + 1}`,
    windowName: name,
    activePaneId: `%${index + 10}`,
    agentId: null,
    serverPid: null,
    lastSeenAt: null,
    statsJson: null,
  };
}

function managedPane(
  paneId: string,
  windowId: string,
  command: string,
  overrides: Partial<PaneInfo> = {},
): PaneInfo {
  return {
    paneId,
    target: `smux:1.${paneId.slice(1)}`,
    sessionName: 'smux',
    windowIndex: '1',
    windowName: 'main',
    title: `smux:${command}`,
    currentCommand: 'pnpm',
    currentPath: '/home/tomford/code/tomfordweb/andromeda',
    width: 200,
    height: 12,
    windowId,
    managed: true,
    managedName: 'main',
    lastCommand: command,
    busy: false,
    paneClass: 'oneshot',
    lastUsedAt: 123,
    lastExitCode: 0,
    agentId: 'agent-1',
    serverPid: 4242,
    description: `${command} gate at user request`,
    ...overrides,
  };
}

function stubDashboardClient(overrides: Partial<TmuxClient> = {}): TmuxClient {
  return {
    listWindows: vi.fn(async () => [window(0, 'lint'), window(1, 'build'), window(2, 'test')]),
    listPanes: vi.fn(async () => []),
    capturePane: vi.fn(async () => ['pane preview line']),
    switchClient: vi.fn(async () => undefined),
    selectPane: vi.fn(async () => undefined),
    zoomPane: vi.fn(async () => undefined),
    killPane: vi.fn(async () => undefined),
    killWindow: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as TmuxClient;
}

function fakeWatcher(tickMs?: number): {
  deps: DashboardDeps;
  emit: (event: WatcherEvent) => void;
  kill: ReturnType<typeof vi.fn>;
} {
  const kill = vi.fn();
  let handler: (event: WatcherEvent) => void = () => {};
  const deps: DashboardDeps = {
    ...(tickMs === undefined ? {} : { tickMs }),
    spawnWatcher: (_session, onEvent) => {
      handler = onEvent;
      return { kill };
    },
  };
  return { deps, emit: (event) => { handler(event); }, kill };
}

/** Let the async key handler (capture + render promises) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function press(stdin: FakeStdin, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    stdin.emit('data', Buffer.from(key));
    await flush();
  }
}

describe('runDashboard key loop', () => {
  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true });
  });

  test('refuses to start without a TTY', async () => {
    const { stdin, stdout } = installFakeTty();
    stdout.isTTY = false;
    const client = stubDashboardClient();
    await runDashboard(client, loadConfig({}), fakeWatcher().deps);
    expect(stdout.text).toContain('needs a TTY');
    expect(stdin.setRawMode).not.toHaveBeenCalled();
    expect(client.listWindows).not.toHaveBeenCalled();
  });

  test('starts in raw mode, renders windows, and q closes cleanly', async () => {
    const { stdin, stdout } = installFakeTty();
    await runDashboard(stubDashboardClient(), loadConfig({}), fakeWatcher().deps);

    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    const initial = stripAnsi(stdout.text);
    expect(initial).toContain('panes 3/3');
    expect(initial).toContain('lint');
    expect(initial).toContain('pane preview line');

    await press(stdin, 'q');
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(stdin.pause).toHaveBeenCalled();
    expect(stdout.text).toContain('\x1b[?25h'); // cursor restored
  });

  test('Enter opens the selected window via switch-client then closes', async () => {
    const { stdin } = installFakeTty();
    const client = stubDashboardClient();
    await runDashboard(client, loadConfig({}), fakeWatcher().deps);

    await press(stdin, '\r');
    expect(client.switchClient).toHaveBeenCalledWith('@1');
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
  });

  test('j and k move the cursor before opening', async () => {
    const { stdin } = installFakeTty();
    const client = stubDashboardClient();
    await runDashboard(client, loadConfig({}), fakeWatcher().deps);

    await press(stdin, 'j', 'j', 'k', '\r');
    expect(client.switchClient).toHaveBeenCalledWith('@2');
  });

  test('d kills the selected window and reloads the list', async () => {
    const { stdin, stdout } = installFakeTty();
    const remaining = [window(1, 'build'), window(2, 'test')];
    const client = stubDashboardClient({
      listWindows: vi
        .fn<() => Promise<WindowInfo[]>>()
        .mockResolvedValueOnce([window(0, 'lint'), ...remaining])
        .mockResolvedValue(remaining),
    });
    await runDashboard(client, loadConfig({}), fakeWatcher().deps);

    await press(stdin, 'd');
    expect(client.killWindow).toHaveBeenCalledWith('@1');
    expect(client.listWindows).toHaveBeenCalledTimes(2);
    const last = stripAnsi(stdout.chunks.at(-1) ?? '');
    expect(last).toContain('panes 2/2');
    expect(last).not.toContain('lint');
  });

  test('failed delete surfaces the tmux error in the footer', async () => {
    const { stdin, stdout } = installFakeTty();
    const client = stubDashboardClient({
      killWindow: vi.fn(async () => {
        throw new Error("can't find window: @1");
      }),
    });
    await runDashboard(client, loadConfig({}), fakeWatcher().deps);

    await press(stdin, 'd');
    expect(stripAnsi(stdout.chunks.at(-1) ?? '')).toContain("can't find window: @1");
    expect(stdin.setRawMode).not.toHaveBeenCalledWith(false); // still running
  });

  test('slash enters insert mode, typed chars filter, Enter opens the match', async () => {
    const { stdin, stdout } = installFakeTty();
    const client = stubDashboardClient();
    await runDashboard(client, loadConfig({}), fakeWatcher().deps);

    await press(stdin, '/', 't', 'e');
    const filtered = stripAnsi(stdout.chunks.at(-1) ?? '');
    expect(filtered).toContain('INSERT');
    expect(filtered).toContain('panes 1/3');
    expect(filtered).toContain('te');

    await press(stdin, '\r');
    expect(client.switchClient).toHaveBeenCalledWith('@3');
  });

  test('backspace edits the filter and Escape returns to normal mode', async () => {
    const { stdin, stdout } = installFakeTty();
    await runDashboard(stubDashboardClient(), loadConfig({}), fakeWatcher().deps);

    await press(stdin, '/', 'z', 'z');
    expect(stripAnsi(stdout.chunks.at(-1) ?? '')).toContain('panes 0/3');
    await press(stdin, '\x7f', '\x7f');
    expect(stripAnsi(stdout.chunks.at(-1) ?? '')).toContain('panes 3/3');
    await press(stdin, '\x1b');
    expect(stripAnsi(stdout.chunks.at(-1) ?? '')).toContain('NORMAL');
  });

  test('r reloads the window list', async () => {
    const { stdin } = installFakeTty();
    const client = stubDashboardClient();
    await runDashboard(client, loadConfig({}), fakeWatcher().deps);

    await press(stdin, 'r');
    expect(client.listWindows).toHaveBeenCalledTimes(2);
  });

  test('a failed reload renders the error as the empty-state message', async () => {
    const { stdin, stdout } = installFakeTty();
    const client = stubDashboardClient({
      listWindows: vi.fn(async () => {
        throw new Error('no server running');
      }),
    });
    await runDashboard(client, loadConfig({}), fakeWatcher().deps);
    expect(stripAnsi(stdout.text)).toContain('no server running');
    // Still interactive: q closes.
    await press(stdin, 'q');
    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
  });
});

describe('buildRows', () => {
  test('window with managed panes becomes an agent row plus nested pane rows', () => {
    const win = window(0, '* main');
    const panes = [
      managedPane('%20', win.windowId, 'pnpm lint', { busy: true, lastExitCode: null }),
      managedPane('%21', win.windowId, 'pnpm test', { lastExitCode: 1 }),
      managedPane('%22', win.windowId, 'pnpm build'),
    ];
    const built = buildRows([win], panes);

    expect(built.map((row) => row.kind)).toEqual(['agent', 'pane', 'pane', 'pane']);
    const [agent, lint, testRow, build] = built;
    expect(agent).toMatchObject({
      windowId: win.windowId,
      paneIds: ['%20', '%21', '%22'],
      script: '* main · 3 panes',
      busy: true,
      lastExitCode: 1,
    });
    expect(lint).toMatchObject({
      activePaneId: '%20',
      script: 'pnpm lint',
      busy: true,
      lastExitCode: null,
      dir: '/home/tomford/code/tomfordweb/andromeda',
    });
    expect(testRow).toMatchObject({ activePaneId: '%21', lastExitCode: 1 });
    expect(build).toMatchObject({ activePaneId: '%22', lastExitCode: 0 });
  });

  test('window without managed panes stays a single agent row', () => {
    const built = buildRows([window(0, 'shell')], []);
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ kind: 'agent', windowName: 'shell', paneIds: [] });
  });

  test('filter keeps the whole subtree when only a nested pane matches', () => {
    const win = window(0, 'main');
    const other = window(1, 'other');
    const built = buildRows(
      [win, other],
      [
        managedPane('%20', win.windowId, 'pnpm lint'),
        managedPane('%21', win.windowId, 'pnpm e2e'),
      ],
    );
    let state = initialDashboardState(built);
    state = dashboardReducer(state, { type: 'input', text: 'e2e' });
    const visible = filteredRows(state);
    expect(visible.map((row) => `${row.kind}:${row.activePaneId}`)).toEqual([
      `agent:${win.activePaneId}`,
      'pane:%20',
      'pane:%21',
    ]);
  });

  test('pane rows render indented under their agent row', () => {
    const win = window(0, 'main');
    const built = buildRows([win], [managedPane('%20', win.windowId, 'pnpm lint')]);
    const plain = stripAnsi(renderDashboard(initialDashboardState(built), '', 120, 14));
    expect(plain).toContain('└ pnpm lint');
    expect(plain).toContain('main · 1 pane');
  });
});

describe('runDashboard pane tree key loop', () => {
  afterEach(() => {
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true });
  });

  function treeClient(overrides: Partial<TmuxClient> = {}): TmuxClient {
    const win = window(0, '* main');
    return stubDashboardClient({
      listWindows: vi.fn(async () => [win]),
      listPanes: vi.fn(async () => [
        managedPane('%20', win.windowId, 'pnpm lint', { busy: true, lastExitCode: null }),
        managedPane('%21', win.windowId, 'pnpm test'),
      ]),
      ...overrides,
    });
  }

  test('Tab walks down the tree and Enter on a pane row selects and zooms it', async () => {
    const { stdin } = installFakeTty();
    const client = treeClient();
    await runDashboard(client, loadConfig({}), fakeWatcher().deps);

    await press(stdin, '\t', '\r');
    expect(client.switchClient).toHaveBeenCalledWith('@1');
    expect(client.selectPane).toHaveBeenCalledWith('%20');
    expect(client.zoomPane).toHaveBeenCalledWith('%20');
  });

  test('Shift-Tab moves back up; Enter on the agent row never selects a pane', async () => {
    const { stdin } = installFakeTty();
    const client = treeClient();
    await runDashboard(client, loadConfig({}), fakeWatcher().deps);

    await press(stdin, '\t', '\x1b[Z', '\r');
    expect(client.switchClient).toHaveBeenCalledWith('@1');
    expect(client.selectPane).not.toHaveBeenCalled();
    expect(client.zoomPane).not.toHaveBeenCalled();
  });

  test('d on a pane row kills just that pane', async () => {
    const { stdin } = installFakeTty();
    const client = treeClient();
    await runDashboard(client, loadConfig({}), fakeWatcher().deps);

    await press(stdin, 'j', 'd');
    expect(client.killPane).toHaveBeenCalledWith('%20');
    expect(client.killWindow).not.toHaveBeenCalled();
  });

  test('agent row preview stacks every child pane tail with headers', async () => {
    const { stdout } = installFakeTty();
    const capturePane = vi.fn(async (paneId: string) => [`${paneId} tail line`]);
    await runDashboard(treeClient({ capturePane }), loadConfig({}), fakeWatcher().deps);

    expect(capturePane).toHaveBeenCalledWith('%20', -40);
    expect(capturePane).toHaveBeenCalledWith('%21', -40);
    const plain = stripAnsi(stdout.text);
    expect(plain).toContain('── pnpm lint · ● run ──');
    expect(plain).toContain('%20 tail line');
    expect(plain).toContain('── pnpm test · ✓ ok ──');
  });
});

describe('detail bar and descriptions', () => {
  test('pane rows carry the run description into rows and the DESC column', () => {
    const win = window(0, 'main');
    const built = buildRows(
      [win],
      [managedPane('%20', win.windowId, 'pnpm lint', { description: 'lint gate before release' })],
    );
    expect(built[1]).toMatchObject({ kind: 'pane', description: 'lint gate before release' });
    expect(built[0]!.description).toBe('1 pane · 0 running');

    const plain = stripAnsi(renderDashboard(initialDashboardState(built), '', 320, 14));
    expect(plain).toContain('lint gate'); // DESC column (may be truncated to its width)
  });

  test('detail bar shows window, name, description, command, pwd, and status for a pane row', () => {
    const win = window(0, 'main');
    const built = buildRows(
      [win],
      [managedPane('%20', win.windowId, 'pnpm lint', { description: 'lint gate before release' })],
    );
    let state = initialDashboardState(built);
    state = dashboardReducer(state, { type: 'move', delta: 1 });
    const bar = stripAnsi(renderDetailBar(selectedRow(state), 400));
    expect(bar).toContain('win 0'); // pane rows use their parent window's index
    expect(bar).toContain('main %20');
    expect(bar).toContain('lint gate before release');
    expect(bar).toContain('pnpm lint');
    expect(bar).toContain('~/code/tomfordweb/andromeda');
    expect(bar).toContain('✓ ok exit 0');
  });

  test('detail bar aggregates for an agent row and handles no selection', () => {
    const win = window(0, 'main');
    const built = buildRows(
      [win],
      [
        managedPane('%20', win.windowId, 'pnpm lint', { busy: true, lastExitCode: null }),
        managedPane('%21', win.windowId, 'pnpm test'),
      ],
    );
    const bar = stripAnsi(renderDetailBar(built[0]!, 400));
    expect(bar).toContain('win 0');
    expect(bar).toContain('2 panes · 1 running');
    expect(bar).toContain('agent-1');
    expect(stripAnsi(renderDetailBar(null, 80))).toContain('no selection');
  });
});

describe('preview tail clipping', () => {
  test('a preview taller than the panel shows its last lines, not its first', () => {
    const state = initialDashboardState(rows);
    const preview = Array.from({ length: 80 }, (_, index) => `log line ${index + 1}`).join('\n');
    const plain = stripAnsi(renderDashboard(state, preview, 120, 20));
    expect(plain).toContain('log line 80');
    expect(plain).not.toMatch(/log line 1\s/);
  });
});

describe('runDashboard auto-refresh', () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true });
  });

  async function advance(ms: number): Promise<void> {
    vi.advanceTimersByTime(ms);
    await flush();
  }

  test('a watcher event marks dirty and the next tick reloads once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    installFakeTty();
    const client = stubDashboardClient();
    const watcher = fakeWatcher();
    await runDashboard(client, loadConfig({}), watcher.deps);
    expect(client.listWindows).toHaveBeenCalledTimes(1);

    watcher.emit({ type: 'output', paneId: '%10' });
    await advance(500);
    expect(client.listWindows).toHaveBeenCalledTimes(2);

    // No further events: ticks stay idle.
    await advance(5000);
    expect(client.listWindows).toHaveBeenCalledTimes(2);
  });

  test('topology events also trigger a reload', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    installFakeTty();
    const client = stubDashboardClient();
    const watcher = fakeWatcher();
    await runDashboard(client, loadConfig({}), watcher.deps);

    watcher.emit({ type: 'topology' });
    await advance(500);
    expect(client.listWindows).toHaveBeenCalledTimes(2);
  });

  test('a dead watcher degrades to reloading every third tick', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    installFakeTty();
    const client = stubDashboardClient();
    const watcher = fakeWatcher();
    await runDashboard(client, loadConfig({}), watcher.deps);

    watcher.emit({ type: 'died' });
    await advance(500);
    await advance(500);
    expect(client.listWindows).toHaveBeenCalledTimes(1);
    await advance(500);
    expect(client.listWindows).toHaveBeenCalledTimes(2);
    await advance(1500);
    expect(client.listWindows).toHaveBeenCalledTimes(3);
  });

  test('closing the dashboard kills the watcher and stops refreshing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { stdin } = installFakeTty();
    const client = stubDashboardClient();
    const watcher = fakeWatcher();
    await runDashboard(client, loadConfig({}), watcher.deps);

    await press(stdin, 'q');
    expect(watcher.kill).toHaveBeenCalled();
    watcher.emit({ type: 'output', paneId: '%10' });
    await advance(5000);
    expect(client.listWindows).toHaveBeenCalledTimes(1);
  });
});

function stripAnsi(value: string): string {
  return value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g'), '');
}

function countRenderedJobs(value: string): number {
  return [...value.matchAll(/job-\d/g)].length;
}

function blankLineCount(value: string): number {
  return value.split('\n').filter((line) => line.trim() === '').length;
}
