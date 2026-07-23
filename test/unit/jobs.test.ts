import { describe, expect, test, vi } from "vitest";
import {
  JobManager,
  buildPipefailPrefix,
  buildSentinelSuffix,
  makeJobId,
  parseSentinel,
  scrubOutput,
  sentinelRegex,
  stripSentinel,
} from "../../src/core/jobs.js";
import type { TmuxClient } from "../../src/tmux/client.js";

describe("sentinel", () => {
  test("job ids are unique and shell-quote safe", () => {
    const a = makeJobId();
    const b = makeJobId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^j[0-9a-f]{6}$/);
  });

  test("posix suffix uses $?, fish uses $status", () => {
    expect(buildSentinelSuffix("j1a2b3", "posix")).toBe(
      "; printf '\\n<<SMUX:%s:%d>>\\n' 'j1a2b3' $?",
    );
    expect(buildSentinelSuffix("j1a2b3", "fish")).toBe(
      "; printf '\\n<<SMUX:%s:%d>>\\n' 'j1a2b3' $status",
    );
  });

  test("posix prefix enables pipefail with a quiet fallback, fish gets none", () => {
    // Probed in a subshell first: `set` is a special builtin, so in dash the
    // rejected option would otherwise abort the whole line (command included).
    expect(buildPipefailPrefix("posix")).toBe(
      "(set -o pipefail) 2>/dev/null && set -o pipefail; ",
    );
    expect(buildPipefailPrefix("fish")).toBe("");
  });

  test("MANDATORY: the echoed command line can never match the completion regex", () => {
    // What the pane shows when the shell echoes the typed command back:
    const echoedLine = `$ npm test${buildSentinelSuffix("j1a2b3", "posix")}`;
    expect(sentinelRegex("j1a2b3").test(echoedLine)).toBe(false);
    // ...because the format string holds literal %d where the regex needs digits.
    expect(parseSentinel([echoedLine], "j1a2b3")).toBeNull();
  });

  test("parses the completed sentinel and returns the exit code", () => {
    const lines = ["npm test output", "<<SMUX:j1a2b3:0>>", ""];
    expect(parseSentinel(lines, "j1a2b3")).toBe(0);
    expect(parseSentinel(["<<SMUX:j1a2b3:127>>"], "j1a2b3")).toBe(127);
  });

  test("ignores sentinels belonging to other jobs", () => {
    expect(parseSentinel(["<<SMUX:jffffff:0>>"], "j1a2b3")).toBeNull();
  });

  test("scans from the end so the latest sentinel wins", () => {
    const lines = ["<<SMUX:j1a2b3:1>>", "rerun...", "<<SMUX:j1a2b3:0>>"];
    expect(parseSentinel(lines, "j1a2b3")).toBe(0);
  });

  test("stripSentinel removes completed sentinel lines but keeps the echo", () => {
    const echoed = `$ make${buildSentinelSuffix("j1a2b3", "posix")}`;
    const lines = [echoed, "building...", "<<SMUX:j1a2b3:0>>"];
    expect(stripSentinel(lines, "j1a2b3")).toEqual([echoed, "building..."]);
  });
});

describe("scrubOutput", () => {
  test("drops any completed sentinel line regardless of job id", () => {
    const lines = [
      "build output",
      "<<SMUX:jabc123:0>>",
      "more",
      "<<SMUX:jffffff:127>>",
    ];
    expect(scrubOutput(lines)).toEqual(["build output", "more"]);
  });

  test("scrubs the posix echo suffix, leaving the user command intact", () => {
    const echoed = `$ npm test${buildSentinelSuffix("jabc12", "posix")}`;
    expect(scrubOutput([echoed])).toEqual(["$ npm test"]);
  });

  test("scrubs the fish echo suffix ($status)", () => {
    const echoed = `❯ npm test${buildSentinelSuffix("jabc12", "fish")}`;
    expect(scrubOutput([echoed])).toEqual(["❯ npm test"]);
  });

  test("scrubs a prompt-perturbed echo where the shell widened the gaps", () => {
    // A reflowing prompt can insert extra spaces around the suffix tokens.
    const perturbed =
      "$ npm test ;  printf  '\\n<<SMUX:%s:%d>>\\n'  'jabc12'  $?";
    expect(scrubOutput([perturbed])).toEqual(["$ npm test"]);
  });

  test("last-resort residue strip catches a marker the echo regex missed", () => {
    const weird = "$ make; printf garbled <<SMUX:%s:%d>> leftovers";
    expect(scrubOutput([weird])).toEqual(["$ make"]);
  });

  test("scrubs the pipefail prefix from the echoed launch line", () => {
    const echoed = `$ ${buildPipefailPrefix("posix")}npm test${buildSentinelSuffix("jabc12", "posix")}`;
    expect(scrubOutput([echoed])).toEqual(["$ npm test"]);
  });

  test("leaves ordinary output that merely mentions pipefail untouched", () => {
    // No sentinel echo on the line → not sidemux's launch line → hands off.
    const lines = [
      "hint: run (set -o pipefail) 2>/dev/null && set -o pipefail; before piping",
    ];
    expect(scrubOutput(lines)).toEqual(lines);
  });

  test("leaves ordinary output containing no marker untouched", () => {
    const lines = ["compiling foo.ts", "PASS 12 tests", "done in 3s"];
    expect(scrubOutput(lines)).toEqual(lines);
  });
});

