import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { loadConfig } from "../../src/config.js";
import { runLogCommand } from "../../src/log-cli.js";

function sink(): { stream: NodeJS.WritableStream; text: () => string } {
  let out = "";
  return {
    stream: {
      write: (chunk: string) => ((out += chunk), true),
    } as unknown as NodeJS.WritableStream,
    text: () => out,
  };
}

// A failed job's raw log: colored output, a spinner redrawing via \r, then
// the actual error — the shape from github#36 where direct grep returned
// spinner frames.
const RAW =
  "pnpm nx run demo:format; printf sentinel\r\n" +
  "\x1b[32m>\x1b[0m starting\r\n" +
  "⠋ nx run demo:format\r⠙ nx run demo:format\r⠹ nx run demo:format\r✖ nx run demo:format\r\n" +
  "\x1b[31mERROR\x1b[0m src/app.ts is unformatted\r\n";

describe("sidemux log CLI (github#36)", () => {
  test("prints display-ready text: escapes stripped, spinner collapsed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smux-logcli-"));
    await writeFile(join(dir, "jabc123.log"), RAW);
    const config = loadConfig({ SIDEMUX_LOG_DIR: dir });
    const stdout = sink();

    const code = await runLogCommand(["jabc123"], config, stdout.stream);

    expect(code).toBe(0);
    const text = stdout.text();
    expect(text).toContain("ERROR src/app.ts is unformatted");
    // CR overwrites collapse to the final frame, like on screen.
    expect(text).toContain("✖ nx run demo:format");
    expect(text).not.toContain("⠋");
    expect(text).not.toContain("\x1b[");
  });

  test("accepts an absolute path and errors cleanly on a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "smux-logcli-"));
    await writeFile(join(dir, "direct.log"), "plain line\r\n");
    const config = loadConfig({ SIDEMUX_LOG_DIR: dir });

    const ok = sink();
    expect(
      await runLogCommand([join(dir, "direct.log")], config, ok.stream),
    ).toBe(0);
    expect(ok.text()).toContain("plain line");

    const err = sink();
    expect(
      await runLogCommand(["jnosuch"], config, sink().stream, err.stream),
    ).toBe(1);
    expect(err.text()).toContain("cannot read");
  });

  test("no argument prints usage and exits 2", async () => {
    const err = sink();
    const config = loadConfig({});
    expect(await runLogCommand([], config, sink().stream, err.stream)).toBe(2);
    expect(err.text()).toContain("usage: sidemux log");
  });
});
