import { describe, expect, test, vi } from "vitest";
import { loadConfig } from "../../src/config.js";
import { PaneAllocator } from "../../src/core/panes.js";
import type { OptionWrite, TmuxClient } from "../../src/tmux/client.js";
import { decodeOptionValue } from "../../src/tmux/formats.js";

function stubClient(overrides: Partial<TmuxClient> = {}): TmuxClient {
  let counter = 10;
  let windowCounter = 1;
  const panes = new Map<
    string,
    {
      paneId: string;
      target: string;
      title: string;
      currentCommand: string;
      width: number;
      height: number;
      windowId: string;
      cwd: string;
      options: Record<string, string>;
    }
  >();
  const windows = new Map<
    string,
    {
      sessionName: string;
      windowIndex: string;
      windowId: string;
      windowName: string;
      options: Record<string, string>;
    }
  >();
  const createPane = async (
    cwd: string,
    windowName?: string,
    windowId?: string,
  ) => {
    const paneId = `%${counter++}`;
    let wid = windowId;
    if (!wid) {
      wid = `@${windowCounter++}`;
      windows.set(wid, {
        sessionName: "smux",
        windowIndex: String(windows.size),
        windowId: wid,
        windowName: windowName ?? `w${windows.size}`,
        options: {},
      });
    }
    const windowIndex = windows.get(wid)?.windowIndex ?? "0";
    panes.set(paneId, {
      paneId,
      target: `smux:${windowIndex}.0`,
      title: "",
      currentCommand: "sh",
      width: 100,
      height: 30,
      windowId: wid,
      cwd,
      options: {},
    });
    return paneId;
  };
  return {
    resolveTarget: vi.fn(async (t: string) => {
      if (panes.has(t)) {
        return t;
      }
      for (const pane of panes.values()) {
        if (pane.target === t) {
          return pane.paneId;
        }
      }
      return t;
    }),
    paneExists: vi.fn(async (t: string) => panes.has(t)),
    panePath: vi.fn(
      async (paneId: string) => panes.get(paneId)?.cwd ?? "/somewhere",
    ),
    splitWindow: vi.fn(async (cwd: string) => createPane(cwd)),
    splitWindowInWindow: vi.fn(
      async (_session: string, windowIndex: string, cwd: string) => {
        const host = [...windows.values()].find(
          (w) => w.windowIndex === windowIndex,
        );
        return createPane(cwd, undefined, host?.windowId);
      },
    ),
    newSession: vi.fn(
      async (
        _session: string,
        cwd: string,
        _shell?: string,
        windowName?: string,
      ) => createPane(cwd, windowName),
    ),
    newWindow: vi.fn(
      async (
        _session: string,
        cwd: string,
        _shell?: string,
        windowName?: string,
      ) => createPane(cwd, windowName),
    ),
    hasSession: vi.fn(async (sessionName: string) =>
      [...windows.values()].some(
        (window) => window.sessionName === sessionName,
      ),
    ),
    listPanes: vi.fn(async () =>
      [...panes.values()].map((pane) => ({
        paneId: pane.paneId,
        target: pane.target,
        sessionName: pane.target.split(":")[0]!,
        windowIndex: pane.target.split(":")[1]?.split(".")[0] ?? "0",
        windowName: windows.get(pane.windowId)?.windowName ?? "",
        title: pane.title,
        currentCommand: pane.currentCommand,
        width: pane.width,
        height: pane.height,
        windowId: pane.windowId,
        managed:
          pane.options["@smux_managed"] === "1" ||
          pane.title.startsWith("smux:"),
        managedName: pane.options["@smux_name"]
          ? decodeOptionValue(pane.options["@smux_name"])
          : null,
        lastCommand: pane.options["@smux_last_command"]
          ? decodeOptionValue(pane.options["@smux_last_command"])
          : null,
        busy: pane.options["@smux_busy"] === "1",
        paneClass:
          pane.options["@smux_class"] === "persistent" ||
          pane.options["@smux_class"] === "oneshot"
            ? pane.options["@smux_class"]
            : null,
        lastUsedAt: pane.options["@smux_last_used_at"]
          ? Number.parseInt(pane.options["@smux_last_used_at"], 10)
          : null,
        lastExitCode: pane.options["@smux_last_exit_code"]
          ? Number.parseInt(pane.options["@smux_last_exit_code"], 10)
          : null,
        agentId: pane.options["@smux_agent_id"] ?? null,
        serverPid: pane.options["@smux_server_pid"]
          ? Number.parseInt(pane.options["@smux_server_pid"], 10)
          : null,
      })),
    ),
    listWindows: vi.fn(async (_session?: string) =>
      [...windows.values()].map((window) => ({
        ...window,
        activePaneId:
          [...panes.values()].find((pane) => pane.windowId === window.windowId)
            ?.paneId ?? "%0",
        agentId: window.options["@smux_agent_id"] ?? null,
        serverPid: window.options["@smux_server_pid"]
          ? Number.parseInt(window.options["@smux_server_pid"], 10)
          : null,
        lastSeenAt: window.options["@smux_last_seen_at"]
          ? Number.parseInt(window.options["@smux_last_seen_at"], 10)
          : null,
      })),
    ),
    setPaneTitle: vi.fn(async (paneId: string, title: string) => {
      const pane = panes.get(paneId);
      if (pane) {
        pane.title = title;
      }
    }),
    setPaneOption: vi.fn(
      async (paneId: string, name: string, value: string) => {
        const pane = panes.get(paneId);
        if (pane) {
          pane.options[name] = value;
        }
      },
    ),
    unsetPaneOption: vi.fn(async (paneId: string, name: string) => {
      const pane = panes.get(paneId);
      if (pane) {
        delete pane.options[name];
      }
    }),
    updatePane: vi.fn(
      async (paneId: string, title: string, options: OptionWrite[]) => {
        const pane = panes.get(paneId);
        if (!pane) {
          return;
        }
        pane.title = title;
        for (const option of options) {
          if (option.value === null) {
            delete pane.options[option.name];
          } else {
            pane.options[option.name] = option.value;
          }
        }
      },
    ),
    paneWindow: vi.fn(
      async (paneId: string) => panes.get(paneId)?.windowId ?? "@1",
    ),
    setWindowOption: vi.fn(
      async (windowId: string, name: string, value: string) => {
        const window = windows.get(windowId);
        if (window) {
          window.options[name] = value;
        }
      },
    ),
    setWindowOptions: vi.fn(
      async (windowId: string, options: OptionWrite[]) => {
        const window = windows.get(windowId);
        if (!window) {
          return;
        }
        for (const option of options) {
          if (option.value === null) {
            delete window.options[option.name];
          } else {
            window.options[option.name] = option.value;
          }
        }
      },
    ),
    unsetWindowOption: vi.fn(async (windowId: string, name: string) => {
      const window = windows.get(windowId);
      if (window) {
        delete window.options[name];
      }
    }),
    renameWindow: vi.fn(async (windowId: string, name: string) => {
      const window = windows.get(windowId);
      if (window) {
        window.windowName = name;
      }
    }),
    switchClient: vi.fn(async () => undefined),
    bindKey: vi.fn(async () => undefined),
    killPane: vi.fn(async (paneId: string) => {
      panes.delete(paneId);
    }),
    killWindow: vi.fn(async (windowId: string) => {
      windows.delete(windowId);
      for (const [paneId, pane] of panes) {
        if (pane.windowId === windowId) {
          panes.delete(paneId);
        }
      }
    }),
    ...overrides,
  } as unknown as TmuxClient;
}

