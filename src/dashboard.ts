import type { Config, DashboardDensity } from "./config.js";
import { errorMessage } from "./core/shared.js";
import {
  estimateTokens,
  mergeStats,
  type RoleStat,
  type WorkspaceStats,
} from "./core/stats.js";
import { ROLE_ORDER } from "./init/detect.js";
import type { TmuxClient } from "./tmux/client.js";
import { spawnDetachedTmuxSequence } from "./tmux/exec.js";
import {
  spawnControlWatcher,
  type ControlWatcher,
  type WatcherEvent,
  type WatcherOptions,
} from "./tmux/watcher.js";
import type { PaneInfo, WindowInfo } from "./types.js";

export type DashboardMode = "normal" | "insert";

export interface DashboardRow {
  /** 'agent' = a workspace window; 'pane' = a managed pane nested under it. */
  kind: "agent" | "pane";
  sessionName: string;
  windowIndex: string;
  windowId: string;
  windowName: string;
  /** The row's own pane: the managed pane for 'pane' rows, the window's active pane for 'agent' rows. */
  activePaneId: string;
  /** Child pane ids, in window order — set on 'agent' rows for the stacked preview. */
  paneIds?: string[];
  script?: string | null;
  /** Agent-supplied run context ("<stage> due to <reason>"); aggregate on agent rows. */
  description?: string | null;
  dir?: string | null;
  managedName?: string | null;
  agentId?: string | null;
  serverPid?: number | null;
  busy?: boolean;
  lastExitCode?: number | null;
}

export interface DashboardState {
  mode: DashboardMode;
  query: string;
  cursor: number;
  rows: DashboardRow[];
  message: string | null;
}

export interface DashboardRenderOptions {
  density?: DashboardDensity;
  /** Workspace token-savings totals, rendered as a section above the footer. */
  stats?: WorkspaceStats;
}

export type DashboardAction =
  | { type: "move"; delta: number }
  | { type: "setRows"; rows: DashboardRow[]; message?: string | null }
  | { type: "enterInsert" }
  | { type: "escape" }
  | { type: "input"; text: string }
  | { type: "backspace" }
  | { type: "deleteSelected" };

export const EMPTY_MESSAGE =
  "No sidemux workspace exists yet. Run a command first.";
export const NORMAL_HELP =
  "NORMAL · j/k/Tab move · Enter open+zoom · d kill · / search · r reload · q close";
export const INSERT_HELP = "INSERT · type filter · Enter open · Esc normal";

