import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { runInit } from '../../src/init/install.js';

function fakeIo(answers: string[] = []): {
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream };
  text: () => string;
} {
  let out = '';
  return {
    io: {
      stdin: answers.length > 0 ? Readable.from(answers.map((a) => `${a}\n`)) : process.stdin,
      stdout: { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WritableStream,
    },
    text: () => out,
  };
}

function runGuard(dir: string, command: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('node', [join(dir, '.sidemux', 'delegate-guard.mjs')], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('sidemux init', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sidemux-init-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'vitest', build: 'tsup', dev: 'vite' } }),
    );
    await writeFile(join(dir, 'pnpm-lock.yaml'), '');
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  test('--yes writes guard, hook, delegate.json, and directives', async () => {
    const { io } = fakeIo();
    const code = await runInit({ cwd: dir, argv: ['--yes'], io });
    expect(code).toBe(0);

    const guard = await stat(join(dir, '.sidemux', 'delegate-guard.mjs'));
    expect(guard.mode & 0o111).toBeGreaterThan(0); // executable

    const delegate = JSON.parse(await readFile(join(dir, '.sidemux', 'delegate.json'), 'utf8'));
    expect(delegate.commands.map((c: { command: string }) => c.command)).toEqual([
      'pnpm test',
      'pnpm build',
      'pnpm dev',
    ]);

    const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(settings)).toContain('delegate-guard.mjs');

    const claudeMd = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('BEGIN sidemux-delegate');
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toContain('BEGIN sidemux-delegate');
  });

  test('re-running is idempotent (single block, single hook)', async () => {
    const { io } = fakeIo();
    await runInit({ cwd: dir, argv: ['--yes'], io });
    await runInit({ cwd: dir, argv: ['--yes'], io });

    const claudeMd = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd.match(/BEGIN sidemux-delegate/g)).toHaveLength(1);
    const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toHaveLength(1);
  });

  test('--commands overrides detection and infers unknown roles', async () => {
    const { io } = fakeIo();
    await runInit({ cwd: dir, argv: ['--commands', 'cargo test,webpack serve'], io });
    const delegate = JSON.parse(await readFile(join(dir, '.sidemux', 'delegate.json'), 'utf8'));
    const byCommand = Object.fromEntries(
      delegate.commands.map((c: { command: string; longRunning: boolean }) => [c.command, c.longRunning]),
    );
    expect(byCommand['cargo test']).toBe(false);
    expect(byCommand['webpack serve']).toBe(true); // "serve" → long-running
  });

  test('the generated guard blocks a delegated command and passes others', () => {
    return runInit({ cwd: dir, argv: ['--yes'], io: fakeIo().io }).then(() => {
      const blocked = runGuard(dir, 'pnpm test --coverage');
      expect(blocked.status).toBe(2);
      expect(blocked.stderr).toContain('Delegate');
      expect(blocked.stderr).toContain('run { command: "pnpm test" }');

      const allowed = runGuard(dir, 'ls -la');
      expect(allowed.status).toBe(0);

      const bypass = runGuard(dir, 'pnpm test', { SIDEMUX_DELEGATE_OFF: '1' });
      expect(bypass.status).toBe(0);
    });
  });

  test('--uninstall removes the guard, hook, and directives', async () => {
    const { io } = fakeIo();
    await runInit({ cwd: dir, argv: ['--yes'], io });
    await runInit({ cwd: dir, argv: ['--uninstall'], io });

    await expect(stat(join(dir, '.sidemux', 'delegate-guard.mjs'))).rejects.toThrow();
    const settings = JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(settings)).not.toContain('delegate-guard.mjs');
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).not.toContain('sidemux-delegate');
  });

  test('--uninstall strips the sidemux .mcp.json entry but keeps other servers', async () => {
    const { io, text } = fakeIo();
    await writeFile(
      join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    );
    await runInit({ cwd: dir, argv: ['--yes', '--mcp'], io });
    await runInit({ cwd: dir, argv: ['--uninstall'], io });

    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.sidemux).toBeUndefined();
    expect(mcp.mcpServers.other).toEqual({ command: 'x' });
    expect(text()).toContain('the sidemux entry in .mcp.json');
  });

  test('--mcp with --layout/--pane-size writes them into the server env', async () => {
    const { io } = fakeIo();
    const code = await runInit({
      cwd: dir,
      argv: ['--yes', '--mcp', '--layout', 'right', '--pane-size', '40%'],
      io,
    });
    expect(code).toBe(0);
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.sidemux.env).toEqual({
      SIDEMUX_LAYOUT: 'right',
      SIDEMUX_PANE_SIZE: '40%',
    });
  });

  test('--mcp --close-on-success writes SIDEMUX_CLOSE_ON_SUCCESS into the env', async () => {
    const { io } = fakeIo();
    await runInit({ cwd: dir, argv: ['--yes', '--mcp', '--close-on-success'], io });
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.sidemux.env).toEqual({ SIDEMUX_CLOSE_ON_SUCCESS: '1' });
  });

  test('--mcp --yes with no layout flags leaves env empty (runtime defaults)', async () => {
    const { io } = fakeIo();
    await runInit({ cwd: dir, argv: ['--yes', '--mcp'], io });
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.sidemux.env).toEqual({});
  });

  test('--mcp ignores an invalid --layout and warns', async () => {
    const { io, text } = fakeIo();
    await runInit({ cwd: dir, argv: ['--yes', '--mcp', '--layout', 'sideways'], io });
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.sidemux.env).toEqual({});
    expect(text()).toContain('ignoring --layout "sideways"');
  });

  test('--sync --yes refreshes artifacts, keeps the recorded selection, lists new candidates', async () => {
    const { io, text } = fakeIo();
    await runInit({ cwd: dir, argv: ['--commands', 'pnpm test', '--mcp', '--layout', 'right'], io });

    // Simulate a stale install: clobber the guard, drop the directive block.
    await writeFile(join(dir, '.sidemux', 'delegate-guard.mjs'), '// stale\n');
    await writeFile(join(dir, 'CLAUDE.md'), '# Project\n');

    const code = await runInit({ cwd: dir, argv: ['--sync', '--yes'], io });
    expect(code).toBe(0);

    // Guard regenerated from the current template and still executable.
    expect(await readFile(join(dir, '.sidemux', 'delegate-guard.mjs'), 'utf8')).toContain(
      'matchesDelegated',
    );
    expect(runGuard(dir, 'pnpm test').status).toBe(2);

    // Custom selection preserved — not reset to everything detected — with the
    // detected-but-undelegated commands reported.
    const delegate = JSON.parse(await readFile(join(dir, '.sidemux', 'delegate.json'), 'utf8'));
    expect(delegate.commands.map((c: { command: string }) => c.command)).toEqual(['pnpm test']);
    expect(text()).toContain('new candidates detected but not delegated');
    expect(text()).toContain('pnpm build');

    // Directive block restored; MCP env (layout choice) untouched.
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toContain('BEGIN sidemux-delegate');
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers.sidemux.env).toEqual({ SIDEMUX_LAYOUT: 'right' });
  });

  test('interactive --sync asks about commands detected since the last init', async () => {
    await runInit({ cwd: dir, argv: ['--commands', 'pnpm test'], io: fakeIo().io });

    // Answer "1" to the new-commands prompt: delegate the first fresh candidate.
    const { io, text } = fakeIo(['1']);
    const code = await runInit({ cwd: dir, argv: ['--sync'], io });
    expect(code).toBe(0);
    expect(text()).toContain('new commands detected since the last init');

    const delegate = JSON.parse(await readFile(join(dir, '.sidemux', 'delegate.json'), 'utf8'));
    const commands = delegate.commands.map((c: { command: string }) => c.command);
    expect(commands).toContain('pnpm test'); // recorded selection kept
    expect(commands).toHaveLength(2); // exactly one addition
  });

  test('interactive --sync with "none" keeps the recorded selection unchanged', async () => {
    await runInit({ cwd: dir, argv: ['--commands', 'pnpm test'], io: fakeIo().io });

    const { io } = fakeIo(['none']);
    await runInit({ cwd: dir, argv: ['--sync'], io });

    const delegate = JSON.parse(await readFile(join(dir, '.sidemux', 'delegate.json'), 'utf8'));
    expect(delegate.commands.map((c: { command: string }) => c.command)).toEqual(['pnpm test']);
  });

  test('--sync without a prior install makes no changes and exits 1', async () => {
    const { io, text } = fakeIo();
    const code = await runInit({ cwd: dir, argv: ['--sync'], io });
    expect(code).toBe(1);
    expect(text()).toContain('run `sidemux init` first');
    await expect(stat(join(dir, '.sidemux'))).rejects.toThrow();
  });

  test('--yes with nothing detected installs the generic-only directive', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { deploy: 'x' } }));
    const { io, text } = fakeIo();
    const code = await runInit({ cwd: dir, argv: ['--yes'], io });
    expect(code).toBe(0);
    expect(text()).toContain('no test/lint/build/dev commands detected');
    expect(text()).toContain('generic delegation directive only');

    const delegate = JSON.parse(await readFile(join(dir, '.sidemux', 'delegate.json'), 'utf8'));
    expect(delegate.commands).toEqual([]);
    const claudeMd = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('No project-specific commands are wired up yet');
    expect(runGuard(dir, 'pnpm test').status).toBe(0); // guard inert on an empty list
  });

  test('interactive nothing-detected: "n" declines, default installs', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { deploy: 'x' } }));

    const decline = fakeIo(['n']);
    expect(await runInit({ cwd: dir, argv: [], io: decline.io })).toBe(0);
    expect(decline.text()).toContain('--commands "pytest,composer test"');
    await expect(stat(join(dir, '.sidemux'))).rejects.toThrow();

    const accept = fakeIo(['']);
    expect(await runInit({ cwd: dir, argv: [], io: accept.io })).toBe(0);
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toContain('BEGIN sidemux-delegate');
  });

  test('--sync after a generic-only install offers later-added commands', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { deploy: 'x' } }));
    await runInit({ cwd: dir, argv: ['--yes'], io: fakeIo().io });

    // The project later gains a test script; --sync picks it up.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest' } }));
    const { io, text } = fakeIo(['1']);
    const code = await runInit({ cwd: dir, argv: ['--sync'], io });
    expect(code).toBe(0);
    expect(text()).toContain('new commands detected since the last init');

    const delegate = JSON.parse(await readFile(join(dir, '.sidemux', 'delegate.json'), 'utf8'));
    expect(delegate.commands.map((c: { command: string }) => c.command)).toEqual(['pnpm test']);
  });
});