function stubClient(currentCommand = "sh"): TmuxClient {
  return {
    paneState: vi.fn(async () => ({
      historySize: 0,
      historyLimit: 2000,
      cursorY: 0,
      paneHeight: 30,
      currentCommand,
      currentPath: "/proj",
    })),
    sendLiteral: vi.fn(async () => undefined),
    sendKeys: vi.fn(async () => undefined),
  } as unknown as TmuxClient;
}

describe("JobManager", () => {
  test("launch sends the pipefail prefix ahead of the command (posix)", async () => {
    const client = stubClient();
    const manager = new JobManager(client);
    await manager.launch("%1", "cmd | tee log", "posix");
    const sent = vi.mocked(client.sendLiteral).mock.calls[0]?.[1];
    expect(sent).toMatch(
      /^\(set -o pipefail\) 2>\/dev\/null && set -o pipefail; cmd \| tee log; /,
    );
  });

  test("launch sends no pipefail prefix for fish", async () => {
    const client = stubClient();
    const manager = new JobManager(client);
    await manager.launch("%1", "cmd | tee log", "fish");
    const sent = vi.mocked(client.sendLiteral).mock.calls[0]?.[1];
    expect(sent).toMatch(/^cmd \| tee log; /);
  });

  test("launch refuses a pane running a shell that cannot report exit codes", async () => {
    // tcsh parses `$?` as a variable-existence test, so the sentinel never
    // prints and the job would hang until its timeout. Failing here is the
    // whole point — an error the caller can read beats a silent stall.
    const client = stubClient("tcsh");
    const manager = new JobManager(client);
    await expect(manager.launch("%1", "echo hi", null)).rejects.toThrow(/tcsh/);
    expect(client.sendLiteral).not.toHaveBeenCalled();
  });

  test("launch refuses even when a dialect is forced", async () => {
    // SIDEMUX_SHELL only picks `$?` vs `$status`; neither works in csh, so
    // an explicit dialect must not turn the refusal back into a hang.
    const manager = new JobManager(stubClient("/bin/csh"));
    await expect(manager.launch("%1", "echo hi", "posix")).rejects.toThrow(
      /csh/,
    );
  });

  test("launch allows an unrecognized foreground command", async () => {
    // Unknown is not incompatible: the pane may be running a wrapper, and
    // posix stays the safe default there.
    const manager = new JobManager(stubClient("some-wrapper"));
    await expect(manager.launch("%1", "echo hi", null)).resolves.toBeDefined();
  });

  test("launch registers the job and findByPane returns the latest per pane", async () => {
    const manager = new JobManager(stubClient());
    const first = await manager.launch("%1", "echo one", "posix");
    const second = await manager.launch("%1", "echo two", "posix");
    expect(manager.get(first.jobId)).toBe(first);
    expect(manager.findByPane("%1")).toBe(second);
    expect(manager.findByPane("%99")).toBeUndefined();
  });

  test("applyScan flips status from the sentinel, then becomes a no-op", async () => {
    const manager = new JobManager(stubClient());
    const job = await manager.launch("%1", "false", "posix");
    manager.applyScan(job, [`<<SMUX:${job.jobId}:1>>`]);
    expect(job.status).toBe("failed");
    expect(job.exitCode).toBe(1);
    // A later scan (e.g. a stale re-read) must not resurrect or mutate the job.
    manager.applyScan(job, [`<<SMUX:${job.jobId}:0>>`]);
    expect(job.exitCode).toBe(1);
  });

  test("markInterrupted synthesizes 130 for running jobs only", async () => {
    const manager = new JobManager(stubClient());
    const running = await manager.launch("%1", "sleep 99", "posix");
    manager.markInterrupted(running);
    expect(running.status).toBe("failed");
    expect(running.exitCode).toBe(130);

    const done = await manager.launch("%1", "echo ok", "posix");
    manager.applyScan(done, [`<<SMUX:${done.jobId}:0>>`]);
    manager.markInterrupted(done);
    expect(done.status).toBe("done");
    expect(done.exitCode).toBe(0);
  });

  test("prunes the oldest finished jobs beyond the retention cap", async () => {
    const manager = new JobManager(stubClient());
    const finished = [];
    for (let i = 0; i < 105; i++) {
      const job = await manager.launch("%2", `echo ${i}`, "posix");
      manager.applyScan(job, [`<<SMUX:${job.jobId}:0>>`]);
      finished.push(job);
    }
    // Prune runs on launch; trigger one more so all 105 finished jobs are seen.
    await manager.launch("%3", "sleep 99", "posix");

    for (const job of finished.slice(0, 5)) {
      expect(manager.get(job.jobId)).toBeUndefined();
    }
    for (const job of finished.slice(5)) {
      expect(manager.get(job.jobId)).toBe(job);
    }
  });

  test("running jobs are never pruned, no matter how many finish after them", async () => {
    const manager = new JobManager(stubClient());
    const longLived = await manager.launch("%1", "pnpm dev", "posix");
    for (let i = 0; i < 120; i++) {
      const job = await manager.launch("%2", `echo ${i}`, "posix");
      manager.applyScan(job, [`<<SMUX:${job.jobId}:0>>`]);
    }
    expect(manager.get(longLived.jobId)).toBe(longLived);
    expect(longLived.status).toBe("running");
  });
});