const ANSI = {
  clear: "\x1b[2J\x1b[H",
  hideCursor: "\x1b[?25l",
  showCursor: "\x1b[?25h",
  reset: "\x1b[0m",
  reverse: "\x1b[7m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  fg: (color: number) => `\x1b[38;5;${color}m`,
  bg: (color: number) => `\x1b[48;5;${color}m`,
};
const ANSI_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`,
  "g",
);
const THEME = {
  accent: 45,
  accent2: 81,
  border: 240,
  dim: 245,
  /** Darker than `dim`: help text and other non-critical chrome. */
  faint: 240,
  text: 252,
  title: 159,
  danger: 203,
  panel: 236,
  selected: 238,
};

export function initialDashboardState(
  rows: DashboardRow[] = [],
): DashboardState {
  return { mode: "normal", query: "", cursor: 0, rows, message: null };
}

export function selectedRow(state: DashboardState): DashboardRow | null {
  return filteredRows(state)[state.cursor] ?? null;
}

export function filteredRows(state: DashboardState): DashboardRow[] {
  const query = state.query.trim().toLowerCase();
  if (!query) {
    return state.rows;
  }
  const matches = (row: DashboardRow): boolean =>
    [
      row.windowIndex,
      row.windowName,
      row.windowId,
      row.activePaneId,
      row.script,
      row.description,
      row.dir,
      row.managedName,
      row.agentId,
      row.serverPid?.toString(),
      row.lastExitCode?.toString(),
    ]
      .join(" ")
      .toLowerCase()
      .includes(query);
  // Tree-aware: a window keeps its whole subtree visible when the agent row
  // or any of its panes match, so a matching pane never loses its parent.
  const matchedWindows = new Set(
    state.rows.filter((row) => matches(row)).map((row) => row.windowId),
  );
  return state.rows.filter((row) => matchedWindows.has(row.windowId));
}

export function dashboardReducer(
  state: DashboardState,
  action: DashboardAction,
): DashboardState {
  switch (action.type) {
    case "move": {
      const count = filteredRows(state).length;
      if (count === 0) {
        return { ...state, cursor: 0 };
      }
      return {
        ...state,
        cursor: clamp(state.cursor + action.delta, 0, count - 1),
      };
    }
    case "setRows": {
      const next = {
        ...state,
        rows: action.rows,
        message: action.message ?? null,
      };
      const count = filteredRows(next).length;
      return {
        ...next,
        cursor: count === 0 ? 0 : clamp(next.cursor, 0, count - 1),
      };
    }
    case "enterInsert":
      return { ...state, mode: "insert" };
    case "escape":
      return state.mode === "insert" ? { ...state, mode: "normal" } : state;
    case "input": {
      const next = { ...state, query: state.query + action.text };
      const count = filteredRows(next).length;
      return {
        ...next,
        cursor: count === 0 ? 0 : clamp(next.cursor, 0, count - 1),
      };
    }
    case "backspace": {
      const next = { ...state, query: state.query.slice(0, -1) };
      const count = filteredRows(next).length;
      return {
        ...next,
        cursor: count === 0 ? 0 : clamp(next.cursor, 0, count - 1),
      };
    }
    case "deleteSelected": {
      const selected = selectedRow(state);
      if (!selected) {
        return state;
      }
      // Killing an agent row takes its whole window (children included);
      // killing a pane row drops just that pane.
      const next = {
        ...state,
        rows: state.rows.filter((row) =>
          selected.kind === "agent"
            ? row.windowId !== selected.windowId
            : row.activePaneId !== selected.activePaneId,
        ),
      };
      const count = filteredRows(next).length;
      return {
        ...next,
        cursor: count === 0 ? 0 : clamp(state.cursor, 0, count - 1),
      };
    }
  }
}

export interface DashboardDeps {
  /** Injectable control-mode watcher factory (tests swap in a fake). */
  spawnWatcher?: (
    sessionName: string,
    onEvent: (event: WatcherEvent) => void,
    options: WatcherOptions,
  ) => ControlWatcher;
  /** Auto-refresh coalescing interval in ms. */
  tickMs?: number;
  /**
   * Runs focus commands (switch-client/select-pane/zoom) after the dashboard
   * exits. tmux ignores `switch-client` for the client that owns an open
   * popup, so these must not run while the dashboard is still on screen.
   */
  deferFocus?: (commands: string[][]) => void;
}

/** Watcher dead → force a reload every Nth tick (degraded ~1.5s poll). */
const FALLBACK_TICKS = 3;

export async function runDashboard(
  client: TmuxClient,
  config: Config,
  deps: DashboardDeps = {},
): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY) {
    output.write("sidemux dashboard needs a TTY.\n");
    return;
  }

  const deferFocus =
    deps.deferFocus ??
    ((commands: string[][]): void => {
      spawnDetachedTmuxSequence({ socketName: config.socketName }, commands);
    });
  let state = initialDashboardState();
  let preview = "";
  let stats: WorkspaceStats = {};
  let closed = false;
  let dirty = false;
  let reloading = false;
  let watcherAlive = true;
  let fallbackTicks = 0;

  const redraw = (): void => {
    if (!closed) {
      render(output, state, preview, config, stats);
    }
  };

  const reload = async (): Promise<void> => {
    try {
      const [windows, panes] = await Promise.all([
        client.listWindows(config.sessionName),
        client.listPanes(),
      ]);
      const rows = buildRows(windows, panes);
      stats = mergeStats(windows.map((window) => window.statsJson));
      state = dashboardReducer(state, {
        type: "setRows",
        rows,
        message: rows.length === 0 ? EMPTY_MESSAGE : null,
      });
    } catch (error) {
      state = dashboardReducer(state, {
        type: "setRows",
        rows: [],
        message: errorMessage(error),
      });
    }
    await refreshPreview();
    redraw();
  };

  // Control-mode watcher pushes change notifications; the tick only coalesces
  // them (≤2 reloads/s under output floods, zero tmux calls when idle).
  const watcher = (deps.spawnWatcher ?? spawnControlWatcher)(
    config.sessionName,
    (event) => {
      if (event.type === "died") {
        watcherAlive = false;
      } else {
        dirty = true;
      }
    },
    { socketName: config.socketName },
  );
  const tick = setInterval(() => {
    if (closed || reloading) {
      return;
    }
    if (!watcherAlive) {
      fallbackTicks += 1;
      if (fallbackTicks >= FALLBACK_TICKS) {
        fallbackTicks = 0;
        dirty = true;
      }
    }
    if (!dirty) {
      return;
    }
    dirty = false;
    reloading = true;
    reload()
      .catch((error: unknown) => {
        state = { ...state, message: errorMessage(error) };
        redraw();
      })
      .finally(() => {
        reloading = false;
      });
  }, deps.tickMs ?? 500);
  tick.unref();

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(tick);
    watcher.kill();
    input.setRawMode(false);
    input.pause();
    process.off("SIGWINCH", redraw);
    output.write(`${ANSI.showCursor}${ANSI.reset}`);
  };

  const openSelected = async (): Promise<void> => {
    const row = selectedRow(state);
    if (!row) {
      return;
    }
    // The keybind resolved which client opened this popup; without -c a
    // detached switch-client may grab whichever client was last active.
    const clientTty = process.env.SIDEMUX_CLIENT_TTY?.trim();
    const commands: string[][] = [
      [
        "switch-client",
        ...(clientTty ? ["-c", clientTty] : []),
        "-t",
        row.windowId,
      ],
    ];
    if (row.kind === "pane") {
      commands.push(["select-pane", "-t", row.activePaneId]);
      let zoomed = false;
      try {
        zoomed = await client.isZoomed(row.activePaneId);
      } catch {
        // Pane may already be gone; zoom stays best-effort.
      }
      if (!zoomed) {
        // resize-pane -Z toggles; only send it when the pane isn't zoomed yet.
        commands.push(["resize-pane", "-Z", "-t", row.activePaneId]);
      }
    }
    deferFocus(commands);
    close();
  };

  const deleteSelected = async (): Promise<void> => {
    const row = selectedRow(state);
    if (!row) {
      return;
    }
    try {
      if (row.kind === "pane") {
        await client.killPane(row.activePaneId);
      } else {
        await client.killWindow(row.windowId);
      }
      state = dashboardReducer(state, { type: "deleteSelected" });
      await reload();
    } catch (error) {
      state = { ...state, message: errorMessage(error) };
      render(output, state, preview, config, stats);
    }
  };

  const refreshPreview = async (): Promise<void> => {
    const row = selectedRow(state);
    if (!row) {
      preview = "";
      return;
    }
    if (row.kind === "agent" && row.paneIds && row.paneIds.length > 0) {
      preview = await stackedPreview(
        client,
        row,
        state.rows,
        output.rows || 30,
      );
      return;
    }
    try {
      preview = (await client.capturePane(row.activePaneId, -120)).join("\n");
    } catch (error) {
      preview = errorMessage(error);
    }
  };

  const handleKey = async (chunk: Buffer): Promise<void> => {
    const key = chunk.toString("utf8");
    if (state.mode === "insert") {
      if (key === "\x1b") {
        state = dashboardReducer(state, { type: "escape" });
      } else if (key === "\r" || key === "\n") {
        await openSelected();
      } else if (key === "\x7f" || key === "\b") {
        state = dashboardReducer(state, { type: "backspace" });
      } else if (isPrintable(key)) {
        state = dashboardReducer(state, { type: "input", text: key });
      }
    } else {
      if (key === "q" || key === "\x1b") {
        close();
      } else if (key === "j" || key === "\t" || key === "\x1b[B") {
        state = dashboardReducer(state, { type: "move", delta: 1 });
      } else if (key === "k" || key === "\x1b[Z" || key === "\x1b[A") {
        state = dashboardReducer(state, { type: "move", delta: -1 });
      } else if (key === "/") {
        state = dashboardReducer(state, { type: "enterInsert" });
      } else if (key === "r") {
        await reload();
      } else if (key === "d") {
        await deleteSelected();
      } else if (key === "\r" || key === "\n") {
        await openSelected();
      }
    }
    await refreshPreview();
    if (!closed) {
      render(output, state, preview, config, stats);
    }
  };

  output.write(ANSI.hideCursor);
  input.setRawMode(true);
  input.resume();
  input.on(
    "data",
    (chunk) =>
      void handleKey(chunk as Buffer).catch((error: unknown) => {
        state = { ...state, message: errorMessage(error) };
        render(output, state, preview, config, stats);
      }),
  );
  process.on("SIGWINCH", redraw);
  process.once("exit", close);
  process.once("SIGINT", () => {
    close();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    close();
    process.exit(143);
  });
  await reload();
}

export function renderDashboard(
  state: DashboardState,
  preview: string,
  width: number,
  height: number,
  options: DashboardRenderOptions = {},
): string {
  const density = densitySpec(options.density ?? "normal");
  const header = state.mode === "normal" ? NORMAL_HELP : INSERT_HELP;
  const rows = filteredRows(state);
  // The stats section only claims rows it can afford: on short terminals the
  // list/preview keep their minimum height and stats are dropped instead.
  const statsLines =
    height >= 16 ? renderStats(options.stats ?? {}, width) : [];
  const bodyHeight = Math.max(
    3,
    height - 3 - density.outerBlankLines - statsLines.length,
  );
  const wide = width >= 100;
  const listWidth = wide ? Math.max(38, Math.floor(width * 0.38)) : width;
  const gapWidth = wide ? density.horizontalGap.length : 0;
  const previewWidth = wide ? Math.max(1, width - listWidth - gapWidth) : width;
  const listHeight = wide
    ? bodyHeight
    : Math.max(5, Math.floor(bodyHeight * 0.44));
  const stackGap = wide ? 0 : density.stackGapLines;
  const previewHeight = wide
    ? bodyHeight
    : Math.max(3, bodyHeight - listHeight - stackGap);
  const selected = selectedRow(state);
  const listInner = innerSize(listWidth, listHeight, density);
  const previewInner = innerSize(previewWidth, previewHeight, density);
  const list = renderPanel(
    density.compactTitles
      ? `pane ${rows.length}/${state.rows.length}`
      : `panes ${rows.length}/${state.rows.length}`,
    renderList(
      state,
      rows,
      Math.max(1, listInner.width),
      Math.max(1, listInner.height),
      density.rowGapLines,
    ),
    listWidth,
    listHeight,
    density,
  );
  const previewText = preview || state.message || "";
  const previewTitle = density.compactTitles
    ? selected
      ? `out ${selected.activePaneId}`
      : "out"
    : selected
      ? `preview ${selected.activePaneId}`
      : "preview";
  const previewPanel = renderPanel(
    previewTitle,
    renderPreview(
      previewText,
      Math.max(1, previewInner.width),
      Math.max(1, previewInner.height),
      density.rowGapLines,
    ),
    previewWidth,
    previewHeight,
    density,
  );
  const lines = [
    renderTopBar(header, state, rows.length, width),
    renderDetailBar(selected, width),
  ];
  for (let i = 0; i < density.outerBlankLines; i += 1) {
    lines.push("");
  }

  if (wide) {
    for (let i = 0; i < bodyHeight; i += 1) {
      lines.push(
        `${pad(list[i] ?? "", listWidth)}${density.horizontalGap}${previewPanel[i] ?? ""}`,
      );
    }
    lines.push(...statsLines);
    lines.push(renderFooter(state, width));
    return lines.slice(0, height).join("\n");
  }

  lines.push(...list.slice(0, listHeight));
  for (let i = 0; i < stackGap; i += 1) {
    lines.push("");
  }
  lines.push(...previewPanel.slice(0, previewHeight));
  lines.push(...statsLines);
  lines.push(renderFooter(state, width));
  return lines.slice(0, height).join("\n");
}

function render(
  output: NodeJS.WriteStream,
  state: DashboardState,
  preview: string,
  config: Config,
  stats: WorkspaceStats = {},
): void {
  const width = output.columns || 100;
  const height = output.rows || 30;
  output.write(
    ANSI.clear +
      renderDashboard(state, preview, width, height, {
        density: config.dashboardDensity,
        stats,
      }),
  );
}

function renderList(
  state: DashboardState,
  rows: DashboardRow[],
  width: number,
  height: number,
  rowGapLines = 0,
): string[] {
  if (rows.length === 0) {
    const text =
      state.rows.length === 0
        ? state.message || EMPTY_MESSAGE
        : `No matches for "${state.query}"`;
    return centerBlock(text, width, height);
  }
  const rowStride = rowGapLines + 1;
  const table = tableSpec(Math.max(1, width - 2));
  const visibleRowCount = Math.max(1, Math.ceil((height - 1) / rowStride));
  const offset = Math.max(
    0,
    Math.min(state.cursor - visibleRowCount + 1, rows.length - visibleRowCount),
  );
  const lines: string[] = [color(pad(table.header, width), THEME.title)];
  for (const [index, row] of rows
    .slice(offset, offset + visibleRowCount)
    .entries()) {
    const selected = offset + index === state.cursor;
    const accent = selected
      ? color("▌", THEME.accent)
      : color(" ", THEME.border);
    const line = `${accent} ${formatTableRow(row, table, selected)}`;
    lines.push(selected ? selectedLine(line, width) : pad(line, width));
    for (let gap = 0; gap < rowGapLines && lines.length < height; gap += 1) {
      lines.push("");
    }
  }
  return lines.slice(0, height);
}

// Shows the TAIL of the capture — logs grow at the bottom, so the newest
// lines are the ones worth pinning in a fixed-height panel.
function renderPreview(
  value: string,
  width: number,
  height: number,
  rowGapLines = 0,
): string[] {
  const text = value.trimEnd() || color("<no pane output>", THEME.faint);
  const lines: string[] = [];
  for (const line of wrapLines(text, width)) {
    lines.push(color(truncate(line, width), THEME.dim));
    for (let gap = 0; gap < rowGapLines; gap += 1) {
      lines.push("");
    }
  }
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  return lines.slice(-height);
}

function renderTopBar(
  help: string,
  state: DashboardState,
  visibleRows: number,
  width: number,
): string {
  const brand = `${ANSI.bold}${color("SIDEMUX", THEME.title)}${ANSI.reset}`;
  const modeColor = state.mode === "normal" ? THEME.accent : THEME.accent2;
  const mode = chip(state.mode.toUpperCase(), modeColor);
  const count = color(`${visibleRows}/${state.rows.length} rows`, THEME.faint);
  return fitLine(
    `${brand} ${mode} ${color(help, THEME.faint)} ${count}`,
    width,
  );
}

const SEGMENT_ARROW = "";

interface DetailSegment {
  text: string;
  bg: number;
  fg?: number;
}

function abbreviateHome(dir: string): string {
  return dir.replace(/^\/home\/[^/]+/, "~");
}

/**
 * Powerline-style detail bar for the selected row: window, name/pane, run
 * description, command, pwd, and status rendered as arrow-joined chips.
 */
export function renderDetailBar(
  row: DashboardRow | null,
  width: number,
): string {
  if (!row) {
    return fitLine(color("no selection", THEME.faint), width);
  }
  const exitSuffix =
    row.lastExitCode !== null && row.lastExitCode !== undefined
      ? ` exit ${row.lastExitCode}`
      : "";
  const segments: DetailSegment[] =
    row.kind === "pane"
      ? [
          { text: `win ${row.windowIndex}`, bg: THEME.accent, fg: 16 },
          {
            text: `${row.managedName || row.windowName} ${row.activePaneId}`,
            bg: THEME.selected,
          },
          { text: truncatePlain(row.description ?? "—", 48), bg: THEME.panel },
          { text: truncatePlain(row.script ?? "-", 36), bg: THEME.selected },
          {
            text: truncatePlain(abbreviateHome(row.dir ?? "-"), 32),
            bg: THEME.panel,
          },
          {
            text: `${statusText(row, true)}${exitSuffix}`,
            bg: statusColor(row),
            fg: 16,
          },
        ]
      : [
          { text: `win ${row.windowIndex}`, bg: THEME.accent, fg: 16 },
          { text: `${row.windowName} ${row.windowId}`, bg: THEME.selected },
          { text: truncatePlain(row.description ?? "—", 32), bg: THEME.panel },
          {
            text: `${row.agentId ?? "-"} · pid ${row.serverPid ?? "-"}`,
            bg: THEME.selected,
          },
          {
            text: truncatePlain(abbreviateHome(row.dir ?? "-"), 32),
            bg: THEME.panel,
          },
          {
            text: `${statusText(row, true)}${exitSuffix}`,
            bg: statusColor(row),
            fg: 16,
          },
        ];
  return fitLine(powerline(segments), width);
}

function powerline(segments: DetailSegment[]): string {
  let out = "";
  for (const [index, segment] of segments.entries()) {
    const next = segments[index + 1];
    out += `${ANSI.bg(segment.bg)}${ANSI.fg(segment.fg ?? THEME.text)} ${segment.text} ${ANSI.reset}`;
    out += `${next ? ANSI.bg(next.bg) : ""}${ANSI.fg(segment.bg)}${SEGMENT_ARROW}${ANSI.reset}`;
  }
  return out;
}

function renderFooter(state: DashboardState, width: number): string {
  const filter = state.query
    ? color(state.query, THEME.text)
    : color("<empty>", THEME.faint);
  const message = state.message
    ? color(state.message, state.rows.length === 0 ? THEME.dim : THEME.danger)
    : color("Enter open+zoom · d kill · r reload · q close", THEME.faint);
  return fitLine(
    `${color("filter", THEME.accent)}: ${filter}  ${message}`,
    width,
  );
}

/**
 * Workspace token-savings table: one line per script group with data plus a
 * total. "AI" is the estimated tokens the agent would have consumed running
 * the commands inline; "SMUX" is what sidemux actually returned.
 */
export function renderStats(stats: WorkspaceStats, width: number): string[] {
  const roles = ROLE_ORDER.filter((role) => stats[role] !== undefined);
  if (roles.length === 0) {
    return [];
  }
  const row = (label: string, stat: RoleStat, labelColor: number): string => {
    const ai = estimateTokens(stat.ai);
    const smux = estimateTokens(stat.smux);
    const saved = ai > 0 ? Math.max(0, Math.round((1 - smux / ai) * 100)) : 0;
    return fitLine(
      `${color(pad(label, 8), labelColor)}${color(padLeft(formatTokens(ai), 10), THEME.text)}` +
        `${color(padLeft(formatTokens(smux), 10), THEME.text)}${color(padLeft(`${saved}%`, 8), THEME.accent)}`,
      width,
    );
  };
  const lines = [
    fitLine(
      `${color(pad("tokens", 8), THEME.title)}${color(padLeft("AI", 10), THEME.faint)}` +
        `${color(padLeft("SMUX", 10), THEME.faint)}${color(padLeft("SAVED", 8), THEME.faint)}`,
      width,
    ),
  ];
  const total: RoleStat = { ai: 0, smux: 0, responses: 0 };
  for (const role of roles) {
    const stat = stats[role];
    if (!stat) {
      continue;
    }
    total.ai += stat.ai;
    total.smux += stat.smux;
    total.responses += stat.responses;
    lines.push(row(role, stat, THEME.dim));
  }
  if (roles.length > 1) {
    lines.push(row("total", total, THEME.text));
  }
  return lines;
}

/** Compact token count: 812, 4.2k, 1.3M. */
export function formatTokens(count: number): string {
  if (count < 1000) {
    return String(count);
  }
  if (count < 1_000_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }
  return `${(count / 1_000_000).toFixed(1)}M`;
}

interface DensitySpec {
  compactTitles: boolean;
  horizontalGap: string;
  outerBlankLines: number;
  panelPadding: number;
  rowGapLines: number;
  stackGapLines: number;
  style: "compact" | "normal";
}

function densitySpec(density: DashboardDensity): DensitySpec {
  if (density === "compact") {
    return {
      compactTitles: true,
      horizontalGap: " ",
      outerBlankLines: 0,
      panelPadding: 0,
      rowGapLines: 0,
      stackGapLines: 0,
      style: "compact",
    };
  }
  if (density === "spacious") {
    return {
      compactTitles: false,
      horizontalGap: "  ",
      outerBlankLines: 1,
      panelPadding: 1,
      rowGapLines: 1,
      stackGapLines: 1,
      style: "normal",
    };
  }
  return {
    compactTitles: false,
    horizontalGap: " ",
    outerBlankLines: 0,
    panelPadding: 0,
    rowGapLines: 0,
    stackGapLines: 0,
    style: "normal",
  };
}

function innerSize(
  width: number,
  height: number,
  density: DensitySpec,
): { width: number; height: number } {
  if (density.style === "compact") {
    return { width, height: Math.max(0, height - 1) };
  }
  return {
    width: Math.max(0, width - 2 - density.panelPadding * 2),
    height: Math.max(0, height - 2 - density.panelPadding * 2),
  };
}

function renderPanel(
  title: string,
  content: string[],
  width: number,
  height: number,
  density: DensitySpec,
): string[] {
  if (height <= 0) {
    return [];
  }
  if (height === 1) {
    return [fitLine(title, width)];
  }
  if (density.style === "compact") {
    return [
      fitLine(`${title}:`, width),
      ...content.map((line) => fitLine(line, width)),
    ].slice(0, height);
  }
  if (height === 2) {
    return [panelTop(title, width), panelBottom(width)];
  }
  const innerWidth = Math.max(0, width - 2);
  const bodyHeight = height - 2;
  const lines = [panelTop(title, width)];
  for (
    let i = 0;
    i < density.panelPadding && lines.length < height - 1;
    i += 1
  ) {
    lines.push(
      `${color("│", THEME.border)}${" ".repeat(innerWidth)}${color("│", THEME.border)}`,
    );
  }
  for (let i = 0; i < bodyHeight; i += 1) {
    if (lines.length >= height - 1 - density.panelPadding) {
      break;
    }
    const padded = `${" ".repeat(density.panelPadding)}${pad(content[i] ?? "", Math.max(0, innerWidth - density.panelPadding * 2))}${" ".repeat(density.panelPadding)}`;
    lines.push(
      `${color("│", THEME.border)}${pad(padded, innerWidth)}${color("│", THEME.border)}`,
    );
  }
  while (lines.length < height - 1) {
    lines.push(
      `${color("│", THEME.border)}${" ".repeat(innerWidth)}${color("│", THEME.border)}`,
    );
  }
  lines.push(panelBottom(width));
  return lines;
}

function panelTop(title: string, width: number): string {
  const cleanTitle = ` ${title} `;
  const right = Math.max(0, width - visibleWidth(cleanTitle) - 2);
  return `${color("┌", THEME.border)}${color(cleanTitle, THEME.title)}${color("─".repeat(right), THEME.border)}${color("┐", THEME.border)}`;
}

function panelBottom(width: number): string {
  return color(`└${"─".repeat(Math.max(0, width - 2))}┘`, THEME.border);
}

function centerBlock(value: string, width: number, height: number): string[] {
  const wrapped = wrapLines(value, Math.max(1, width - 4));
  const topPad = Math.max(0, Math.floor((height - wrapped.length) / 2));
  const lines = Array.from({ length: topPad }, () => "");
  lines.push(...wrapped.map((line) => center(color(line, THEME.faint), width)));
  while (lines.length < height) {
    lines.push("");
  }
  return lines.slice(0, height);
}

function chip(value: string, colorId: number): string {
  return `${ANSI.bg(colorId)}${ANSI.fg(16)} ${value} ${ANSI.reset}`;
}

function color(value: string, colorId: number): string {
  return `${ANSI.fg(colorId)}${value}${ANSI.reset}`;
}

function selectedLine(value: string, width: number): string {
  return `${ANSI.bg(THEME.selected)}${fitLine(value, width)}${ANSI.reset}`;
}

function center(value: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleWidth(value)) / 2));
  return pad(`${" ".repeat(left)}${value}`, width);
}

function fitLine(value: string, width: number): string {
  return pad(truncate(value, width), width);
}

interface TableSpec {
  header: string;
  full: boolean;
  statusWidth: number;
  scriptWidth: number;
  descWidth: number;
  dirWidth: number;
  nameWidth: number;
  agentWidth: number;
}

function tableSpec(width: number): TableSpec {
  const full = width >= 88;
  if (full) {
    const statusWidth = 8;
    const nameWidth = 12;
    const agentWidth = width >= 112 ? 18 : 12;
    const fixed = 3 + statusWidth + nameWidth + agentWidth + 5 + 4 + 9 + 9;
    const flexible = Math.max(48, width - fixed);
    const scriptWidth = Math.min(28, Math.max(16, Math.floor(flexible * 0.32)));
    const descWidth = Math.max(14, Math.floor((flexible - scriptWidth) * 0.55));
    const dirWidth = Math.max(14, flexible - scriptWidth - descWidth);
    return {
      full,
      statusWidth,
      scriptWidth,
      descWidth,
      dirWidth,
      nameWidth,
      agentWidth,
      header: [
        pad("#", 3),
        pad("STATUS", statusWidth),
        pad("SCRIPT", scriptWidth),
        pad("DESC", descWidth),
        pad("DIR", dirWidth),
        pad("NAME", nameWidth),
        pad("AGENT", agentWidth),
        pad("PID", 5),
        pad("EXIT", 4),
        "IDS",
      ].join(" "),
    };
  }
  const statusWidth = 1;
  const fixed = 3 + statusWidth + 9 + 4;
  const flexible = Math.max(16, width - fixed);
  const scriptWidth = Math.max(10, Math.floor(flexible * 0.62));
  const dirWidth = Math.max(8, flexible - scriptWidth);
  return {
    full,
    statusWidth,
    scriptWidth,
    descWidth: 0,
    dirWidth,
    nameWidth: 0,
    agentWidth: 0,
    header: [
      pad("#", 3),
      "S",
      pad("SCRIPT", scriptWidth),
      pad("DIR", dirWidth),
      "IDS",
    ].join(" "),
  };
}

function formatTableRow(
  row: DashboardRow,
  table: TableSpec,
  selected: boolean,
): string {
  const dim = selected ? THEME.text : THEME.dim;
  const status = color(
    pad(statusText(row, table.full), table.statusWidth),
    statusColor(row),
  );
  const script = color(
    pad(
      truncatePlain(displayScript(row), table.scriptWidth),
      table.scriptWidth,
    ),
    dim,
  );
  const dir = color(
    pad(
      truncatePlain(displayDir(row, table.full), table.dirWidth),
      table.dirWidth,
    ),
    dim,
  );
  const ids = color(`${row.windowId} ${row.activePaneId}`, THEME.dim);
  const index = color(
    pad(row.kind === "pane" ? "" : row.windowIndex, 3),
    selected ? THEME.accent2 : THEME.dim,
  );
  if (!table.full) {
    return `${index} ${status} ${script} ${dir} ${ids}`;
  }

  const desc = color(
    pad(
      truncatePlain(row.description ?? "-", table.descWidth),
      table.descWidth,
    ),
    THEME.dim,
  );
  const name = color(
    pad(
      truncatePlain(row.managedName || row.windowName, table.nameWidth),
      table.nameWidth,
    ),
    dim,
  );
  const agent = color(
    pad(truncatePlain(row.agentId || "-", table.agentWidth), table.agentWidth),
    THEME.dim,
  );
  const pid = color(pad(row.serverPid?.toString() ?? "-", 5), THEME.dim);
  const exit = color(
    pad(row.lastExitCode?.toString() ?? "-", 4),
    statusColor(row),
  );
  return `${index} ${status} ${script} ${desc} ${dir} ${name} ${agent} ${pid} ${exit} ${ids}`;
}

function displayScript(row: DashboardRow): string {
  const base = row.script || row.windowName || row.activePaneId;
  return row.kind === "pane" ? `└ ${base}` : base;
}

function displayDir(row: DashboardRow, full: boolean): string {
  if (!row.dir) {
    return "-";
  }
  if (full) {
    return row.dir;
  }
  return row.dir.split("/").filter(Boolean).pop() ?? row.dir;
}

function statusGlyph(row: DashboardRow): string {
  if (row.busy) {
    return "●";
  }
  if (row.lastExitCode === 0) {
    return "✓";
  }
  if (row.lastExitCode !== null && row.lastExitCode !== undefined) {
    return "✕";
  }
  return "·";
}

function statusText(row: DashboardRow, full: boolean): string {
  const icon = statusGlyph(row);
  if (!full) {
    return icon;
  }
  if (row.busy) {
    return `${icon} run`;
  }
  if (row.lastExitCode === 0) {
    return `${icon} ok`;
  }
  if (row.lastExitCode !== null && row.lastExitCode !== undefined) {
    return `${icon} fail`;
  }
  return `${icon} idle`;
}

function statusColor(row: DashboardRow): number {
  if (row.busy) {
    return THEME.accent2;
  }
  if (row.lastExitCode === 0) {
    return THEME.accent;
  }
  if (row.lastExitCode !== null && row.lastExitCode !== undefined) {
    return THEME.danger;
  }
  return THEME.dim;
}

/**
 * Build the dashboard tree: one 'agent' row per workspace window followed by
 * one nested 'pane' row per managed pane in that window. The tree is always
 * fully expanded — there is no collapse state.
 */
export function buildRows(
  windows: WindowInfo[],
  panes: PaneInfo[],
): DashboardRow[] {
  const rows: DashboardRow[] = [];
  for (const window of windows) {
    const children = panes.filter(
      (candidate) =>
        candidate.windowId === window.windowId && candidate.managed,
    );
    const fallback =
      panes.find((candidate) => candidate.paneId === window.activePaneId) ??
      panes.find((candidate) => candidate.windowId === window.windowId);
    const failed = children.find(
      (pane) => pane.lastExitCode !== null && pane.lastExitCode !== 0,
    );
    rows.push({
      kind: "agent",
      sessionName: window.sessionName,
      windowIndex: window.windowIndex,
      windowId: window.windowId,
      windowName: window.windowName,
      activePaneId: window.activePaneId,
      paneIds: children.map((pane) => pane.paneId),
      script:
        children.length > 0
          ? `${window.windowName} · ${children.length} pane${children.length === 1 ? "" : "s"}`
          : (fallback?.lastCommand ?? fallback?.currentCommand ?? null),
      description:
        children.length > 0
          ? `${children.length} pane${children.length === 1 ? "" : "s"} · ${children.filter((pane) => pane.busy).length} running`
          : null,
      dir: fallback?.currentPath ?? null,
      managedName: null,
      agentId: window.agentId ?? fallback?.agentId ?? null,
      serverPid: window.serverPid,
      busy: children.some((pane) => pane.busy),
      lastExitCode:
        failed?.lastExitCode ??
        (children.some((pane) => pane.lastExitCode === 0) ? 0 : null),
    });
    for (const pane of children) {
      rows.push({
        kind: "pane",
        sessionName: window.sessionName,
        windowIndex: window.windowIndex,
        windowId: window.windowId,
        windowName: window.windowName,
        activePaneId: pane.paneId,
        script: pane.lastCommand ?? pane.currentCommand,
        description: pane.description,
        dir: pane.currentPath,
        managedName: pane.managedName,
        agentId: pane.agentId ?? window.agentId ?? null,
        serverPid: pane.serverPid ?? window.serverPid,
        busy: pane.busy,
        lastExitCode: pane.lastExitCode,
      });
    }
  }
  return rows;
}

/**
 * Preview for an agent row: the last few log lines of every child pane,
 * stacked, each under a header naming the script and its status.
 */
async function stackedPreview(
  client: TmuxClient,
  row: DashboardRow,
  rows: DashboardRow[],
  terminalRows: number,
): Promise<string> {
  const paneIds = row.paneIds ?? [];
  const perPane = Math.max(
    3,
    Math.floor((terminalRows - 6) / paneIds.length) - 1,
  );
  const sections: string[] = [];
  for (const paneId of paneIds) {
    const child = rows.find(
      (candidate) =>
        candidate.kind === "pane" && candidate.activePaneId === paneId,
    );
    const label = child?.script ?? paneId;
    const status = child ? statusText(child, true) : "·";
    let tail: string[];
    try {
      tail = await client.capturePane(paneId, -40);
    } catch (error) {
      tail = [errorMessage(error)];
    }
    while (tail.length > 0 && tail.at(-1)?.trim() === "") {
      tail.pop();
    }
    sections.push(`── ${label} · ${status} ──`, ...tail.slice(-perPane));
  }
  return sections.join("\n");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isPrintable(value: string): boolean {
  return value.length === 1 && value >= " " && value !== "\x7f";
}

function truncate(value: string, width: number): string {
  if (visibleWidth(value) <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${truncatePlain(stripAnsi(value), width - 1)}…`;
}

function truncatePlain(value: string, width: number): string {
  if (value.length <= width) {
    return value;
  }
  if (width <= 1) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 1)}…`;
}

function pad(value: string, width: number): string {
  const visible = visibleWidth(value);
  return visible >= width ? value : value + " ".repeat(width - visible);
}

function padLeft(value: string, width: number): string {
  const visible = visibleWidth(value);
  return visible >= width ? value : " ".repeat(width - visible) + value;
}

function wrapLines(value: string, width: number): string[] {
  const lines: string[] = [];
  for (const rawLine of value.split("\n")) {
    let line = rawLine;
    while (stripAnsi(line).length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
    lines.push(line);
  }
  return lines;
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

function visibleWidth(value: string): number {
  return stripAnsi(value).length;
}
