import { execFile } from 'node:child_process';

const MAX_BUFFER = 10 * 1024 * 1024;

export class TmuxError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'TmuxError';
  }
}

/** Runs a single tmux subcommand and resolves with its stdout. */
export type TmuxRunner = (args: string[]) => Promise<string>;

export interface RunnerOptions {
  /** tmux -L socket name; isolates test servers from the user's real tmux. */
  socketName?: string | null;
  /** tmux -f config file; /dev/null in tests so user config never leaks in. */
  configFile?: string | null;
}

export function createTmuxRunner(options: RunnerOptions = {}): TmuxRunner {
  const prefix: string[] = [];
  if (options.socketName) {prefix.push('-L', options.socketName);}
  if (options.configFile) {prefix.push('-f', options.configFile);}

  return (args) =>
    new Promise((resolve, reject) => {
      const fullArgs = [...prefix, ...args];
      execFile('tmux', fullArgs, { maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
        if (error) {
          const enoent = (error as NodeJS.ErrnoException).code === 'ENOENT';
          const message = enoent
            ? 'tmux is not installed or not on PATH — install tmux to use sidemux'
            : `tmux ${args[0] ?? ''} failed: ${stderr.trim() || error.message}`;
          reject(new TmuxError(message, fullArgs, stderr));
          return;
        }
        resolve(stdout);
      });
    });
}
