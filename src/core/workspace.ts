/**
 * Monorepo package resolution for the `run` tool's `project` argument. Given a
 * repo root, work out where each workspace package lives so a run can target a
 * single package's directory instead of the whole monorepo. Supports pnpm
 * workspaces (pnpm-workspace.yaml globs) with an Nx fallback (apps/*, libs/*).
 *
 * Deliberately dependency-free: pnpm-workspace.yaml is parsed with a minimal
 * line reader (the `packages:` list is always simple `- 'glob'` entries), so no
 * YAML library is pulled in.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** name (and dir-basename alias) → absolute package directory, cached per root. */
const projectCache = new Map<string, Map<string, string>>();

/** True when the directory looks like a monorepo root sidemux can resolve. */
export function hasWorkspace(rootCwd: string): boolean {
  return (
    existsSync(join(rootCwd, 'pnpm-workspace.yaml')) || existsSync(join(rootCwd, 'nx.json'))
  );
}

async function isDir(path: string): Promise<boolean> {
  return stat(path)
    .then((s) => s.isDirectory())
    .catch(() => false);
}

/** Extract the `packages:` globs from a pnpm-workspace.yaml, comments stripped. */
async function readPnpmGlobs(rootCwd: string): Promise<string[]> {
  const text = await readFile(join(rootCwd, 'pnpm-workspace.yaml'), 'utf8').catch(() => '');
  if (!text) {return [];}
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '');
    if (line.startsWith("packages:")) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {continue;}
    const item = /^\s*-\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
    if (item) {
      if (item[1] !== undefined) {globs.push(item[1].trim());}
      continue;
    }
    if (line.trim() === '') {continue;}
    if (/^\S/.test(line)) {break;} // next top-level key ends the packages block
  }
  return globs;
}

/** Expand a workspace glob. Supports a literal dir or a trailing `base/*`. */
async function expandGlob(rootCwd: string, glob: string): Promise<string[]> {
  if (!glob.includes('*')) {
    const dir = join(rootCwd, glob);
    return (await isDir(dir)) ? [dir] : [];
  }
  if (!glob.endsWith('*')) {return [];} // deeper patterns (a/*/b) unsupported
  const base = glob.slice(0, glob.indexOf('*')).replace(/\/$/, '');
  const baseDir = join(rootCwd, base);
  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => join(baseDir, e.name));
}

/** A package directory's declared name (package.json, then Nx project.json). */
async function projectName(dir: string): Promise<{ name: string | null; hasManifest: boolean }> {
  for (const manifest of ['package.json', 'project.json']) {
    const text = await readFile(join(dir, manifest), 'utf8').catch(() => '');
    if (!text) {continue;}
    try {
      const name = (JSON.parse(text) as { name?: string }).name;
      return { name: name ?? null, hasManifest: true };
    } catch {
      return { name: null, hasManifest: true };
    }
  }
  return { name: null, hasManifest: false };
}

/**
 * Map every workspace package to its directory, keyed by its declared name and
 * by its directory basename (a fallback alias so `bevvi` resolves even when the
 * package is named `@scope/bevvi`). Cached — workspace layout is static.
 */
export async function listProjects(rootCwd: string): Promise<Map<string, string>> {
  const cached = projectCache.get(rootCwd);
  if (cached) {return cached;}

  const map = new Map<string, string>();
  let globs = await readPnpmGlobs(rootCwd);
  if (globs.length === 0 && existsSync(join(rootCwd, 'nx.json'))) {globs = ['apps/*', 'libs/*'];}

  const dirs = (await Promise.all(globs.map((g) => expandGlob(rootCwd, g)))).flat();
  for (const dir of dirs) {
    const { name, hasManifest } = await projectName(dir);
    if (!hasManifest) {continue;}
    if (name && !map.has(name)) {map.set(name, dir);}
    const base = basename(dir);
    if (!map.has(base)) {map.set(base, dir);}
  }

  projectCache.set(rootCwd, map);
  return map;
}

/** Resolve a project name/alias to its absolute directory, or null if unknown. */
export async function resolveProject(rootCwd: string, name: string): Promise<string | null> {
  return (await listProjects(rootCwd)).get(name) ?? null;
}
