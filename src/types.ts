export type JobStatus = "running" | "done" | "failed" | "unknown";
export type ManagedPaneClass = "oneshot" | "persistent";

export interface PaneState {
  historySize: number;
  historyLimit: number;
  cursorY: number;
  paneHeight: number;
  currentCommand: string;
  currentPath: string;
}

export interface PaneInfo {
  paneId: string;
  target: string;
  sessionName: string;
  windowIndex: string;
  windowName: string;
  title: string;
  currentCommand: string;
  currentPath: string;
  width: number;
  height: number;
  windowId: string;
  managed: boolean;
  managedName: string | null;
  lastCommand: string | null;
  busy: boolean;
  paneClass: ManagedPaneClass | null;
  lastUsedAt: number | null;
  lastExitCode: number | null;
  agentId: string | null;
  /** Pid of the sidemux server that last wrote this pane's metadata. */
  serverPid: number | null;
  /** Agent-supplied context for the pane's current run ("<stage> due to <reason>"). */
  description: string | null;
}

export interface WindowInfo {
  sessionName: string;
  windowIndex: string;
  windowId: string;
  windowName: string;
  activePaneId: string;
  agentId: string | null;
  serverPid: number | null;
  lastSeenAt: number | null;
  /** Encoded token-savings stats written by the owning server (JSON). */
  statsJson: string | null;
}

export interface Job {
  jobId: string;
  paneId: string;
  command: string;
  startedAt: number;
  /** Absolute line count in the pane when the job was launched (cursor baseline). */
  baselineLines: number;
  status: JobStatus;
  exitCode: number | null;
  /**
   * Absolute path of the job's full-output log file (pipe-pane tee), or null
   * when logging could not be set up. The file survives pane history-limit
   * truncation and pane teardown.
   */
  logFile: string | null;
}
