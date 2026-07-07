/**
 * `sidemux init` orchestrator: detect delegation candidates, ask which to
 * wire up (or take them from flags), then write the guard hook + directives.
 * The pure detection/merging lives in detect.ts and templates.ts; this file
 * owns the filesystem and the prompt.
 */
import { readdir, readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import {
  globalConfigPath,
  globalConfigTemplate,
  loadProjectScripts,
} from "../config-file.js";
import {
  classifyCommandRole,
  detectCandidates,
  detectPackageManager,
  nxProjectScripts,
  packageManagerFromLockfiles,
  parseJustfileRecipes,
  parsePyproject,
  ROLE_ORDER,
  type DelegatedCommand,
  type NxProjectInfo,
  type PackageManager,
} from "./detect.js";
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
} from "./templates.js";

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
  /** Auto-close panes after a successful command (SIDEMUX_CLOSE_ON_SUCCESS). */
  closeOnSuccess: boolean;
}

const HELP = `sidemux init — wire a project to delegate test/lint/build to tmux panes.

Usage: sidemux init [options]

  --yes, -y            Non-interactive: delegate every detected command
  --commands "a,b"     Delegate exactly these commands (implies --yes),
                       e.g. --commands "pytest,composer test"
  --mcp                Also register the sidemux MCP server in .mcp.json
  --close-on-success   Auto-close a pane after its command exits 0 (with --mcp)
  --sync               Refresh all generated files, keep your selection, and ask
                       about commands detected since the last init (--yes skips
                       the question and keeps the recorded selection as-is)
  --uninstall          Remove everything sidemux init added, including the
                       sidemux entry in .mcp.json ("sidemux uninstall" is an alias)
  --dir <path>         Target project directory (default: current directory)
  --help, -h           Show this help

Commands run in sidemux's external workspace (tmux session "smux") — attach
to it, or press Prefix+e for the dashboard popup.

Detection covers package.json scripts (via your lockfile's package manager,
its packageManager field, pnpm-workspace.yaml, or a lockfile in a parent
directory for monorepo packages), Nx workspaces (nx.json → nx run-many per
target, plus per-project targets as named scripts in .sidemux.toml),
composer.json scripts, pyproject.toml (pytest/ruff/mypy under uv/poetry),
go.mod and Cargo.toml conventions, and Makefile / justfile targets.

Writes: .sidemux/delegate-guard.mjs + delegate.json, a PreToolUse hook in
.claude/settings.json, a delegation block in CLAUDE.md / AGENTS.md, and (Nx)
per-project scripts in .sidemux.toml.
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
    closeOnSuccess: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
    } else if (arg === "--sync") {
      flags.sync = true;
    } else if (arg === "--uninstall") {
      flags.uninstall = true;
    } else if (arg === "--mcp") {
      flags.mcp = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--dir") {
      flags.dir = argv[++i] ?? cwd;
    } else if (arg.startsWith("--dir=")) {
      flags.dir = arg.slice("--dir=".length);
    } else if (arg === "--commands") {
      flags.commands = splitCommands(argv[++i] ?? "");
    } else if (arg.startsWith("--commands=")) {
      flags.commands = splitCommands(arg.slice("--commands=".length));
    } else if (arg === "--close-on-success") {
      flags.closeOnSuccess = true;
    }
  }
  return flags;
}

function splitCommands(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

function parseMakefileTargets(makefile: string): string[] {
  const targets: string[] = [];
  for (const line of makefile.split("\n")) {
    const match = /^([a-zA-Z0-9_.-]+):(?!=)/.exec(line);
    if (match?.[1] && !match[1].startsWith(".")) {
      targets.push(match[1]);
    }
  }
  return targets;
}

/** Infer role/longRunning for a command string not in the detected set. */
function inferCommand(command: string): DelegatedCommand {
  const role = classifyCommandRole(command);
  return { role, command, longRunning: role === "dev" };
}

function resolveExplicit(
  detected: DelegatedCommand[],
  commands: string[],
): DelegatedCommand[] {
  return commands.map(
    (command) =>
      detected.find((c) => c.command === command) ?? inferCommand(command),
  );
}

async function promptSelection(
  candidates: DelegatedCommand[],
  io: InitIO,
  heading = "\nsidemux init — commands it can delegate to tmux panes:\n",
): Promise<DelegatedCommand[]> {
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    io.stdout.write(heading);
    candidates.forEach((c, i) =>
      io.stdout.write(`  ${i + 1}. ${c.command}  (${c.role})\n`),
    );
    const answer = (
      await rl.question("\nDelegate which? [all / comma numbers / none]: ")
    )
      .trim()
      .toLowerCase();
    if (answer === "" || answer === "all" || answer === "a") {
      return candidates;
    }
    if (answer === "none" || answer === "n") {
      return [];
    }
    const picks = answer
      .split(",")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length);
    return picks.flatMap((n) => candidates[n - 1] ?? []);
  } finally {
    rl.close();
  }
}

/** Yes/no question; empty input takes `defaultYes`. */
async function promptYesNo(
  io: InitIO,
  question: string,
  defaultYes = true,
): Promise<boolean> {
  const rl = createInterface({ input: io.stdin, output: io.stdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (answer === "") {
      return defaultYes;
    }
    return answer === "y" || answer === "yes";
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
  nxScripts = new Map<string, string>(),
): Promise<void> {
  // Names a previous init generated — read before delegate.json is overwritten
  // so stale per-project scripts get replaced, not accumulated.
  const previousNxNames = await readGeneratedScriptNames(dir);

  const sidemuxDir = join(dir, ".sidemux");
  await mkdir(sidemuxDir, { recursive: true });
  const guardPath = join(sidemuxDir, "delegate-guard.mjs");
  await writeFile(guardPath, guardScript());
  await chmod(guardPath, 0o755);
  await writeFile(
    join(sidemuxDir, "delegate.json"),
    delegateJson(selected, [...nxScripts.keys()]),
  );

  if (nxScripts.size > 0 || previousNxNames.length > 0) {
    await writeNxScripts(dir, nxScripts, previousNxNames);
  }

  const claudeDir = join(dir, ".claude");
  await mkdir(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, "settings.json");
  const settings = mergeSettingsHook(await readJson(settingsPath));
  await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);

  const block = directiveBlock(selected, { nxScripts: nxScripts.size > 0 });
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const path = join(dir, name);
    await writeFile(path, upsertMarkedBlock(await readText(path), block));
  }

  if (withMcp) {
    const mcpPath = join(dir, ".mcp.json");
    const mcp = mergeMcpServer(await readJson(mcpPath), mcpEnv);
    await writeFile(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`);
  }

  if (selected.length === 0) {
    out.write(
      "\nsidemux init: no commands delegated yet — generic directive installed.\n",
    );
  } else {
    out.write("\nsidemux init: delegating\n");
    for (const c of selected) {
      out.write(`  • ${c.command}\n`);
    }
  }
  if (nxScripts.size > 0) {
    out.write(
      `\nGenerated ${nxScripts.size} Nx per-project scripts in .sidemux.toml — run them as run { command: "<project>:<target>" }.\n`,
    );
  }
  out.write(
    "\nWrote:\n" +
      "  .sidemux/delegate-guard.mjs   PreToolUse guard (blocks inline runs)\n" +
      "  .sidemux/delegate.json        the delegated command list\n" +
      "  .claude/settings.json         registers the guard hook\n" +
      "  CLAUDE.md, AGENTS.md          delegation directives\n" +
      (nxScripts.size > 0
        ? "  .sidemux.toml                 Nx per-project scripts\n"
        : "") +
      (withMcp ? "  .mcp.json                     sidemux MCP server\n" : "") +
      "\nUndo any time with:  sidemux init --uninstall\n",
  );
}

