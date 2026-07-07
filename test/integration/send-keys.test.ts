import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { JobManager } from "../../src/core/jobs.js";
import { waitFor } from "../../src/core/waiter.js";
import { TmuxFixture, tmuxAvailable } from "./helpers/tmux-fixture.js";

describe.skipIf(!tmuxAvailable())(
  "interactive prompts against real tmux",
  () => {
    const fx = new TmuxFixture();
    let jobs: JobManager;

    beforeAll(async () => {
      await fx.start("/tmp");
      jobs = new JobManager(fx.client);
    });

    afterAll(async () => {
      await fx.stop();
    });

    test("answer an interactive prompt: wait idle → send_keys → command completes", async () => {
      const job = await jobs.launch(
        fx.firstPane,
        'sh -c \'printf "name? "; read x; echo "got:$x"\'',
        null,
      );

      // command is sitting on read(1); idle detection must fire (non-shell 3x window)
      const idle = await waitFor(fx.client, fx.firstPane, jobs, job, {
        until: "idle",
        idleMs: 300,
        timeoutMs: 15_000,
      });
      expect(idle.status).toBe("idle");

      await fx.client.sendLiteral(fx.firstPane, "tomford");
      await fx.client.sendKeys(fx.firstPane, ["Enter"]);

      const done = await waitFor(fx.client, fx.firstPane, jobs, job, {
        until: "exit",
        timeoutMs: 10_000,
      });
      expect(done.status).toBe("exit");
      expect(done.exitCode).toBe(0);
      expect(await fx.screen(fx.firstPane)).toContain("got:tomford");
    });

    test("C-c interrupts a stuck command; job is marked interrupted (no sentinel)", async () => {
      const job = await jobs.launch(fx.firstPane, "sleep 300", null);
      await new Promise((r) => setTimeout(r, 300));
      await fx.client.sendKeys(fx.firstPane, ["C-c"]);

      // Ctrl-C aborts the whole command list including the sentinel printf,
      // so exit detection can't work — the shell just returns to its prompt.
      const idle = await waitFor(fx.client, fx.firstPane, jobs, job, {
        until: "idle",
        idleMs: 500,
        timeoutMs: 15_000,
      });
      expect(idle.status).toBe("idle");

      jobs.markInterrupted(job);
      expect(job.status).toBe("failed");
      expect(job.exitCode).toBe(130);
    });
  },
);