describe("JobManager per-job log files", () => {
  interface PipeStub {
    client: TmuxClient;
    pipePane: ReturnType<typeof vi.fn>;
    pipePaneStop: ReturnType<typeof vi.fn>;
    sendLiteral: ReturnType<typeof vi.fn>;
  }

  function stubClientWithPipes(): PipeStub {
    const pipePane = vi.fn(async () => undefined);
    const pipePaneStop = vi.fn(async () => undefined);
    const sendLiteral = vi.fn(async () => undefined);
    const client = {
      paneState: vi.fn(async () => ({
        historySize: 0,
        historyLimit: 2000,
        cursorY: 0,
        paneHeight: 30,
        currentCommand: "sh",
        currentPath: "/proj",
      })),
      sendLiteral,
      sendKeys: vi.fn(async () => undefined),
      pipePane,
      pipePaneStop,
    } as unknown as TmuxClient;
    return { client, pipePane, pipePaneStop, sendLiteral };
  }

  async function tempLogDir(): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    return mkdtemp(join(tmpdir(), "smux-jobs-"));
  }

  test("launch opens the pane's pipe onto the log file before typing", async () => {
    const stub = stubClientWithPipes();
    const logDir = await tempLogDir();
    const manager = new JobManager(stub.client, logDir);
    const job = await manager.launch("%1", "echo hi", "posix");

    expect(job.logFile).toBe(`${logDir}/${job.jobId}.log`);
    expect(stub.pipePane).toHaveBeenCalledWith(
      "%1",
      `exec cat >> '${logDir}/${job.jobId}.log'`,
    );
    // The pipe must be live before the command's echo, or the file misses it.
    expect(stub.pipePane.mock.invocationCallOrder[0]).toBeLessThan(
      stub.sendLiteral.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  test("without a logDir no pipe is opened and logFile is null", async () => {
    const stub = stubClientWithPipes();
    const manager = new JobManager(stub.client);
    const job = await manager.launch("%1", "echo hi", "posix");
    expect(job.logFile).toBeNull();
    expect(stub.pipePane).not.toHaveBeenCalled();
  });

  test("a pipe-pane failure degrades to logFile null but still launches", async () => {
    const stub = stubClientWithPipes();
    stub.pipePane.mockRejectedValueOnce(new Error("tmux busy"));
    const manager = new JobManager(stub.client, await tempLogDir());
    const job = await manager.launch("%1", "echo hi", "posix");
    expect(job.logFile).toBeNull();
    expect(job.status).toBe("running");
    expect(stub.sendLiteral).toHaveBeenCalled();
  });

  test("observed completion closes the pane's pipe", async () => {
    const stub = stubClientWithPipes();
    const manager = new JobManager(stub.client, await tempLogDir());
    const job = await manager.launch("%1", "echo hi", "posix");
    manager.applyScan(job, [`<<SMUX:${job.jobId}:0>>`]);
    expect(stub.pipePaneStop).toHaveBeenCalledWith("%1");
  });

  test("interrupt closes the pane's pipe too", async () => {
    const stub = stubClientWithPipes();
    const manager = new JobManager(stub.client, await tempLogDir());
    const job = await manager.launch("%1", "sleep 99", "posix");
    manager.markInterrupted(job);
    expect(stub.pipePaneStop).toHaveBeenCalledWith("%1");
  });

  test("the pipe is left alone when a newer job re-piped the pane", async () => {
    const stub = stubClientWithPipes();
    const manager = new JobManager(stub.client, await tempLogDir());
    const first = await manager.launch("%1", "echo one", "posix");
    await manager.launch("%1", "echo two", "posix");
    // First job's completion is observed late — its pipe now belongs to job two.
    manager.applyScan(first, [`<<SMUX:${first.jobId}:0>>`]);
    expect(stub.pipePaneStop).not.toHaveBeenCalled();
  });
});
