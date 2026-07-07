import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  hasWorkspace,
  listProjects,
  resolveProject,
} from "../../src/core/workspace.js";

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "smux-ws-"));
  roots.push(root);
  return root;
}

async function pkg(root: string, rel: string, name?: string): Promise<void> {
  const dir = join(root, rel);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify(name ? { name } : {}),
  );
}

afterAll(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});

describe("workspace project resolution", () => {
  test("pnpm-workspace globs map package names and dir-basename aliases", async () => {
    const root = await makeRoot();
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'apps/*'\n  - 'libs/*'\n\nminimumReleaseAge: 10080\n",
    );
    await pkg(root, "apps/bevvi", "@andromeda/bevvi");
    await pkg(root, "apps/keebgod", "keebgod");
    await pkg(root, "libs/domain", "@andromeda/domain");

    expect(hasWorkspace(root)).toBe(true);
    const map = await listProjects(root);

    // declared name resolves
    expect(map.get("@andromeda/bevvi")).toBe(join(root, "apps/bevvi"));
    // basename alias resolves even when the package is scoped
    expect(await resolveProject(root, "bevvi")).toBe(join(root, "apps/bevvi"));
    expect(await resolveProject(root, "keebgod")).toBe(
      join(root, "apps/keebgod"),
    );
    expect(await resolveProject(root, "domain")).toBe(
      join(root, "libs/domain"),
    );

    // unknown name resolves to null
    expect(await resolveProject(root, "nope")).toBeNull();
  });

  test("nested globs (libs/maps/*) expand", async () => {
    const root = await makeRoot();
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - 'libs/maps/*'\n",
    );
    await pkg(root, "libs/maps/tiles", "@maps/tiles");

    expect(await resolveProject(root, "tiles")).toBe(
      join(root, "libs/maps/tiles"),
    );
  });

  test("nx.json without pnpm-workspace falls back to apps/* + libs/*", async () => {
    const root = await makeRoot();
    await writeFile(join(root, "nx.json"), "{}");
    await pkg(root, "apps/web", "web");

    expect(hasWorkspace(root)).toBe(true);
    expect(await resolveProject(root, "web")).toBe(join(root, "apps/web"));
  });

  test("a non-workspace directory has no projects", async () => {
    const root = await makeRoot();
    expect(hasWorkspace(root)).toBe(false);
    expect((await listProjects(root)).size).toBe(0);
    expect(await resolveProject(root, "anything")).toBeNull();
  });
});
