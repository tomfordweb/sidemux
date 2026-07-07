import { describe, expect, test } from "vitest";
import {
  classifyCommandRole,
  detectCandidates,
  detectPackageManager,
  execCommand,
  matchesDelegated,
  nxProjectScripts,
  parseJustfileRecipes,
  parsePyproject,
  scriptCommand,
} from "../../src/init/detect.js";

describe("detectPackageManager", () => {
  test("picks pnpm/yarn/npm from lockfiles, defaults npm", () => {
    expect(detectPackageManager(["pnpm-lock.yaml"])).toBe("pnpm");
    expect(detectPackageManager(["yarn.lock"])).toBe("yarn");
    expect(detectPackageManager(["package-lock.json"])).toBe("npm");
    expect(detectPackageManager([])).toBe("npm");
  });

  test("precedence: lockfile > packageManager pin > pnpm-workspace.yaml > fallback > npm", () => {
    expect(detectPackageManager(["yarn.lock"], "pnpm@11.5.1")).toBe("yarn");
    expect(detectPackageManager([], "pnpm@11.5.1")).toBe("pnpm");
    expect(detectPackageManager([], "yarn")).toBe("yarn");
    expect(detectPackageManager([], "pnpm@11.5.1", "yarn")).toBe("pnpm");
    expect(detectPackageManager(["pnpm-workspace.yaml"])).toBe("pnpm");
    expect(
      detectPackageManager(["pnpm-workspace.yaml"], undefined, "yarn"),
    ).toBe("pnpm");
    expect(detectPackageManager([], undefined, "pnpm")).toBe("pnpm");
    expect(detectPackageManager([], "not-a-pin")).toBe("npm");
  });
});

describe("execCommand", () => {
  test("npm uses npx, pnpm uses exec, yarn is direct", () => {
    expect(execCommand("npm", "nx")).toBe("npx nx");
    expect(execCommand("pnpm", "nx")).toBe("pnpm exec nx");
    expect(execCommand("yarn", "nx")).toBe("yarn nx");
  });
});

describe("nxProjectScripts", () => {
  test("emits one script per project × known target, sorted, skipping unknown targets", () => {
    const scripts = nxProjectScripts("pnpm", [
      { name: "web", targets: ["lint", "build", "deploy", "serve"] },
      { name: "api", targets: ["test", "typecheck"] },
      { name: "e2e-web", targets: ["e2e"] },
      { name: "empty", targets: [] },
    ]);
    expect([...scripts.entries()]).toEqual([
      ["api:test", "pnpm exec nx run api:test"],
      ["api:typecheck", "pnpm exec nx run api:typecheck"],
      ["e2e-web:e2e", "pnpm exec nx run e2e-web:e2e"],
      ["web:build", "pnpm exec nx run web:build"],
      ["web:lint", "pnpm exec nx run web:lint"],
    ]);
  });
});

describe("classifyCommandRole", () => {
  test("groups commands by keyword, e2e before test", () => {
    expect(classifyCommandRole("pnpm exec nx run web:e2e")).toBe("e2e");
    expect(classifyCommandRole("pnpm exec playwright test")).toBe("e2e");
    expect(classifyCommandRole("pnpm vitest run")).toBe("test");
    expect(classifyCommandRole("pnpm typecheck")).toBe("lint");
    expect(classifyCommandRole("cargo build")).toBe("build");
    expect(classifyCommandRole("pnpm dev")).toBe("dev");
    expect(classifyCommandRole("echo hi")).toBe("other");
  });
});

describe("scriptCommand", () => {
  test("npm uses run, pnpm/yarn are direct", () => {
    expect(scriptCommand("npm", "test")).toBe("npm run test");
    expect(scriptCommand("pnpm", "test")).toBe("pnpm test");
    expect(scriptCommand("yarn", "build")).toBe("yarn build");
  });
});

