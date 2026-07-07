/**
 * Pure project detection for `sidemux init`. Given the raw contents of a
 * project root (parsed manifests, root filenames, Makefile/justfile targets),
 * work out which commands are worth delegating to sidemux and how to invoke
 * them. Covers package.json scripts, composer.json scripts, pyproject.toml
 * heuristics, go.mod/Cargo.toml conventions, and Makefile/justfile targets.
 * No filesystem access here so it unit-tests off fixtures.
 */

export type CommandRole = 'test' | 'lint' | 'build' | 'e2e' | 'dev' | 'other';

/** Display/sort order for roles, shared by detection and the stats table. */
export const ROLE_ORDER: CommandRole[] = ['test', 'lint', 'build', 'e2e', 'dev', 'other'];

export interface DelegatedCommand {
  role: CommandRole;
  /** The full shell command to run, e.g. "pnpm test". */
  command: string;
  /** Long-running (dev servers, watchers): suggest background, never close. */
  longRunning: boolean;
}

export type PackageManager = 'pnpm' | 'yarn' | 'npm';

/** Facts scanned from pyproject.toml (see parsePyproject). */
export interface PyprojectFacts {
  /** Normalized TOML table headers seen, e.g. "tool.ruff", "tool.pytest.ini_options". */
  sections: string[];
  /** Lowercased distribution names from dependency contexts (PEP 621/735, Poetry). */
  deps: string[];
}

export interface DetectInput {
  /** Parsed package.json (or undefined when absent/unreadable). */
  packageJson?: { scripts?: Record<string, string>; packageManager?: string } | undefined;
  /** Filenames in the project root (lockfiles, go.mod, Cargo.toml, pytest.ini, …). */
  rootFiles?: string[];
  /**
   * Package manager resolved by the caller (e.g. from a lockfile found in a
   * parent directory of a monorepo package). Local root files still win.
   */
  fallbackPackageManager?: PackageManager | undefined;
  /** Makefile target names, if a Makefile was found. */
  makefileTargets?: string[];
  /** composer.json "scripts" keys, if a composer.json was found. */
  composerScripts?: string[];
  /** Facts scanned from pyproject.toml, if present. */
  pyproject?: PyprojectFacts | undefined;
  /** justfile recipe names, if a justfile was found. */
  justfileRecipes?: string[];
}

/** Script name → role. Anything not listed is ignored by detection. */
const SCRIPT_ROLES: Record<string, CommandRole> = {
  test: 'test',
  'test:unit': 'test',
  'test:integration': 'test',
  lint: 'lint',
  typecheck: 'lint',
  'type-check': 'lint',
  check: 'lint',
  build: 'build',
  compile: 'build',
  e2e: 'e2e',
  'test:e2e': 'e2e',
  dev: 'dev',
  start: 'dev',
  watch: 'dev',
  serve: 'dev',
};

const LONG_RUNNING_ROLES = new Set<CommandRole>(['dev']);

/**
 * Package manager for a project. Precedence: a lockfile among the local root
 * files, then package.json's `packageManager` field (corepack pin — present at
 * most monorepo roots), then a `pnpm-workspace.yaml` in the root files (pnpm
 * monorepos need no lockfile to be unambiguous), then the caller's fallback
 * (found by walking up from a monorepo package), then npm.
 */
export function detectPackageManager(
  rootFiles: string[] = [],
  packageManagerField?: string,
  fallback?: PackageManager,
): PackageManager {
  const fromLockfiles = packageManagerFromLockfiles(rootFiles);
  if (fromLockfiles) {return fromLockfiles;}
  const pinned = /^(pnpm|yarn|npm)(?=@|$)/.exec(packageManagerField?.trim() ?? '');
  if (pinned) {return pinned[0] as PackageManager;}
  if (rootFiles.includes('pnpm-workspace.yaml')) {return 'pnpm';}
  return fallback ?? 'npm';
}

/** The package manager a lockfile set pins, or null when none is present. */
export function packageManagerFromLockfiles(lockfiles: string[]): PackageManager | null {
  if (lockfiles.includes('pnpm-lock.yaml')) {return 'pnpm';}
  if (lockfiles.includes('yarn.lock')) {return 'yarn';}
  if (lockfiles.includes('package-lock.json') || lockfiles.includes('npm-shrinkwrap.json')) {
    return 'npm';
  }
  return null;
}

/** Build the shell invocation for a package.json script under a given manager. */
export function scriptCommand(pm: PackageManager, script: string): string {
  if (pm === 'npm') {return `npm run ${script}`;}
  return `${pm} ${script}`;
}

/**
 * How to invoke a locally-installed binary (nx, …) under a given manager.
 * pnpm gets the explicit `exec` form: bare `pnpm nx` resolves scripts first
 * and collides with pnpm built-ins, so it isn't a reliable binary runner.
 */
export function execCommand(pm: PackageManager, binary: string): string {
  if (pm === 'npm') {return `npx ${binary}`;}
  if (pm === 'pnpm') {return `pnpm exec ${binary}`;}
  return `${pm} ${binary}`;
}

