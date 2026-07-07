# Contributing to sidemux

Thanks for your interest in improving sidemux. This document covers everything
you need to get a change from idea to merged PR.

## Prerequisites

- **Node ≥ 18** (per `engines` in `package.json`; CI runs Node 22)
- **pnpm** (the repo uses a `pnpm-lock.yaml` / pnpm workspace)
- **tmux ≥ 3.2** — integration tests drive a real tmux server and the
  dashboard uses `display-popup`. Tests that need tmux are skipped when it is
  not installed, but a full local run requires it. Integration tests never
  touch your real tmux server: they run on isolated `-L smux-test-*` sockets
  with `-f /dev/null`.

## Setup

```bash
git clone https://github.com/tomfordweb/sidemux && cd sidemux
pnpm install
```

## Commands

```bash
pnpm test        # unit + integration (real tmux on a throwaway socket) + E2E
pnpm coverage    # test run with 80% coverage thresholds enforced
pnpm lint        # eslint (type-checked typescript-eslint)
pnpm typecheck   # tsc --noEmit
pnpm build       # tsup → dist/
```

## Code standards

- **Strict TypeScript.** The project compiles with strict settings; don't
  weaken types or reach for `any` to silence errors.
- **Type-checked linting.** `pnpm lint` runs eslint with type-aware
  typescript-eslint rules; it must pass clean.
- **Tests are required for behavior changes.** Any change to observable
  behavior needs a test that fails without the change. Bug fixes should add a
  regression test.
- Keep changes focused; avoid drive-by refactors in the same PR.

## Pull request flow

1. Branch off `main` and make your change.
2. Ensure `pnpm lint`, `pnpm typecheck`, and `pnpm test` all pass locally.
3. Use **Conventional Commits** for commit messages and the PR title
   (`feat: …`, `fix: …`, `docs: …`, `test: …`, `chore: …`).
4. Open a PR against `main`. CI ([.github/workflows/ci.yml](.github/workflows/ci.yml))
   runs lint, typecheck, tests (with tmux installed), and the build — it must
   be green before merge.
5. Update documentation (`README.md`, `docs/`) when your change affects
   user-visible behavior or configuration.

## Release process

Releases are tag-driven:

1. Bump `version` in `package.json` on `main`.
2. Tag it: `git tag v<version> && git push --tags` — the tag must match
   `v*.*.*` and the `package.json` version exactly (the workflow verifies
   this).
3. [.github/workflows/publish.yml](.github/workflows/publish.yml) runs the
   test suite (via `prepublishOnly`) and publishes to npm with `--provenance`.

## Code of conduct

All participation in this project is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).
