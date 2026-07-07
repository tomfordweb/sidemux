import { describe, expect, test } from "vitest";
import { parseCommands, runBenchmark } from "../../src/bench/run.js";

class FakeOut {
  text = "";
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

const out = (fake: FakeOut): NodeJS.WritableStream =>
  fake as unknown as NodeJS.WritableStream;

describe("parseCommands", () => {
  test("collects repeated --command values in order", () => {
    expect(
      parseCommands(["--command", "pnpm test", "--command", "pnpm lint"]),
    ).toEqual({
      commands: ["pnpm test", "pnpm lint"],
      help: false,
    });
  });

  test("supports the --command=value form", () => {
    expect(parseCommands(["--command=pnpm build"])).toEqual({
      commands: ["pnpm build"],
      help: false,
    });
  });

  test("mixed forms and interleaved flags all land in commands", () => {
    expect(
      parseCommands(["--command=a", "--command", "b", "--command=c"]),
    ).toEqual({
      commands: ["a", "b", "c"],
      help: false,
    });
  });

  test("--help and -h set the help flag", () => {
    expect(parseCommands(["--help"])).toEqual({ commands: [], help: true });
    expect(parseCommands(["-h", "--command", "x"])).toEqual({
      commands: ["x"],
      help: true,
    });
  });

  test("a trailing --command without a value is ignored", () => {
    expect(parseCommands(["--command"])).toEqual({ commands: [], help: false });
  });

  test("an empty --command= value is ignored", () => {
    expect(parseCommands(["--command="])).toEqual({
      commands: [],
      help: false,
    });
  });

  test("unknown arguments are skipped", () => {
    expect(parseCommands(["--verbose", "stray", "--command", "x"])).toEqual({
      commands: ["x"],
      help: false,
    });
  });
});

describe("runBenchmark argument handling", () => {
  test("--help prints usage and exits 0 without touching tmux", async () => {
    const fake = new FakeOut();
    const code = await runBenchmark({
      entry: "/nonexistent/entry.js",
      cwd: "/tmp",
      argv: ["--help"],
      out: out(fake),
    });
    expect(code).toBe(0);
    expect(fake.text).toContain("sidemux benchmark");
    expect(fake.text).toContain('--command "cmd"');
  });

  test("no commands prints usage plus an error and exits 1", async () => {
    const fake = new FakeOut();
    const code = await runBenchmark({
      entry: "/nonexistent/entry.js",
      cwd: "/tmp",
      argv: [],
      out: out(fake),
    });
    expect(code).toBe(1);
    expect(fake.text).toContain("pass at least one --command");
  });
});
