/**
 * `sidemux init` orchestrator: detect delegation candidates, ask which to
 * wire up (or take them from flags), then write the guard hook + directives.
 * The pure detection/merging lives in detect.ts and templates.ts; this file
 * owns the filesystem and the prompt.
 */
import { readdir, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { join } from 'node:path';
import { type PaneLayout, isValidLayout, isValidPaneSize } from '../config.js';
import {
  detectCandidates,
  parseJustfileRecipes,
  parsePyproject,
  type DelegatedCommand,
  type CommandRole,
} from './detect.js';
import {
  delegateJson,
  directiveBlock,
  guardScript,
  mergeMcpServer,
  mergeSettingsHook,
  removeMarkedBlock,
  removeMcpServer,
  removeSettingsHook,
  upsertMarkedBlock,
} from './templates.js';

export interface InitIO {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

export interface InitOptions {
  cwd: string;
  argv: string[];
  io?: InitIO;
}

interface Flags {
  dir: string;
  yes: boolean;
  uninstall: boolean;
  mcp: boolean;
  commands: string[] | null;
  help: boolean;
  /** Refresh all artifacts from the recorded selection, no prompts. */
  sync: boolean;
  /** Raw --layout value (validated later, where io is available for warnings). */
  layout: string | null;
  /** Raw --pane-size value (validated later). */
  paneSize: string | null;
  /** Auto-close panes after a successful command (SIDEMUX_CLOSE_ON_SUCCESS). */
  closeOnSuccess: boolean;
}

const HELP = `sidemux init — wire a project to delegate test/lint/build to tmux panes.

Usage: sidemux init [options]

  --yes, -y            Non-interactive: delegate every detected command
  --commands "a,b"     Delegate exactly these commands (implies --yes),
                       e.g. --commands "pytest,composer test"
  --mcp                Also register the sidemux MCP server in .mcp.json
  --layout <edge>      Pane bar edge: bottom|top|left|right (with --mcp)
  --pane-size <size>   Bar size: "30%" or a cell count (with --mcp)
  --close-on-success   Auto-close a pane after its command exits 0 (with --mcp)
  --sync               Refresh all generated files, keep your selection, and ask
                       about commands detected since the last init (--yes skips
                       the question and keeps the recorded selection as-is)
  --uninstall          Remove everything sidemux init added, including the
                       sidemux entry in .mcp.json ("sidemux uninstall" is an alias)
  --dir <path>         Target project directory (default: current directory)
  --help, -h           Show this help

With --mcp and no --layout/--pane-size/--close-on-success flags, init asks
these interactively (unless --yes).

Detection covers package.json scripts (via your lockfile's package manager),
composer.json scripts, pyproject.toml (pytest/ruff/mypy under uv/poetry),
go.mod and Cargo.toml conventions, and Makefile / justfile targets.

Writes: .sidemux/delegate-guard.mjs + delegate.json, a PreToolUse hook in
.claude/settings.json, and a delegation block in CLAUDE.md / AGENTS.md.
`;

function parseFlags(cwd: string, argv: string[]): Flags {
  const flags: Flags = {
    dir: cwd,
    yes: false,
    uninstall: false,
    mcp: false,
    commands: null,
    help: false,
    sync: false,
    layout: null,
    paneSize: null,
    closeOnSuccess: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--yes' || arg === '-y') flags.yes = true;
    else if (arg === '--sync') flags.sync = true;
    else if (arg === '--uninstall') flags.uninstall = true;
    else if (arg === '--mcp') flags.mcp = true;
    else if (arg === '--help' || arg === '-h') flags.help = true;
    else if (arg === '--dir') flags.dir = argv[++i] ?? cwd;
    else if (arg.startsWith('--dir=')) flags.dir = arg.slice('--dir='.length);
    else if (arg === '--commands') flags.commands = splitCommands(argv[++i] ?? '');
    else if (arg.startsWith('--commands=')) flags.commands = splitCommands(arg.slice('--commands='.length));
    else if (arg === '--layout') flags.layout = argv[++i] ?? null;
    else if (arg.startsWith('--layout=')) flags.layout = arg.slice('--layout='.length);
    else if (arg === '--pane-size') flags.paneSize = argv[++i] ?? null;
    else if (arg.startsWith('--pane-size=')) flags.paneSize = arg.slice('--pane-size='.length);
    else if (arg === '--close-on-success') flags.closeOnSuccess = true;
  }
  return flags;
}

function splitCommands(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

function parseMakefileTargets(makefile: string): string[] {
  const targets: string[] = [];
  for (const line of makefile.split('\n')) {
    const match = /^([a-zA-Z0-9_.-]+):(?!=)/.exec(line);
    if (match && !match[1]!.startsWith('.')) targets.push(match[1]!);
  }
  return targets;
}

/** Infer role/longRunning for a command string not in the detected set. */
function inferCommand(command: string): DelegatedCommand {
  const lower = command.toLowerCase();
  const longRunning = /\b(dev|start|watch|serve)\b/.test(lower);
  let role: CommandRole = 'other';
  if (/\btest\b/.test(lower)) role = 'test';
  else if (/\b(lint|typecheck|check)\b/.test(lower)) role = 'lint';
  else if (/\b(build|compile)\b/.test(lower)) role = 'build';
  else if (longRunning) role = 'dev';
  return { role, command, longRunning };
}

function resolveExplicit(detected: DelegatedCommand[], commands: string[]): DelegatedCommand[] {
  return commands.map((command) => detected.find((c) => c.command === command) ?? inferCommand(command));
}

async function promptSelection(
  candidates: DelegatedCommand[],
  io: InitIO,
  heading = '\nsidemux init — commands it can delegate to tmux panes:\n',
): Promise<DelegatedCommand[]> {
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    io.stdout.write(heading);
    candidates.forEach((c, i) => io.stdout.write(`  ${i + 1}. ${c.command}  (${c.role})\n`));
    const answer = (
      await rl.question('\nDelegate which? [all / comma numbers / none]: ')
    ).trim().toLowerCase();
    if (answer === '' || answer === 'all' || answer === 'a') return candidates;
    if (answer === 'none' || answer === 'n') return [];
    const picks = answer
      .split(',')
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length);
    return picks.map((n) => candidates[n - 1]!);
  } finally {
    rl.close();
  }
}

/** Yes/no question with a default-yes answer on empty input. */
async function promptYesNo(io: InitIO, question: string): Promise<boolean> {
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Ask where delegated panes appear (a full-span bar; extras tile within it). */
async function promptLayout(
  io: InitIO,
): Promise<{ layout: PaneLayout; paneSize: string; closeOnSuccess: boolean }> {
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    io.stdout.write(
      '\nsidemux init — where should delegated panes appear?\n' +
        '  A bar spanning that edge; extra panes tile within it (agent keeps the rest).\n',
    );
    const layoutRaw = (
      await rl.question('\nBar edge? [bottom (default) / top / left / right]: ')
    ).trim().toLowerCase();
    let layout: PaneLayout = 'bottom';
    if (layoutRaw === '') layout = 'bottom';
    else if (isValidLayout(layoutRaw)) layout = layoutRaw;
    else io.stdout.write(`  (unrecognized "${layoutRaw}" — using bottom)\n`);

    const sizeRaw = (
      await rl.question('Bar size? ["30%" default, or a % / cell count]: ')
    ).trim();
    let paneSize = '30%';
    if (sizeRaw === '') paneSize = '30%';
    else if (isValidPaneSize(sizeRaw)) paneSize = sizeRaw;
    else io.stdout.write(`  (unrecognized "${sizeRaw}" — using 30%)\n`);

    const closeRaw = (
      await rl.question('Auto-close a pane after its command succeeds? [y/N]: ')
    ).trim().toLowerCase();
    const closeOnSuccess = closeRaw === 'y' || closeRaw === 'yes';

    return { layout, paneSize, closeOnSuccess };
  } finally {
    rl.close();
  }
}

async function writeArtifacts(
  dir: string,
  selected: DelegatedCommand[],
  withMcp: boolean,
  mcpEnv: Record<string, string>,
  out: NodeJS.WritableStream,
): Promise<void> {
  const sidemuxDir = join(dir, '.sidemux');
  await mkdir(sidemuxDir, { recursive: true });
  const guardPath = join(sidemuxDir, 'delegate-guard.mjs');
  await writeFile(guardPath, guardScript());
  await chmod(guardPath, 0o755);
  await writeFile(join(sidemuxDir, 'delegate.json'), delegateJson(selected));

  const claudeDir = join(dir, '.claude');
  await mkdir(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');
  const settings = mergeSettingsHook(await readJson(settingsPath));
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  const block = directiveBlock(selected);
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const path = join(dir, name);
    await writeFile(path, upsertMarkedBlock(await readText(path), block));
  }

  if (withMcp) {
    const mcpPath = join(dir, '.mcp.json');
    const mcp = mergeMcpServer(await readJson(mcpPath), mcpEnv);
    await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
  }

  if (selected.length === 0) {
    out.write('\nsidemux init: no commands delegated yet — generic directive installed.\n');
  } else {
    out.write('\nsidemux init: delegating\n');
    for (const c of selected) out.write(`  • ${c.command}\n`);
  }
  out.write(
    '\nWrote:\n' +
      '  .sidemux/delegate-guard.mjs   PreToolUse guard (blocks inline runs)\n' +
      '  .sidemux/delegate.json        the delegated command list\n' +
      '  .claude/settings.json         registers the guard hook\n' +
      '  CLAUDE.md, AGENTS.md          delegation directives\n' +
      (withMcp ? '  .mcp.json                     sidemux MCP server\n' : '') +
      '\nUndo any time with:  sidemux init --uninstall\n',
  );
}

/** Detect delegation candidates from a project directory's manifests. */
async function detectFromDir(dir: string): Promise<DelegatedCommand[]> {
  const packageJson = (await readJson(join(dir, 'package.json'))) as
    | { scripts?: Record<string, string> }
    | null;
  const rootFiles = await readdir(dir).catch(() => [] as string[]);
  const makefile = await readText(join(dir, 'Makefile'));

  const composer = await readJson(join(dir, 'composer.json'));
  const composerScripts = Object.keys(
    (composer?.scripts as Record<string, unknown> | undefined) ?? {},
  );

  const pyprojectText = await readText(join(dir, 'pyproject.toml'));

  const justfileName = rootFiles.find((f) => {
    const lower = f.toLowerCase();
    return lower === 'justfile' || lower === '.justfile';
  });
  const justfile = justfileName ? await readText(join(dir, justfileName)) : '';

  return detectCandidates({
    packageJson: packageJson ?? undefined,
    rootFiles,
    makefileTargets: parseMakefileTargets(makefile),
    composerScripts,
    pyproject: pyprojectText ? parsePyproject(pyprojectText) : undefined,
    justfileRecipes: parseJustfileRecipes(justfile),
  });
}

/** Rehydrate the recorded selection from `.sidemux/delegate.json`, if any. */
async function readPriorSelection(dir: string): Promise<DelegatedCommand[] | null> {
  const config = await readJson(join(dir, '.sidemux', 'delegate.json'));
  if (!config || !Array.isArray(config.commands)) return null;
  const roles: CommandRole[] = ['test', 'lint', 'build', 'dev', 'other'];
  const selected: DelegatedCommand[] = [];
  for (const entry of config.commands as Partial<DelegatedCommand>[]) {
    if (!entry || typeof entry.command !== 'string') continue;
    const inferred = inferCommand(entry.command);
    selected.push({
      command: entry.command,
      role: roles.includes(entry.role as CommandRole) ? (entry.role as CommandRole) : inferred.role,
      longRunning: typeof entry.longRunning === 'boolean' ? entry.longRunning : inferred.longRunning,
    });
  }
  // An empty array is a valid recorded selection (generic-only install) —
  // --sync must still work there, so only a missing/invalid file returns null.
  return selected;
}

/**
 * `sidemux init --sync`: rewrite every artifact (guard, hook, directives, MCP
 * entry) from the recorded selection — refresh templates after a sidemux
 * upgrade without resetting a custom command list. Commands detected since the
 * last init are offered interactively (skipped under --yes, which keeps the
 * recorded selection untouched). The MCP entry is only touched if one already
 * exists, and its env is left alone.
 */
async function sync(dir: string, yes: boolean, io: InitIO): Promise<number> {
  const selected = await readPriorSelection(dir);
  if (!selected) {
    io.stdout.write(
      'sidemux init --sync: no .sidemux/delegate.json here — run `sidemux init` first.\n',
    );
    return 1;
  }

  const known = new Set(selected.map((c) => c.command));
  const fresh = (await detectFromDir(dir)).filter((c) => !known.has(c.command));
  if (fresh.length > 0) {
    if (yes) {
      io.stdout.write(
        'sidemux init --sync: new candidates detected but not delegated (re-run without --yes to pick):\n',
      );
      for (const c of fresh) io.stdout.write(`  • ${c.command}  (${c.role})\n`);
    } else {
      const additions = await promptSelection(
        fresh,
        io,
        '\nsidemux init --sync — new commands detected since the last init:\n',
      );
      selected.push(...additions);
    }
  }

  const mcp = await readJson(join(dir, '.mcp.json'));
  const withMcp = Boolean((mcp?.mcpServers as Record<string, unknown> | undefined)?.sidemux);
  await writeArtifacts(dir, selected, withMcp, {}, io.stdout);
  return 0;
}

/** Join a list with commas and an Oxford "and": [a] → "a", [a,b,c] → "a, b, and c". */
function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

async function uninstall(dir: string, out: NodeJS.WritableStream): Promise<void> {
  const { rm, stat } = await import('node:fs/promises');
  const exists = async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  };

  const hadSidemuxDir = await exists(join(dir, '.sidemux'));
  await rm(join(dir, '.sidemux', 'delegate-guard.mjs'), { force: true });
  await rm(join(dir, '.sidemux', 'delegate.json'), { force: true });
  await rm(join(dir, '.sidemux'), { recursive: true, force: true });

  const settingsPath = join(dir, '.claude', 'settings.json');
  const settings = await readJson(settingsPath);
  let removedHook = false;
  if (settings) {
    const stripped = removeSettingsHook(settings);
    removedHook = JSON.stringify(stripped) !== JSON.stringify(settings);
    if (removedHook) await writeFile(settingsPath, `${JSON.stringify(stripped, null, 2)}\n`);
  }

  let removedDirectives = false;
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    const path = join(dir, name);
    const existing = await readText(path);
    if (existing) {
      const stripped = removeMarkedBlock(existing);
      if (stripped !== existing) {
        await writeFile(path, stripped);
        removedDirectives = true;
      }
    }
  }

  const mcpPath = join(dir, '.mcp.json');
  const mcp = await readJson(mcpPath);
  const hadMcpEntry = Boolean((mcp?.mcpServers as Record<string, unknown> | undefined)?.sidemux);
  if (mcp && hadMcpEntry) {
    await writeFile(mcpPath, `${JSON.stringify(removeMcpServer(mcp), null, 2)}\n`);
  }

  if (!hadSidemuxDir && !removedHook && !removedDirectives && !hadMcpEntry) {
    out.write('sidemux init: nothing to remove — sidemux was not installed here.\n');
    return;
  }

  const removed: string[] = [];
  if (hadSidemuxDir) removed.push('guard');
  if (removedHook) removed.push('hook');
  if (removedDirectives) removed.push('delegation directives');
  if (hadMcpEntry) removed.push('the sidemux entry in .mcp.json');
  out.write(`sidemux init: removed ${joinList(removed)}.\n`);
}

