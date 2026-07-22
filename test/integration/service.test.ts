import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "../../src/config.js";
import { SidemuxService } from "../../src/service.js";
import { TmuxFixture, tmuxAvailable } from "./helpers/tmux-fixture.js";

// Keep per-job log files out of the developer's real state dir.
const LOG_DIR = join(tmpdir(), `smux-test-logs-${process.pid}`);

describe.skipIf(!tmuxAvailable())(
  "SidemuxService end-to-end on real tmux",
  () => {
    const fx = new TmuxFixture();
    let service: SidemuxService;

    beforeAll(async () => {
      await fx.start("/tmp");
      // Simulate the agent living in the fixture's first pane, default cwd /tmp.
      service = new SidemuxService(
        fx.client,
        loadConfig({ SIDEMUX_PANE_SHELL: "sh", SIDEMUX_LOG_DIR: LOG_DIR }),
        { TMUX: "fixture", TMUX_PANE: fx.firstPane },
        "/tmp",
      );
    });

    afterAll(async () => {
      await fx.stop();
    });

    test("run creates a managed pane in the default cwd and completes", async () => {
      const result = await service.run({
        command: "pwd && echo svc-run-ok",
        name: "svc",
        timeout_ms: 10_000,
        background: false,
      });
      expect(result.status).toBe("done");
      expect(result.exit_code).toBe(0);
      expect(result.pane).not.toBe(fx.firstPane);
      expect(result.tail).toContain("/tmp");
      expect(result.tail).toContain("svc-run-ok");
      expect(result.tail).not.toContain("<<SMUX:");
    });

    test("run reuses the managed pane and cd-prefixes when cwd differs", async () => {
      const result = await service.run({
        command: "pwd",
        name: "svc",
        cwd: "/usr",
        timeout_ms: 10_000,
        background: false,
      });
      expect(result.status).toBe("done");
      expect(result.tail).toContain("/usr");
    });

    test("failed command surfaces status failed and its exit code", async () => {
      const result = await service.run({
        command: "ls /definitely-not-a-real-path-xyz",
        name: "svc",
        timeout_ms: 10_000,
        background: false,
      });
      expect(result.status).toBe("failed");
      expect(result.exit_code).not.toBe(0);
    });

    test("read since=job returns full job output; grep filters it", async () => {
      const run = await service.run({
        command: 'printf "aaa\\nERROR boom\\nbbb\\n"',
        name: "svc",
        timeout_ms: 10_000,
        background: false,
      });
      const full = await service.read({
        job_id: run.job_id,
        since: "job",
        lines: 100,
        context: 2,
        max_bytes: 8192,
      });
      expect(full.text).toContain("aaa");
      expect(full.job_status).toBe("done");

      // Anchored so the echoed command line (which also contains "ERROR")
      // does not match — real output lines start at column 0.
      const grepped = await service.read({
        job_id: run.job_id,
        since: "job",
        lines: 100,
        grep: "^ERROR",
        context: 0,
        max_bytes: 8192,
      });
      expect(grepped.text).toContain("ERROR boom");
      expect(grepped.text).not.toContain("bbb");
    });

    test("run publishes token-savings stats on the agent window", async () => {
      const result = await service.run({
        command: "echo lint-stats-probe",
        name: "svc",
        timeout_ms: 10_000,
        background: false,
      });
      expect(result.status).toBe("done");
      const windows = await fx.client.listWindows("smux");
      const encoded = windows.map((w) => w.statsJson).find((value) => value);
      expect(encoded).toBeTruthy();
      const stats = JSON.parse(encoded ?? "{}") as Record<
        string,
        { ai: number; smux: number; responses: number }
      >;
      expect(stats.lint).toBeDefined();
      expect(stats.lint?.responses).toBeGreaterThanOrEqual(1);
      expect(stats.lint?.ai).toBeGreaterThan(0);
      expect(stats.lint?.smux).toBeGreaterThan(0);
    });

    test("background run + wait pattern + kill interrupt (dev-server flow)", async () => {
      const run = await service.run({
        command:
          'sh -c "echo booting; sleep 0.3; echo LISTENING on 4000; sleep 60"',
        name: "devsrv",
        timeout_ms: 10_000,
        background: true,
      });
      expect(run.status).toBe("running");

      const waited = await service.wait({
        job_id: run.job_id,
        until: "pattern",
        pattern: "LISTENING on \\d+",
        idle_ms: 2000,
        timeout_ms: 10_000,
      });
      expect(waited.status).toBe("pattern");
      expect(waited.matched_line).toContain("LISTENING on 4000");

      const killed = await service.kill({
        job_id: run.job_id,
        mode: "interrupt",
      });
      expect(killed.ok).toBe(true);
      const job = service.jobs.get(run.job_id)!;
      expect(job.status).toBe("failed");
      expect(job.exitCode).toBe(130);
    });

    test("status settles a finished background job without read/wait", async () => {
      const run = await service.run({
        command: 'sh -c "exit 3"',
        name: "bgexit",
        timeout_ms: 10_000,
        background: true,
      });
      expect(run.status).toBe("running");

      let status: string | null = "running";
      for (
        let attempt = 0;
        attempt < 40 && status === "running";
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const { tabs } = await service.status();
        const pane = tabs
          .flatMap((tab) => tab.panes)
          .find((p) => p.job_id === run.job_id);
        status = pane?.job_status ?? null;
      }
      expect(status).toBe("failed");
      expect(service.jobs.get(run.job_id)?.exitCode).toBe(3);
    });

    test("run description round-trips into list_panes", async () => {
      const run = await service.run({
        command: "echo described",
        description: "context probe at user request",
        name: "desc",
        timeout_ms: 10_000,
        background: false,
      });
      expect(run.status).toBe("done");
      const panes = await service.listPanes(false);
      const pane = panes.find((candidate) => candidate.pane === run.pane);
      expect(pane?.description).toBe("context probe at user request");
    });

    test("run resolves .sidemux.toml script names against the run's cwd", async () => {
      const dir = await mkdtemp(join(tmpdir(), "smux-scripts-"));
      try {
        await writeFile(
          join(dir, ".sidemux.toml"),
          '[scripts]\n"probe:e2e" = "echo script-resolved-ok"\n',
        );
        const result = await service.run({
          command: "probe:e2e",
          cwd: dir,
          timeout_ms: 10_000,
          background: false,
        });
        expect(result.status).toBe("done");
        expect(result.tail).toContain("script-resolved-ok");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });

    test("send_keys answers a prompt; guard refuses the agent pane", async () => {
      const run = await service.run({
        command: 'sh -c \'printf "answer? "; read x; echo "echoed:$x"\'',
        name: "svc",
        timeout_ms: 500,
        background: false,
      });
      expect(run.status).toBe("running");

      await service.wait({
        job_id: run.job_id,
        until: "idle",
        idle_ms: 300,
        timeout_ms: 15_000,
      });
      await service.sendKeys({
        job_id: run.job_id,
        text: "yes",
        press_enter: true,
      });
      const done = await service.wait({
        job_id: run.job_id,
        until: "exit",
        idle_ms: 2000,
        timeout_ms: 10_000,
      });
      expect(done.status).toBe("exit");
      expect(done.tail).toContain("echoed:yes");

      await expect(
        service.sendKeys({
          pane: fx.firstPane,
          text: "nope",
          press_enter: true,
        }),
      ).rejects.toThrow(/agent's own pane/);
    });

    test("list_panes shows managed panes with job status; kill-pane removes them", async () => {
      const panes = await service.listPanes(false);
      const managed = panes.filter((p) => p.managed);
      expect(managed.length).toBeGreaterThan(0);
      const svc = managed.find((p) => p.name === "svc");
      expect(svc).toBeDefined();
      expect(svc!.job_id).toMatch(/^j[0-9a-f]{6}$/);

      // kill-pane refuses foreign panes
      await expect(
        service.kill({ pane: fx.firstPane, mode: "kill-pane" }),
      ).rejects.toThrow();

      const killed = await service.kill({ pane: svc!.pane, mode: "kill-pane" });
      expect(killed.ok).toBe(true);
      const after = await service.listPanes(true);
      expect(after.find((p) => p.pane === svc!.pane)).toBeUndefined();
    });

    test("read since=last-read is incremental across service reads", async () => {
      const run = await service.run({
        command: "echo inc-one",
        name: "inc",
        timeout_ms: 10_000,
        background: false,
      });
      const first = await service.read({
        pane: run.pane,
        since: "last-read",
        lines: 100,
        context: 2,
        max_bytes: 8192,
      });
      expect(first.text).toContain("inc-one");

      const second = await service.read({
        pane: run.pane,
        since: "last-read",
        lines: 100,
        context: 2,
        max_bytes: 8192,
      });
      expect(second.text).not.toContain("inc-one");
    });

    test("run close:true returns a clean tail then destroys the managed pane", async () => {
      const result = await service.run({
        command: "echo close-me",
        name: "closer",
        timeout_ms: 10_000,
        background: false,
        close: true,
      });
      expect(result.status).toBe("done");
      expect(result.tail).toContain("close-me");
      expect(result.closed).toBe(true);
      const after = await service.listPanes(true);
      expect(after.find((p) => p.pane === result.pane)).toBeUndefined();
    });

    test("run close:true is a no-op for a background job (pane survives)", async () => {
      const result = await service.run({
        command: "sleep 30",
        name: "bg-close",
        timeout_ms: 10_000,
        background: true,
        close: true,
      });
      expect(result.status).toBe("running");
      expect(result.closed).toBe(false);
      const after = await service.listPanes(true);
      expect(after.find((p) => p.pane === result.pane)).toBeDefined();
      await service.kill({ job_id: result.job_id, mode: "kill-pane" });
    });

    test("run close:true does not close a still-running (timed-out) job", async () => {
      const result = await service.run({
        command: "sleep 30",
        name: "slow-close",
        timeout_ms: 400,
        background: false,
        close: true,
      });
      expect(result.status).toBe("running");
      expect(result.closed).toBe(false);
      const after = await service.listPanes(true);
      expect(after.find((p) => p.pane === result.pane)).toBeDefined();
      await service.kill({ job_id: result.job_id, mode: "kill-pane" });
    });

    test("SIDEMUX_CLOSE_ON_SUCCESS closes on exit 0 but keeps a failed pane", async () => {
      const closer = new SidemuxService(
        fx.client,
        loadConfig({
          SIDEMUX_PANE_SHELL: "sh",
          SIDEMUX_CLOSE_ON_SUCCESS: "1",
          SIDEMUX_LOG_DIR: LOG_DIR,
        }),
        { TMUX: "fixture", TMUX_PANE: fx.firstPane },
        "/tmp",
      );

      const ok = await closer.run({
        command: "echo auto-close-ok",
        name: "autoclose",
        timeout_ms: 10_000,
        background: false,
      });
      expect(ok.status).toBe("done");
      expect(ok.closed).toBe(true);
      const afterOk = await closer.listPanes(true);
      expect(afterOk.find((p) => p.pane === ok.pane)).toBeUndefined();

      // A failing command must NOT auto-close — the pane stays up for inspection.
      const bad = await closer.run({
        command: "ls /definitely-not-a-real-path-xyz",
        name: "autoclose",
        timeout_ms: 10_000,
        background: false,
      });
      expect(bad.status).toBe("failed");
      expect(bad.closed).toBe(false);
      const afterBad = await closer.listPanes(true);
      expect(afterBad.find((p) => p.pane === bad.pane)).toBeDefined();
      await closer.kill({ pane: bad.pane, mode: "kill-pane" });
    });

    test("wait on a bare pane (no tracked job) scrubs a stale sentinel from the tail", async () => {
      // A pane sidemux never launched a job into: findByPane returns undefined,
      // so wait() falls back to screenTail. Simulate a completed sentinel left on
      // screen by an earlier command and assert it does not leak into the tail.
      const pane = await fx.newPane("/tmp");
      await fx.client.sendLiteral(
        pane,
        "printf 'work done\\n<<SMUX:jdead00:0>>\\n'",
      );
      await fx.client.sendKeys(pane, ["Enter"]);
      await fx.until(async () =>
        (await fx.screen(pane)).includes("<<SMUX:jdead00:0>>"),
      );

      const waited = await service.wait({
        pane,
        until: "idle",
        idle_ms: 300,
        timeout_ms: 10_000,
      });
      expect(waited.tail).toContain("work done");
      expect(waited.tail).not.toContain("<<SMUX:");
    });

    test("a fresh service instance reuses an existing managed pane", async () => {
      const first = await service.run({
        command: "echo shared-first",
        name: "shared",
        timeout_ms: 10_000,
        background: false,
      });
      const sibling = new SidemuxService(
        fx.client,
        loadConfig({ SIDEMUX_PANE_SHELL: "sh", SIDEMUX_LOG_DIR: LOG_DIR }),
        { TMUX: "fixture", TMUX_PANE: fx.firstPane },
        "/tmp",
      );

      const second = await sibling.run({
        command: "echo shared-second",
        name: "shared",
        timeout_ms: 10_000,
        background: false,
      });
      expect(second.pane).toBe(first.pane);
    });

    test("idle-pane TTL trims expired panes after a run, keeping the just-used one", async () => {
      // TTL 0 = every idle pane is already expired; only keepPaneId (the pane
      // that just ran) survives each post-run trim. Failed panes are collected
      // by the TTL too — retention, not exit code, decides.
      const trimming = new SidemuxService(
        fx.client,
        loadConfig({
          SIDEMUX_PANE_SHELL: "sh",
          SIDEMUX_IDLE_PANE_TTL_MS: "0",
          SIDEMUX_LOG_DIR: LOG_DIR,
        }),
        { TMUX: "fixture", TMUX_PANE: fx.firstPane },
        "/tmp",
      );

      const first = await trimming.run({
        command: "echo trim-one",
        name: "trim-one",
        timeout_ms: 10_000,
        background: false,
      });
      const failed = await trimming.run({
        command: "ls /definitely-not-a-real-path-xyz",
        name: "trim-fail",
        timeout_ms: 10_000,
        background: false,
      });
      expect(
        (await trimming.listPanes(true)).find((p) => p.pane === first.pane),
      ).toBeUndefined();

      const second = await trimming.run({
        command: "echo trim-two",
        name: "trim-two",
        timeout_ms: 10_000,
        background: false,
      });

      const managed = (await trimming.listPanes(true)).filter((p) => p.managed);
      expect(managed.find((p) => p.pane === failed.pane)).toBeUndefined();
      expect(managed.find((p) => p.pane === second.pane)).toBeDefined();

      await trimming.closeAll();
    });

    test("close_all destroys every managed pane in one call", async () => {
      await service.run({
        command: "echo one",
        name: "ca1",
        timeout_ms: 10_000,
        background: false,
      });
      await service.run({
        command: "echo two",
        name: "ca2",
        timeout_ms: 10_000,
        background: false,
      });
      const managedBefore = (await service.listPanes(true)).filter(
        (p) => p.managed,
      );
      expect(managedBefore.length).toBeGreaterThanOrEqual(2);

      const result = await service.closeAll();
      expect(result.count).toBeGreaterThanOrEqual(2);

      const managedAfter = (await service.listPanes(true)).filter(
        (p) => p.managed,
      );
      expect(managedAfter.length).toBe(0);
    });

    test("run {project} resolves cwd to the package dir and names the pane", async () => {
      const root = await mkdtemp(join(tmpdir(), "smux-mono-"));
      await writeFile(
        join(root, "pnpm-workspace.yaml"),
        "packages:\n  - 'apps/*'\n",
      );
      const bevvi = join(root, "apps", "bevvi");
      await mkdir(bevvi, { recursive: true });
      await writeFile(
        join(bevvi, "package.json"),
        JSON.stringify({ name: "bevvi" }),
      );

      // A server rooted at the monorepo; project resolution is relative to it.
      const mono = new SidemuxService(
        fx.client,
        loadConfig({ SIDEMUX_PANE_SHELL: "sh", SIDEMUX_LOG_DIR: LOG_DIR }),
        { TMUX: "fixture", TMUX_PANE: fx.firstPane },
        root,
      );

      const ran = await mono.run({
        command: "pwd",
        project: "bevvi",
        timeout_ms: 10_000,
        background: false,
      });
      expect(ran.status).toBe("done");
      expect(ran.tail).toContain(bevvi);

      const listed = await mono.listPanes(true);
      expect(listed.find((p) => p.pane === ran.pane)?.name).toContain("bevvi");

      // An unknown project errors with the list of valid names.
      await expect(
        mono.run({
          command: "pwd",
          project: "nope",
          timeout_ms: 10_000,
          background: false,
        }),
      ).rejects.toThrow(/unknown project "nope".*available: bevvi/s);

      await mono.closeAll();
      await rm(root, { recursive: true, force: true });
    });

    test("run resolves a .sidemux.toml script name to its command", async () => {
      const root = await mkdtemp(join(tmpdir(), "smux-scripts-"));
      await writeFile(
        join(root, ".sidemux.toml"),
        '[scripts]\nhello = "echo script-resolved"\n',
      );

      const scripted = new SidemuxService(
        fx.client,
        loadConfig({ SIDEMUX_PANE_SHELL: "sh", SIDEMUX_LOG_DIR: LOG_DIR }),
        { TMUX: "fixture", TMUX_PANE: fx.firstPane },
        root,
      );

      const ran = await scripted.run({
        command: "hello",
        timeout_ms: 10_000,
        background: false,
      });
      expect(ran.status).toBe("done");
      expect(ran.tail).toContain("script-resolved");

      // The pane is named after the script.
      const listed = await scripted.listPanes(true);
      expect(listed.find((p) => p.pane === ran.pane)?.name).toContain("hello");

      // A non-script command still passes through as raw shell.
      const raw = await scripted.run({
        command: "echo raw-shell",
        timeout_ms: 10_000,
        background: false,
      });
      expect(raw.tail).toContain("raw-shell");

      await scripted.closeAll();
      await rm(root, { recursive: true, force: true });
    });

    test("wait pattern matches real output, not the echoed launch command", async () => {
      // The pattern text is also a substring of the launched command, so scanning
      // the echoed command line would false-match instantly instead of waiting
      // for the program's own output.
      const run = await service.run({
        command: 'sh -c "sleep 0.4; echo READYMARKER-live"',
        name: "echomatch",
        timeout_ms: 10_000,
        background: true,
      });
      const waited = await service.wait({
        job_id: run.job_id,
        until: "pattern",
        pattern: "READYMARKER",
        idle_ms: 2000,
        timeout_ms: 10_000,
      });
      expect(waited.status).toBe("pattern");
      // The real stdout line — not the echoed `... echo READYMARKER-live ...; printf`.
      expect(waited.matched_line).toContain("READYMARKER-live");
      expect(waited.matched_line).not.toContain("<<SMUX:");
      expect(waited.matched_line).not.toMatch(/echo READYMARKER-live/);
      await service.kill({ job_id: run.job_id, mode: "kill-pane" });
    });

    test("run whose command exits the shell reports unknown without throwing", async () => {
      // `exit 7` runs before the appended sentinel, so the pane's shell is gone
      // before an exit code can be read. sidemux must report an unknown outcome
      // rather than surfacing a raw tmux "can't find pane" error, and must drop
      // the dead pane from its registry (no stale busy entry left behind).
      const result = await service.run({
        command: "echo bye; exit 7",
        name: "selfexit",
        timeout_ms: 10_000,
        background: false,
      });
      expect(result.status).toBe("unknown");
      expect(result.exit_code).toBeNull();
      const after = await service.listPanes(true);
      expect(after.find((p) => p.pane === result.pane)).toBeUndefined();
    });

    test("close_all survives a managed pane that died out-of-band", async () => {
      const a = await service.run({
        command: "echo r1",
        name: "res1",
        timeout_ms: 10_000,
        background: false,
      });
      const b = await service.run({
        command: "echo r2",
        name: "res2",
        timeout_ms: 10_000,
        background: false,
      });
      // A human closing a split removes it from tmux's live inventory. close_all
      // should still tear down every remaining managed pane without choking on
      // the missing one.
      await fx.client.killPane(a.pane);

      const result = await service.closeAll();
      expect(result.closed).toContain(b.pane);
      const managedAfter = (await service.listPanes(true)).filter(
        (p) => p.managed,
      );
      expect(managedAfter.length).toBe(0);
    });
  },
);