/** An Nx project discovered in the workspace and its runnable target names. */
export interface NxProjectInfo {
  name: string;
  targets: string[];
}

/** Nx targets worth exposing as per-project sidemux scripts. */
const NX_SCRIPT_TARGETS = new Set(['lint', 'test', 'build', 'e2e', 'typecheck']);

/**
 * Per-project Nx targets as named sidemux scripts: `"<project>:<target>"` →
 * `pnpm exec nx run <project>:<target>`. These go into `.sidemux.toml`
 * `[scripts]` rather than the delegated-command list — a real workspace has
 * dozens of projects, which would swamp the interactive selection.
 */
export function nxProjectScripts(
  pm: PackageManager,
  projects: NxProjectInfo[],
): Map<string, string> {
  const nx = execCommand(pm, 'nx');
  const scripts = new Map<string, string>();
  for (const project of [...projects].sort((a, b) => a.name.localeCompare(b.name))) {
    for (const target of project.targets.filter((t) => NX_SCRIPT_TARGETS.has(t)).sort()) {
      const ref = `${project.name}:${target}`;
      scripts.set(ref, `${nx} run ${ref}`);
    }
  }
  return scripts;
}

/**
 * Classify an arbitrary shell command into a role by keyword. Used for
 * explicitly-passed `--commands` entries and for the workspace token-stats
 * grouping — detection itself matches exact script names instead.
 */
export function classifyCommandRole(command: string): CommandRole {
  const lower = command.toLowerCase();
  if (/\be2e\b|\bplaywright\b|\bcypress\b/.test(lower)) {return 'e2e';}
  if (/\btest\b|\bvitest\b|\bjest\b|\bpytest\b/.test(lower)) {return 'test';}
  if (/\b(lint|typecheck|check)\b/.test(lower)) {return 'lint';}
  if (/\b(build|compile)\b/.test(lower)) {return 'build';}
  if (/\b(dev|start|watch|serve)\b/.test(lower)) {return 'dev';}
  return 'other';
}

