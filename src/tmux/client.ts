import type { PaneInfo, PaneState, WindowInfo } from '../types.js';
import { TmuxError, type TmuxRunner } from './exec.js';
import {
  LIST_PANES_FORMAT,
  LIST_WINDOWS_FORMAT,
  PANE_STATE_FORMAT,
  parsePaneList,
  parsePaneState,
  parseWindowList,
} from './formats.js';

/** Direction a split opens toward, relative to the target pane. */
export type SplitDirection = 'right' | 'left' | 'top' | 'bottom';

/**
 * Environment every sidemux-created pane starts with (tmux `-e`, ≥3.2 —
 * already sidemux's floor for display-popup). NX_TUI=false keeps Nx's
 * interactive terminal UI from opening in a pane: it never exits on its own,
 * so the job's sentinel would never print and the run would hang as
 * "running" forever.
 */
export const PANE_ENVIRONMENT: readonly string[] = ['NX_TUI=false'];

function paneEnvArgs(): string[] {
  return PANE_ENVIRONMENT.flatMap((assignment) => ['-e', assignment]);
}

/** One option assignment in a batched write; null value = unset the option. */
export interface OptionWrite {
  name: string;
  value: string | null;
}

/** Shared "the tmux server is not running" detector for list commands. */
export function isNoServerError(error: unknown): boolean {
  return (
    error instanceof TmuxError &&
    /no server running|error connecting|can't find session/.test(error.stderr)
  );
}

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
      if (found) {return found.paneId;}
      throw new Error(`no such pane: ${target}`);
    }
    const exact = panes.find((p) => p.target === target);
    if (exact) {return exact.paneId;}
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
    if (start !== undefined) {args.push('-S', String(start));}
    if (end !== undefined) {args.push('-E', String(end));}
    const out = await this.run(args);
    // capture-pane output ends with a newline; drop only that terminator.
    const lines = out.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {lines.pop();}
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
    let out: string;
    try {
      out = await this.run(['list-panes', '-a', '-F', LIST_PANES_FORMAT]);
    } catch (error) {
      // No tmux server running yet → no panes. Any other failure re-throws.
      if (isNoServerError(error)) {return [];}
      throw error;
    }
    return parsePaneList(out);
  }

  async listWindows(sessionName?: string): Promise<WindowInfo[]> {
    const args = ['list-windows', '-F', LIST_WINDOWS_FORMAT];
    if (sessionName) {args.push('-t', `=${sessionName}`);}
    try {
      return parseWindowList(await this.run(args));
    } catch (error) {
      if (isNoServerError(error)) {return [];}
      throw error;
    }
  }

  /**
   * Split a new pane off the target (or the client's active pane) in the given
   * direction, always anchored to an explicit cwd — never tmux's default-path.
   * right/left → horizontal split (-h); top/bottom → vertical split (-v); the
   * "before" side (left/top) adds -b. bottom is tmux's own default.
   */
  async splitWindow(
    cwd: string,
    targetPane?: string,
    size = '30%',
    shellCommand?: string,
    direction: SplitDirection = 'bottom',
  ): Promise<string> {
    const args = ['split-window', '-d', '-P', '-F', '#{pane_id}', '-l', size, '-c', cwd, ...paneEnvArgs()];
    args.push(direction === 'right' || direction === 'left' ? '-h' : '-v');
    if (direction === 'left' || direction === 'top') {args.push('-b');}
    if (targetPane) {args.push('-t', targetPane);}
    if (shellCommand) {args.push(shellCommand);}
    const out = await this.run(args);
    return out.trim();
  }

  /** Create a detached session; returns the pane id of its first pane. */
  async newSession(
    sessionName: string,
    cwd: string,
    shellCommand?: string,
    windowName?: string,
  ): Promise<string> {
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
      ...paneEnvArgs(),
    ];
    if (windowName) {args.splice(7, 0, '-n', windowName);}
    if (shellCommand) {args.push(shellCommand);}
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
    const args = ['new-window', '-d', '-P', '-F', '#{pane_id}', ...paneEnvArgs()];
    if (windowName) {args.push('-n', windowName);}
    args.push('-t', sessionName, '-c', cwd);
    if (shellCommand) {args.push(shellCommand);}
    const out = await this.run(args);
    return out.trim();
  }

  /**
   * Split inside an existing window, targeting that window's active pane.
   * When the window is too crowded for another split, re-tile it (evening out
   * all panes) and retry once — strict pane affinity means an agent window can
   * legitimately hold many panes.
   */
  async splitWindowInWindow(
    sessionName: string,
    windowIndex: string,
    cwd: string,
    shellCommand?: string,
  ): Promise<string> {
    const target = `${sessionName}:${windowIndex}`;
    try {
      return await this.splitWindow(cwd, target, '50%', shellCommand, 'right');
    } catch (error) {
      if (!(error instanceof TmuxError) || !error.stderr.includes('no space for a new pane')) {
        throw error;
      }
      await this.selectLayout(target, 'tiled');
      return this.splitWindow(cwd, target, '50%', shellCommand, 'right');
    }
  }

  /** Apply a preset layout (e.g. "tiled") to a window. */
  async selectLayout(target: string, layout: string): Promise<void> {
    await this.run(['select-layout', '-t', target, layout]);
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

  async unsetPaneOption(paneId: string, name: string): Promise<void> {
    await this.run(['set-option', '-p', '-u', '-t', paneId, name]);
  }

  /**
   * Set a pane's title and a batch of pane options in ONE tmux invocation
   * (`;`-separated subcommands), instead of one subprocess per option. A null
   * value unsets that option.
   */
  async updatePane(paneId: string, title: string, options: OptionWrite[]): Promise<void> {
    const args = ['select-pane', '-t', paneId, '-T', title];
    for (const option of options) {
      args.push(';', 'set-option', '-p');
      if (option.value === null) {args.push('-u');}
      args.push('-t', paneId, option.name);
      if (option.value !== null) {args.push(option.value);}
    }
    await this.run(args);
  }

  /** Set several window-scoped options in one tmux invocation. */
  async setWindowOptions(window: string, options: OptionWrite[]): Promise<void> {
    const args: string[] = [];
    for (const option of options) {
      if (args.length > 0) {args.push(';');}
      args.push('set-option', '-w');
      if (option.value === null) {args.push('-u');}
      args.push('-t', window, option.name);
      if (option.value !== null) {args.push(option.value);}
    }
    await this.run(args);
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

  async renameWindow(window: string, name: string): Promise<void> {
    await this.run(['rename-window', '-t', window, '--', name]);
  }

  async switchClient(target: string): Promise<void> {
    await this.run(['switch-client', '-t', target]);
  }

  /** Focus a pane within its window. */
  async selectPane(paneId: string): Promise<void> {
    await this.run(['select-pane', '-t', paneId]);
  }

  /** Toggle tmux zoom on a pane (fullscreen within its window). */
  async zoomPane(paneId: string): Promise<void> {
    await this.run(['resize-pane', '-Z', '-t', paneId]);
  }

  async bindKey(args: string[]): Promise<void> {
    await this.run(['bind-key', ...args]);
  }

  /** Clear a window-scoped option so it falls back to the global/default value. */
  async unsetWindowOption(window: string, name: string): Promise<void> {
    await this.run(['set-option', '-w', '-u', '-t', window, name]);
  }

  async killPane(paneId: string): Promise<void> {
    await this.run(['kill-pane', '-t', paneId]);
  }

  async killWindow(window: string): Promise<void> {
    await this.run(['kill-window', '-t', window]);
  }
}
