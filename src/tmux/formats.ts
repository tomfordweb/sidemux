import type {
  ManagedPaneClass,
  PaneInfo,
  PaneState,
  WindowInfo,
} from "../types.js";

/** Title prefix marking panes created by sidemux. */
export const MANAGED_TITLE_PREFIX = "smux:";
export const MANAGED_OPTION = "@smux_managed";
export const NAME_OPTION = "@smux_name";
export const LAST_COMMAND_OPTION = "@smux_last_command";
export const BUSY_OPTION = "@smux_busy";
export const CLASS_OPTION = "@smux_class";
export const LAST_USED_AT_OPTION = "@smux_last_used_at";
export const LAST_EXIT_CODE_OPTION = "@smux_last_exit_code";
export const AGENT_ID_OPTION = "@smux_agent_id";
export const SERVER_PID_OPTION = "@smux_server_pid";
export const LAST_SEEN_AT_OPTION = "@smux_last_seen_at";
/** Agent-supplied context for the pane's current run ("<stage> due to <reason>"). */
export const DESCRIPTION_OPTION = "@smux_description";
/** Window option holding the owning server's encoded token-savings stats. */
export const STATS_OPTION = "@smux_stats";

/**
 * Pane user-option holding a sidemux pane's border-header label. pane_title is
 * owned by the pane's own program — a shell that emits an OSC title escape on
 * every prompt (most zsh/bash setups) overwrites it with the cwd — so the
 * header can't key on the title. This option is sidemux's alone and survives
 * any renaming prompt.
 */
export const HEADER_LABEL_OPTION = "@smux_label";

const SEP = "\t";

/**
 * User-supplied strings (commands, pane names) round-trip through tmux format
 * expansion and this module's tab/newline-delimited list output. A command
 * containing a tab, newline, or `#{` would corrupt the parse — and silently
 * break pane reuse, which compares the stored command byte-for-byte. Encode
 * such values as base64url with a `b64:` prefix; plain values (and values
 * written by older sidemux versions) pass through untouched.
 */
const ENCODED_PREFIX = "b64:";

export function encodeOptionValue(value: string): string {
  // A bare ";" would read as a subcommand separator in batched tmux calls.
  const needsEncoding =
    /[\t\n\r]|#\{/.test(value) ||
    value === ";" ||
    value.startsWith(ENCODED_PREFIX);
  if (!needsEncoding) {
    return value;
  }
  return `${ENCODED_PREFIX}${Buffer.from(value, "utf8").toString("base64url")}`;
}

export function decodeOptionValue(value: string): string {
  if (!value.startsWith(ENCODED_PREFIX)) {
    return value;
  }
  try {
    return Buffer.from(
      value.slice(ENCODED_PREFIX.length),
      "base64url",
    ).toString("utf8");
  } catch {
    return value;
  }
}

export const PANE_STATE_FORMAT = [
  "#{history_size}",
  "#{history_limit}",
  "#{cursor_y}",
  "#{pane_height}",
  "#{pane_current_command}",
  "#{pane_current_path}",
].join(SEP);

export function parsePaneState(line: string): PaneState {
  const parts = line.replace(/\n$/, "").split(SEP);
  if (parts.length < 6) {
    throw new Error(`unexpected pane state line: ${JSON.stringify(line)}`);
  }
  const field = (index: number): string => parts[index] ?? "";
  return {
    historySize: Number.parseInt(field(0), 10),
    historyLimit: Number.parseInt(field(1), 10),
    cursorY: Number.parseInt(field(2), 10),
    paneHeight: Number.parseInt(field(3), 10),
    currentCommand: field(4),
    // pane_current_path may itself contain tabs in pathological cases; rejoin.
    currentPath: parts.slice(5).join(SEP),
  };
}

export const LIST_PANES_FORMAT = [
  "#{pane_id}",
  "#{session_name}:#{window_index}.#{pane_index}",
  "#{session_name}",
  "#{window_index}",
  "#{window_name}",
  "#{pane_title}",
  "#{pane_current_command}",
  "#{pane_current_path}",
  "#{pane_width}x#{pane_height}",
  "#{window_id}",
  `#{${MANAGED_OPTION}}`,
  `#{${NAME_OPTION}}`,
  `#{${LAST_COMMAND_OPTION}}`,
  `#{${BUSY_OPTION}}`,
  `#{${CLASS_OPTION}}`,
  `#{${LAST_USED_AT_OPTION}}`,
  `#{${LAST_EXIT_CODE_OPTION}}`,
  `#{${AGENT_ID_OPTION}}`,
  `#{${SERVER_PID_OPTION}}`,
  `#{${DESCRIPTION_OPTION}}`,
].join(SEP);

export const LIST_WINDOWS_FORMAT = [
  "#{session_name}",
  "#{window_index}",
  "#{window_id}",
  "#{window_name}",
  "#{pane_id}",
  `#{${AGENT_ID_OPTION}}`,
  `#{${SERVER_PID_OPTION}}`,
  `#{${LAST_SEEN_AT_OPTION}}`,
  `#{${STATS_OPTION}}`,
].join(SEP);

function parseManagedClass(value: string): ManagedPaneClass | null {
  return value === "oneshot" || value === "persistent" ? value : null;
}

function parseNumberOrNull(value: string): number | null {
  if (value === "") {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePaneList(output: string): PaneInfo[] {
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(SEP);
      if (parts.length < 9) {
        throw new Error(`unexpected list-panes line: ${JSON.stringify(line)}`);
      }
      const field = (index: number): string => parts[index] ?? "";
      const [width, height] = field(8)
        .split("x")
        .map((n) => Number.parseInt(n, 10));
      const title = field(5);
      const windowId = parts[9] ?? "";
      const managedOption = parts[10] ?? "";
      const managed =
        managedOption === "1" || title.startsWith(MANAGED_TITLE_PREFIX);
      return {
        paneId: field(0),
        target: field(1),
        sessionName: field(2),
        windowIndex: field(3),
        windowName: field(4),
        title,
        currentCommand: field(6),
        currentPath: field(7),
        width: width ?? 0,
        height: height ?? 0,
        windowId,
        managed,
        managedName: parts[11] ? decodeOptionValue(parts[11]) : null,
        lastCommand: parts[12] ? decodeOptionValue(parts[12]) : null,
        busy: parts[13] === "1",
        paneClass: parseManagedClass(parts[14] ?? ""),
        lastUsedAt: parseNumberOrNull(parts[15] ?? ""),
        lastExitCode: parseNumberOrNull(parts[16] ?? ""),
        agentId: parts[17] || null,
        serverPid: parseNumberOrNull(parts[18] ?? ""),
        description: parts[19] ? decodeOptionValue(parts[19]) : null,
      };
    });
}

export function parseWindowList(output: string): WindowInfo[] {
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(SEP);
      if (parts.length < 5) {
        throw new Error(
          `unexpected list-windows line: ${JSON.stringify(line)}`,
        );
      }
      const field = (index: number): string => parts[index] ?? "";
      return {
        sessionName: field(0),
        windowIndex: field(1),
        windowId: field(2),
        windowName: field(3),
        activePaneId: field(4),
        agentId: parts[5] || null,
        serverPid: parseNumberOrNull(parts[6] ?? ""),
        lastSeenAt: parseNumberOrNull(parts[7] ?? ""),
        statsJson: parts[8] ? decodeOptionValue(parts[8]) : null,
      };
    });
}