describe("detectCandidates", () => {
  test("maps known scripts to roles under the detected manager, ordered by role", () => {
    const candidates = detectCandidates({
      packageJson: {
        scripts: {
          dev: "vite",
          build: "tsup",
          test: "vitest",
          lint: "eslint .",
        },
      },
      rootFiles: ["pnpm-lock.yaml"],
    });
    expect(candidates).toEqual([
      { role: "test", command: "pnpm test", longRunning: false },
      { role: "lint", command: "pnpm lint", longRunning: false },
      { role: "build", command: "pnpm build", longRunning: false },
      { role: "dev", command: "pnpm dev", longRunning: true },
    ]);
  });

  test("ignores unknown scripts and folds in Makefile targets", () => {
    const candidates = detectCandidates({
      packageJson: { scripts: { deploy: "x", prepare: "y" } },
      rootFiles: [],
      makefileTargets: ["test", "clean"],
    });
    expect(candidates).toEqual([
      { role: "test", command: "make test", longRunning: false },
    ]);
  });

  test("nx.json proposes run-many per role, only for roles root scripts miss", () => {
    const candidates = detectCandidates({
      packageJson: { scripts: { lint: "nx run-many -t lint" } },
      rootFiles: ["nx.json", "pnpm-workspace.yaml"],
    });
    expect(candidates).toEqual([
      {
        role: "test",
        command: "pnpm exec nx run-many -t test",
        longRunning: false,
      },
      { role: "lint", command: "pnpm lint", longRunning: false },
      {
        role: "build",
        command: "pnpm exec nx run-many -t build",
        longRunning: false,
      },
      {
        role: "e2e",
        command: "pnpm exec nx run-many -t e2e",
        longRunning: false,
      },
    ]);
  });

  test("empty when nothing recognized", () => {
    expect(detectCandidates({ packageJson: { scripts: {} } })).toEqual([]);
    expect(detectCandidates({})).toEqual([]);
    // Regression: the npm default without package.json must stay inert.
    expect(detectCandidates({ rootFiles: [] })).toEqual([]);
  });

  test("maps composer.json scripts and ignores unknown/event hooks", () => {
    const candidates = detectCandidates({
      composerScripts: ["test", "lint", "post-install-cmd", "deploy"],
    });
    expect(candidates).toEqual([
      { role: "test", command: "composer test", longRunning: false },
      { role: "lint", command: "composer lint", longRunning: false },
    ]);
  });

  test("pyproject picks the runner from the lockfile (uv wins over poetry)", () => {
    const pyproject = { sections: [], deps: ["pytest"] };
    expect(detectCandidates({ pyproject, rootFiles: ["uv.lock"] })).toEqual([
      { role: "test", command: "uv run pytest", longRunning: false },
    ]);
    expect(detectCandidates({ pyproject, rootFiles: ["poetry.lock"] })).toEqual(
      [{ role: "test", command: "poetry run pytest", longRunning: false }],
    );
    expect(
      detectCandidates({ pyproject, rootFiles: ["uv.lock", "poetry.lock"] }),
    ).toEqual([{ role: "test", command: "uv run pytest", longRunning: false }]);
    expect(detectCandidates({ pyproject, rootFiles: [] })).toEqual([
      { role: "test", command: "pytest", longRunning: false },
    ]);
  });

  test("pyproject detects pytest from config section or pytest.ini", () => {
    expect(
      detectCandidates({
        pyproject: { sections: ["tool.pytest.ini_options"], deps: [] },
      }),
    ).toEqual([{ role: "test", command: "pytest", longRunning: false }]);
    expect(
      detectCandidates({
        pyproject: { sections: [], deps: [] },
        rootFiles: ["pytest.ini"],
      }),
    ).toEqual([{ role: "test", command: "pytest", longRunning: false }]);
  });

  test("weak pytest signals (tests dir, tox.ini) need a runner lock", () => {
    const pyproject = { sections: [], deps: [] };
    expect(detectCandidates({ pyproject, rootFiles: ["tests"] })).toEqual([]);
    expect(detectCandidates({ pyproject, rootFiles: ["tox.ini"] })).toEqual([]);
    expect(
      detectCandidates({ pyproject, rootFiles: ["tests", "uv.lock"] }),
    ).toEqual([{ role: "test", command: "uv run pytest", longRunning: false }]);
  });

  test("pyproject detects ruff and mypy from sections or deps", () => {
    const candidates = detectCandidates({
      pyproject: {
        sections: ["tool.ruff.lint", "tool.mypy.overrides"],
        deps: [],
      },
      rootFiles: ["uv.lock"],
    });
    expect(candidates).toEqual([
      { role: "lint", command: "uv run mypy .", longRunning: false },
      { role: "lint", command: "uv run ruff check .", longRunning: false },
    ]);
    // pytest-cov is not pytest; ruff dep alone is enough for ruff.
    expect(
      detectCandidates({
        pyproject: { sections: [], deps: ["pytest-cov", "ruff"] },
      }),
    ).toEqual([{ role: "lint", command: "ruff check .", longRunning: false }]);
  });

  test("go.mod and Cargo.toml yield conventional commands", () => {
    expect(detectCandidates({ rootFiles: ["go.mod"] })).toEqual([
      { role: "test", command: "go test ./...", longRunning: false },
      { role: "lint", command: "go vet ./...", longRunning: false },
      { role: "build", command: "go build ./...", longRunning: false },
    ]);
    expect(detectCandidates({ rootFiles: ["Cargo.toml"] })).toEqual([
      { role: "test", command: "cargo test", longRunning: false },
      { role: "lint", command: "cargo clippy", longRunning: false },
      { role: "build", command: "cargo build", longRunning: false },
    ]);
  });

  test("conventional commands coexist with Makefile targets", () => {
    const candidates = detectCandidates({
      rootFiles: ["go.mod"],
      makefileTargets: ["test"],
    });
    expect(candidates.map((c) => c.command)).toEqual([
      "go test ./...",
      "make test",
      "go vet ./...",
      "go build ./...",
    ]);
  });

  test("maps justfile recipes like Makefile targets", () => {
    const candidates = detectCandidates({
      justfileRecipes: ["test", "dev", "fmt"],
    });
    expect(candidates).toEqual([
      { role: "test", command: "just test", longRunning: false },
      { role: "dev", command: "just dev", longRunning: true },
    ]);
  });

  test("polyglot projects merge candidates across manifests", () => {
    const candidates = detectCandidates({
      packageJson: { scripts: { build: "vite build" } },
      rootFiles: ["pnpm-lock.yaml", "uv.lock"],
      pyproject: { sections: [], deps: ["pytest"] },
    });
    expect(candidates.map((c) => c.command)).toEqual([
      "uv run pytest",
      "pnpm build",
    ]);
  });
});

