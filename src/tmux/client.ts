import type { PaneLayout } from '../config.js';
import type { PaneInfo, PaneState } from '../types.js';
import type { TmuxRunner } from './exec.js';
import {
  LIST_PANES_FORMAT,
  PANE_STATE_FORMAT,
  parsePaneList,
  parsePaneState,
} from './formats.js';

/**
 * Thin, injectable wrapper over tmux subcommands. Every method maps to a
 * single tmux invocation; higher-level behavior (jobs, cursors, waits) lives
 * in core/.
 */
export class TmuxClient {
  constructor(private readonly run: TmuxRunner) {}

  /**
   * Resolve a target (pane id or session:win.pane) to a canonical %id.
   * Strict: cross-checked against list-panes, because tmux display-message
   * silently falls back to the active pane on unknown targets and returns
   * empty output for dead pane ids — either would misroute send-keys.
   */
  async resolveTarget(target: string): Promise<string> {
    const panes = await this.listPanes();
    if (/^%\d+$/.test(target)) {
      const found = panes.find((p) => p.paneId === target);
      if (found) return found.paneId;
      throw new Error(`no such pane: ${target}`);
    }
    const exact = panes.find((p) => p.target === target);
    if (exact) return exact.paneId;
    throw new Error(
      `cannot resolve pane target: ${target} (use %id or session:window.pane)`,
    );
  }

  async paneExists(target: string): Promise<boolean> {
    try {
      await this.resolveTarget(target);
      return true;
    } catch {
      return false;
    }
  }

  async paneState(paneId: string): Promise<PaneState> {
    const out = await this.run(['display-message', '-p', '-t', paneId, PANE_STATE_FORMAT]);
    return parsePaneState(out);
  }

  async panePath(paneId: string): Promise<string> {
    const out = await this.run(['display-message', '-p', '-t', paneId, '#{pane_current_path}']);
    return out.trim();
  }

