import { randomBytes } from "node:crypto";
import { isKnownShell, type ShellDialect } from "../config.js";
import type { TmuxClient } from "../tmux/client.js";
import type { Job } from "../types.js";
import { totalLines } from "./shared.js";

export function makeJobId(): string {
  return `j${randomBytes(3).toString("hex")}`;
}

/**
 * Suffix appended to the launched command. printf's format string contains
 * literal %s/%d, so the *echoed command line* in the pane never contains a
 * digit exit code — the completion regex (which requires digits) can never
 * false-positive on the echo.
 */
export function buildSentinelSuffix(
  jobId: string,
  dialect: ShellDialect,
): string {
  const exitVar = dialect === "fish" ? "$status" : "$?";
  return `; printf '\\n<<SMUX:%s:%d>>\\n' '${jobId}' ${exitVar}`;
}

export function sentinelRegex(jobId: string): RegExp {
  return new RegExp(`<<SMUX:${jobId}:(\\d+)>>`);
}

/** Scan captured lines for the completed sentinel; returns exit code or null. */
export function parseSentinel(lines: string[], jobId: string): number | null {
  const regex = sentinelRegex(jobId);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = regex.exec(lines[i] ?? "");
    if (match?.[1] !== undefined) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}

/** Remove completed sentinel lines from output shown to the agent. */
export function stripSentinel(lines: string[], jobId: string): string[] {
  const regex = sentinelRegex(jobId);
  return lines.filter((line) => !regex.test(line));
}

/**
 * Matches any *completed* sentinel line (has a digit exit code — never the
 * echo). Job-id length is matched with `+` rather than a fixed count so the
 * filter keeps working if makeJobId ever changes width.
 */
export const ANY_SENTINEL = /<<SMUX:j[0-9a-f]+:\d+>>/;

/**
 * The literal marker present in BOTH the echoed launch line (the printf holds
 * `<<SMUX:%s:%d>>`) and every completed sentinel — but never in real command
 * output. Used to keep sidemux plumbing out of pattern matches so a wait
 * pattern that is a substring of the launched command can't false-match the echo.
 */
export const SENTINEL_MARKER = "<<SMUX:";

/**
 * Matches the sentinel suffix as it appears in the *echoed* command line.
 * Whitespace-tolerant: a fancy prompt (fish/zsh with reflow) can widen the
 * gaps in the echoed line, so we do not require exact single spaces. Consumes
 * from the leading `;` through any trailing whitespace so the user's command
 * is left clean.
 */
const SENTINEL_ECHO =
  /\s*;\s*printf\s+'\\n<<SMUX:%s:%d>>\\n'\s+'j[0-9a-f]+'\s+\$(?:\?|status)\s*/g;

/**
 * Last-resort scrub: if the private marker still survives on a line (a shell
 * whose echo we could not match exactly), drop from the sentinel's printf — or
 * the bare marker — to end of line. `<<SMUX:` is sidemux plumbing and never
 * appears in legitimate command output.
 */
const SENTINEL_RESIDUE = /\s*;?\s*printf[^\n]*<<SMUX:[^\n]*$|<<SMUX:[^\n]*$/;

/**
 * Clean job output for the agent: drop completed sentinel lines and scrub the
 * sentinel suffix out of the echoed command line — both are sidemux plumbing,
 * not command output. Every code path that returns pane text to the agent must
 * pass through here (run/wait/read tails all do).
 */
export function scrubOutput(lines: string[]): string[] {
  return lines
    .filter((line) => !ANY_SENTINEL.test(line))
    .map((line) =>
      line.replace(SENTINEL_ECHO, "").replace(SENTINEL_RESIDUE, ""),
    );
}

/** Finished jobs retained for late read/wait lookups before pruning. */
const MAX_FINISHED_JOBS = 100;

export class JobManager {
  private readonly jobs = new Map<string, Job>();

  constructor(private readonly client: TmuxClient) {}

  /**
   * Drop the oldest finished jobs beyond MAX_FINISHED_JOBS so the registry
   * (and findByPane's linear scan) stays bounded in a long-lived server.
   * Running jobs are never pruned.
   */
  private prune(): void {
    const finished = [...this.jobs.values()]
      .filter((job) => job.status !== "running")
      .sort((a, b) => a.startedAt - b.startedAt);
    for (const job of finished.slice(
      0,
      Math.max(0, finished.length - MAX_FINISHED_JOBS),
    )) {
      this.jobs.delete(job.jobId);
    }
  }

  get(jobId: string): Job | undefined {
    return this.jobs.get(jobId);
  }

  /** Most recently launched job for a pane. */
  findByPane(paneId: string): Job | undefined {
    let latest: Job | undefined;
    for (const job of this.jobs.values()) {
      if (
        job.paneId === paneId &&
        (!latest || job.startedAt >= latest.startedAt)
      ) {
        latest = job;
      }
    }
    return latest;
  }

  /**
   * Type the command into the pane with the exit-code sentinel appended and
   * press Enter. Records the pane's absolute line count first, so reads can
   * be scoped to exactly this job's output.
   */
  async launch(
    paneId: string,
    command: string,
    forcedDialect: ShellDialect | null,
  ): Promise<Job> {
    const state = await this.client.paneState(paneId);
    const dialect =
      forcedDialect ??
      (state.currentCommand.includes("fish") ? "fish" : "posix");
    if (!isKnownShell(state.currentCommand)) {
      // Not fatal — the pane may be a wrapper — but posix is the safe default.
    }

    const jobId = makeJobId();
    const job: Job = {
      jobId,
      paneId,
      command,
      startedAt: Date.now(),
      baselineLines: totalLines(state),
      status: "running",
      exitCode: null,
    };

    await this.client.sendLiteral(
      paneId,
      command + buildSentinelSuffix(jobId, dialect),
    );
    await this.client.sendKeys(paneId, ["Enter"]);

    this.jobs.set(jobId, job);
    this.prune();
    return job;
  }

  /**
   * Mark a job as interrupted. Ctrl-C aborts the shell's entire command
   * list, including the `; printf` sentinel — so no exit code ever appears
   * in the pane. 130 (128+SIGINT) is synthesized to match shell convention.
   */
  markInterrupted(job: Job): Job {
    if (job.status === "running") {
      job.status = "failed";
      job.exitCode = 130;
    }
    return job;
  }

  /** Update job state from freshly captured pane lines. */
  applyScan(job: Job, lines: string[]): Job {
    if (job.status !== "running") {
      return job;
    }
    const exitCode = parseSentinel(lines, job.jobId);
    if (exitCode !== null) {
      job.exitCode = exitCode;
      job.status = exitCode === 0 ? "done" : "failed";
    }
    return job;
  }
}
