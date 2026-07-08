import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import type { SidemuxService } from "../../src/service.js";

function stubService(): SidemuxService {
  return {
    run: vi.fn(async () => ({
      job_id: "jabc123",
      pane: "%7",
      status: "done",
      exit_code: 0,
      duration_ms: 42,
      tail: "ok",
      closed: false,
    })),
    wait: vi.fn(async () => ({
      status: "pattern",
      exit_code: null,
      matched_line: "ready on 3000",
      elapsed_ms: 900,
      tail: "ready on 3000",
    })),
    read: vi.fn(async () => ({
      text: "hello",
      lines_returned: 1,
      truncated: false,
      cursor_reset: false,
      job_status: "done",
      exit_code: 0,
    })),
    sendKeys: vi.fn(async () => ({ ok: true as const, pane: "%7" })),
    listPanes: vi.fn(async () => [
      {
        pane: "%7",
        session: "main",
        window: "1",
        tab: "* build",
        name: "build",
        current_command: "node",
        managed: true,
        description: "build gate",
        job_id: "jabc123",
        job_status: "running" as const,
      },
    ]),
    status: vi.fn(async () => ({
      tabs: [
        {
          session: "main",
          window: "1",
          tab: "* build",
          running: 1,
          failed: 0,
          done: 0,
          panes: [],
        },
      ],
    })),
    kill: vi.fn(async () => ({
      ok: true as const,
      pane: "%7",
      mode: "interrupt",
    })),
    closeOwned: vi.fn(async () => ({
      closed: ["%7"],
      skipped: [{ pane: "%8", reason: "running" }],
      count: 1,
      skipped_count: 1,
    })),
    closeAll: vi.fn(async () => ({
      closed: ["%7", "%8"],
      skipped: [],
      count: 2,
      skipped_count: 0,
    })),
  } as unknown as SidemuxService;
}

