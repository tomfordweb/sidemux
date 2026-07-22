import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { sentinelRegex } from "./jobs.js";

/**
 * Per-job output log files.
 *
 * Every job's full output is teed to a file via `tmux pipe-pane` — the pane's
 * raw output stream, so the file is complete even when the pane's
 * history-limit has discarded the start of the output (github#6, github#8).
 * Because pipe-pane taps the stream between the pty and tmux, the launched
 * command is never modified: exit-code sentinel semantics, tty-ness (colors,
 * buffering), and the echo-scrub regexes all stay exactly as they were.
 *
 * The trade-off is that the file holds raw terminal bytes — ANSI colors, CR
 * overwrites (progress bars), OSC title escapes. Agents tailing the file cope
 * fine with that; when sidemux itself serves output from the file (read
 * since="job" after history overflow), it sanitizes first.
 */

/** Log file path for a job id. */
export function jobLogPath(logDir: string, jobId: string): string {
  return join(logDir, `${jobId}.log`);
}

// CSI (colors, cursor movement), OSC (titles, with BEL or ST terminator), and
// remaining single-char ESC sequences, in that order — OSC must go before the
// single-char rule or its leading `]` survives. Control chars are the whole
// point here, hence the eslint exceptions.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// eslint-disable-next-line no-control-regex
const ANSI_OTHER = /\x1b[@-_]/g;

/**
 * Reduce raw terminal output to the text a pane would display: strip escape
 * sequences and apply carriage-return overwrite semantics (a progress bar
 * that redraws with `\r` collapses to its final frame, like on screen).
 */
export function sanitizeTerminalOutput(raw: string): string[] {
  const text = raw
    .replace(ANSI_CSI, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_OTHER, "")
    .replace(/\r\n/g, "\n");
  return text.split("\n").map((line) => {
    const lastCr = line.lastIndexOf("\r");
    return lastCr === -1 ? line : line.slice(lastCr + 1);
  });
}

/**
 * Read a job's log file as display-ready lines. The pipe stays open briefly
 * after the job exits (it closes when completion is next observed), so the
 * tail may hold a prompt or the next command's echo — everything after the
 * job's own sentinel line is cut. Sentinel/echo scrubbing itself is the
 * caller's business (scrubOutput), same as for captured pane lines.
 */
export async function readJobLog(
  logFile: string,
  jobId: string,
): Promise<string[]> {
  const lines = sanitizeTerminalOutput(await readFile(logFile, "utf8"));
  const regex = sentinelRegex(jobId);
  const sentinelAt = lines.findIndex((line) => regex.test(line));
  return sentinelAt === -1 ? lines : lines.slice(0, sentinelAt + 1);
}

/** Logs older than this are deleted opportunistically at server startup. */
export const LOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Delete stale job logs. Best-effort by design (races with other sidemux
 * servers sharing the dir are harmless — losing a delete just retries next
 * startup); callers fire-and-forget.
 */
export async function pruneOldLogs(
  logDir: string,
  maxAgeMs: number = LOG_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return; // dir not created yet — nothing to prune
  }
  for (const entry of entries) {
    if (!/^j[0-9a-f]+\.log$/.test(entry)) {
      continue;
    }
    const path = join(logDir, entry);
    try {
      if (now - (await stat(path)).mtimeMs > maxAgeMs) {
        await unlink(path);
      }
    } catch {
      // deleted concurrently or unreadable — skip
    }
  }
}
