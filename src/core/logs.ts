import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_LOG_MAX_AGE_MS,
  DEFAULT_LOG_MAX_TOTAL_BYTES,
} from "../config.js";
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

// Escape-sequence families, applied in order: CSI (colors, cursor movement),
// OSC (titles, with BEL or ST terminator), string sequences carrying a payload
// (DCS/SOS/PM/APC, also ST-terminated), charset designators + keypad-mode
// toggles (`\x1b(B`, `\x1b=` — common in prompt/less output), and finally any
// remaining single-char ESC sequence — the string forms must go first or their
// leading byte survives. Control chars are the whole point here, hence the
// eslint exceptions.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
// eslint-disable-next-line no-control-regex
const ANSI_STRING = /\x1b[PX^_][^\x1b\x07]*(?:\x07|\x1b\\)?/g;
// eslint-disable-next-line no-control-regex
const ANSI_CHARSET = /\x1b[()*+/][0-9A-Za-z]|\x1b[=><]/g;
// eslint-disable-next-line no-control-regex
const ANSI_OTHER = /\x1b[@-_]/g;

/** Strip terminal escape sequences from a single already-split line. */
export function stripAnsi(line: string): string {
  return line
    .replace(ANSI_CSI, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_STRING, "")
    .replace(ANSI_CHARSET, "")
    .replace(ANSI_OTHER, "");
}

/**
 * Reduce raw terminal output to the text a pane would display: strip escape
 * sequences and apply carriage-return overwrite semantics (a progress bar
 * that redraws with `\r` collapses to its final frame, like on screen).
 */
export function sanitizeTerminalOutput(raw: string): string[] {
  const text = raw
    .replace(ANSI_CSI, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_STRING, "")
    .replace(ANSI_CHARSET, "")
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

/** Retention limits for the log directory; 0 disables that limit. */
export interface PruneOptions {
  /** Logs older than this are deleted. */
  maxAgeMs?: number;
  /** Byte budget for the whole directory; oldest logs go first. */
  maxTotalBytes?: number;
  /** Injected clock, for tests. */
  now?: number;
}

const LOG_FILE_NAME = /^j[0-9a-f]+\.log$/;

/**
 * Delete stale job logs, by age and then by total size. Age alone cannot
 * bound the directory — one job printing a gigabyte inside the retention
 * window would sit there for a week — so whatever survives the age pass is
 * evicted oldest-first until the byte budget is met.
 *
 * Best-effort by design (races with other sidemux servers sharing the dir are
 * harmless — losing a delete just retries next startup); callers
 * fire-and-forget.
 */
export async function pruneOldLogs(
  logDir: string,
  options: PruneOptions = {},
): Promise<void> {
  const {
    maxAgeMs = DEFAULT_LOG_MAX_AGE_MS,
    maxTotalBytes = DEFAULT_LOG_MAX_TOTAL_BYTES,
    now = Date.now(),
  } = options;

  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return; // dir not created yet — nothing to prune
  }

  const kept: { path: string; mtimeMs: number; size: number }[] = [];
  let total = 0;
  for (const entry of entries) {
    if (!LOG_FILE_NAME.test(entry)) {
      continue;
    }
    const path = join(logDir, entry);
    try {
      const info = await stat(path);
      if (maxAgeMs > 0 && now - info.mtimeMs > maxAgeMs) {
        await unlink(path);
        continue;
      }
      kept.push({ path, mtimeMs: info.mtimeMs, size: info.size });
      total += info.size;
    } catch {
      // deleted concurrently or unreadable — skip
    }
  }

  if (maxTotalBytes <= 0 || total <= maxTotalBytes) {
    return;
  }
  kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const log of kept) {
    if (total <= maxTotalBytes) {
      return;
    }
    try {
      await unlink(log.path);
      total -= log.size;
    } catch {
      // already gone — its bytes are still counted, so the next pass retries
    }
  }
}
