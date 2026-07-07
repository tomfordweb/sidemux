/**
 * Workspace token-savings accounting. Every agent-facing tail response is a
 * data point: the full pane region the agent WOULD have received had it run
 * the command inline via Bash (`ai`), versus the shaped tail sidemux actually
 * returned (`smux`). Grouped per command role (test/lint/build/…) using the
 * same classifier as init detection. Session-only: each server accumulates in
 * memory and mirrors its map into a tmux window option so the dashboard (a
 * separate popup process) can sum across agents.
 */
import { classifyCommandRole, ROLE_ORDER, type CommandRole } from '../init/detect.js';

export interface RoleStat {
  /** Bytes the agent would have consumed inline (full region). */
  ai: number;
  /** Bytes sidemux actually returned (shaped tail). */
  smux: number;
  /** Tail responses counted. */
  responses: number;
}

export type WorkspaceStats = Partial<Record<CommandRole, RoleStat>>;

/** The bench tool's estimator (~4 bytes per token); good enough for a gauge. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export class StatsTracker {
  private readonly stats: WorkspaceStats = {};

  record(command: string, bytesTotal: number, bytesReturned: number): void {
    const role = classifyCommandRole(command);
    const entry = this.stats[role] ?? { ai: 0, smux: 0, responses: 0 };
    entry.ai += bytesTotal;
    entry.smux += bytesReturned;
    entry.responses += 1;
    this.stats[role] = entry;
  }

  /** Compact JSON for the `@smux_stats` window option. */
  encoded(): string {
    return JSON.stringify(this.stats);
  }
}

function isRoleStat(value: unknown): value is RoleStat {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.ai === 'number' &&
    typeof candidate.smux === 'number' &&
    typeof candidate.responses === 'number'
  );
}

/** Parse one window's encoded stats; malformed input reads as empty. */
export function parseStats(encoded: string | null): WorkspaceStats {
  if (!encoded) {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(encoded);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null) {
    return {};
  }
  const stats: WorkspaceStats = {};
  for (const role of ROLE_ORDER) {
    const value = (raw as Record<string, unknown>)[role];
    if (isRoleStat(value)) {
      stats[role] = { ai: value.ai, smux: value.smux, responses: value.responses };
    }
  }
  return stats;
}

/** Sum per-window stats (one encoded value per agent window) into one table. */
export function mergeStats(encodedList: (string | null)[]): WorkspaceStats {
  const merged: WorkspaceStats = {};
  for (const encoded of encodedList) {
    for (const [role, stat] of Object.entries(parseStats(encoded)) as [CommandRole, RoleStat][]) {
      const entry = merged[role] ?? { ai: 0, smux: 0, responses: 0 };
      entry.ai += stat.ai;
      entry.smux += stat.smux;
      entry.responses += stat.responses;
      merged[role] = entry;
    }
  }
  return merged;
}
