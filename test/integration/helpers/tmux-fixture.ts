import { spawnSync } from "node:child_process";
import { TmuxClient } from "../../../src/tmux/client.js";
import { createTmuxRunner, type TmuxRunner } from "../../../src/tmux/exec.js";

let socketCounter = 0;

export function tmuxAvailable(): boolean {
  try {
    return spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Throwaway tmux server on a private socket (-L) with no user config (-f
 * /dev/null). Unique socket per fixture so test files parallelize safely.
 */
export class TmuxFixture {
  readonly socketName = `smux-test-${process.pid}-${socketCounter++}`;
  readonly run: TmuxRunner = createTmuxRunner({
    socketName: this.socketName,
    configFile: "/dev/null",
  });
  readonly client = new TmuxClient(this.run);
  /** Pane id of the fixture session's first pane. */
  firstPane = "";

  /**
   * Panes run plain `sh` instead of the user's login shell — oh-my-zsh and
   * friends inject update prompts and cd around, which makes tests flaky.
   */
  async start(cwd = process.cwd()): Promise<void> {
    this.firstPane = await this.client.newSession("t", cwd, "sh");
  }

  /** Extra pane in the fixture session, also running plain sh. */
  async newPane(cwd = "/tmp"): Promise<string> {
    return this.client.splitWindow(cwd, this.firstPane, "30%", "sh");
  }

  async stop(): Promise<void> {
    try {
      await this.run(["kill-server"]);
    } catch {
      // server already gone — fine
    }
  }

  /** Poll until predicate is true or timeout; test-side helper only. */
  async until(
    predicate: () => Promise<boolean>,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("fixture: condition not met within timeout");
  }

  /** Capture full visible screen as one string (test assertions). */
  async screen(paneId: string): Promise<string> {
    return (await this.client.capturePane(paneId)).join("\n");
  }
}
