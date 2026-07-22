import { mkdtemp, readdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  jobLogPath,
  pruneOldLogs,
  readJobLog,
  sanitizeTerminalOutput,
} from "../../src/core/logs.js";

describe("jobLogPath", () => {
  test("names the file after the job id inside the log dir", () => {
    expect(jobLogPath("/state/logs", "jabc123")).toBe("/state/logs/jabc123.log");
  });
});

describe("sanitizeTerminalOutput", () => {
  test("strips CSI color/cursor sequences", () => {
    expect(sanitizeTerminalOutput("\x1b[31mFAIL\x1b[0m tests")).toEqual([
      "FAIL tests",
    ]);
  });

  test("strips OSC title sequences (BEL and ST terminated)", () => {
    expect(sanitizeTerminalOutput("\x1b]0;my title\x07hello")).toEqual([
      "hello",
    ]);
    expect(sanitizeTerminalOutput("\x1b]2;t\x1b\\world")).toEqual(["world"]);
  });

  test("CRLF splits into lines without stray carriage returns", () => {
    expect(sanitizeTerminalOutput("one\r\ntwo\r\nthree")).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  test("a CR-redrawn progress bar collapses to its final frame", () => {
    expect(sanitizeTerminalOutput("10%\r50%\r100% done\r\nnext")).toEqual([
      "100% done",
      "next",
    ]);
  });
});

describe("readJobLog", () => {
  test("returns sanitized lines cut at the job's sentinel", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smux-logs-"));
    const path = jobLogPath(dir, "jabc123");
    await writeFile(
      path,
      "$ seq 1 3\r\n1\r\n2\r\n3\r\n<<SMUX:jabc123:0>>\r\n$ \r\nnext command noise\r\n",
    );
    expect(await readJobLog(path, "jabc123")).toEqual([
      "$ seq 1 3",
      "1",
      "2",
      "3",
      "<<SMUX:jabc123:0>>",
    ]);
  });

  test("returns everything when no sentinel has landed yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smux-logs-"));
    const path = jobLogPath(dir, "jabc123");
    await writeFile(path, "partial\r\noutput");
    expect(await readJobLog(path, "jabc123")).toEqual(["partial", "output"]);
  });

  test("rejects when the file does not exist", async () => {
    await expect(readJobLog("/nope/missing.log", "jabc123")).rejects.toThrow();
  });
});

describe("pruneOldLogs", () => {
  test("deletes stale job logs, keeps fresh ones and foreign files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smux-logs-"));
    const now = Date.now();
    const stale = new Date(now - 10_000);
    await writeFile(join(dir, "jaaa001.log"), "old");
    await utimes(join(dir, "jaaa001.log"), stale, stale);
    await writeFile(join(dir, "jbbb001.log"), "new");
    await writeFile(join(dir, "not-a-job.log"), "keep");
    await utimes(join(dir, "not-a-job.log"), stale, stale);

    await pruneOldLogs(dir, 5000, now);

    expect((await readdir(dir)).sort()).toEqual([
      "jbbb001.log",
      "not-a-job.log",
    ]);
  });

  test("a missing log dir is a no-op", async () => {
    await expect(
      pruneOldLogs("/definitely/not/a/dir"),
    ).resolves.toBeUndefined();
  });
});
