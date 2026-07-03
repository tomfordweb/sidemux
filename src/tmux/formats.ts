import type { PaneInfo, PaneState } from '../types.js';

/** Title prefix marking panes created by sidemux. */
export const MANAGED_TITLE_PREFIX = 'smux:';

/**
 * Pane user-option holding a sidemux pane's border-header label. pane_title is
 * owned by the pane's own program — a shell that emits an OSC title escape on
 * every prompt (most zsh/bash setups) overwrites it with the cwd — so the
 * header can't key on the title. This option is sidemux's alone and survives
 * any renaming prompt.
 */
export const HEADER_LABEL_OPTION = '@smux_label';

const SEP = '\t';

export const PANE_STATE_FORMAT = [
  '#{history_size}',
  '#{history_limit}',
  '#{cursor_y}',
  '#{pane_height}',
  '#{pane_current_command}',
  '#{pane_current_path}',
].join(SEP);

export function parsePaneState(line: string): PaneState {
  const parts = line.replace(/\n$/, '').split(SEP);
  if (parts.length < 6) {
    throw new Error(`unexpected pane state line: ${JSON.stringify(line)}`);
  }
  return {
    historySize: Number.parseInt(parts[0]!, 10),
    historyLimit: Number.parseInt(parts[1]!, 10),
    cursorY: Number.parseInt(parts[2]!, 10),
    paneHeight: Number.parseInt(parts[3]!, 10),
    currentCommand: parts[4]!,
    // pane_current_path may itself contain tabs in pathological cases; rejoin.
    currentPath: parts.slice(5).join(SEP),
  };
}

export const LIST_PANES_FORMAT = [
  '#{pane_id}',
  '#{session_name}:#{window_index}.#{pane_index}',
  '#{pane_title}',
  '#{pane_current_command}',
  '#{pane_width}x#{pane_height}',
].join(SEP);

export function parsePaneList(output: string): PaneInfo[] {
  return output
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(SEP);
      if (parts.length < 5) {
        throw new Error(`unexpected list-panes line: ${JSON.stringify(line)}`);
      }
      const [width, height] = parts[4]!.split('x').map((n) => Number.parseInt(n, 10));
      const title = parts[2]!;
      return {
        paneId: parts[0]!,
        target: parts[1]!,
        title,
        currentCommand: parts[3]!,
        width: width ?? 0,
        height: height ?? 0,
        managed: title.startsWith(MANAGED_TITLE_PREFIX),
      };
    });
}