async function connect(service: SidemuxService): Promise<Client> {
  const server = buildServer(service);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("buildServer", () => {
  let service: SidemuxService;
  let client: Client;

  beforeEach(async () => {
    service = stubService();
    client = await connect(service);
  });

  test("registers the tools with teaching descriptions", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "close_all",
      "close_owned",
      "kill",
      "list_panes",
      "read",
      "run",
      "send_keys",
      "status",
      "wait",
    ]);
    for (const tool of tools) {
      expect(tool.description!.length).toBeGreaterThan(50);
      expect(tool.outputSchema).toBeDefined();
    }
  });

  test("status reports grouped workspace tabs", async () => {
    const result = await client.callTool({ name: "status", arguments: {} });
    expect(service.status).toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      tabs: [{ session: "main", window: "1", running: 1 }],
    });
  });

  test("run applies schema defaults and returns structured + text content", async () => {
    const result = await client.callTool({
      name: "run",
      arguments: { command: "echo hi", description: "echo probe" },
    });
    expect(service.run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "echo hi",
        timeout_ms: 60_000,
        background: false,
        close: false,
      }),
      undefined,
    );
    expect(result.structuredContent).toMatchObject({
      job_id: "jabc123",
      status: "done",
      closed: false,
    });
    const text = (result.content as { text: string }[])[0]!.text;
    expect(text).toContain("done");
    expect(text).toContain("jabc123");
  });

  test("run summary points at wait when still running", async () => {
    (service.run as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      job_id: "jslow01",
      pane: "%7",
      status: "running",
      exit_code: null,
      duration_ms: 60_000,
      tail: "",
      closed: false,
    });
    const result = await client.callTool({
      name: "run",
      arguments: { command: "make", description: "build gate" },
    });
    expect((result.content as { text: string }[])[0]!.text).toContain(
      "call wait",
    );
  });

  test("run without a description is rejected by the schema", async () => {
    const result = await client.callTool({
      name: "run",
      arguments: { command: "echo hi" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain(
      "description",
    );
    expect(service.run).not.toHaveBeenCalled();
  });

  test("run forwards the description to the service", async () => {
    await client.callTool({
      name: "run",
      arguments: {
        command: "pnpm lint",
        description: "lint gate before release",
      },
    });
    expect(service.run).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "pnpm lint",
        description: "lint gate before release",
      }),
      undefined,
    );
  });

  test("run forwards close=true to the service", async () => {
    await client.callTool({
      name: "run",
      arguments: {
        command: "pnpm test",
        description: "test gate",
        close: true,
      },
    });
    expect(service.run).toHaveBeenCalledWith(
      expect.objectContaining({ command: "pnpm test", close: true }),
      undefined,
    );
  });

  test("wait forwards args and reports the matched line", async () => {
    const result = await client.callTool({
      name: "wait",
      arguments: { job_id: "jabc123", until: "pattern", pattern: "ready" },
    });
    expect(service.wait).toHaveBeenCalledWith(
      expect.objectContaining({
        until: "pattern",
        pattern: "ready",
        timeout_ms: 120_000,
      }),
      undefined,
    );
    expect((result.content as { text: string }[])[0]!.text).toContain(
      "ready on 3000",
    );
  });

  test("read defaults to incremental last-read", async () => {
    await client.callTool({ name: "read", arguments: { pane: "%7" } });
    expect(service.read).toHaveBeenCalledWith(
      expect.objectContaining({
        since: "last-read",
        lines: 100,
        context: 2,
        max_bytes: 8192,
      }),
    );
  });

  test("send_keys, list_panes, kill round-trip", async () => {
    const sent = await client.callTool({
      name: "send_keys",
      arguments: { pane: "%7", text: "y", press_enter: true },
    });
    expect(sent.structuredContent).toMatchObject({ ok: true, pane: "%7" });

    const listed = await client.callTool({ name: "list_panes", arguments: {} });
    expect(service.listPanes).toHaveBeenCalledWith(false);
    expect(
      (listed.structuredContent as { panes: unknown[] }).panes,
    ).toHaveLength(1);

    const killed = await client.callTool({
      name: "kill",
      arguments: { pane: "%7" },
    });
    expect(service.kill).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "interrupt" }),
    );
    expect(killed.structuredContent).toMatchObject({ ok: true });
  });

  test("close_all reports how many panes it closed", async () => {
    const result = await client.callTool({ name: "close_all", arguments: {} });
    expect(service.closeAll).toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      closed: ["%7", "%8"],
      count: 2,
    });
    expect((result.content as { text: string }[])[0]!.text).toContain(
      "closed 2 pane(s)",
    );
  });

  test("close_owned skips running panes by default", async () => {
    const result = await client.callTool({
      name: "close_owned",
      arguments: {},
    });
    expect(service.closeOwned).toHaveBeenCalledWith(
      expect.objectContaining({ force: false }),
    );
    expect(result.structuredContent).toMatchObject({
      closed: ["%7"],
      skipped: [{ pane: "%8", reason: "running" }],
      count: 1,
      skipped_count: 1,
    });
  });

  test("run forwards project to the service", async () => {
    await client.callTool({
      name: "run",
      arguments: {
        command: "pnpm test",
        description: "test gate",
        project: "bevvi",
      },
    });
    expect(service.run).toHaveBeenCalledWith(
      expect.objectContaining({ command: "pnpm test", project: "bevvi" }),
      undefined,
    );
  });

  test("service errors surface as MCP tool errors", async () => {
    (service.run as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("refusing to write"),
    );
    const result = await client.callTool({
      name: "run",
      arguments: { command: "x", description: "error probe" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain(
      "refusing to write",
    );
  });

  test("progress token wires a reporter through to the service", async () => {
    await client.callTool(
      { name: "wait", arguments: { job_id: "jabc123" } },
      undefined,
      { onprogress: () => undefined },
    );
    const onProgress = (service.wait as ReturnType<typeof vi.fn>).mock
      .calls[0]![1] as ((ms: number) => void) | undefined;
    expect(onProgress).toBeTypeOf("function");
    // firing the reporter must not throw even if notification delivery fails
    onProgress!(12_000);
  });
});
