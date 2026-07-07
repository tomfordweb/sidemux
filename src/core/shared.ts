import type { PaneState } from "../types.js";

/** Quote a string for a POSIX shell (single quotes, embedded quotes escaped). */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Human-readable message from any thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Absolute line count of a pane: scrollback plus cursor row (1-based). */
export function totalLines(
  state: Pick<PaneState, "historySize" | "cursorY">,
): number {
  return state.historySize + state.cursorY + 1;
}

/**
 * Clamp a capture-pane start coordinate so it never reaches past the top of
 * the pane's scrollback (tmux treats deeper negatives as "from the top", which
 * would silently return more history than asked for).
 */
export function clampCaptureStart(
  state: Pick<PaneState, "historySize">,
  start: number,
): number {
  return Math.max(-state.historySize, start);
}
