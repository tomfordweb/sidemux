import { afterEach, describe, expect, test, vi } from "vitest";
import {
  DEFAULT_IDLE_PANE_TTL_MS,
  DEFAULT_LOG_MAX_AGE_MS,
  DEFAULT_LOG_MAX_TOTAL_BYTES,
  incompatibleShellReason,
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
      logMaxAgeMs: DEFAULT_LOG_MAX_AGE_MS,
      logMaxTotalBytes: DEFAULT_LOG_MAX_TOTAL_BYTES,
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
      SIDEMUX_LOG_MAX_AGE_MS: "3600000",
      SIDEMUX_LOG_MAX_TOTAL_BYTES: "1048576",
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
      logMaxAgeMs: 3_600_000,
      logMaxTotalBytes: 1_048_576,
      agentId: "agent-abcdef123456",
      agentLabel: "agent-abcdef",
    });
  });

  test("logDir honors XDG_STATE_HOME when SIDEMUX_LOG_DIR is unset", () => {
    expect(loadConfig({ XDG_STATE_HOME: "/xdg/state" }, "/proj").logDir).toBe(
      "/xdg/state/sidemux/logs",
    );
  });

  test("SIDEMUX_LOG_DIR=off disables job logging", () => {
    for (const value of ["off", "OFF", "0", "false", "none"]) {
      expect(loadConfig({ SIDEMUX_LOG_DIR: value }, "/proj").logDir).toBeNull();
    }
  });

  test("an empty SIDEMUX_LOG_DIR falls through to the default", () => {
    expect(
      loadConfig({ SIDEMUX_LOG_DIR: "  ", XDG_STATE_HOME: "/xdg" }, "/proj")
        .logDir,
    ).toBe("/xdg/sidemux/logs");
  });

  test("log settings fall back to the config file, env still wins", () => {
    const file = {
      logDir: "/file/logs",
      logMaxAgeMs: 1000,
      logMaxTotalBytes: 2000,
    };
    expect(loadConfig({}, "/proj", file)).toMatchObject({
      logDir: "/file/logs",
      logMaxAgeMs: 1000,
      logMaxTotalBytes: 2000,
    });
    expect(
      loadConfig(
        {
          SIDEMUX_LOG_DIR: "/env/logs",
          SIDEMUX_LOG_MAX_AGE_MS: "9",
          SIDEMUX_LOG_MAX_TOTAL_BYTES: "8",
        },
        "/proj",
        file,
      ),
    ).toMatchObject({
      logDir: "/env/logs",
      logMaxAgeMs: 9,
      logMaxTotalBytes: 8,
    });
  });

  test("log_dir = \"off\" in the config file disables logging too", () => {
    expect(loadConfig({}, "/proj", { logDir: "off" }).logDir).toBeNull();
  });

  test("negative and unparseable retention values clamp to defaults", () => {
    expect(loadConfig({ SIDEMUX_LOG_MAX_AGE_MS: "-5" }).logMaxAgeMs).toBe(0);
    expect(loadConfig({ SIDEMUX_LOG_MAX_AGE_MS: "nope" }).logMaxAgeMs).toBe(
      DEFAULT_LOG_MAX_AGE_MS,
    );
    expect(
      loadConfig({ SIDEMUX_LOG_MAX_TOTAL_BYTES: "0" }).logMaxTotalBytes,
    ).toBe(0);
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

  test("recognizes the smaller posix shells the matrix test covers", () => {
    // These all run the launch line correctly, so they should not be treated
    // as unknown foreground programs (which slows the waiter's idle check).
    for (const shell of ["mksh", "yash", "posh", "ash", "busybox", "ksh93"]) {
      expect(shellDialectFromCommand(shell)).toBe("posix");
    }
  });

  test("strips the leading dash a login shell prepends", () => {
    expect(shellDialectFromCommand("-zsh")).toBe("posix");
    expect(incompatibleShellReason("-tcsh")).toContain("tcsh");
  });
});

describe("incompatibleShellReason", () => {
  test("names a reason for shells that cannot evaluate the sentinel", () => {
    for (const shell of ["csh", "tcsh", "nu", "nushell", "xonsh", "elvish"]) {
      expect(incompatibleShellReason(shell)).toEqual(expect.any(String));
    }
    expect(incompatibleShellReason("/usr/bin/tcsh")).toContain("$?");
  });

  test("compatible and merely-unknown commands are not rejected", () => {
    for (const command of ["bash", "zsh", "fish", "dash", "node", "vim"]) {
      expect(incompatibleShellReason(command)).toBeNull();
    }
  });
});
