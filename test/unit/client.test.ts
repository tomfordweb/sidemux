import { describe, expect, test, vi } from "vitest";
import { TmuxClient } from "../../src/tmux/client.js";
import type { TmuxRunner } from "../../src/tmux/exec.js";

function mockRunner(stdout = ""): { run: TmuxRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: TmuxRunner = vi.fn(async (args: string[]) => {
    calls.push(args);
    return stdout;
  });
  return { run, calls };
}

const PANE_LIST =
  "%3\tmain:1.2\tmain\t1\t2\tcode\tzsh\tzsh\t200x50\t@1\t\t\t\t\t\t\t\t\n" +
  "%0\tmain:1.0\tmain\t1\t0\tcode\tzsh\tzsh\t200x50\t@1\t\t\t\t\t\t\t\t\n";

describe("TmuxClient argument construction", () => {
  test("resolveTarget matches session:window.pane against list-panes", async () => {
    const { run } = mockRunner(PANE_LIST);
    const client = new TmuxClient(run);
    expect(await client.resolveTarget("main:1.2")).toBe("%3");
  });

  test("resolveTarget accepts a live %id and rejects a dead one", async () => {
    const { run } = mockRunner(PANE_LIST);
    const client = new TmuxClient(run);
    expect(await client.resolveTarget("%0")).toBe("%0");
    await expect(client.resolveTarget("%99")).rejects.toThrow(/no such pane/);
  });

  test("resolveTarget rejects unknown targets instead of falling back to active pane", async () => {
    const { run } = mockRunner(PANE_LIST);
    const client = new TmuxClient(run);
    await expect(client.resolveTarget("typo:9.9")).rejects.toThrow(
      /cannot resolve/,
    );
  });

  test("capturePane passes -p -J and optional -S/-E, strips trailing terminator only", async () => {
    const { run, calls } = mockRunner("a\nb\n\n");
    const client = new TmuxClient(run);
    const lines = await client.capturePane("%1", -10, 5);
    expect(calls[0]).toEqual([
      "capture-pane",
      "-p",
      "-J",
      "-t",
      "%1",
      "-S",
      "-10",
      "-E",
      "5",
    ]);
    // interior blank line preserved; only the final terminator dropped
    expect(lines).toEqual(["a", "b", ""]);
  });

  test("capturePane omits -S/-E when not given", async () => {
    const { run, calls } = mockRunner("x\n");
    const client = new TmuxClient(run);
    await client.capturePane("%1");
    expect(calls[0]).toEqual(["capture-pane", "-p", "-J", "-t", "%1"]);
  });

  test("sendLiteral uses -l and -- so leading dashes are safe", async () => {
    const { run, calls } = mockRunner();
    const client = new TmuxClient(run);
    await client.sendLiteral("%2", "--help");
    expect(calls[0]).toEqual(["send-keys", "-t", "%2", "-l", "--", "--help"]);
  });

  test("sendKeys sends named keys", async () => {
    const { run, calls } = mockRunner();
    const client = new TmuxClient(run);
    await client.sendKeys("%2", ["C-c", "Enter"]);
    expect(calls[0]).toEqual(["send-keys", "-t", "%2", "--", "C-c", "Enter"]);
  });

  test("splitWindow always passes -c cwd and -d -P, defaulting to a -v (bottom) split", async () => {
    const { run, calls } = mockRunner("%9\n");
    const client = new TmuxClient(run);
    const id = await client.splitWindow("/home/tom/project", "%0");
    expect(id).toBe("%9");
    expect(calls[0]).toEqual([
      "split-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-l",
      "30%",
      "-c",
      "/home/tom/project",
      "-e",
      "NX_TUI=false",
      "-v",
      "-t",
      "%0",
    ]);
  });

  test("splitWindow maps direction to -h/-v and -b", async () => {
    const dirFlags = async (direction: "right" | "left" | "top" | "bottom") => {
      const { run, calls } = mockRunner("%9\n");
      await new TmuxClient(run).splitWindow(
        "/wd",
        "%0",
        "30%",
        undefined,
        direction,
      );
      return calls[0]!.filter((a) => a === "-h" || a === "-v" || a === "-b");
    };
    expect(await dirFlags("right")).toEqual(["-h"]);
    expect(await dirFlags("left")).toEqual(["-h", "-b"]);
    expect(await dirFlags("bottom")).toEqual(["-v"]);
    expect(await dirFlags("top")).toEqual(["-v", "-b"]);
  });

  test("paneWindow queries the window id of a pane", async () => {
    const { run, calls } = mockRunner("@3\n");
    const client = new TmuxClient(run);
    expect(await client.paneWindow("%7")).toBe("@3");
    expect(calls[0]).toEqual([
      "display-message",
      "-p",
      "-t",
      "%7",
      "#{window_id}",
    ]);
  });

  test("setWindowOption / unsetWindowOption use set -w (and -u to clear)", async () => {
    const { run, calls } = mockRunner();
    const client = new TmuxClient(run);
    await client.setWindowOption("@3", "pane-border-status", "top");
    expect(calls[0]).toEqual([
      "set-option",
      "-w",
      "-t",
      "@3",
      "pane-border-status",
      "top",
    ]);
    await client.unsetWindowOption("@3", "pane-border-status");
    expect(calls[1]).toEqual([
      "set-option",
      "-w",
      "-u",
      "-t",
      "@3",
      "pane-border-status",
    ]);
  });

  test("newWindow adds -n only when a window name is given", async () => {
    const { run: r1, calls: c1 } = mockRunner("%20\n");
    await new TmuxClient(r1).newWindow("0", "/wd", "sh", "smux");
    expect(c1[0]).toEqual([
      "new-window",
      "-d",
      "-P",
      "-F",
      "#{pane_id}",
      "-e",
      "NX_TUI=false",
      "-n",
      "smux",
      "-t",
      "0",
      "-c",
      "/wd",
      "sh",
    ]);
    const { run: r2, calls: c2 } = mockRunner("%21\n");
    await new TmuxClient(r2).newWindow("smux", "/wd");
    expect(c2[0]).not.toContain("-n");
  });

  test("updatePane batches title + option writes into one invocation", async () => {
    const { run, calls } = mockRunner();
    const client = new TmuxClient(run);
    await client.updatePane("%7", "smux:build", [
      { name: "@smux_managed", value: "1" },
      { name: "@smux_last_exit_code", value: null },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "select-pane",
      "-t",
      "%7",
      "-T",
      "smux:build",
      ";",
      "set-option",
      "-p",
      "-t",
      "%7",
      "@smux_managed",
      "1",
      ";",
      "set-option",
      "-p",
      "-u",
      "-t",
      "%7",
      "@smux_last_exit_code",
    ]);
  });

  test("setWindowOptions batches window option writes into one invocation", async () => {
    const { run, calls } = mockRunner();
    const client = new TmuxClient(run);
    await client.setWindowOptions("@3", [
      { name: "@smux_agent_id", value: "agent-1" },
      { name: "@smux_server_pid", value: "123" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "set-option",
      "-w",
      "-t",
      "@3",
      "@smux_agent_id",
      "agent-1",
      ";",
      "set-option",
      "-w",
      "-t",
      "@3",
      "@smux_server_pid",
      "123",
    ]);
  });

  test("newSession passes -c cwd and fixed size", async () => {
    const { run, calls } = mockRunner("%0\n");
    const client = new TmuxClient(run);
    await client.newSession("smux", "/tmp/wd");
    expect(calls[0]).toContain("-c");
    expect(calls[0]![calls[0]!.indexOf("-c") + 1]).toBe("/tmp/wd");
    expect(calls[0]).toContain("new-session");
  });

  test("newSession names the first window when requested", async () => {
    const { run, calls } = mockRunner("%0\n");
    await new TmuxClient(run).newSession("smux", "/tmp/wd", undefined, "main");
    expect(calls[0]).toContain("-n");
    expect(calls[0]![calls[0]!.indexOf("-n") + 1]).toBe("main");
  });

  test("listWindows scopes to an exact session when provided", async () => {
    const { run, calls } = mockRunner(
      "smux\t0\t@1\tmain\t%1\tagent-1\t123\t456\t\n",
    );
    const windows = await new TmuxClient(run).listWindows("smux");
    expect(calls[0]).toEqual([
      "list-windows",
      "-F",
      "#{session_name}\t#{window_index}\t#{window_id}\t#{window_name}\t#{pane_id}\t#{@smux_agent_id}\t#{@smux_server_pid}\t#{@smux_last_seen_at}\t#{@smux_stats}",
      "-t",
      "=smux",
    ]);
    expect(windows).toEqual([
      {
        sessionName: "smux",
        windowIndex: "0",
        windowId: "@1",
        windowName: "main",
        activePaneId: "%1",
        agentId: "agent-1",
        serverPid: 123,
        lastSeenAt: 456,
        statsJson: null,
      },
    ]);
  });

  test("paneExists returns false when runner throws", async () => {
    const run: TmuxRunner = async () => {
      throw new Error("can't find pane");
    };
    const client = new TmuxClient(run);
    expect(await client.paneExists("%99")).toBe(false);
  });

  test("hasSession uses exact-match target", async () => {
    const { run, calls } = mockRunner();
    const client = new TmuxClient(run);
    await client.hasSession("smux");
    expect(calls[0]).toEqual(["has-session", "-t", "=smux"]);
  });

  test("selectPane and zoomPane target the pane id directly", async () => {
    const { run, calls } = mockRunner();
    const client = new TmuxClient(run);
    await client.selectPane("%7");
    await client.zoomPane("%7");
    expect(calls[0]).toEqual(["select-pane", "-t", "%7"]);
    expect(calls[1]).toEqual(["resize-pane", "-Z", "-t", "%7"]);
  });

  test("switchClient targets exactly what caller passes", async () => {
    const { run, calls } = mockRunner();
    const client = new TmuxClient(run);
    await client.switchClient("@4");
    expect(calls[0]).toEqual(["switch-client", "-t", "@4"]);
  });

  test("isZoomed reads the pane's window_zoomed_flag", async () => {
    const { run, calls } = mockRunner("1\n");
    const client = new TmuxClient(run);
    expect(await client.isZoomed("%7")).toBe(true);
    expect(calls[0]).toEqual([
      "display-message",
      "-p",
      "-t",
      "%7",
      "#{window_zoomed_flag}",
    ]);
  });
});