const HOUR_MS = 60 * 60 * 1000;

/** Backdate a pane's last-used timestamp so TTL-based trimming sees it as old. */
async function backdate(
  client: TmuxClient,
  paneId: string,
  ageMs: number,
): Promise<void> {
  await client.setPaneOption(
    paneId,
    "@smux_last_used_at",
    String(Date.now() - ageMs),
  );
}

describe("PaneAllocator", () => {
  test("refuses to write to the agent's own pane", async () => {
    const allocator = new PaneAllocator(
      stubClient(),
      loadConfig({}),
      { TMUX: "/tmp/tmux-1000/default,123,0", TMUX_PANE: "%1" },
      "/proj",
    );
    expect(() => {
      allocator.guardWrite("%1");
    }).toThrow(/agent's own pane/);
    expect(() => {
      allocator.guardWrite("%2");
    }).not.toThrow();
  });

  test("managed-only mode refuses foreign panes but allows managed ones", async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_MANAGED_ONLY: "1" }),
      { TMUX: "x", TMUX_PANE: "%1" },
      "/proj",
    );
    expect(() => {
      allocator.guardWrite("%9");
    }).toThrow(/SIDEMUX_MANAGED_ONLY/);
    const acquired = await allocator.acquire({ name: "build" });
    expect(() => {
      allocator.guardWrite(acquired.paneId);
    }).not.toThrow();
  });

  test("creates the configured detached workspace session", async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
      {},
      "/proj",
    );
    const acquired = await allocator.acquire({});
    expect(acquired.created).toBe(true);
    expect(client.newSession).toHaveBeenCalledWith(
      "smux",
      "/proj",
      undefined,
      "agent-1",
    );
  });

  test("existing workspace session gets a new window per agent", async () => {
    const client = stubClient({ hasSession: vi.fn(async () => true) });
    const allocator = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
      {},
      "/proj",
    );
    await allocator.acquire({});
    expect(client.newWindow).toHaveBeenCalledWith(
      "smux",
      "/proj",
      undefined,
      "agent-1",
    );
  });

  test("groups multiple pane names under the same agent window", async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
      {},
      "/proj",
    );

    await allocator.acquire({ name: "lint" });
    const second = await allocator.acquire({ name: "build" });

    expect(second.paneId).toBe("%11");
    expect(client.newSession).toHaveBeenCalledTimes(1);
    expect(client.newWindow).not.toHaveBeenCalled();
    expect(client.splitWindowInWindow).toHaveBeenCalledWith(
      "smux",
      "0",
      "/proj",
      undefined,
    );
  });

  test("creates a separate window for another agent", async () => {
    const client = stubClient();
    const firstAgent = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
      {},
      "/proj",
    );
    const secondAgent = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_AGENT_ID: "agent-2" }),
      {},
      "/proj",
    );

    await firstAgent.acquire({ name: "lint" });
    await secondAgent.acquire({ name: "lint" });

    expect(client.newSession).toHaveBeenCalledTimes(1);
    expect(client.newWindow).toHaveBeenCalledWith(
      "smux",
      "/proj",
      undefined,
      "agent-2",
    );
  });

  test("explicit cwd param beats the default", async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
    await allocator.acquire({ cwd: "/elsewhere" });
    expect(client.newSession).toHaveBeenCalledWith(
      "smux",
      "/elsewhere",
      undefined,
      expect.any(String),
    );
  });

  test("pane header title carries the command and pane id", async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
    await allocator.acquire({ name: "test", command: "pnpm test" });
    expect(client.updatePane).toHaveBeenCalledWith(
      "%10",
      "smux:test · pnpm test · %10",
      expect.arrayContaining([
        { name: "@smux_label", value: "test · pnpm test · %10" },
      ]),
    );
  });

  test("enables the pane-border header on first create and restores it when empty", async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
    const { paneId } = await allocator.acquire({
      name: "test",
      command: "pnpm test",
    });
    expect(client.setWindowOption).toHaveBeenCalledWith(
      "@1",
      "pane-border-status",
      "top",
    );
    // Format is conditional on sidemux's own @smux_label pane option so it does
    // not label the human's panes — and survives a shell that rewrites pane_title.
    expect(client.setWindowOption).toHaveBeenCalledWith(
      "@1",
      "pane-border-format",
      expect.stringMatching(/#\{\?#\{@smux_label\}/),
    );
    // Themed frames: double lines, dim border, accent on the active pane.
    expect(client.setWindowOption).toHaveBeenCalledWith(
      "@1",
      "pane-border-lines",
      "double",
    );
    expect(client.setWindowOption).toHaveBeenCalledWith(
      "@1",
      "pane-border-style",
      "fg=colour240",
    );
    expect(client.setWindowOption).toHaveBeenCalledWith(
      "@1",
      "pane-active-border-style",
      "fg=colour45",
    );

    await client.killPane(paneId);
    await allocator.remove(paneId); // last managed pane gone → restore
    expect(client.unsetWindowOption).toHaveBeenCalledWith(
      "@1",
      "pane-border-status",
    );
    expect(client.unsetWindowOption).toHaveBeenCalledWith(
      "@1",
      "pane-border-format",
    );
    expect(client.unsetWindowOption).toHaveBeenCalledWith(
      "@1",
      "pane-border-lines",
    );
    expect(client.unsetWindowOption).toHaveBeenCalledWith(
      "@1",
      "pane-border-style",
    );
    expect(client.unsetWindowOption).toHaveBeenCalledWith(
      "@1",
      "pane-active-border-style",
    );
  });

  test("acquire stores the run description in @smux_description and the header label", async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
    await allocator.acquire({
      name: "lint",
      command: "pnpm lint",
      description: "lint gate before release",
    });
    const updates = (
      client.updatePane as ReturnType<typeof vi.fn>
    ).mock.calls.at(-1)!;
    const options = updates[2] as { name: string; value: string | null }[];
    expect(options).toContainEqual({
      name: "@smux_description",
      value: "lint gate before release",
    });
    const label = options.find(
      (option) => option.name === "@smux_label",
    )?.value;
    expect(label).toContain("lint gate before release");
    expect(label).toContain("pnpm lint");
  });

  test("SIDEMUX_PANE_HEADER=0 leaves the window border untouched", async () => {
    const client = stubClient();
    const allocator = new PaneAllocator(
      client,
      loadConfig({ SIDEMUX_PANE_HEADER: "0" }),
      {},
      "/proj",
    );
    await allocator.acquire({ name: "test", command: "pnpm test" });
    expect(client.setWindowOption).not.toHaveBeenCalled();
  });

  describe("reuse (strict affinity)", () => {
    test("a rerun reuses the idle pane that last ran the same command", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");

      const a = await allocator.acquire({ command: "pnpm test" }); // %10
      const b = await allocator.acquire({ command: "pnpm build" }); // %11 (a is busy)
      await allocator.noteFinished(a.paneId, 0);
      await allocator.noteFinished(b.paneId, 0);

      const rerun = await allocator.acquire({ command: "pnpm test" });
      expect(rerun.paneId).toBe(a.paneId);
      expect(rerun.created).toBe(false);
    });

    test("a different command never steals an idle pane — it gets a new one", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");

      const a = await allocator.acquire({ command: "pnpm test" });
      await allocator.noteFinished(a.paneId, 0);

      const other = await allocator.acquire({ command: "pnpm lint" });
      expect(other.paneId).not.toBe(a.paneId);
      expect(other.created).toBe(true);

      // …and the original pane still answers to its own command afterwards.
      await allocator.noteFinished(other.paneId, 0);
      const rerun = await allocator.acquire({ command: "pnpm test" });
      expect(rerun.paneId).toBe(a.paneId);
    });

    test("interleaved distinct commands keep their pane affinity", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");

      const homes = new Map<string, string>();
      for (const command of ["pnpm test", "pnpm lint", "pnpm build"]) {
        const acquired = await allocator.acquire({ command });
        homes.set(command, acquired.paneId);
        await allocator.noteFinished(acquired.paneId, 0);
      }
      for (const command of ["pnpm build", "pnpm test", "pnpm lint"]) {
        const acquired = await allocator.acquire({ command });
        expect(acquired.paneId).toBe(homes.get(command));
        expect(acquired.created).toBe(false);
        await allocator.noteFinished(acquired.paneId, 0);
      }
    });

    test("an explicit name binds to that named pane", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const first = await allocator.acquire({ name: "build" });
      await allocator.noteFinished(first.paneId, 0);
      const second = await allocator.acquire({ name: "build" });
      expect(second.paneId).toBe(first.paneId);
      expect(second.created).toBe(false);
    });

    test("busy managed panes are not reused", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const first = await allocator.acquire({ name: "a" });
      await allocator.setBusy(first.paneId, true);
      const second = await allocator.acquire({ name: "b" });
      expect(second.paneId).not.toBe(first.paneId);
    });

    test("the most-recently-used pane wins when several match", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");

      const older = await allocator.acquire({ name: "dev" });
      const newer = await allocator.acquire({ name: "dev" }); // older is busy → 2nd pane
      await allocator.noteFinished(older.paneId, 0);
      await allocator.noteFinished(newer.paneId, 0);
      await backdate(client, older.paneId, HOUR_MS);

      // A fresh allocator reads timestamps straight from tmux state.
      const fresh = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const reused = await fresh.acquire({ name: "dev" });
      expect(reused.paneId).toBe(newer.paneId);
    });

    test("reuse disabled via config always creates", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_REUSE_PANES: "0" }),
        {},
        "/proj",
      );
      const a = await allocator.acquire({ command: "x" });
      await allocator.noteFinished(a.paneId, 0);
      const b = await allocator.acquire({ command: "x" });
      expect(b.paneId).not.toBe(a.paneId);
    });

    test("commands with tabs and newlines round-trip and still match for reuse", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const command = 'printf "a\tb"\necho done && echo "#{weird}"';

      const first = await allocator.acquire({ command });
      await allocator.noteFinished(first.paneId, 0);

      // A brand-new allocator must rediscover the pane purely from tmux state.
      const fresh = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const reused = await fresh.acquire({ command });
      expect(reused.paneId).toBe(first.paneId);
      expect(reused.created).toBe(false);
    });

    test("reuse ignores panes owned by another agent", async () => {
      const client = stubClient();
      const firstAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
        {},
        "/proj",
      );
      const secondAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-2" }),
        {},
        "/proj",
      );

      const foreign = await firstAgent.acquire({ name: "lint" });
      await firstAgent.noteFinished(foreign.paneId, 0);
      const own = await secondAgent.acquire({ name: "lint" });

      expect(own.paneId).not.toBe(foreign.paneId);
    });

    test("a restarted server in the same cwd reclaims its panes", async () => {
      const client = stubClient();
      const before = new PaneAllocator(
        client,
        loadConfig({}, "/proj"),
        {},
        "/proj",
      );
      const pane = await before.acquire({ command: "pnpm test" });
      await before.noteFinished(pane.paneId, 0);

      // Same project directory, fresh process: the cwd-derived agent id matches.
      const after = new PaneAllocator(
        client,
        loadConfig({}, "/proj"),
        {},
        "/proj",
      );
      expect(await after.hasManagedPane(pane.paneId)).toBe(true);
      const reused = await after.acquire({ command: "pnpm test" });
      expect(reused.paneId).toBe(pane.paneId);
      expect(reused.created).toBe(false);
    });

    test("a stale busy pane from a dead server becomes reusable", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(
        client,
        loadConfig({}, "/proj"),
        {},
        "/proj",
      );
      const pane = await allocator.acquire({ command: "pnpm test" });
      // The owning server "crashed" mid-run: busy stuck at 1, its pid dead.
      await client.setPaneOption(pane.paneId, "@smux_busy", "1");
      await client.setPaneOption(pane.paneId, "@smux_server_pid", "999999999");

      const restarted = new PaneAllocator(
        client,
        loadConfig({}, "/proj"),
        {},
        "/proj",
      );
      const reused = await restarted.acquire({ command: "pnpm test" });
      expect(reused.paneId).toBe(pane.paneId);
      expect(reused.created).toBe(false);
    });
  });

  describe("acquire claims the pane (trim/acquire race)", () => {
    test("acquire marks the pane busy before any launch happens", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const pane = await allocator.acquire({ command: "pnpm test" });
      const listed = await client.listPanes();
      expect(listed.find((p) => p.paneId === pane.paneId)?.busy).toBe(true);
    });

    test("a just-acquired pane survives an aggressive trim", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const pane = await allocator.acquire({ command: "pnpm test" });
      await backdate(client, pane.paneId, HOUR_MS);
      // busy (claimed) → immune even at TTL 0 with no keep-pane hint
      const closed = await allocator.trimIdlePanes(0);
      expect(closed).not.toContain(pane.paneId);
      expect(client.killPane).not.toHaveBeenCalled();
    });

    test("release makes a claimed pane reusable again after a failed launch", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const pane = await allocator.acquire({ command: "pnpm test" });
      await allocator.release(pane.paneId);
      const reused = await allocator.acquire({ command: "pnpm test" });
      expect(reused.paneId).toBe(pane.paneId);
    });
  });

  describe("trimIdlePanes (TTL)", () => {
    test("collects idle one-shot panes past the TTL, keeps recent ones", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const old = await allocator.acquire({ command: "pnpm test" });
      const recent = await allocator.acquire({ command: "pnpm lint" });
      await allocator.noteFinished(old.paneId, 0);
      await allocator.noteFinished(recent.paneId, 0);
      await backdate(client, old.paneId, HOUR_MS);

      const closed = await allocator.trimIdlePanes(30 * 60 * 1000);
      expect(closed).toEqual([old.paneId]);
      expect(await client.paneExists(recent.paneId)).toBe(true);
    });

    test("collects failed panes past the TTL too", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const failed = await allocator.acquire({ command: "pnpm test" });
      await allocator.noteFinished(failed.paneId, 1);
      await backdate(client, failed.paneId, HOUR_MS);

      const closed = await allocator.trimIdlePanes(30 * 60 * 1000);
      expect(closed).toEqual([failed.paneId]);
    });

    test("never touches busy or persistent panes", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const busy = await allocator.acquire({ command: "pnpm dev" });
      const persistent = await allocator.acquire({ command: "pnpm watch" });
      await allocator.noteLaunch(persistent.paneId, {
        name: "watch",
        command: "pnpm watch",
        paneClass: "persistent",
      });
      await allocator.noteFinished(persistent.paneId, 0);
      await backdate(client, busy.paneId, HOUR_MS);
      await backdate(client, persistent.paneId, HOUR_MS);

      const closed = await allocator.trimIdlePanes(0);
      expect(closed).toEqual([]);
    });

    test("never touches another agent's panes", async () => {
      const client = stubClient();
      const firstAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
        {},
        "/proj",
      );
      const secondAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-2" }),
        {},
        "/proj",
      );

      const foreign = await firstAgent.acquire({ command: "pnpm test" });
      await firstAgent.noteFinished(foreign.paneId, 0);
      await backdate(client, foreign.paneId, HOUR_MS);

      const closed = await secondAgent.trimIdlePanes(0);
      expect(closed).toEqual([]);
      expect(await client.paneExists(foreign.paneId)).toBe(true);
    });

    test("keepPaneId shields the just-used pane even past the TTL", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const pane = await allocator.acquire({ command: "pnpm test" });
      await allocator.noteFinished(pane.paneId, 0);
      await backdate(client, pane.paneId, HOUR_MS);

      const closed = await allocator.trimIdlePanes(0, pane.paneId);
      expect(closed).toEqual([]);
    });
  });

  describe("garbage collection", () => {
    test("startup keybind scheduling does not wait for garbage collection", async () => {
      const client = stubClient({
        listWindows: vi.fn(() => new Promise(() => undefined)) as never,
        listPanes: vi.fn(() => new Promise(() => undefined)) as never,
      });
      const allocator = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
        {},
        "/proj",
      );

      await expect(
        allocator.ensureWorkspaceKeybinds(),
      ).resolves.toBeUndefined();
      expect(client.bindKey).toHaveBeenCalledTimes(1);
    });

    test("kills stale idle agent windows whose server pid is dead", async () => {
      const client = stubClient();
      const firstAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
        {},
        "/proj",
      );
      const pane = await firstAgent.acquire({ name: "lint" });
      await firstAgent.noteFinished(pane.paneId, 0);
      await client.setWindowOption("@1", "@smux_server_pid", "0");

      const secondAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-2" }),
        {},
        "/proj",
      );
      await secondAgent.acquire({ name: "build" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(client.killWindow).toHaveBeenCalledWith("@1");
    });

    test("skips windows with a genuinely busy pane (live server pid)", async () => {
      const client = stubClient();
      const firstAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
        {},
        "/proj",
      );
      const stale = await firstAgent.acquire({ name: "lint" });
      await firstAgent.setBusy(stale.paneId, true);
      // The pane's own server is still alive, only the window pid is stale.
      await client.setPaneOption(
        stale.paneId,
        "@smux_server_pid",
        String(process.pid),
      );
      await client.setWindowOption("@1", "@smux_server_pid", "0");

      const secondAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-2" }),
        {},
        "/proj",
      );
      await secondAgent.acquire({ name: "build" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(client.killWindow).not.toHaveBeenCalledWith("@1");
    });

    test("tolerates stale windows already gone", async () => {
      const client = stubClient({
        killWindow: vi.fn(async () => {
          throw new Error("can't find window: @1");
        }),
      });
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const firstAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
        {},
        "/proj",
      );
      const pane = await firstAgent.acquire({ name: "lint" });
      await firstAgent.noteFinished(pane.paneId, 0);
      await client.setWindowOption("@1", "@smux_server_pid", "0");

      const secondAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-2" }),
        {},
        "/proj",
      );
      await secondAgent.acquire({ name: "build" });
      await new Promise((resolve) => setImmediate(resolve));

      expect(client.killWindow).toHaveBeenCalledWith("@1");
      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    });
  });

  describe("workspace keybind", () => {
    test("default Prefix e opens the first-party dashboard", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      await allocator.acquire({ name: "test" });

      expect(client.bindKey).toHaveBeenCalledTimes(1);
      const binding = vi.mocked(client.bindKey).mock.calls[0]?.[0];
      // run-shell wrapper: display-popup does not format-expand its command,
      // so #{client_tty} must resolve before the popup opens.
      expect(binding?.slice(0, 5)).toEqual([
        "-T",
        "prefix",
        "e",
        "run-shell",
        "-b",
      ]);

      const command = binding?.at(-1) ?? "";
      expect(command).toContain(
        "display-popup -c '#{client_tty}' -E -w 96% -h 92% -x C -y C",
      );
      expect(command).toContain("SIDEMUX_CLIENT_TTY='#{client_tty}'");
      expect(command).toContain("SIDEMUX_SESSION='smux'");
      expect(command).toContain(`'${process.execPath}'`);
      expect(command).toContain(`'${process.argv[1]}'`);
      expect(command).toContain("dashboard");
      expect(command).not.toContain("fzf");
      expect(command).not.toContain("choose-tree");
    });

    test("dashboard key is configurable", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_DASHBOARD_KEY: "s" }),
        {},
        "/proj",
      );
      await allocator.acquire({ name: "test" });

      const binding = vi.mocked(client.bindKey).mock.calls[0]?.[0];
      expect(binding?.slice(0, 5)).toEqual([
        "-T",
        "prefix",
        "s",
        "run-shell",
        "-b",
      ]);
      expect(binding?.at(-1)).toContain("display-popup -c '#{client_tty}' -E");
    });

    test("keybind can be installed on process startup before a run", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");

      await allocator.ensureWorkspaceKeybinds();

      expect(client.bindKey).toHaveBeenCalledTimes(1);
      const command =
        vi.mocked(client.bindKey).mock.calls[0]?.[0]?.at(-1) ?? "";
      expect(command).toContain("SIDEMUX_SESSION='smux'");
      expect(command).toContain("dashboard");
    });

    test("keybind carries tmux socket into dashboard process", async () => {
      const client = stubClient();
      const allocator = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_TMUX_SOCKET: "sidemux-test" }),
        {},
        "/proj",
      );

      await allocator.ensureWorkspaceKeybinds();

      const command =
        vi.mocked(client.bindKey).mock.calls[0]?.[0]?.at(-1) ?? "";
      expect(command).toContain("SIDEMUX_SESSION='smux'");
      expect(command).toContain("SIDEMUX_TMUX_SOCKET='sidemux-test'");
      // The nested display-popup call must hit the same tmux server.
      expect(command).toContain("tmux -L 'sidemux-test' display-popup");
      expect(command).toContain("dashboard");
    });

    test("keybind retries after a failed bind", async () => {
      const client = stubClient({
        bindKey: vi
          .fn()
          .mockRejectedValueOnce(new Error("tmux busy"))
          .mockResolvedValue(undefined),
      });
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");

      await expect(allocator.ensureWorkspaceKeybinds()).rejects.toThrow(
        "tmux busy",
      );
      await allocator.ensureWorkspaceKeybinds();

      expect(client.bindKey).toHaveBeenCalledTimes(2);
    });

    test("rediscovering managed panes after restart refreshes the dashboard keybind", async () => {
      const client = stubClient();
      const beforeRestart = new PaneAllocator(
        client,
        loadConfig({}),
        {},
        "/proj",
      );
      const pane = await beforeRestart.acquire({
        name: "test",
        command: "pnpm test",
      });
      vi.mocked(client.bindKey).mockClear();

      const afterRestart = new PaneAllocator(
        client,
        loadConfig({}),
        {},
        "/proj",
      );
      expect(await afterRestart.hasManagedPane(pane.paneId)).toBe(true);

      expect(client.bindKey).toHaveBeenCalledTimes(1);
    });
  });

  describe("ownership scope", () => {
    test("close_all scope ignores panes owned by another agent", async () => {
      const client = stubClient();
      const firstAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
        {},
        "/proj",
      );
      const secondAgent = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-2" }),
        {},
        "/proj",
      );

      const foreign = await firstAgent.acquire({ name: "lint" });
      const own = await secondAgent.acquire({ name: "build" });

      expect(await secondAgent.managedPaneIds()).toEqual([own.paneId]);
      expect(await secondAgent.hasManagedPane(foreign.paneId)).toBe(false);
    });
  });

  describe("resolve", () => {
    test("maps managed name to pane id, falls back to tmux targets", async () => {
      const client = stubClient({ resolveTarget: vi.fn(async () => "%42") });
      const allocator = new PaneAllocator(client, loadConfig({}), {}, "/proj");
      const acquired = await allocator.acquire({ name: "build" });
      expect(await allocator.resolve("build")).toBe(acquired.paneId);
      expect(await allocator.resolve("main:1.0")).toBe("%42");
    });

    test("prefers the tmux-managed name inventory before raw tmux targets", async () => {
      const alive = ["%10", "%11"];
      const client = stubClient({
        listPanes: vi.fn(async () =>
          alive.map((paneId, index) => ({
            paneId,
            target: `main:0.${index}`,
            sessionName: "main",
            windowIndex: "0",
            windowName: "dev",
            title: "smux:dev",
            currentCommand: "sh",
            width: 100,
            height: 30,
            windowId: "@1",
            managed: true,
            managedName: "dev",
            lastCommand: null,
            busy: paneId === "%10",
            paneClass: "oneshot" as const,
            lastUsedAt: paneId === "%11" ? 2 : 1,
            lastExitCode: 0,
            agentId: "agent-1",
            serverPid: process.pid,
          })),
        ) as never,
        resolveTarget: vi.fn(async () => "%42"),
      });
      const allocator = new PaneAllocator(
        client,
        loadConfig({ SIDEMUX_AGENT_ID: "agent-1" }),
        { TMUX: "x", TMUX_PANE: "%1" },
        "/proj",
      );
      expect(await allocator.resolve("dev")).toBe("%11");
      expect(await allocator.resolve("main:9.9")).toBe("%42");
    });
  });
});
