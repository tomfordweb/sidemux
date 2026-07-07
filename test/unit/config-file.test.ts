import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  globalConfigPath,
  globalConfigTemplate,
  loadGlobalFileConfig,
  loadProjectScripts,
} from '../../src/config-file.js';
import { DEFAULT_IDLE_PANE_TTL_MS, loadConfig } from '../../src/config.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'smux-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function writeGlobal(content: string): Promise<NodeJS.ProcessEnv> {
  const env = { XDG_CONFIG_HOME: dir };
  await mkdir(join(dir, 'sidemux'), { recursive: true });
  await writeFile(join(dir, 'sidemux', 'config.toml'), content);
  return env;
}

describe('globalConfigPath', () => {
  test('honors XDG_CONFIG_HOME', () => {
    expect(globalConfigPath({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/sidemux/config.toml');
  });

  test('falls back to ~/.config', () => {
    expect(globalConfigPath({})).toMatch(/\.config\/sidemux\/config\.toml$/);
  });
});

describe('loadGlobalFileConfig', () => {
  test('missing file yields empty config', () => {
    expect(loadGlobalFileConfig({ XDG_CONFIG_HOME: dir })).toEqual({});
  });

  test('reads settings including the [dashboard] table', async () => {
    const env = await writeGlobal(
      'session = "work"\nidle_pane_ttl_ms = 60000\nclose_on_success = true\n' +
        '[dashboard]\nkey = "s"\ndensity = "compact"\n',
    );
    const file = loadGlobalFileConfig(env);
    expect(file.session).toBe('work');
    expect(file.idlePaneTtlMs).toBe(60_000);
    expect(file.closeOnSuccess).toBe(true);
    expect(file.dashboardKey).toBe('s');
    expect(file.dashboardDensity).toBe('compact');
  });

  test('malformed TOML warns and is ignored', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = await writeGlobal('session = = broken');
    expect(loadGlobalFileConfig(env)).toEqual({});
    expect(error).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });

  test('unknown keys warn but known keys still apply', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = await writeGlobal('session = "work"\ntypo_key = 1\n');
    expect(loadGlobalFileConfig(env).session).toBe('work');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('unknown key "typo_key"'));
  });

  test('type-invalid file warns and is ignored entirely', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = await writeGlobal('session = 42\n');
    expect(loadGlobalFileConfig(env)).toEqual({});
    expect(error).toHaveBeenCalledWith(expect.stringContaining('invalid'));
  });

  test('the scaffold template parses cleanly with all keys commented out', async () => {
    const env = await writeGlobal(globalConfigTemplate());
    // Only the [dashboard] table header is active — everything else commented.
    const file = loadGlobalFileConfig(env);
    expect(file.session).toBeUndefined();
    expect(file.dashboardKey).toBeUndefined();
  });
});

describe('loadConfig precedence (defaults < global file < env)', () => {
  test('file values beat defaults', () => {
    const config = loadConfig({}, '/proj', {
      session: 'work',
      dashboardKey: 's',
      dashboardDensity: 'compact',
      idlePaneTtlMs: 60_000,
      closeOnSuccess: true,
      reusePanes: false,
      keybinds: false,
    });
    expect(config.sessionName).toBe('work');
    expect(config.dashboardKey).toBe('s');
    expect(config.dashboardDensity).toBe('compact');
    expect(config.idlePaneTtlMs).toBe(60_000);
    expect(config.closeOnSuccess).toBe(true);
    expect(config.reusePanes).toBe(false);
    expect(config.keybinds).toBe(false);
  });

  test('env beats file', () => {
    const config = loadConfig(
      {
        SIDEMUX_SESSION: 'env-session',
        SIDEMUX_DASHBOARD_KEY: 'x',
        SIDEMUX_IDLE_PANE_TTL_MS: '5',
        SIDEMUX_CLOSE_ON_SUCCESS: '0',
        SIDEMUX_KEYBINDS: '1',
      },
      '/proj',
      { session: 'file-session', dashboardKey: 's', idlePaneTtlMs: 60_000, closeOnSuccess: true, keybinds: false },
    );
    expect(config.sessionName).toBe('env-session');
    expect(config.dashboardKey).toBe('x');
    expect(config.idlePaneTtlMs).toBe(5);
    expect(config.closeOnSuccess).toBe(false);
    expect(config.keybinds).toBe(true);
  });

  test('defaults apply when neither env nor file set a value', () => {
    const config = loadConfig({}, '/proj', {});
    expect(config.sessionName).toBe('smux');
    expect(config.idlePaneTtlMs).toBe(DEFAULT_IDLE_PANE_TTL_MS);
  });
});

describe('loadProjectScripts', () => {
  test('reads string and table script forms', async () => {
    await writeFile(
      join(dir, '.sidemux.toml'),
      '[scripts]\nlint = "nx run *:lint"\nbig = "./bin/someCustomScript"\ndev = { command = "pnpm dev", background = true }\n',
    );
    const scripts = loadProjectScripts(dir);
    expect(scripts.get('lint')).toEqual({ name: 'lint', command: 'nx run *:lint', background: false });
    expect(scripts.get('big')?.command).toBe('./bin/someCustomScript');
    expect(scripts.get('dev')).toEqual({ name: 'dev', command: 'pnpm dev', background: true });
  });

  test('globs in script bodies pass through untouched', async () => {
    await writeFile(join(dir, '.sidemux.toml'), '[scripts]\nlint = "nx run *:lint --fix **/*.ts"\n');
    expect(loadProjectScripts(dir).get('lint')?.command).toBe('nx run *:lint --fix **/*.ts');
  });

  test('walks up parent directories like .mcp.json discovery', async () => {
    await writeFile(join(dir, '.sidemux.toml'), '[scripts]\ntest = "pnpm test"\n');
    const nested = join(dir, 'packages', 'app');
    await mkdir(nested, { recursive: true });
    expect(loadProjectScripts(nested).get('test')?.command).toBe('pnpm test');
  });

  test('missing file yields empty map', () => {
    expect(loadProjectScripts(dir).size).toBe(0);
  });

  test('malformed file warns and yields empty map', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await writeFile(join(dir, '.sidemux.toml'), '[scripts\nbroken');
    expect(loadProjectScripts(dir).size).toBe(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('malformed'));
  });
});