/** Truncate a line at the first # that sits outside single/double quotes. */
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (quote) {
      if (ch === quote) {quote = null;}
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** Sections whose `key = [...]` arrays hold dependency specifiers. */
const ARRAY_DEP_SECTIONS = new Set(['project.optional-dependencies', 'dependency-groups']);
/** Poetry sections whose keys are dependency names. */
const POETRY_DEP_SECTION = /^tool\.poetry(\.group\.[\w-]+)?\.(dev-)?dependencies$/;

/**
 * Scan pyproject.toml without a TOML parser: record table headers and the
 * distribution names that appear in dependency contexts — PEP 621
 * `[project] dependencies`, `[project.optional-dependencies]`,
 * `[dependency-groups]` (PEP 735, where uv keeps dev deps), and Poetry's
 * key-style dependency tables. Line-based and conservative by design.
 */
export function parsePyproject(toml: string): PyprojectFacts {
  const sections: string[] = [];
  const deps = new Set<string>();
  let current = '';
  let inDepArray = false;
  let bracketDepth = 0;

  for (const raw of toml.split('\n')) {
    const line = stripTomlComment(raw);

    if (!inDepArray) {
      const header = /^\s*\[\[?\s*([^\]]+?)\s*\]?\]/.exec(line);
      if (header) {
        current = (header[1] ?? '')
          .split('.')
          .map((part) => part.trim().replace(/^["']|["']$/g, ''))
          .join('.');
        sections.push(current);
        continue;
      }
    }

    const opensArray =
      !inDepArray &&
      ((current === 'project' && /^\s*dependencies\s*=\s*\[/.test(line)) ||
        (ARRAY_DEP_SECTIONS.has(current) && /^\s*[\w."'-]+\s*=\s*\[/.test(line)));

    if (opensArray || inDepArray) {
      // On the opening line only look past the `[` so a quoted key name
      // (`"dev" = [...]`) is never taken for a dependency.
      const specs = opensArray ? line.slice(line.indexOf('[')) : line;
      for (const match of specs.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) {
        if (match[1] !== undefined) {deps.add(match[1].toLowerCase());}
      }
      // Track the array across lines: strip quoted content (extras like
      // "uvicorn[standard]" carry brackets) then count what remains.
      const unquoted = line.replace(/"[^"]*"|'[^']*'/g, '');
      for (const ch of unquoted) {
        if (ch === '[') {bracketDepth++;}
        else if (ch === ']') {bracketDepth--;}
      }
      inDepArray = bracketDepth > 0;
      continue;
    }

    if (POETRY_DEP_SECTION.test(current)) {
      const match = /^\s*"?([A-Za-z0-9][A-Za-z0-9._-]*)"?\s*=/.exec(line);
      if (match?.[1] && match[1].toLowerCase() !== 'python') {deps.add(match[1].toLowerCase());}
    }
  }

  return { sections, deps: [...deps] };
}

/**
 * Recipe names from a justfile. Only bare column-0 recipes count —
 * parameterized recipes, `name := value` assignments, `_private` names,
 * attribute/`set`/`alias` lines, and indented bodies are all skipped.
 */
export function parseJustfileRecipes(text: string): string[] {
  const recipes: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^@?([A-Za-z][A-Za-z0-9_-]*)\s*:(?!=)/.exec(line);
    if (match?.[1] !== undefined) {recipes.push(match[1]);}
  }
  return recipes;
}

/**
 * Detect delegation candidates. Ordered by role (test, lint, build, dev) then
 * command, de-duplicated by command string.
 */
export function detectCandidates(input: DetectInput): DelegatedCommand[] {
  const roots = input.rootFiles ?? [];
  const pm = detectPackageManager(
    roots,
    input.packageJson?.packageManager,
    input.fallbackPackageManager,
  );
  const found = new Map<string, DelegatedCommand>();
  const add = (role: CommandRole, command: string): void => {
    if (!found.has(command)) {
      found.set(command, { role, command, longRunning: LONG_RUNNING_ROLES.has(role) });
    }
  };

  const scripts = input.packageJson?.scripts ?? {};
  for (const name of Object.keys(scripts)) {
    const role = SCRIPT_ROLES[name];
    if (role) {add(role, scriptCommand(pm, name));}
  }

  // Nx workspace (nx.json at the root): propose `nx run-many` per role, but
  // only for roles the root package.json scripts did not already cover — most
  // Nx repos keep targets on projects, not root scripts. NX_TUI=false is set
  // on every sidemux pane, so these never open Nx's interactive TUI.
  if (roots.includes('nx.json')) {
    const nx = execCommand(pm, 'nx');
    const covered = new Set([...found.values()].map((c) => c.role));
    for (const target of ['test', 'lint', 'build', 'e2e'] as const) {
      if (!covered.has(target)) {add(target, `${nx} run-many -t ${target}`);}
    }
  }

  for (const target of input.makefileTargets ?? []) {
    const role = SCRIPT_ROLES[target];
    if (role) {add(role, `make ${target}`);}
  }

  // composer.json scripts (PHP). No SCRIPT_ROLES name collides with a composer
  // built-in today; if the map ever gains one (install, status, …), switch that
  // entry to `composer run <name>`.
  for (const name of input.composerScripts ?? []) {
    const role = SCRIPT_ROLES[name];
    if (role) {add(role, `composer ${name}`);}
  }

  // pyproject.toml (Python): propose tool invocations under the project's
  // runner. uv wins when both locks are present (arbitrary but deterministic).
  if (input.pyproject) {
    const runner = roots.includes('uv.lock')
      ? 'uv run '
      : roots.includes('poetry.lock')
        ? 'poetry run '
        : '';
    const { sections, deps } = input.pyproject;
    const hasSection = (name: string): boolean =>
      sections.some((s) => s === name || s.startsWith(`${name}.`));
    const strongPytest =
      deps.includes('pytest') ||
      sections.includes('tool.pytest.ini_options') ||
      roots.includes('pytest.ini');
    // Weak signals (tox.ini, a tests/ entry) only count when a lockfile pins a
    // runner — a bare `pytest` guess fails too often without one.
    const weakPytest = runner !== '' && (roots.includes('tox.ini') || roots.includes('tests'));
    if (strongPytest || weakPytest) {add('test', `${runner}pytest`);}
    if (hasSection('tool.ruff') || deps.includes('ruff')) {add('lint', `${runner}ruff check .`);}
    if (hasSection('tool.mypy') || deps.includes('mypy')) {add('lint', `${runner}mypy .`);}
  }

  // Toolchains with conventional commands instead of a scripts manifest.
  if (roots.includes('go.mod')) {
    add('test', 'go test ./...');
    add('lint', 'go vet ./...');
    add('build', 'go build ./...');
  }
  if (roots.includes('Cargo.toml')) {
    add('test', 'cargo test');
    add('lint', 'cargo clippy');
    add('build', 'cargo build');
  }

  for (const recipe of input.justfileRecipes ?? []) {
    const role = SCRIPT_ROLES[recipe];
    if (role) {add(role, `just ${recipe}`);}
  }

  return [...found.values()].sort((a, b) => {
    const byRole = ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role);
    return byRole !== 0 ? byRole : a.command.localeCompare(b.command);
  });
}

/**
 * Does a Bash command line invoke one of the delegated commands? Splits on
 * shell separators and matches a segment that *is* or *starts with* a delegated
 * command. Shared shape with the generated guard script (kept in sync by test).
 */
export function matchesDelegated(
  commandLine: string,
  delegated: string[],
): string | null {
  const segments = commandLine
    .split(/&&|\|\||[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const segment of segments) {
    for (const target of delegated) {
      if (segment === target || segment.startsWith(`${target} `)) {return target;}
    }
  }
  return null;
}
