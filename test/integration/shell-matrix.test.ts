import { spawnSync } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  buildPipefailPrefix,
  buildSentinelSuffix,
  parseSentinel,
} from "../../src/core/jobs.js";
import type { ShellDialect } from "../../src/config.js";

/**
 * The launch line, run through every shell installed on this machine.
 *
 * sidemux types one line into a pane — pipefail prefix, the user's command,
 * the exit-code sentinel — and then waits for that sentinel. If a shell
 * mangles any part of the line the job never completes: it sits "running"
 * until its timeout, forever for a background job. That failure mode is silent
 * on the host that wrote the code and only shows up on someone else's machine,
 * so the contract is asserted here against whatever shells are present rather
 * than against one blessed shell.
 *
 * Two real examples this guards, both found in CI rather than locally:
 *  - dash and posh abort the whole line on `set -o pipefail` (`set` is a POSIX
 *    special builtin, so its failure is fatal) unless the option is probed in
 *    a subshell first.
 *  - dash 0.5.13 tolerates what 0.5.12 rejects, so pinning the test to one
 *    shell name proves nothing about the shell a user actually has.
 *
 * No tmux involved: this is the shell contract, not the pane plumbing.
 */

interface Candidate {
  /** Display name, also the binary unless argv0 says otherwise. */
  name: string;
  bin: string;
  /** Args that make the shell read the following string as a command. */
  args: string[];
  dialect: ShellDialect;
}

const CANDIDATES: Candidate[] = [
  { name: "bash", bin: "bash", args: ["-c"], dialect: "posix" },
  { name: "zsh", bin: "zsh", args: ["-c"], dialect: "posix" },
  { name: "dash", bin: "dash", args: ["-c"], dialect: "posix" },
  { name: "ksh", bin: "ksh", args: ["-c"], dialect: "posix" },
  { name: "mksh", bin: "mksh", args: ["-c"], dialect: "posix" },
  { name: "yash", bin: "yash", args: ["-c"], dialect: "posix" },
  { name: "posh", bin: "posh", args: ["-c"], dialect: "posix" },
  { name: "busybox-ash", bin: "busybox", args: ["sh", "-c"], dialect: "posix" },
  { name: "sh", bin: "sh", args: ["-c"], dialect: "posix" },
  { name: "fish", bin: "fish", args: ["-c"], dialect: "fish" },
];

function runs(candidate: Candidate): boolean {
  try {
    return (
      spawnSync(candidate.bin, [...candidate.args, "exit 0"], {
        stdio: "ignore",
      }).status === 0
    );
  } catch {
    return false;
  }
}

const AVAILABLE = CANDIDATES.filter(runs);

/** Type the launch line into `shell` exactly as JobManager would. */
function launch(
  candidate: Candidate,
  command: string,
  jobId = "jm4tr1x",
): { sentinel: number | null; stdout: string } {
  const line =
    buildPipefailPrefix(candidate.dialect) +
    command +
    buildSentinelSuffix(jobId, candidate.dialect);
  const result = spawnSync(candidate.bin, [...candidate.args, line], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const stdout = result.stdout;
  return { sentinel: parseSentinel(stdout.split("\n"), jobId), stdout };
}

describe("launch line across installed shells", () => {
  test("at least one shell is available to test", () => {
    expect(AVAILABLE.map((c) => c.name)).not.toHaveLength(0);
  });

  describe.each(AVAILABLE.map((c) => [c.name, c] as const))(
    "%s",
    (_name, candidate) => {
      // 127 and 130 matter beyond the ordinary 0/1: they are what a missing
      // binary and a Ctrl-C'd job report, and a shell that clamps or drops
      // them would silently mislabel jobs as successful.
      test.each([0, 3, 42, 127, 130, 255])(
        "exit code %i round-trips through the sentinel",
        (code) => {
          const { sentinel, stdout } = launch(
            candidate,
            `sh -c "exit ${String(code)}"`,
          );
          expect({ code: sentinel, stdout }).toEqual({
            code,
            stdout: expect.any(String),
          });
        },
      );

      test("the command actually runs (its output precedes the sentinel)", () => {
        const { sentinel, stdout } = launch(candidate, "echo matrix-ran");
        expect(stdout).toContain("matrix-ran");
        expect(sentinel).toBe(0);
      });

      test("a pipeline reports a sentinel, whether or not pipefail is supported", () => {
        // Shells with pipefail report the failing stage (3); those that reject
        // the option degrade to tail-of-pipe (0). Both are contractual — a
        // missing sentinel is not.
        const { sentinel } = launch(candidate, 'sh -c "exit 3" | cat');
        expect([0, 3]).toContain(sentinel);
      });
    },
  );
});
