import { createHash } from 'node:crypto';
import type { TmuxClient } from '../tmux/client.js';
import { clampCaptureStart, totalLines } from './shared.js';

interface CursorState {
  /** Absolute line count (history_size + cursor_y + 1) at last read. */
  totalLines: number;
  /** Hash of the ≤3 lines immediately before the cursor, for drift detection. */
  anchorHash: string;
}

export interface IncrementalRead {
  lines: string[];
  /**
   * True when continuity broke (first read, scrollback rotation past
   * history-limit, `clear`, alternate-screen app) and `lines` is a tail
   * snapshot rather than strictly-new output.
   */
  cursorReset: boolean;
  totalLines: number;
}

const ANCHOR_SPAN = 3;

function hashLines(lines: string[]): string {
  return createHash('sha1').update(lines.join('\n')).digest('hex');
}

/**
 * Tracks a per-pane read cursor in absolute line coordinates so `read`
 * returns only output the agent has not seen yet.
 *
 * Coordinate system: tmux capture-pane coordinate 0 is the first visible
 * line; negatives reach into history. Absolute line i (0-based from the
 * start of retained scrollback) maps to capture coordinate i - history_size.
 * Absolute numbering silently shifts once scrollback rotates past
 * history-limit — the anchor hash detects that and degrades to a tail read.
 */
export class CursorTracker {
  private readonly cursors = new Map<string, CursorState>();

  forget(paneId: string): void {
    this.cursors.delete(paneId);
  }

  /**
   * Read new lines since the stored cursor (or a tail snapshot on reset)
   * and advance the cursor to the current end of output.
   */
  async read(
    client: TmuxClient,
    paneId: string,
    fallbackTailLines = 100,
  ): Promise<IncrementalRead> {
    const state = await client.paneState(paneId);
    const currentTotal = totalLines(state);
    const stored = this.cursors.get(paneId);

    const resetRead = async (): Promise<IncrementalRead> => {
      const start = clampCaptureStart(state, state.cursorY - fallbackTailLines + 1);
      const lines = await client.capturePane(paneId, start, state.cursorY);
      await this.advance(client, paneId, state.historySize, state.cursorY);
      return { lines, cursorReset: true, totalLines: currentTotal };
    };

    if (!stored) {return resetRead();}

    // Screen cleared or history vanished: absolute count went backwards.
    if (currentTotal < stored.totalLines) {return resetRead();}

    // Validate the anchor: the lines just before the old cursor must match
    // what we hashed last time, otherwise scrollback rotated underneath our
    // numbering. The last line itself is excluded from the anchor — it is
    // the shell prompt, and the next typed command mutates it in place.
    const anchorEndAbs = stored.totalLines - 2;
    const anchorStartAbs = Math.max(0, stored.totalLines - 1 - ANCHOR_SPAN);
    if (anchorEndAbs >= anchorStartAbs) {
      const anchorLines = await client.capturePane(
        paneId,
        anchorStartAbs - state.historySize,
        anchorEndAbs - state.historySize,
      );
      if (hashLines(anchorLines) !== stored.anchorHash) {return resetRead();}
    }

    if (currentTotal === stored.totalLines) {
      return { lines: [], cursorReset: false, totalLines: currentTotal };
    }

    // Re-capture from the old prompt line (inclusive): it now holds the
    // echoed command, which is context the agent should see once.
    const lines = await client.capturePane(
      paneId,
      clampCaptureStart(state, stored.totalLines - 1 - state.historySize),
      state.cursorY,
    );
    await this.advance(client, paneId, state.historySize, state.cursorY);
    return { lines, cursorReset: false, totalLines: currentTotal };
  }

  /** Point the cursor at the current end of output without consuming lines. */
  async markRead(client: TmuxClient, paneId: string): Promise<void> {
    const state = await client.paneState(paneId);
    await this.advance(client, paneId, state.historySize, state.cursorY);
  }

  private async advance(
    client: TmuxClient,
    paneId: string,
    historySize: number,
    cursorY: number,
  ): Promise<void> {
    const total = totalLines({ historySize, cursorY });
    // Anchor = up to ANCHOR_SPAN lines ending just BEFORE the cursor line;
    // the cursor line is the live prompt and mutates when a command is typed.
    const anchorEndAbs = total - 2;
    const anchorStartAbs = Math.max(0, total - 1 - ANCHOR_SPAN);
    const anchorLines =
      anchorEndAbs >= anchorStartAbs
        ? await client.capturePane(
            paneId,
            anchorStartAbs - historySize,
            anchorEndAbs - historySize,
          )
        : [];
    this.cursors.set(paneId, {
      totalLines: total,
      anchorHash: hashLines(anchorLines),
    });
  }
}
