import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { JobManager } from "../../src/core/jobs.js";
import { waitFor } from "../../src/core/waiter.js";
import { TmuxFixture, tmuxAvailable } from "./helpers/tmux-fixture.js";

function bashAvailable(): boolean {
  try {
    return spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

describe.skipIf(!tmuxAvailable())("run → wait against real tmux", () => {
  const fx = new TmuxFixture();
  let jobs: JobManager;

  beforeAll(async () => {
    await fx.start("/tmp");
    jobs = new JobManager(fx.client);
  });

  afterAll(async () => {
    await fx.stop();
  });

  test("successful command completes with exit 0", async () => {
    const job = await jobs.launch(fx.firstPane, "echo run-wait-ok", null);
    const result = await waitFor(fx.client, fx.firstPane, jobs, job, {
      until: "exit",
      timeoutMs: 10_000,
    });
    expect(result.status).toBe("exit");
    expect(result.exitCode).toBe(0);
    expect(job.status).toBe("done");
  });

  test("failing command reports its real exit code", async () => {
    const job = await jobs.launch(fx.firstPane, 'sh -c "exit 3"', null);
    const result = await waitFor(fx.client, fx.firstPane, jobs, job, {
      until: "exit",
      timeoutMs: 10_000,
    });
    expect(result.status).toBe("exit");
    expect(result.exitCode).toBe(3);
    expect(job.status).toBe("failed");
  });

  test.skipIf(!bashAvailable())(
    "piped failing command surfaces the failing stage's exit code (pipefail)",
    async () => {
      // pipefail needs a shell that supports it; the fixture's plain sh may
      // be dash (which keeps tail-of-pipe status), so run this pane in bash.
      const pane = await fx.client.splitWindow(
        "/tmp",
        fx.firstPane,
        "30%",
        "bash --norc",
      );
      const job = await jobs.launch(pane, 'sh -c "exit 3" | cat', null);
      const result = await waitFor(fx.client, pane, jobs, job, {
        until: "exit",
        timeoutMs: 10_000,
      });
      expect(result.status).toBe("exit");
      expect(result.exitCode).toBe(3);
      expect(job.status).toBe("failed");
    },
  );

  test("long command: wait times out re-armably, second wait completes", async () => {
    const job = await jobs.launch(
      fx.firstPane,
      "sleep 2 && echo slow-done",
      null,
    );
    const first = await waitFor(fx.client, fx.firstPane, jobs, job, {
      until: "exit",
      timeoutMs: 500,
    });
    expect(first.status).toBe("timeout");
    expect(job.status).toBe("running");

    const second = await waitFor(fx.client, fx.firstPane, jobs, job, {
      until: "exit",
      timeoutMs: 10_000,
    });
    expect(second.status).toBe("exit");
    expect(second.exitCode).toBe(0);
  });

  test("wait until pattern returns the matching line", async () => {
    const job = await jobs.launch(
      fx.firstPane,
      'sh -c "sleep 0.3; echo SERVER READY on 3000; sleep 5"',
      null,
    );
    const result = await waitFor(fx.client, fx.firstPane, jobs, job, {
      until: "pattern",
      pattern: "READY on \\d+",
      timeoutMs: 10_000,
    });
    expect(result.status).toBe("pattern");
    expect(result.matchedLine).toContain("SERVER READY on 3000");
    // interrupt the leftover sleep so the pane is free for other tests
    await fx.client.sendKeys(fx.firstPane, ["C-c"]);
  });

  test("wait until idle detects the shell sitting at a prompt", async () => {
    const job = await jobs.launch(fx.firstPane, "echo idle-me", null);
    const result = await waitFor(fx.client, fx.firstPane, jobs, job, {
      until: "idle",
      idleMs: 600,
      timeoutMs: 15_000,
    });
    expect(result.status).toBe("idle");
  });
});
