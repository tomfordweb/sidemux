import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

const { classifyControlLine, spawnControlWatcher } =
  await import("../../src/tmux/watcher.js");
type WatcherEvent = import("../../src/tmux/watcher.js").WatcherEvent;

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  kill = vi.fn();
}

function start(options: { socketName?: string | null } = {}): {
  child: FakeChild;
  events: WatcherEvent[];
  watcher: ReturnType<typeof spawnControlWatcher>;
} {
  const child = new FakeChild();
  spawnMock.mockReturnValueOnce(child);
  const events: WatcherEvent[] = [];
  const watcher = spawnControlWatcher(
    "smux",
    (event) => events.push(event),
    options,
  );
  return { child, events, watcher };
}

describe("classifyControlLine", () => {
  test("output and extended-output map to an output event with the pane id", () => {
    expect(classifyControlLine("%output %5 some \\033 escaped data")).toEqual({
      type: "output",
      paneId: "%5",
    });
    expect(classifyControlLine("%extended-output %12 0 : data")).toEqual({
      type: "output",
      paneId: "%12",
    });
  });

  test("window and layout notifications map to topology", () => {
    for (const line of [
      "%window-add @3",
      "%window-close @3",
      "%window-renamed @3 new-name",
      "%layout-change @3 b25d,208x60,0,0,4",
      "%session-window-changed $1 @3",
    ]) {
      expect(classifyControlLine(line)).toEqual({ type: "topology" });
    }
  });

  test("command replies and unknown lines are ignored", () => {
    expect(classifyControlLine("%begin 1751800000 1 0")).toBeNull();
    expect(classifyControlLine("%end 1751800000 1 0")).toBeNull();
    expect(classifyControlLine("%exit")).toBeNull();
    expect(classifyControlLine("not a notification")).toBeNull();
  });
});

describe("spawnControlWatcher", () => {
  test("attaches a read-only ignore-size control client to the exact session", () => {
    start();
    expect(spawnMock).toHaveBeenCalledWith(
      "tmux",
      ["-C", "attach-session", "-t", "=smux", "-f", "read-only,ignore-size"],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
  });

  test("prefixes -L when a socket name is configured", () => {
    start({ socketName: "test-sock" });
    expect(spawnMock).toHaveBeenLastCalledWith(
      "tmux",
      expect.arrayContaining(["-L", "test-sock"]),
      expect.anything(),
    );
  });

  test("emits events per complete line, buffering partial chunks", () => {
    const { child, events } = start();
    child.stdout.write("%output %5 par");
    expect(events).toEqual([]);
    child.stdout.write("tial\n%window-add @2\n%begin 1 2 0\n");
    expect(events).toEqual([
      { type: "output", paneId: "%5" },
      { type: "topology" },
    ]);
  });

  test("child exit reports died exactly once", () => {
    const { child, events } = start();
    child.emit("exit", 1);
    child.emit("error", new Error("boom"));
    expect(events).toEqual([{ type: "died" }]);
  });

  test("kill() terminates the child and suppresses the died event", () => {
    const { child, events, watcher } = start();
    watcher.kill();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("exit", 0);
    expect(events).toEqual([]);
  });
});
