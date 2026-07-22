import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CursorTracker } from "../../src/core/cursor.js";
import { JobManager, scrubOutput } from "../../src/core/jobs.js";
import { waitFor } from "../../src/core/waiter.js";
import { TmuxFixture, tmuxAvailable } from "./helpers/tmux-fixture.js";

/**
 * Regression coverage for issue #5: narrow panes hard-wrap long output
 * mid-word, and every capture sidemux does (read cursor, run/wait tails,
 * pattern scans, sentinel scans) must see logical lines — capture-pane -J —
 * or line-oriented regex/grep silently fails on fragments like
 * "d 353 | sk" / "ipped 36".
 *
 * The fixture session is 200 columns wide, so these tests split off a
 * deliberately narrow pane where a typical progress line wraps 2-4 times.
 *
 * Assertions use "some captured line contains the full logical line" rather
 * than strict equality: when a line ends exactly at the right margin, tmux
 * cannot distinguish it from a wrapped line and -J may join it with the next
 * one (over-join). The contract that matters is that no capture boundary ever
 * SPLITS a logical line.
 */
const LONG_LINE = "scovilled: upserted 353 | skipped 36";

const containsWhole = (lines: string[], needle: string): boolean =>
  lines.some((line) => line.includes(needle));

describe.skipIf(!tmuxAvailable())(
  "wrapped lines in narrow panes (issue #5)",
  () => {
    const fx = new TmuxFixture();
    /** 20 columns: LONG_LINE (36 chars) wraps into two rows. */
    let narrowPane: string;
    let jobs: JobManager;
    let cursor: CursorTracker;

    async function runToCompletion(
      paneId: string,
      command: string,
    ): Promise<void> {
      const job = await jobs.launch(paneId, command, null);
      const result = await waitFor(fx.client, paneId, jobs, job, {
        until: "exit",
        timeoutMs: 10_000,
      });
      expect(result.status).toBe("exit");
      expect(result.exitCode).toBe(0);
    }

    beforeAll(async () => {
      await fx.start("/tmp");
      narrowPane = await fx.client.splitWindow(
        "/tmp",
        fx.firstPane,
        "20",
        "sh",
        "right",
      );
      jobs = new JobManager(fx.client);
      cursor = new CursorTracker();
    });

    afterAll(async () => {
      await fx.stop();
    });

    test("read returns a line longer than the pane width as one logical line", async () => {
      await runToCompletion(narrowPane, `echo '${LONG_LINE}'`);
      const read = await cursor.read(fx.client, narrowPane);
      expect(containsWhole(read.lines, LONG_LINE)).toBe(true);
    });

    test("incremental read (cursor advanced) still joins wrapped lines", async () => {
      await cursor.read(fx.client, narrowPane); // drain
      await runToCompletion(narrowPane, `echo '${LONG_LINE}-second'`);
      const read = await cursor.read(fx.client, narrowPane);
      expect(read.cursorReset).toBe(false);
      expect(containsWhole(read.lines, `${LONG_LINE}-second`)).toBe(true);
    });

    test("wait until=pattern matches a regex spanning the wrap point", async () => {
      const job = await jobs.launch(narrowPane, `echo '${LONG_LINE}-p'`, null);
      // "upserted 353 | sk↵ipped" straddles the 20-column boundary; without
      // -J no single captured row would ever match this.
      const result = await waitFor(fx.client, narrowPane, jobs, job, {
        until: "pattern",
        pattern: "upserted \\d+ \\| skipped \\d+-p",
        timeoutMs: 10_000,
      });
      expect(result.status).toBe("pattern");
      expect(result.matchedLine).toContain(`${LONG_LINE}-p`);
    });

    test("pattern never matches the echoed launch line, even when the echo wraps", async () => {
      // The echoed command wraps across many rows in a narrow pane. Without
      // joining, the fragment holding the pattern would not contain the
      // SENTINEL_MARKER, so the echo-skip filter could not recognize it and
      // the wait would false-positive before the command even runs.
      const job = await jobs.launch(
        narrowPane,
        `sh -c "sleep 0.4; echo needle-in-echo-done"`,
        null,
      );
      const result = await waitFor(fx.client, narrowPane, jobs, job, {
        until: "pattern",
        pattern: "needle-in-echo",
        timeoutMs: 10_000,
      });
      expect(result.status).toBe("pattern");
      expect(result.matchedLine).toContain("needle-in-echo-done");
      expect(result.matchedLine).not.toContain("sleep 0.4");
    });

    test("exit sentinel is detected in a pane so narrow the sentinel itself wraps", async () => {
      // 12 columns: the completed sentinel "<<SMUX:jxxxxxx:0>>" (19 chars)
      // hard-wraps across two rows; parseSentinel only sees it joined.
      const tinyPane = await fx.client.splitWindow(
        "/tmp",
        fx.firstPane,
        "12",
        "sh",
        "right",
      );
      await runToCompletion(tinyPane, "echo tiny-ok");
      await fx.client.killPane(tinyPane);
    });

    test("scrubOutput removes the joined echo and sentinel lines from read output", async () => {
      await cursor.read(fx.client, narrowPane); // drain
      await runToCompletion(narrowPane, `echo '${LONG_LINE}-scrub'`);
      const read = await cursor.read(fx.client, narrowPane);
      const scrubbed = scrubOutput(read.lines);
      expect(containsWhole(scrubbed, `${LONG_LINE}-scrub`)).toBe(true);
      const text = scrubbed.join("\n");
      expect(text).not.toContain("<<SMUX:");
      expect(text).not.toContain("printf");
    });
  },
);
