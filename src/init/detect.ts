/**
 * Pure project detection for `sidemux init`. Given the raw contents of a
 * project root (parsed manifests, root filenames, Makefile/justfile targets),
 * work out which commands are worth delegating to sidemux and how to invoke
 * them. Covers package.json scripts, composer.json scripts, pyproject.toml
 * heuristics, go.mod/Cargo.toml conventions, and Makefile/justfile targets.
 * No filesystem access here so it unit-tests off fixtures.
 */

export type CommandRole = 'test' | 'lint' | 'build' | 'dev' | 'other';

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
  packageJson?: { scripts?: Record<string, string> } | undefined;
  /** Filenames in the project root (lockfiles, go.mod, Cargo.toml, pytest.ini, …). */
  rootFiles?: string[];
  /** Makefile target names, if a Makefile was found. */
  makefileTargets?: string[];
  /** composer.json "scripts" keys, if a composer.json was found. */
  composerScripts?: string[];
  /** Facts scanned from pyproject.toml, if present. */
  pyproject?: PyprojectFacts;
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
  dev: 'dev',
  start: 'dev',
  watch: 'dev',
  serve: 'dev',
};

const LONG_RUNNING_ROLES = new Set<CommandRole>(['dev']);

export function detectPackageManager(lockfiles: string[] = []): PackageManager {
  if (lockfiles.includes('pnpm-lock.yaml')) return 'pnpm';
  if (lockfiles.includes('yarn.lock')) return 'yarn';
  return 'npm';
}

/** Build the shell invocation for a package.json script under a given manager. */
export function scriptCommand(pm: PackageManager, script: string): string {
  if (pm === 'npm') return `npm run ${script}`;
  return `${pm} ${script}`;
}

/** Truncate a line at the first # that sits outside single/double quotes. */
function stripTomlComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
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
        current = header[1]!
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
        deps.add(match[1]!.toLowerCase());
      }
      // Track the array across lines: strip quoted content (extras like
      // "uvicorn[standard]" carry brackets) then count what remains.
      const unquoted = line.replace(/"[^"]*"|'[^']*'/g, '');
      for (const ch of unquoted) {
        if (ch === '[') bracketDepth++;
        else if (ch === ']') bracketDepth--;
      }
      inDepArray = bracketDepth > 0;
      continue;
    }

    if (POETRY_DEP_SECTION.test(current)) {
      const match = /^\s*"?([A-Za-z0-9][A-Za-z0-9._-]*)"?\s*=/.exec(line);
      if (match && match[1]!.toLowerCase() !== 'python') deps.add(match[1]!.toLowerCase());
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
    if (match) recipes.push(match[1]!);
  }
  return recipes;
}

/**
 * Detect delegation candidates. Ordered by role (test, lint, build, dev) then
 * command, de-duplicated by command string.
 */
export function detectCandidates(input: DetectInput): DelegatedCommand[] {
  const roots = input.rootFiles ?? [];
  const pm = detectPackageManager(roots);
  const found = new Map<string, DelegatedCommand>();
  const add = (role: CommandRole, command: string): void => {
    if (!found.has(command)) {
      found.set(command, { role, command, longRunning: LONG_RUNNING_ROLES.has(role) });
    }
  };

  const scripts = input.packageJson?.scripts ?? {};
  for (const name of Object.keys(scripts)) {
    const role = SCRIPT_ROLES[name];
    if (role) add(role, scriptCommand(pm, name));
  }

  for (const target of input.makefileTargets ?? []) {
    const role = SCRIPT_ROLES[target];
    if (role) add(role, `make ${target}`);
  }

  // composer.json scripts (PHP). No SCRIPT_ROLES name collides with a composer
  // built-in today; if the map ever gains one (install, status, …), switch that
  // entry to `composer run <name>`.
  for (const name of input.composerScripts ?? []) {
    const role = SCRIPT_ROLES[name];
    if (role) add(role, `composer ${name}`);
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
    if (strongPytest || weakPytest) add('test', `${runner}pytest`);
    if (hasSection('tool.ruff') || deps.includes('ruff')) add('lint', `${runner}ruff check .`);
    if (hasSection('tool.mypy') || deps.includes('mypy')) add('lint', `${runner}mypy .`);
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
    if (role) add(role, `just ${recipe}`);
  }

  const roleOrder: CommandRole[] = ['test', 'lint', 'build', 'dev', 'other'];
  return [...found.values()].sort((a, b) => {
    const byRole = roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role);
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
      if (segment === target || segment.startsWith(`${target} `)) return target;
    }
  }
  return null;
}
