import { spawn } from 'node:child_process';

export type WatcherEvent =
  | { type: 'output'; paneId: string }
  | { type: 'topology' }
  | { type: 'died' };

export interface ControlWatcher {
  kill(): void;
}

export interface WatcherOptions {
  socketName?: string | null;
}

const TOPOLOGY = new Set([
  '%window-add',
  '%window-close',
  '%window-renamed',
  '%window-pane-changed',
  '%unlinked-window-add',
  '%unlinked-window-close',
  '%unlinked-window-renamed',
  '%layout-change',
  '%pane-mode-changed',
  '%session-changed',
  '%session-window-changed',
  '%sessions-changed',
]);

/**
 * Maps one control-mode notification line to a watcher event; null = ignored.
 * Payload is never decoded — lines are only a change signal for the dashboard.
 */
export function classifyControlLine(line: string): { type: 'output'; paneId: string } | { type: 'topology' } | null {
  if (!line.startsWith('%')) {return null;}
  const [word, second] = line.split(' ', 2);
  if (word === '%output' || word === '%extended-output') {
    return second?.startsWith('%') ? { type: 'output', paneId: second } : null;
  }
  return word !== undefined && TOPOLOGY.has(word) ? { type: 'topology' } : null;
}

/**
 * Attaches a tmux control-mode client (`tmux -C attach`) to the workspace
 * session and forwards change notifications. read-only + ignore-size keep the
 * hidden client from resizing windows or accepting input; stdin stays open
 * (but unused) because control mode detaches on stdin EOF.
 */
export function spawnControlWatcher(
  sessionName: string,
  onEvent: (event: WatcherEvent) => void,
  options: WatcherOptions = {},
): ControlWatcher {
  const args = [
    ...(options.socketName ? ['-L', options.socketName] : []),
    '-C',
    'attach-session',
    '-t',
    `=${sessionName}`,
    '-f',
    'read-only,ignore-size',
  ];
  const child = spawn('tmux', args, { stdio: ['pipe', 'pipe', 'ignore'] });
  let killed = false;
  let died = false;
  const reportDied = (): void => {
    if (!killed && !died) {
      died = true;
      onEvent({ type: 'died' });
    }
  };
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = classifyControlLine(line);
      if (event) {onEvent(event);}
    }
  });
  child.on('error', reportDied);
  child.on('exit', reportDied);
  return {
    kill(): void {
      killed = true;
      child.kill('SIGTERM');
    },
  };
}
