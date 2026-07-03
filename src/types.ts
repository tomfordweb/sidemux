export type JobStatus = 'running' | 'done' | 'failed' | 'unknown';

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
  title: string;
  currentCommand: string;
  width: number;
  height: number;
  managed: boolean;
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
}
