export interface ShapeOptions {
  /** Tail cap: keep at most this many lines (after grep filtering). */
  lines?: number | undefined;
  /** Regex filter; only matching lines (plus context) are kept. */
  grep?: string | undefined;
  /** Context lines around each grep match. */
  context?: number | undefined;
  /** Hard cap on returned bytes; truncates from the FRONT (newest output wins). */
  maxBytes?: number | undefined;
}

export interface ShapedOutput {
  text: string;
  linesReturned: number;
  truncated: boolean;
  /** Size of the full input region, before any grep/tail/byte-cap shaping. */
  bytesTotal: number;
  /** Size of the text actually returned to the agent. */
  bytesReturned: number;
}

const GAP_MARKER = "···";

function stripTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim() === "") {
    end--;
  }
  return lines.slice(0, end);
}

function applyGrep(
  lines: string[],
  pattern: string,
  context: number,
): string[] {
  const regex = new RegExp(pattern);
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i] ?? "")) {
      for (
        let j = Math.max(0, i - context);
        j <= Math.min(lines.length - 1, i + context);
        j++
      ) {
        keep.add(j);
      }
    }
  }
  const result: string[] = [];
  let previous = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (previous >= 0 && i > previous + 1) {
      result.push(GAP_MARKER);
    }
    result.push(lines[i] ?? "");
    previous = i;
  }
  return result;
}

export function shapeOutput(
  rawLines: string[],
  options: ShapeOptions = {},
): ShapedOutput {
  const { lines: tailCap = 100, grep, context = 2, maxBytes = 8192 } = options;

  let lines = stripTrailingBlanks(rawLines);
  const bytesTotal = Buffer.byteLength(lines.join("\n"), "utf8");
  let truncated = false;

  if (grep !== undefined && grep !== "") {
    lines = applyGrep(lines, grep, context);
  }

  if (lines.length > tailCap) {
    lines = lines.slice(lines.length - tailCap);
    truncated = true;
  }

  let text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    truncated = true;
    // Cut whole lines from the front until under budget; newest output wins.
    while (lines.length > 1 && Buffer.byteLength(text, "utf8") > maxBytes) {
      lines.shift();
      text = lines.join("\n");
    }
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      const buf = Buffer.from(text, "utf8").subarray(-maxBytes);
      text = buf.toString("utf8");
    }
  }

  return {
    text,
    linesReturned: lines.length,
    truncated,
    bytesTotal,
    bytesReturned: Buffer.byteLength(text, "utf8"),
  };
}