  /**
   * Capture pane text. Coordinates: 0 = first visible line, negatives reach
   * into history. Omitted start/end = visible screen only. -J joins wrapped
   * lines so cursor math sees logical lines.
   */
  async capturePane(paneId: string, start?: number, end?: number): Promise<string[]> {
    const args = ['capture-pane', '-p', '-J', '-t', paneId];
    if (start !== undefined) args.push('-S', String(start));
    if (end !== undefined) args.push('-E', String(end));
    const out = await this.run(args);
    // capture-pane output ends with a newline; drop only that terminator.
    const lines = out.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** Send literal text (no key-name interpretation). */
  async sendLiteral(paneId: string, text: string): Promise<void> {
    await this.run(['send-keys', '-t', paneId, '-l', '--', text]);
  }

  /** Send named keys: "Enter", "C-c", "Up", "Escape", ... */
  async sendKeys(paneId: string, keys: string[]): Promise<void> {
    await this.run(['send-keys', '-t', paneId, '--', ...keys]);
  }

  async listPanes(): Promise<PaneInfo[]> {
    const out = await this.run(['list-panes', '-a', '-F', LIST_PANES_FORMAT]);
    return parsePaneList(out);
  }

  /**
   * Split a new pane off the target (or the client's active pane) in the given
   * direction, always anchored to an explicit cwd — never tmux's default-path.
   * right/left → horizontal split (-h); top/bottom → vertical split (-v); the
   * "before" side (left/top) adds -b. bottom is tmux's own default.
   *
   * With `full`, adds -f ("full window size") so the split spans the entire
   * window instead of just the target pane: -f -v = a full-width strip on the
   * top/bottom edge, -f -h = a full-height strip on the left/right edge. This
   * is how the layout bar spans the window regardless of other splits; the
   * -l size then applies to the whole window dimension (e.g. -f -v -l 30% =
   * a full-width strip 30% of the window height).
   */
  async splitWindow(
    cwd: string,
    targetPane?: string,
    size = '30%',
    shellCommand?: string,
    direction: PaneLayout = 'bottom',
    full = false,
  ): Promise<string> {
    const args = ['split-window', '-d', '-P', '-F', '#{pane_id}', '-l', size, '-c', cwd];
    args.push(direction === 'right' || direction === 'left' ? '-h' : '-v');
    if (direction === 'left' || direction === 'top') args.push('-b');
    if (full) args.push('-f');
    if (targetPane) args.push('-t', targetPane);
    if (shellCommand) args.push(shellCommand);
    const out = await this.run(args);
    return out.trim();
  }

  /** Create a detached session; returns the pane id of its first pane. */
  async newSession(sessionName: string, cwd: string, shellCommand?: string): Promise<string> {
    const args = [
      'new-session',
      '-d',
      '-P',
      '-F',
      '#{pane_id}',
      '-s',
      sessionName,
      '-x',
      '200',
      '-y',
      '50',
      '-c',
      cwd,
    ];
    if (shellCommand) args.push(shellCommand);
    const out = await this.run(args);
    return out.trim();
  }

  /** Create a new window in an existing session; returns its pane id. */
  async newWindow(
    sessionName: string,
    cwd: string,
    shellCommand?: string,
    windowName?: string,
  ): Promise<string> {
    const args = ['new-window', '-d', '-P', '-F', '#{pane_id}'];
    if (windowName) args.push('-n', windowName);
    args.push('-t', sessionName, '-c', cwd);
    if (shellCommand) args.push(shellCommand);
    const out = await this.run(args);
    return out.trim();
  }

  /**
   * The session of an attached client, or null if none is attached. Lets
   * sidemux surface its work in the human's session even when the launching
   * client stripped TMUX/TMUX_PANE (so it can't split off the agent's pane).
   * The most-recently-active client wins when several are attached.
   */
  async attachedSession(): Promise<string | null> {
    let out: string;
    try {
      out = await this.run(['list-clients', '-F', '#{client_activity}\t#{client_session}']);
    } catch {
      return null; // no server / no clients
    }
    let best: { activity: number; session: string } | null = null;
    for (const line of out.split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const session = line.slice(tab + 1);
      if (!session) continue;
      const activity = Number.parseInt(line.slice(0, tab), 10);
      const normalized = Number.isFinite(activity) ? activity : 0;
      if (!best || normalized >= best.activity) best = { activity: normalized, session };
    }
    return best?.session ?? null;
  }

  async hasSession(sessionName: string): Promise<boolean> {
    try {
      await this.run(['has-session', '-t', `=${sessionName}`]);
      return true;
    } catch {
      return false;
    }
  }

  async setPaneTitle(paneId: string, title: string): Promise<void> {
    await this.run(['select-pane', '-t', paneId, '-T', title]);
  }

  /**
   * Set a pane-scoped option (tmux `set -p`) — used for sidemux's own `@smux_*`
   * markers. Unlike pane_title, which the pane's shell overwrites via OSC title
   * escapes, a user option is sidemux's alone and survives a renaming prompt.
   */
  async setPaneOption(paneId: string, name: string, value: string): Promise<void> {
    await this.run(['set-option', '-p', '-t', paneId, name, value]);
  }

  /** The window id (`@n`) containing a pane. */
  async paneWindow(paneId: string): Promise<string> {
    const out = await this.run(['display-message', '-p', '-t', paneId, '#{window_id}']);
    return out.trim();
  }

  /** Set a window-scoped option (tmux `set -w`). */
  async setWindowOption(window: string, name: string, value: string): Promise<void> {
    await this.run(['set-option', '-w', '-t', window, name, value]);
  }

  /** Clear a window-scoped option so it falls back to the global/default value. */
  async unsetWindowOption(window: string, name: string): Promise<void> {
    await this.run(['set-option', '-w', '-u', '-t', window, name]);
  }

  async killPane(paneId: string): Promise<void> {
    await this.run(['kill-pane', '-t', paneId]);
  }
}
