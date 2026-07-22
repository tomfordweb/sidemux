import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "../../src/config.js";
import { JobManager } from "../../src/core/jobs.js";
import { readJobLog } from "../../src/core/logs.js";
import { waitFor } from "../../src/core/waiter.js";
import { SidemuxService } from "../../src/service.js";
import { TmuxFixture, tmuxAvailable } from "./helpers/tmux-fixture.js";

/** Small enough that a couple hundred output lines overflow the scrollback. */
const HISTORY_LIMIT = 20;

describe.skipIf(!tmuxAvailable())("per-job log files on real tmux", () => {
  const fx = new TmuxFixture();
  let logDir: string;
  let jobs: JobManager;

  beforeAll(async () => {
    await fx.start("/tmp");
    // Applies to panes created from here on — the point of these tests is
    // output that outgrows the pane's history.
    await fx.run(["set-option", "-g", "history-limit", String(HISTORY_LIMIT)]);
    logDir = await mkdtemp(join(tmpdir(), "smux-int-logs-"));
    jobs = new JobManager(fx.client, logDir);
  });

  afterAll(async () => {
    await fx.stop();
  });

  test("log file holds the FULL output after scrollback overflow, exit code intact", async () => {
    const pane = await fx.newPane();
    const job = await jobs.launch(pane, "seq 1 200", null);
    expect(job.logFile).toBe(join(logDir, `${job.jobId}.log`));

    const result = await waitFor(fx.client, pane, jobs, job, {
      until: "exit",
      timeoutMs: 15_000,
    });
    expect(result.status).toBe("exit");
    expect(result.exitCode).toBe(0); // pipe-pane never touches the command

    // The pane has lost the early lines (tmux trims to just under the limit)...
    const state = await fx.client.paneState(pane);
    expect(state.historySize).toBeGreaterThanOrEqual(HISTORY_LIMIT - 1);
    // ...but the log file has every one of them, echo to sentinel.
    const lines = await readJobLog(job.logFile ?? "", job.jobId);
    for (const n of [1, 2, 100, 199, 200]) {
      expect(lines).toContain(String(n));
    }
    expect(lines.at(-1)).toContain(`<<SMUX:${job.jobId}:`);
  });

  test("failing command keeps its real exit code with logging active", async () => {
    const pane = await fx.newPane();
    const job = await jobs.launch(pane, 'sh -c "echo boom; exit 3"', null);
    const result = await waitFor(fx.client, pane, jobs, job, {
      until: "exit",
      timeoutMs: 15_000,
    });
    expect(result.exitCode).toBe(3);
    const raw = await readFile(job.logFile ?? "", "utf8");
    expect(raw).toContain("boom");
  });

  test("service: run returns log_file and read since=job serves lost output from it", async () => {
    const serviceLogDir = await mkdtemp(join(tmpdir(), "smux-svc-logs-"));
    const service = new SidemuxService(
      fx.client,
      loadConfig({ SIDEMUX_PANE_SHELL: "sh", SIDEMUX_LOG_DIR: serviceLogDir }),
      { TMUX: "fixture", TMUX_PANE: fx.firstPane },
      "/tmp",
    );

    const run = await service.run({
      command: "seq 1 300",
      name: "log-svc",
      timeout_ms: 15_000,
      background: false,
    });
    expect(run.status).toBe("done");
    expect(run.exit_code).toBe(0);
    expect(run.log_file).toMatch(new RegExp(`${run.job_id}\\.log$`));
    await expect(access(run.log_file ?? "")).resolves.toBeUndefined();

    // With history-limit 20 the pane lost lines 1..~270; the log did not.
    const full = await service.read({
      job_id: run.job_id,
      since: "job",
      lines: 2000,
      context: 2,
      max_bytes: 65_536,
    });
    expect(full.log_file).toBe(run.log_file);
    expect(full.text).toContain("\n5\n");
    expect(full.text).toContain("\n299\n");
    expect(full.text).not.toContain("<<SMUX:");
  });
});