/**
 * Package manager pinned by a lockfile in an ancestor directory. Covers
 * monorepo packages (`init --dir apps/web`), where the lockfile lives at the
 * workspace root, so detection doesn't silently fall back to npm.
 */
async function walkUpPackageManager(
  dir: string,
): Promise<PackageManager | undefined> {
  let current = dirname(dir);
  for (;;) {
    const files = await readdir(current).catch(() => [] as string[]);
    const pm = packageManagerFromLockfiles(files);
    if (pm) {
      return pm;
    }
    if (files.includes("pnpm-workspace.yaml")) {
      return "pnpm";
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/** Directory names an Nx project scan must never descend into. */
const NX_SCAN_SKIP = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".nx",
  ".worktrees",
]);
const NX_SCAN_MAX_DEPTH = 6;

/**
 * Discover Nx projects under an nx.json workspace: every `project.json`
 * (skipping build output, nested worktrees, and node_modules) contributes its
 * `targets` keys plus the sibling `package.json` scripts — Nx infers targets
 * from those in package-based workspaces.
 */
async function scanNxProjects(
  dir: string,
  depth = 0,
): Promise<NxProjectInfo[]> {
  if (depth > NX_SCAN_MAX_DEPTH) {
    return [];
  }
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const projects: NxProjectInfo[] = [];

  if (
    depth > 0 &&
    entries.some((e) => e.isFile() && e.name === "project.json")
  ) {
    const projectJson = await readJson(join(dir, "project.json"));
    if (typeof projectJson?.name === "string") {
      const targets = Object.keys(
        (projectJson.targets as Record<string, unknown> | undefined) ?? {},
      );
      const packageJson = await readJson(join(dir, "package.json"));
      const scripts = Object.keys(
        (packageJson?.scripts as Record<string, unknown> | undefined) ?? {},
      );
      projects.push({
        name: projectJson.name,
        targets: [...new Set([...targets, ...scripts])],
      });
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || NX_SCAN_SKIP.has(entry.name)) {
      continue;
    }
    projects.push(...(await scanNxProjects(join(dir, entry.name), depth + 1)));
  }
  return projects;
}

/**
 * Merge generated Nx per-project scripts into the project's `.sidemux.toml`
 * `[scripts]` table. Keys generated by a previous init (recorded in
 * delegate.json) are replaced wholesale; hand-written entries are preserved.
 * Note: re-serializing drops comments in an existing file.
 */
async function writeNxScripts(
  dir: string,
  generated: Map<string, string>,
  previousNames: string[],
): Promise<void> {
  const path = join(dir, ".sidemux.toml");
  const text = await readText(path);
  let existing: Record<string, unknown> = {};
  if (text) {
    try {
      existing = parseToml(text);
    } catch {
      // Malformed file: leave it alone rather than clobber hand-written content.
      return;
    }
  }
  const prior = (existing.scripts as Record<string, unknown> | undefined) ?? {};
  const dropped = new Set(previousNames);
  const scripts: Record<string, unknown> = Object.fromEntries(
    Object.entries(prior).filter(([name]) => !dropped.has(name)),
  );
  for (const [name, command] of generated) {
    scripts[name] = command;
  }
  if (Object.keys(scripts).length === 0 && !text) {
    return;
  }
  const next = { ...existing, scripts };
  await writeFile(path, `${stringifyToml(next)}\n`);
}

/** Script names a previous init generated into `.sidemux.toml` (from delegate.json). */
async function readGeneratedScriptNames(dir: string): Promise<string[]> {
  const config = await readJson(join(dir, ".sidemux", "delegate.json"));
  const names = config?.nxScripts;
  return Array.isArray(names)
    ? names.filter((n): n is string => typeof n === "string")
    : [];
}

interface DirDetection {
  detected: DelegatedCommand[];
  pm: PackageManager;
  /** nx.json present at the target dir — per-project script generation applies. */
  hasNx: boolean;
}

/** Detect delegation candidates from a project directory's manifests. */
async function detectFromDir(dir: string): Promise<DirDetection> {
  const packageJson = (await readJson(join(dir, "package.json"))) as {
    scripts?: Record<string, string>;
    packageManager?: string;
  } | null;
  const rootFiles = await readdir(dir).catch(() => [] as string[]);
  // Only pay for the ancestor walk when the local dir pins nothing itself.
  const fallbackPackageManager =
    packageJson &&
    !packageManagerFromLockfiles(rootFiles) &&
    !packageJson.packageManager
      ? await walkUpPackageManager(dir)
      : undefined;
  const makefile = await readText(join(dir, "Makefile"));

  const composer = await readJson(join(dir, "composer.json"));
  const composerScripts = Object.keys(
    (composer?.scripts as Record<string, unknown> | undefined) ?? {},
  );

  const pyprojectText = await readText(join(dir, "pyproject.toml"));

  const justfileName = rootFiles.find((f) => {
    const lower = f.toLowerCase();
    return lower === "justfile" || lower === ".justfile";
  });
  const justfile = justfileName ? await readText(join(dir, justfileName)) : "";

  const detected = detectCandidates({
    packageJson: packageJson ?? undefined,
    rootFiles,
    fallbackPackageManager,
    makefileTargets: parseMakefileTargets(makefile),
    composerScripts,
    pyproject: pyprojectText ? parsePyproject(pyprojectText) : undefined,
    justfileRecipes: parseJustfileRecipes(justfile),
  });

  // Named scripts from .sidemux.toml are delegation candidates too — their
  // command bodies get guarded like any detected test/lint/build command.
  // Nx per-project scripts a previous init generated are excluded: a real
  // workspace has dozens of projects, which would swamp the selection.
  const generatedNames = new Set(await readGeneratedScriptNames(dir));
  const known = new Set(detected.map((candidate) => candidate.command));
  for (const script of loadProjectScripts(dir).values()) {
    if (known.has(script.command) || generatedNames.has(script.name)) {
      continue;
    }
    const inferred = inferCommand(script.command);
    detected.push({
      ...inferred,
      longRunning: inferred.longRunning || script.background,
    });
  }
  return {
    detected,
    pm: detectPackageManager(
      rootFiles,
      packageJson?.packageManager,
      fallbackPackageManager,
    ),
    hasNx: rootFiles.includes("nx.json"),
  };
}

/** Rehydrate the recorded selection from `.sidemux/delegate.json`, if any. */
async function readPriorSelection(
  dir: string,
): Promise<DelegatedCommand[] | null> {
  const config = await readJson(join(dir, ".sidemux", "delegate.json"));
  if (!config || !Array.isArray(config.commands)) {
    return null;
  }
  const selected: DelegatedCommand[] = [];
  for (const entry of config.commands as (Partial<DelegatedCommand> | null)[]) {
    if (!entry || typeof entry.command !== "string") {
      continue;
    }
    const inferred = inferCommand(entry.command);
    selected.push({
      command: entry.command,
      role:
        entry.role !== undefined && ROLE_ORDER.includes(entry.role)
          ? entry.role
          : inferred.role,
      longRunning:
        typeof entry.longRunning === "boolean"
          ? entry.longRunning
          : inferred.longRunning,
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
      "sidemux init --sync: no .sidemux/delegate.json here — run `sidemux init` first.\n",
    );
    return 1;
  }

  const detection = await detectFromDir(dir);
  const known = new Set(selected.map((c) => c.command));
  const fresh = detection.detected.filter((c) => !known.has(c.command));
  if (fresh.length > 0) {
    if (yes) {
      io.stdout.write(
        "sidemux init --sync: new candidates detected but not delegated (re-run without --yes to pick):\n",
      );
      for (const c of fresh) {
        io.stdout.write(`  • ${c.command}  (${c.role})\n`);
      }
    } else {
      const additions = await promptSelection(
        fresh,
        io,
        "\nsidemux init --sync — new commands detected since the last init:\n",
      );
      selected.push(...additions);
    }
  }

  const mcp = await readJson(join(dir, ".mcp.json"));
  const withMcp = Boolean(
    (mcp?.mcpServers as Record<string, unknown> | undefined)?.sidemux,
  );
  const nxScripts = detection.hasNx
    ? nxProjectScripts(detection.pm, await scanNxProjects(dir))
    : new Map<string, string>();
  await writeArtifacts(dir, selected, withMcp, {}, io.stdout, nxScripts);
  return 0;
}

/** Join a list with commas and an Oxford "and": [a] → "a", [a,b,c] → "a, b, and c". */
function joinList(items: string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

async function uninstall(
  dir: string,
  out: NodeJS.WritableStream,
): Promise<void> {
  const { rm, stat } = await import("node:fs/promises");
  const exists = async (path: string): Promise<boolean> => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  };

  // Strip generated Nx per-project scripts from .sidemux.toml before the
  // record of their names (delegate.json) is deleted below.
  const generatedNames = await readGeneratedScriptNames(dir);
  let removedNxScripts = false;
  if (generatedNames.length > 0) {
    await writeNxScripts(dir, new Map(), generatedNames);
    removedNxScripts = true;
  }

  const hadSidemuxDir = await exists(join(dir, ".sidemux"));
  await rm(join(dir, ".sidemux", "delegate-guard.mjs"), { force: true });
  await rm(join(dir, ".sidemux", "delegate.json"), { force: true });
  await rm(join(dir, ".sidemux"), { recursive: true, force: true });

  const settingsPath = join(dir, ".claude", "settings.json");
  const settings = await readJson(settingsPath);
  let removedHook = false;
  if (settings) {
    const stripped = removeSettingsHook(settings);
    removedHook = JSON.stringify(stripped) !== JSON.stringify(settings);
    if (removedHook) {
      await writeFile(settingsPath, `${JSON.stringify(stripped, null, 2)}\n`);
    }
  }

  let removedDirectives = false;
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
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

  const mcpPath = join(dir, ".mcp.json");
  const mcp = await readJson(mcpPath);
  const hadMcpEntry = Boolean(
    (mcp?.mcpServers as Record<string, unknown> | undefined)?.sidemux,
  );
  if (mcp && hadMcpEntry) {
    await writeFile(
      mcpPath,
      `${JSON.stringify(removeMcpServer(mcp), null, 2)}\n`,
    );
  }

  if (
    !hadSidemuxDir &&
    !removedHook &&
    !removedDirectives &&
    !removedNxScripts &&
    !hadMcpEntry
  ) {
    out.write(
      "sidemux init: nothing to remove — sidemux was not installed here.\n",
    );
    return;
  }

  const removed: string[] = [];
  if (hadSidemuxDir) {
    removed.push("guard");
  }
  if (removedHook) {
    removed.push("hook");
  }
  if (removedDirectives) {
    removed.push("delegation directives");
  }
  if (removedNxScripts) {
    removed.push("generated Nx scripts in .sidemux.toml");
  }
  if (hadMcpEntry) {
    removed.push("the sidemux entry in .mcp.json");
  }
  out.write(`sidemux init: removed ${joinList(removed)}.\n`);
}

/** Entry point for `sidemux init`. Returns a process exit code. */
export async function runInit(options: InitOptions): Promise<number> {
  const io: InitIO = options.io ?? {
    stdin: process.stdin,
    stdout: process.stdout,
  };
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

  const detection = await detectFromDir(flags.dir);
  const detected = detection.detected;

  let selected: DelegatedCommand[];
  let genericOnly = false;
  if (flags.commands) {
    selected = resolveExplicit(detected, flags.commands);
  } else if (detected.length === 0) {
    io.stdout.write(
      "sidemux init: no test/lint/build/dev commands detected in package.json, " +
        "composer.json, pyproject.toml, go.mod, Cargo.toml, Makefile, or justfile.\n" +
        'You can pass commands explicitly, e.g. --commands "pytest,composer test".\n',
    );
    if (
      !flags.yes &&
      !(await promptYesNo(
        io,
        "\nInstall the generic directive block anyway? [Y/n]: ",
      ))
    ) {
      io.stdout.write("sidemux init: no changes made.\n");
      return 0;
    }
    if (flags.yes) {
      io.stdout.write(
        "Installing the generic delegation directive only — no commands are guarded " +
          "until you add some (--commands, or `sidemux init --sync` once they exist).\n",
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
    io.stdout.write("sidemux init: nothing selected — no changes made.\n");
    return 0;
  }

  // The default MCP env is intentionally empty so the server uses its
  // external-workspace defaults; only explicit opt-ins are recorded.
  const mcpEnv: Record<string, string> = {};
  if (flags.mcp && flags.closeOnSuccess) {
    mcpEnv.SIDEMUX_CLOSE_ON_SUCCESS = "1";
  }

  const nxScripts = detection.hasNx
    ? nxProjectScripts(detection.pm, await scanNxProjects(flags.dir))
    : new Map<string, string>();
  await writeArtifacts(
    flags.dir,
    selected,
    flags.mcp,
    mcpEnv,
    io.stdout,
    nxScripts,
  );
  await maybeScaffoldGlobalConfig(flags.yes, io);
  return 0;
}

/**
 * Offer to create `~/.config/sidemux/config.toml` (commented defaults) so
 * personal settings live in one place instead of per-project MCP env blocks.
 * Interactive only; skipped when the file already exists or under --yes.
 */
async function maybeScaffoldGlobalConfig(
  yes: boolean,
  io: InitIO,
): Promise<void> {
  if (yes) {
    return;
  }
  // Only offer on a real terminal — scripted/piped stdin must never block here.
  if (!(io.stdin as NodeJS.ReadStream).isTTY) {
    return;
  }
  const path = globalConfigPath();
  if (await readText(path)) {
    return;
  }
  const wanted = await promptYesNo(
    io,
    `\nCreate ${path} with commented defaults (global sidemux settings)? [y/N]: `,
    false,
  );
  if (!wanted) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, globalConfigTemplate());
  io.stdout.write(`Wrote ${path}\n`);
}
