import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_IDLE_PANE_TTL_MS,
  isKnownShell,
  loadConfig,
  shellDialectFromCommand,
} from "../../src/config.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadConfig", () => {
  test("defaults with empty env", () => {
    const config = loadConfig({}, "/proj");
    expect(config).toEqual({
      sessionName: "smux",
      keybinds: true,
      dashboardKey: "e",
      dashboardDensity: "normal",
      managedOnly: false,
      shell: null,
      socketName: null,
      maxOutputBytes: 8192,
      reusePanes: true,
      paneShell: null,
      paneHeader: true,
      closeOnSuccess: false,
      idlePaneTtlMs: DEFAULT_IDLE_PANE_TTL_MS,
      logDir: expect.stringMatching(/\/sidemux\/logs$/),
      agentId: expect.stringMatching(/^cwd-[0-9a-f]{8}$/),
      agentLabel: expect.stringMatching(/^cwd-[0-9a-f]{8}$/),
    });
  });

  test("reads all SIDEMUX_* vars", () => {
    const config = loadConfig({
      SIDEMUX_SESSION: "work",
      SIDEMUX_KEYBINDS: "0",
      SIDEMUX_DASHBOARD_KEY: "s",
      SIDEMUX_DASHBOARD_DENSITY: "compact",
      SIDEMUX_MANAGED_ONLY: "1",
      SIDEMUX_SHELL: "fish",
      SIDEMUX_TMUX_SOCKET: "mysock",
      SIDEMUX_MAX_OUTPUT_BYTES: "4096",
      SIDEMUX_REUSE_PANES: "0",
      SIDEMUX_PANE_SHELL: "sh",
      SIDEMUX_PANE_HEADER: "0",
      SIDEMUX_CLOSE_ON_SUCCESS: "1",
      SIDEMUX_IDLE_PANE_TTL_MS: "60000",
      SIDEMUX_LOG_DIR: "/var/log/sidemux",
      SIDEMUX_AGENT_ID: "agent-abcdef123456",
    });
    expect(config).toEqual({
      sessionName: "work",
      keybinds: false,
      dashboardKey: "s",
      dashboardDensity: "compact",
      managedOnly: true,
      shell: "fish",
      socketName: "mysock",
      maxOutputBytes: 4096,
      reusePanes: false,
      paneShell: "sh",
      paneHeader: false,
      closeOnSuccess: true,
      idlePaneTtlMs: 60_000,
      logDir: "/var/log/sidemux",
      agentId: "agent-abcdef123456",
      agentLabel: "agent-abcdef",
    });
  });

  test("logDir honors XDG_STATE_HOME when SIDEMUX_LOG_DIR is unset", () => {
    expect(loadConfig({ XDG_STATE_HOME: "/xdg/state" }, "/proj").logDir).toBe(
      "/xdg/state/sidemux/logs",
    );
  });

  test("default agent id is stable per working directory", () => {
    // Same cwd → same id (a restarted server reclaims its panes); different
    // cwd → different id (two projects never share panes).
    expect(loadConfig({}, "/proj").agentId).toBe(
      loadConfig({}, "/proj").agentId,
    );
    expect(loadConfig({}, "/proj").agentId).not.toBe(
      loadConfig({}, "/other").agentId,
    );
  });

  test("explicit agent ids beat the cwd-derived default", () => {
    expect(loadConfig({ SIDEMUX_AGENT_ID: "me" }, "/proj").agentId).toBe("me");
  });

  test("uses CODEX_THREAD_ID when SIDEMUX_AGENT_ID is absent", () => {
    const config = loadConfig({
      CODEX_THREAD_ID: "019f333c-acdd-72f0-8610-58ee1aab1346",
    });
    expect(config.agentId).toBe("019f333c-acdd-72f0-8610-58ee1aab1346");
    expect(config.agentLabel).toBe("019f333c");
  });

  test('closeOnSuccess only when SIDEMUX_CLOSE_ON_SUCCESS is exactly "1"', () => {
    expect(loadConfig({}).closeOnSuccess).toBe(false);
    expect(loadConfig({ SIDEMUX_CLOSE_ON_SUCCESS: "0" }).closeOnSuccess).toBe(
      false,
    );
    expect(
      loadConfig({ SIDEMUX_CLOSE_ON_SUCCESS: "true" }).closeOnSuccess,
    ).toBe(false);
    expect(loadConfig({ SIDEMUX_CLOSE_ON_SUCCESS: "1" }).closeOnSuccess).toBe(
      true,
    );
  });

  test("dashboard density accepts compact/normal/spacious and defaults invalid to normal", () => {
    expect(loadConfig({}).dashboardDensity).toBe("normal");
    expect(
      loadConfig({ SIDEMUX_DASHBOARD_DENSITY: "compact" }).dashboardDensity,
    ).toBe("compact");
    expect(
      loadConfig({ SIDEMUX_DASHBOARD_DENSITY: "SPACIOUS" }).dashboardDensity,
    ).toBe("spacious");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      loadConfig({ SIDEMUX_DASHBOARD_DENSITY: "dense" }).dashboardDensity,
    ).toBe("normal");
    expect(error).toHaveBeenCalledWith(
      'sidemux: ignoring invalid SIDEMUX_DASHBOARD_DENSITY="dense" (use compact|normal|spacious); using normal',
    );
  });

  test("non-fish shell names map to posix dialect", () => {
    expect(loadConfig({ SIDEMUX_SHELL: "zsh" }).shell).toBe("posix");
  });

  test("invalid max bytes falls back to default", () => {
    expect(
      loadConfig({ SIDEMUX_MAX_OUTPUT_BYTES: "nope" }).maxOutputBytes,
    ).toBe(8192);
    expect(loadConfig({ SIDEMUX_MAX_OUTPUT_BYTES: "-5" }).maxOutputBytes).toBe(
      8192,
    );
  });

  test("invalid idle pane TTL falls back to default; 0 disables retention", () => {
    expect(loadConfig({}).idlePaneTtlMs).toBe(DEFAULT_IDLE_PANE_TTL_MS);
    expect(loadConfig({ SIDEMUX_IDLE_PANE_TTL_MS: "-1" }).idlePaneTtlMs).toBe(
      DEFAULT_IDLE_PANE_TTL_MS,
    );
    expect(loadConfig({ SIDEMUX_IDLE_PANE_TTL_MS: "nope" }).idlePaneTtlMs).toBe(
      DEFAULT_IDLE_PANE_TTL_MS,
    );
    expect(loadConfig({ SIDEMUX_IDLE_PANE_TTL_MS: "0" }).idlePaneTtlMs).toBe(0);
  });
});

describe("shell detection", () => {
  test("recognizes posix shells including full paths", () => {
    expect(shellDialectFromCommand("bash")).toBe("posix");
    expect(shellDialectFromCommand("/usr/bin/zsh")).toBe("posix");
    expect(shellDialectFromCommand("sh")).toBe("posix");
  });

  test("recognizes fish", () => {
    expect(shellDialectFromCommand("fish")).toBe("fish");
    expect(shellDialectFromCommand("/opt/homebrew/bin/fish")).toBe("fish");
  });

  test("unknown commands are not shells", () => {
    expect(shellDialectFromCommand("node")).toBeNull();
    expect(isKnownShell("vim")).toBe(false);
    expect(isKnownShell("bash")).toBe(true);
  });
});
