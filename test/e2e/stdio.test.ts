import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { tmuxAvailable } from "../integration/helpers/tmux-fixture.js";

const ROOT = path.resolve(import.meta.dirname, "../..");
const ENTRY = path.join(ROOT, "dist/index.js");
const SOCKET = `smux-e2e-${process.pid}`;

describe.skipIf(!tmuxAvailable())(
  "MCP stdio e2e against the built server",
  () => {
    let client: Client;

    beforeAll(async () => {
      if (!existsSync(ENTRY)) {
        execFileSync("node", ["node_modules/tsup/dist/cli-default.js"], {
          cwd: ROOT,
          stdio: "ignore",
        });
      }
      client = new Client({ name: "e2e", version: "0.0.0" });
      const transport = new StdioClientTransport({
        command: "node",
        args: [ENTRY],
        env: {
          ...process.env,
          SIDEMUX_TMUX_SOCKET: SOCKET,
          SIDEMUX_PANE_SHELL: "sh",
          SIDEMUX_SESSION: "e2e",
          // ensure the server treats itself as OUTSIDE tmux → detached session
          TMUX: "",
          TMUX_PANE: "",
        },
        cwd: ROOT,
      });
      await client.connect(transport);
    }, 60_000);

    afterAll(async () => {
      await client.close();
      try {
        execFileSync("tmux", ["-L", SOCKET, "kill-server"], {
          stdio: "ignore",
        });
      } catch {
        // no server left — fine
      }
    });

    test("exposes the expected tools, each with a teaching description", async () => {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "close_all",
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
      }
    });

    test("full loop: run → structured result → read → list_panes → kill-pane", async () => {
      const run = await client.callTool({
        name: "run",
        arguments: {
          command: "echo e2e-ok",
          description: "e2e probe",
          name: "e2e-job",
          timeout_ms: 15_000,
        },
      });
      expect(run.isError, JSON.stringify(run)).not.toBe(true);
      const runOut = run.structuredContent as {
        job_id: string;
        pane: string;
        status: string;
        exit_code: number;
        tail?: string;
      };
      expect(runOut.status).toBe("done");
      expect(runOut.exit_code).toBe(0);
      // The tail must be in structuredContent — clients that support
      // structured output show only structuredContent to the model (github#3).
      expect(runOut.tail).toContain("e2e-ok");
      expect((run.content as { text: string }[])[0]!.text).toContain("e2e-ok");

      const read = await client.callTool({
        name: "read",
        arguments: { job_id: runOut.job_id, since: "job" },
      });
      const readOut = read.structuredContent as {
        text?: string;
        job_status: string;
      };
      expect(readOut.text).toContain("e2e-ok");
      expect((read.content as { text: string }[])[0]!.text).toContain("e2e-ok");
      expect(readOut.job_status).toBe("done");

      const list = await client.callTool({ name: "list_panes", arguments: {} });
      const listOut = list.structuredContent as {
        panes: { pane: string; managed: boolean }[];
      };
      expect(
        listOut.panes.some((p) => p.pane === runOut.pane && p.managed),
      ).toBe(true);

      const kill = await client.callTool({
        name: "kill",
        arguments: { pane: runOut.pane, mode: "kill-pane" },
      });
      expect((kill.structuredContent as { ok: boolean }).ok).toBe(true);
    });

    test("failing command round-trips its exit code", async () => {
      const run = await client.callTool({
        name: "run",
        arguments: {
          command: 'sh -c "exit 42"',
          description: "e2e failure probe",
          name: "e2e-fail",
          timeout_ms: 15_000,
        },
      });
      expect(run.isError, JSON.stringify(run)).not.toBe(true);
      const out = run.structuredContent as {
        status: string;
        exit_code: number;
      };
      expect(out.status).toBe("failed");
      expect(out.exit_code).toBe(42);
    });

    test("tool errors surface as MCP errors, not crashes", async () => {
      const result = await client.callTool({
        name: "read",
        arguments: { job_id: "j000000", since: "job" },
      });
      expect(result.isError).toBe(true);
    });
  },
);
