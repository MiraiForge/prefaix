// Tool lines are built here, by the adapter, so the renderer never learns a tool
// schema (DESIGN §4.4, §4.5.3). pi reports `toolName` and a free-form `args`
// object, so every field is read defensively: an unexpected shape must produce
// a usable line, never a crash mid-turn.

const MAX_SUMMARY = 120;
const MAX_PREVIEW = 400;

export function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// Tool output is arbitrary bytes. A lone surrogate would break JSON, and a
// control character would garble the line, so both are replaced.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
// eslint-disable-next-line no-control-regex -- control bytes must not reach the wire
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function sanitize(text: string): string {
  return text.replaceAll(LONE_SURROGATE, "�").replaceAll(CONTROL, " ");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "");
  return (line ?? "").trim();
}

function clamp(text: string, limit: number = MAX_SUMMARY): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit - 1)}…`;
}

// The first string value in an object, for a tool prefaix has no rule for.
function firstStringArg(args: Record<string, unknown>): string | undefined {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

export function toolSummary(toolName: string, args: unknown): string {
  const fields =
    typeof args === "object" && args !== null
      ? (args as Record<string, unknown>)
      : {};
  const command = asText(fields["command"]);
  const path =
    asText(fields["path"]) ||
    asText(fields["file_path"]) ||
    asText(fields["filePath"]);
  const pattern = asText(fields["pattern"]) || asText(fields["query"]);

  const line = (() => {
    switch (toolName) {
      case "bash":
      case "shell": {
        const first = firstLine(command);
        // A blank command has nothing to show, so the tool name is drawn
        // instead of a bare "$".
        return first === "" ? "" : `$ ${first}`;
      }
      case "read":
      case "write":
      case "edit":
      case "multi_edit":
      case "notebook_edit":
        return path;
      case "grep":
      case "find":
      case "glob":
      case "ls":
        return pattern === "" ? path : pattern;
      default: {
        const argument = firstStringArg(fields);
        return argument === undefined
          ? toolName
          : `${toolName} ${firstLine(argument)}`;
      }
    }
  })();

  // The renderer needs something to draw, and the contract requires it.
  return clamp(line === "" ? toolName : line);
}

// The preview is the last line of whatever partial result pi has, which is
// where a streaming tool's progress is visible.
export function toolPreview(partialResult: unknown): string | undefined {
  const text = (() => {
    if (typeof partialResult === "string") {
      const last = partialResult.trimEnd().split("\n").at(-1) ?? "";
      return last.trim();
    }
    if (typeof partialResult === "object" && partialResult !== null) {
      const record = partialResult as Record<string, unknown>;
      for (const key of ["output", "stdout", "text", "content", "result"]) {
        const value = record[key];
        if (typeof value === "string" && value.trim() !== "") {
          return value.trimEnd().split("\n").at(-1)?.trim() ?? "";
        }
      }
    }
    return "";
  })();
  return text === "" ? undefined : clamp(sanitize(text), MAX_PREVIEW);
}

function countsOf(
  result: unknown,
): { added?: number; removed?: number } | undefined {
  if (typeof result !== "object" || result === null) {
    return undefined;
  }
  const record = result as Record<string, unknown>;
  const added = record["added"] ?? record["linesAdded"] ?? record["insertions"];
  const removed =
    record["removed"] ?? record["linesRemoved"] ?? record["deletions"];
  if (typeof added !== "number" && typeof removed !== "number") {
    return undefined;
  }
  return {
    ...(typeof added === "number" ? { added } : {}),
    ...(typeof removed === "number" ? { removed } : {}),
  };
}

/** The `tool_end` line: the result's tail, or `+n −m` for an edit. */
export function toolEndSummary(result: unknown): string | undefined {
  const counts = countsOf(result);
  if (counts !== undefined) {
    return `+${counts.added ?? 0} −${counts.removed ?? 0}`;
  }
  if (typeof result === "string" && result.trim() !== "") {
    const line = firstLine(result);
    return line === "" ? undefined : clamp(sanitize(line));
  }
  return undefined;
}
