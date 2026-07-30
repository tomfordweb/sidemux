import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Config } from "./config.js";
import { jobLogPath, sanitizeTerminalOutput } from "./core/logs.js";

/**
 * `sidemux log <job_id|path>` — print a job's log as display-ready text
 * (github#36). The raw file keeps every terminal byte: ANSI colors, OSC
 * titles, and one spinner frame per repaint, which makes direct grep useless
 * on a failed job. This renders CR-overwrites the way a pane would (a spinner
 * collapses to its final frame) and strips escapes, so grep works.
 */
export async function runLogCommand(
  argv: string[],
  config: Config,
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
): Promise<number> {
  const target = argv[0];
  if (!target) {
    stderr.write(
      "usage: sidemux log <job_id|log-file>\n" +
        "Prints the job's output log with terminal escapes stripped and \\r\n" +
        "overwrites collapsed, so it greps like plain text.\n",
    );
    return 2;
  }
  let path = target;
  if (!isAbsolute(target) && !target.includes("/")) {
    if (config.logDir === null) {
      stderr.write("sidemux log: no log directory configured\n");
      return 1;
    }
    path = jobLogPath(config.logDir, target.replace(/\.log$/, ""));
  }
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    stderr.write(`sidemux log: cannot read ${path}\n`);
    return 1;
  }
  stdout.write(`${sanitizeTerminalOutput(raw).join("\n")}\n`);
  return 0;
}