describe('sidemux init (non-JS projects)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sidemux-init-'));
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dir, { recursive: true, force: true });
  });

  async function delegated(): Promise<string[]> {
    const delegate = JSON.parse(await readFile(join(dir, '.sidemux', 'delegate.json'), 'utf8'));
    return delegate.commands.map((c: { command: string }) => c.command);
  }

  test('Python: pyproject.toml + uv.lock delegates uv run commands', async () => {
    await writeFile(
      join(dir, 'pyproject.toml'),
      '[project]\nname = "demo"\ndependencies = ["fastapi"]\n\n' +
        '[dependency-groups]\ndev = ["pytest", "ruff"]\n',
    );
    await writeFile(join(dir, 'uv.lock'), '');
    await runInit({ cwd: dir, argv: ['--yes'], io: fakeIo().io });
    expect(await delegated()).toEqual(['uv run pytest', 'uv run ruff check .']);
  });

  test('PHP: composer.json scripts delegate as composer commands', async () => {
    await writeFile(
      join(dir, 'composer.json'),
      JSON.stringify({ scripts: { test: 'phpunit', lint: 'phpcs' } }),
    );
    await runInit({ cwd: dir, argv: ['--yes'], io: fakeIo().io });
    expect(await delegated()).toEqual(['composer test', 'composer lint']);
  });

  test('Go: go.mod delegates conventional commands and the guard blocks them', async () => {
    await writeFile(join(dir, 'go.mod'), 'module example.com/demo\n');
    await runInit({ cwd: dir, argv: ['--yes'], io: fakeIo().io });
    expect(await delegated()).toEqual(['go test ./...', 'go vet ./...', 'go build ./...']);
    expect(runGuard(dir, 'go test ./... -run TestFoo').status).toBe(2);
  });

  test('justfile recipes delegate as just commands', async () => {
    await writeFile(join(dir, 'justfile'), 'test:\n  cargo test\n\nfmt:\n  cargo fmt\n');
    await runInit({ cwd: dir, argv: ['--yes'], io: fakeIo().io });
    expect(await delegated()).toEqual(['just test']);
  });
});