/** Entry point for `sidemux init`. Returns a process exit code. */
export async function runInit(options: InitOptions): Promise<number> {
  const io: InitIO = options.io ?? { stdin: process.stdin, stdout: process.stdout };
  const flags = parseFlags(options.cwd, options.argv);
  if (flags.help) {
    io.stdout.write(HELP);
    return 0;
  }
  if (flags.uninstall) {
    await uninstall(flags.dir, io.stdout);
    return 0;
  }
  if (flags.sync) {
    return sync(flags.dir, flags.yes, io);
  }

  const detected = await detectFromDir(flags.dir);

  let selected: DelegatedCommand[];
  let genericOnly = false;
  if (flags.commands) {
    selected = resolveExplicit(detected, flags.commands);
  } else if (detected.length === 0) {
    io.stdout.write(
      'sidemux init: no test/lint/build/dev commands detected in package.json, ' +
        'composer.json, pyproject.toml, go.mod, Cargo.toml, Makefile, or justfile.\n' +
        'You can pass commands explicitly, e.g. --commands "pytest,composer test".\n',
    );
    if (!flags.yes && !(await promptYesNo(io, '\nInstall the generic directive block anyway? [Y/n]: '))) {
      io.stdout.write('sidemux init: no changes made.\n');
      return 0;
    }
    if (flags.yes) {
      io.stdout.write(
        'Installing the generic delegation directive only — no commands are guarded ' +
          'until you add some (--commands, or `sidemux init --sync` once they exist).\n',
      );
    }
    selected = [];
    genericOnly = true;
  } else if (flags.yes) {
    selected = detected;
  } else {
    selected = await promptSelection(detected, io);
  }

  if (selected.length === 0 && !genericOnly) {
    io.stdout.write('sidemux init: nothing selected — no changes made.\n');
    return 0;
  }

  // Pane layout/close only live in the sidemux MCP env, so they're resolved only
  // under --mcp: explicit flags win; otherwise prompt (unless --yes), and a bare
  // --yes leaves env empty so the server's own defaults (bottom / 30% / no auto-
  // close) apply.
  const mcpEnv: Record<string, string> = {};
  if (flags.mcp) {
    if (flags.layout !== null || flags.paneSize !== null || flags.closeOnSuccess) {
      if (flags.layout !== null) {
        if (isValidLayout(flags.layout)) mcpEnv.SIDEMUX_LAYOUT = flags.layout;
        else io.stdout.write(`sidemux init: ignoring --layout "${flags.layout}" (use bottom|top|left|right)\n`);
      }
      if (flags.paneSize !== null) {
        if (isValidPaneSize(flags.paneSize)) mcpEnv.SIDEMUX_PANE_SIZE = flags.paneSize;
        else io.stdout.write(`sidemux init: ignoring --pane-size "${flags.paneSize}" (use "30%" or a cell count)\n`);
      }
      if (flags.closeOnSuccess) mcpEnv.SIDEMUX_CLOSE_ON_SUCCESS = '1';
    } else if (!flags.yes) {
      const chosen = await promptLayout(io);
      mcpEnv.SIDEMUX_LAYOUT = chosen.layout;
      mcpEnv.SIDEMUX_PANE_SIZE = chosen.paneSize;
      if (chosen.closeOnSuccess) mcpEnv.SIDEMUX_CLOSE_ON_SUCCESS = '1';
    }
  }

  await writeArtifacts(flags.dir, selected, flags.mcp, mcpEnv, io.stdout);
  return 0;
}