describe("parsePyproject", () => {
  test("collects PEP 621 deps across multi-line arrays, extras intact", () => {
    const facts = parsePyproject(
      [
        "[project]",
        'name = "demo"',
        'description = "uses pytest heavily"',
        "dependencies = [",
        '  "uvicorn[standard]>=0.30",',
        '  "requests >= 2",',
        "]",
        "",
        "[project.optional-dependencies]",
        'dev = ["pytest-cov>=4"]',
        "",
        "[dependency-groups]",
        "dev = [",
        '  "pytest>=8",',
        '  # "ruff",',
        "]",
      ].join("\n"),
    );
    expect(facts.deps).toEqual(["uvicorn", "requests", "pytest-cov", "pytest"]);
    expect(facts.sections).toEqual([
      "project",
      "project.optional-dependencies",
      "dependency-groups",
    ]);
  });

  test("collects Poetry key-style deps, skipping python", () => {
    const facts = parsePyproject(
      [
        "[tool.poetry.dependencies]",
        'python = "^3.12"',
        'httpx = "^0.27"',
        "",
        "[tool.poetry.group.dev.dependencies]",
        'pytest = "^8"',
        'mypy = { version = "^1.10" }',
      ].join("\n"),
    );
    expect(facts.deps).toEqual(["httpx", "pytest", "mypy"]);
  });

  test("normalizes section headers including array-of-tables", () => {
    const facts = parsePyproject(
      [
        "[tool.ruff.lint]",
        'select = ["E"]',
        "",
        "[[tool.mypy.overrides]]",
        'module = "x"',
      ].join("\n"),
    );
    expect(facts.sections).toEqual(["tool.ruff.lint", "tool.mypy.overrides"]);
    expect(facts.deps).toEqual([]);
  });

  test("ignores mentions outside dependency contexts", () => {
    const facts = parsePyproject(
      [
        "[project]",
        'name = "pytest-helper"',
        'description = "works with pytest"',
      ].join("\n"),
    );
    expect(facts.deps).toEqual([]);
  });
});

describe("parseJustfileRecipes", () => {
  test("extracts bare recipes, skipping everything else", () => {
    const recipes = parseJustfileRecipes(
      [
        "# comment",
        'set shell := ["bash", "-c"]',
        'flags := "--verbose"',
        "alias t := test",
        "",
        "test:",
        "  cargo test",
        "",
        "@build: fmt",
        "  cargo build",
        "",
        "deploy target:",
        "  ./deploy {{target}}",
        "",
        "_helper:",
        "  echo hidden",
        "",
        "[private]",
        "lint:",
        "  cargo clippy",
      ].join("\n"),
    );
    expect(recipes).toEqual(["test", "build", "lint"]);
  });
});

describe("matchesDelegated", () => {
  const delegated = ["pnpm test", "pnpm build"];

  test("matches an exact or prefixed segment", () => {
    expect(matchesDelegated("pnpm test", delegated)).toBe("pnpm test");
    expect(matchesDelegated("pnpm test --coverage", delegated)).toBe(
      "pnpm test",
    );
  });

  test("matches inside a compound command", () => {
    expect(matchesDelegated("cd app && pnpm build", delegated)).toBe(
      "pnpm build",
    );
    expect(matchesDelegated("pnpm lint; pnpm test", delegated)).toBe(
      "pnpm test",
    );
  });

  test("does not match unrelated or substring-only commands", () => {
    expect(matchesDelegated("pnpm test-utils", delegated)).toBeNull();
    expect(matchesDelegated("echo pnpm test", delegated)).toBeNull();
    expect(matchesDelegated("ls -la", delegated)).toBeNull();
  });
});
