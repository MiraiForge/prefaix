import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "../../src/core/agent-port.js";
import { TurnMapper } from "../../src/agents/pi/mapping.js";
import {
  sanitize,
  toolEndSummary,
  toolPreview,
  toolSummary,
} from "../../src/agents/pi/tool-summaries.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/pi/", import.meta.url));
const CHILD_ONLY = new Set(["child.mjs"]);

export function fixtureNames(): string[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".jsonl"))
    .sort();
}

export function readFixture(name: string): Record<string, unknown>[] {
  return readFileSync(`${FIXTURES}${name}`, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const INTERPRETED = new Set(["delay", "waitForUi", "untilCommand"]);

// The turn banner pi's first record triggers, and the usage figures that ride
// along on its records, are noise for an assertion about one thing.
const mapper = (): TurnMapper => new TurnMapper({ now: () => 0 });
const only = (events: AgentEvent[]): AgentEvent[] =>
  events.filter((event) => event.type !== "turn_start");
const stream = (events: AgentEvent[]): AgentEvent[] =>
  events.filter(
    (event) => event.type !== "turn_start" && event.type !== "usage",
  );

export function replay(
  name: string,
  options: { now?: () => number } = {},
): AgentEvent[] {
  const mapper = new TurnMapper({ now: options.now ?? (() => 0) });
  const out: AgentEvent[] = [];
  for (const record of readFixture(name)) {
    if ([...INTERPRETED].some((key) => key in record)) {
      continue;
    }
    out.push(...mapper.map(record as never));
    if (record["type"] === "agent_settled") {
      out.push(mapper.settle());
    }
  }
  return out;
}

describe("pi fixtures are valid JSONL", () => {
  it("has the cases the contract suite needs", () => {
    expect(fixtureNames()).toEqual([
      "abort.jsonl",
      "compaction.jsonl",
      "dialog.jsonl",
      "error.jsonl",
      "leftovers.jsonl",
      "retry.jsonl",
      "stream.jsonl",
      "tools.jsonl",
    ]);
  });

  it.each(fixtureNames())("%s parses and ends with agent_settled", (name) => {
    const records = readFixture(name);
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      // A sync point tells the child to hold, and carries no pi record type.
      if ([...INTERPRETED].some((key) => key in record)) {
        continue;
      }
      expect(typeof record["type"], `${name} has a typed record`).toBe(
        "string",
      );
    }
    expect(records.at(-1)?.["type"]).toBe("agent_settled");
  });

  it("ships no stray non-JSON lines in the fixture directory", () => {
    for (const entry of readdirSync(FIXTURES)) {
      if (!entry.endsWith(".jsonl") || CHILD_ONLY.has(entry)) {
        continue;
      }
      expect(() => readFixture(entry), entry).not.toThrow();
    }
  });
});

describe("mapping a plain turn", () => {
  const events = replay("stream.jsonl");

  it("announces the turn once and settles once, last", () => {
    expect(events.filter((event) => event.type === "turn_start")).toHaveLength(
      1,
    );
    const settled = events.filter((event) => event.type === "settled");
    expect(settled).toHaveLength(1);
    expect(events.at(-1)).toEqual(settled[0]);
  });

  it("streams one block and ends it", () => {
    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas.map((event) => event.text)).toEqual([
      "Reading the config ",
      "loader now.\n",
    ]);
    expect(events.filter((event) => event.type === "text_end")).toHaveLength(1);
  });

  it("settles with the stop reason from the assistant message", () => {
    expect(events.at(-1)).toEqual({ type: "settled", stopReason: "stop" });
  });

  it("reports usage once, at the end of the message", () => {
    const usage = events.filter((event) => event.type === "usage");
    expect(usage.length).toBeGreaterThan(0);
    const last = usage.at(-1);
    expect(last).toMatchObject({ type: "usage", input: 42, output: 11 });
  });
});

describe("mapping tools", () => {
  const events = replay("tools.jsonl");

  it("pairs every start with an end, in order", () => {
    const starts = events.filter((event) => event.type === "tool_start");
    const ends = events.filter((event) => event.type === "tool_end");
    expect(starts.map((event) => event.id)).toEqual([
      "call_1",
      "call_2",
      "call_3",
    ]);
    expect(ends.map((event) => event.id)).toEqual([
      "call_1",
      "call_2",
      "call_3",
    ]);
  });

  it("marks the failing tool", () => {
    const ends = events.filter((event) => event.type === "tool_end");
    expect(ends.map((event) => event.ok)).toEqual([true, true, false]);
  });

  it("gives every tool a summary the renderer can draw", () => {
    for (const event of events) {
      if (event.type === "tool_start") {
        expect(event.summary).not.toBe("");
      }
    }
  });

  it("keeps a running tool's pairing intact when a block follows", () => {
    const order = events.map((event) => event.type);
    expect(order.indexOf("text_end")).toBeLessThan(order.indexOf("tool_start"));
    expect(order.lastIndexOf("text_end")).toBeGreaterThan(
      order.lastIndexOf("tool_end"),
    );
  });
});

describe("mapping a dialog", () => {
  it("turns a pi select into a ui_request with options", () => {
    const request = replay("dialog.jsonl").find(
      (event) => event.type === "ui_request",
    );
    expect(request).toEqual({
      type: "ui_request",
      id: "u1",
      kind: "select",
      title: "Which branch?",
      message: "Two branches match.",
      options: ["main", "release/2.1"],
    });
  });

  it("gives each dialog its own id, so a stale reply cannot answer a new one", () => {
    const mapper = new TurnMapper({ now: () => 0 });
    const first = mapper.map({
      type: "extension_ui_request",
      id: "pi-1",
      method: "select",
      title: "One",
      options: ["a"],
    });
    const second = mapper.map({
      type: "extension_ui_request",
      id: "pi-1",
      method: "select",
      title: "Two",
      options: ["a"],
    });
    expect(first.at(-1)).toMatchObject({ id: "u1" });
    expect(second.at(-1)).toMatchObject({ id: "u2" });
  });

  it("maps notify, setStatus, and set_editor_text", () => {
    const mapper = new TurnMapper({ now: () => 0 });
    expect(
      mapper
        .map({
          type: "extension_ui_request",
          id: "x",
          method: "notify",
          message: "disk almost full",
          notifyType: "warning",
        })
        .at(-1),
    ).toEqual({
      type: "notice",
      level: "warn",
      text: "disk almost full",
      source: "pi",
    });
    expect(
      mapper
        .map({
          type: "extension_ui_request",
          id: "x",
          method: "setStatus",
          statusKey: "tokens",
          statusText: "1.2k",
        })
        .at(-1),
    ).toEqual({ type: "status", key: "tokens", text: "1.2k" });
    // The buffer is data, never something the shell executes.
    expect(
      mapper
        .map({
          type: "extension_ui_request",
          id: "x",
          method: "set_editor_text",
          text: "git status",
        })
        .at(-1),
    ).toEqual({ type: "set_buffer", text: "git status" });
  });

  it("ignores widgets and titles, which belong to pi's own UI", () => {
    const mapper = new TurnMapper({ now: () => 0 });
    expect(
      mapper
        .map({
          type: "extension_ui_request",
          id: "x",
          method: "setWidget",
          widgetKey: "lens",
          widgetLines: ["a"],
        })
        .filter((event) => event.type !== "turn_start"),
    ).toEqual([]);
  });
});

describe("mapping retry, error, abort, and compaction", () => {
  it("maps auto_retry_start to retry, counting from 1", () => {
    const retries = replay("retry.jsonl").filter(
      (event) => event.type === "retry",
    );
    expect(retries).toEqual([
      {
        type: "retry",
        attempt: 1,
        max: 3,
        delayMs: 500,
        reason: "429 rate limited",
      },
      {
        type: "retry",
        attempt: 2,
        max: 3,
        delayMs: 1500,
        reason: "503 upstream unavailable",
      },
    ]);
  });

  it("recovers to a normal stop after retrying", () => {
    expect(replay("retry.jsonl").at(-1)).toEqual({
      type: "settled",
      stopReason: "stop",
    });
  });

  it("reports a notice when a retry finally gives up", () => {
    const mapper = new TurnMapper({ now: () => 0 });
    expect(
      mapper.map({
        type: "auto_retry_end",
        success: false,
        attempt: 3,
        finalError: "still 429",
      }),
    ).toEqual([{ type: "notice", level: "error", text: "still 429" }]);
  });

  it("settles an error turn carrying the provider's own words", () => {
    // DESIGN §8: the final failure prints the provider's error text.
    expect(replay("error.jsonl").at(-1)).toEqual({
      type: "settled",
      stopReason: "error",
      error: "provider exploded",
    });
  });

  it("carries the error text from an assistantMessageEvent error", () => {
    const mapper = new TurnMapper({ now: () => 0 });
    mapper.map({
      type: "message_update",
      usage: { input: 1, output: 0 },
      assistantMessageEvent: {
        type: "error",
        error: { message: "boom" },
      },
    });
    expect(mapper.settle()).toEqual({
      type: "settled",
      stopReason: "error",
      error: "boom",
    });
  });

  it("puts no error on a normal settle", () => {
    expect(replay("stream.jsonl").at(-1)).toEqual({
      type: "settled",
      stopReason: "stop",
    });
  });

  it("settles an aborted turn as aborted, from the assistant stop reason", () => {
    expect(replay("abort.jsonl").at(-1)).toEqual({
      type: "settled",
      stopReason: "aborted",
    });
  });

  it("leaves a tool running when the turn was aborted mid-tool", () => {
    const events = replay("abort.jsonl");
    expect(events.filter((event) => event.type === "tool_start")).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === "tool_end")).toHaveLength(0);
  });

  it("maps compaction start and end, deriving ok from aborted", () => {
    const events = replay("compaction.jsonl").filter(
      (event) => event.type === "compaction",
    );
    expect(events).toEqual([
      { type: "compaction", phase: "start", reason: "manual" },
      { type: "compaction", phase: "end", reason: "manual", ok: true },
    ]);
  });
});

describe("mapping never breaks the one-settled promise", () => {
  it("emits nothing after a settle", () => {
    const mapper = new TurnMapper({ now: () => 0 });
    mapper.settle();
    expect(mapper.map({ type: "agent_start" })).toEqual([]);
    expect(
      mapper.map({ type: "text_delta", contentIndex: 0, delta: "x" }),
    ).toEqual([]);
    expect(mapper.settled).toBe(true);
  });

  it("ignores agent_end with willRetry, because more work follows", () => {
    const mapper = new TurnMapper({ now: () => 0 });
    expect(
      mapper.map({ type: "agent_end", messages: [], willRetry: true }),
    ).toEqual([]);
  });

  it("settles with an explicit reason when the child died", () => {
    const mapper = new TurnMapper({ now: () => 0 });
    expect(mapper.settleWithError("pi exited with code 1")).toEqual({
      type: "settled",
      stopReason: "error",
      error: "pi exited with code 1",
    });
  });
});

describe("mapping tolerates records it has never seen", () => {
  it("drops an unknown event type without failing the turn", () => {
    const mapper = new TurnMapper({ now: () => 0 });
    expect(mapper.map({ type: "some_future_pi_event", data: 1 })).toEqual([]);
  });

  it("drops a tool update for a tool that never started", () => {
    const mapper = new TurnMapper({ now: () => 0 });
    expect(
      mapper.map({
        type: "tool_execution_update",
        toolCallId: "ghost",
        toolName: "bash",
        args: {},
        partialResult: "output",
      }),
    ).toEqual([]);
  });

  it("throttles tool updates but keeps the first", () => {
    let clock = 0;
    const mapper = new TurnMapper({
      now: () => clock,
      toolUpdateThrottleMs: 100,
    });
    mapper.map({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    });
    const first = mapper.map({
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
      partialResult: "one",
    });
    const throttled = mapper.map({
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
      partialResult: "two",
    });
    clock = 200;
    const later = mapper.map({
      type: "tool_execution_update",
      toolCallId: "t1",
      toolName: "bash",
      args: {},
      partialResult: "three",
    });
    expect(first).toEqual([{ type: "tool_update", id: "t1", preview: "one" }]);
    expect(throttled).toEqual([]);
    expect(later).toEqual([
      { type: "tool_update", id: "t1", preview: "three" },
    ]);
  });

  it("reports extension errors as warnings", () => {
    const mapper = new TurnMapper({ now: () => 0 });
    expect(
      mapper.map({ type: "extension_error", message: "lens failed" }),
    ).toEqual([{ type: "notice", level: "warn", text: "lens failed" }]);
  });
});

describe("tool summaries", () => {
  it.each([
    ["bash", { command: "bun run check\nand more" }, "$ bun run check"],
    ["read", { path: "src/core/config.ts" }, "src/core/config.ts"],
    ["edit", { path: "src/a.ts" }, "src/a.ts"],
    ["write", { file_path: "src/b.ts" }, "src/b.ts"],
    ["grep", { pattern: "loadConfig" }, "loadConfig"],
    ["find", { query: "*.ts" }, "*.ts"],
  ])("summarizes %s", (name, args, expected) => {
    expect(toolSummary(name, args)).toBe(expected);
  });

  it("falls back to the name and its first string argument", () => {
    expect(
      toolSummary("mcp__github__star", { repo: "MiraiForge/prefaix" }),
    ).toBe("mcp__github__star MiraiForge/prefaix");
  });

  it("never returns an empty summary, even for a shapeless tool", () => {
    expect(toolSummary("weird", {})).toBe("weird");
    expect(toolSummary("bash", {})).toBe("bash");
    expect(toolSummary("read", { path: 42 })).toBe("read");
    expect(toolSummary("bash", "not an object")).toBe("bash");
  });

  it("truncates a very long line", () => {
    expect(toolSummary("bash", { command: "x".repeat(500) })).toHaveLength(120);
  });

  it("takes the last line of a streaming preview", () => {
    expect(toolPreview("compiling\nline two\nline three")).toBe("line three");
    expect(toolPreview({ output: "a\nb" })).toBe("b");
    expect(toolPreview({ nothing: true })).toBeUndefined();
    expect(toolPreview("")).toBeUndefined();
  });

  it("replaces a lone surrogate and control characters rather than emitting them", () => {
    expect(sanitize("a\uD800b")).toBe("a�b");
    expect(sanitize("a\u0000b")).toBe("a b");
    expect(toolPreview("bad\u0000char")).toBe("bad char");
  });

  it("reports edit line counts when pi gives them", () => {
    expect(toolEndSummary({ added: 12, removed: 3 })).toBe("+12 −3");
    expect(toolEndSummary({ linesAdded: 1, linesRemoved: 0 })).toBe("+1 −0");
    expect(toolEndSummary("all good")).toBe("all good");
    expect(toolEndSummary({})).toBeUndefined();
  });
});

describe("mapping every documented pi shape", () => {
  it("announces the turn once, however many times pi says agent_start", () => {
    const m = mapper();
    expect(only(m.map({ type: "agent_start" }))).toHaveLength(0);
    expect(m.map({ type: "agent_start" })).toEqual([]);
  });

  it("maps a length stop reason as length", () => {
    const m = mapper();
    m.map({ type: "message_end", message: { stopReason: "length" } });
    expect(m.settle()).toEqual({ type: "settled", stopReason: "length" });
  });

  it("maps a stop reason the port does not model as a normal stop", () => {
    const m = mapper();
    // pi's toolUse and deferred both mean "more may follow", not "failed".
    for (const reason of ["toolUse", "deferred", "pending", "nonsense"]) {
      const one = mapper();
      one.map({ type: "message_end", message: { stopReason: reason } });
      expect(one.settle().type === "settled" ? one.settled : true).toBeTruthy();
      expect(one.settle()).toMatchObject({ stopReason: "stop" });
    }
    expect(m.settled).toBe(false);
  });

  it("survives a message_end with no message at all", () => {
    const m = mapper();
    expect(m.map({ type: "message_end" })).toEqual([]);
    expect(m.settle()).toEqual({ type: "settled", stopReason: "stop" });
  });

  it("ends a tool that never started, without inventing a duration", () => {
    const m = mapper();
    expect(
      m.map({
        type: "tool_execution_end",
        toolCallId: "ghost",
        toolName: "bash",
        args: {},
        result: "ok",
        isError: false,
      }),
    ).toEqual([{ type: "tool_end", id: "ghost", ok: true, summary: "ok" }]);
  });

  it("reports a tool duration when it does know the start", () => {
    const m = mapper();
    m.map({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(
      m.map({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        args: {},
        result: {},
        isError: false,
      }),
    ).toEqual([{ type: "tool_end", id: "t1", ok: true, ms: 0 }]);
  });

  it("counts the queue when pi reports queued text", () => {
    const m = mapper();
    expect(
      m.map({ type: "queue_update", steering: ["a"], followUp: ["b", "c"] }),
    ).toEqual([{ type: "status", key: "queue", text: "3 queued" }]);
    expect(m.map({ type: "queue_update", steering: [], followUp: [] })).toEqual(
      [],
    );
    // A record with no arrays at all is not a queue worth reporting.
    expect(m.map({ type: "queue_update" })).toEqual([]);
  });

  it("maps a thinking level change to status", () => {
    expect(
      only(mapper().map({ type: "thinking_level_changed", level: "high" })),
    ).toEqual([{ type: "status", key: "thinking", text: "high" }]);
  });

  it("reports an extension error with no message of its own", () => {
    expect(mapper().map({ type: "extension_error" })).toEqual([
      { type: "notice", level: "warn", text: "a pi extension failed" },
    ]);
  });

  it("treats a notification with no level as informational", () => {
    expect(
      only(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "notify",
          message: "hello",
        }),
      ),
    ).toEqual([{ type: "notice", level: "info", text: "hello", source: "pi" }]);
    expect(
      only(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "notify",
          message: "bad",
          notifyType: "error",
        }),
      ),
    ).toEqual([{ type: "notice", level: "error", text: "bad", source: "pi" }]);
  });

  it("clears a pi status with no text", () => {
    expect(
      only(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "setStatus",
          statusKey: "k",
          statusText: undefined,
        }),
      ),
    ).toEqual([{ type: "status", key: "k" }]);
  });

  it("maps a status with no key to a default one", () => {
    expect(
      only(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "setStatus",
        }),
      ),
    ).toEqual([{ type: "status", key: "pi" }]);
  });

  it("maps an input dialog with its placeholder as the prefill", () => {
    expect(
      only(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "input",
          title: "Branch name?",
          placeholder: "main",
          timeout: 5000,
        }),
      ),
    ).toEqual([
      {
        type: "ui_request",
        id: "u1",
        kind: "input",
        title: "Branch name?",
        prefill: "main",
        timeoutMs: 5000,
      },
    ]);
  });

  it("maps a confirm with its message", () => {
    expect(
      only(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "confirm",
          title: "Continue?",
          message: "This rewrites history.",
        }),
      ),
    ).toEqual([
      {
        type: "ui_request",
        id: "u1",
        kind: "confirm",
        title: "Continue?",
        message: "This rewrites history.",
      },
    ]);
  });

  it("maps an editor with a prefill", () => {
    expect(
      only(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "editor",
          title: "Edit",
          prefill: "git rebase -i HEAD~3",
        }),
      ),
    ).toEqual([
      {
        type: "ui_request",
        id: "u1",
        kind: "editor",
        title: "Edit",
        prefill: "git rebase -i HEAD~3",
      },
    ]);
  });

  it("falls back to the method name when a dialog has no title", () => {
    expect(
      only(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "input",
        }),
      ),
    ).toEqual([
      { type: "ui_request", id: "u1", kind: "input", title: "input" },
    ]);
  });

  it("drops options that are not strings from a select", () => {
    expect(
      only(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "select",
          title: "Pick",
          options: ["main", 42, null, "dev"],
        }),
      ),
    ).toEqual([
      {
        type: "ui_request",
        id: "u1",
        kind: "select",
        title: "Pick",
        options: ["main", "dev"],
      },
    ]);
  });

  it("ignores a widget, which belongs to pi's own UI", () => {
    expect(
      stream(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "setWidget",
          widgetKey: "lens",
          widgetLines: ["a"],
        }),
      ),
    ).toEqual([]);
  });

  it("derives compaction ok from aborted and from an error", () => {
    const aborted = mapper();
    aborted.map({ type: "compaction_start", reason: "threshold" });
    expect(
      aborted.map({
        type: "compaction_end",
        reason: "threshold",
        aborted: true,
        willRetry: false,
      }),
    ).toEqual([
      { type: "compaction", phase: "end", reason: "threshold", ok: false },
    ]);

    const failed = mapper();
    expect(
      failed.map({
        type: "compaction_end",
        aborted: false,
        willRetry: false,
        errorMessage: "summary failed",
      }),
    ).toEqual([
      { type: "compaction", phase: "end", reason: "manual", ok: false },
    ]);
  });

  it("reads usage cost as a number or as a per-token object", () => {
    const flat = mapper();
    expect(
      only(
        flat.map({
          type: "message_update",
          usage: { input: 1, output: 2, cost: 0.5 },
        }),
      ),
    ).toEqual([{ type: "usage", input: 1, output: 2, costUsd: 0.5 }]);

    const nested = mapper();
    expect(
      only(
        nested.map({
          type: "message_update",
          usage: { input: 1, output: 2, cost: { input: 0.25, output: 0.75 } },
        }),
      ),
    ).toEqual([{ type: "usage", input: 1, output: 2, costUsd: 1 }]);
  });

  it("keeps the last known cost when a later usage omits it", () => {
    // No throttle, so the second usage is emitted and can be checked.
    const m = new TurnMapper({ now: () => 0, usageThrottleMs: 0 });
    only(
      m.map({
        type: "message_update",
        usage: { input: 1, output: 1, cost: 2 },
      }),
    );
    expect(
      only(m.map({ type: "message_update", usage: { input: 3, output: 1 } })),
    ).toEqual([{ type: "usage", input: 3, output: 1, costUsd: 2 }]);
  });

  it("ignores a usage event whose numbers did not move", () => {
    const m = mapper();
    m.map({ type: "message_update", usage: { input: 5, output: 5 } });
    expect(
      m.map({ type: "message_update", usage: { input: 5, output: 5 } }),
    ).toEqual([]);
  });

  it("throttles usage but always emits the first and the final figure", () => {
    let clock = 0;
    const m = new TurnMapper({ now: () => clock, usageThrottleMs: 1_000 });
    // The opening figure is never throttled, even with a clock at zero.
    expect(
      only(m.map({ type: "message_update", usage: { input: 1, output: 1 } })),
    ).toEqual([{ type: "usage", input: 1, output: 1 }]);
    clock = 10;
    // Inside the window, so nothing is emitted.
    expect(
      only(m.map({ type: "message_update", usage: { input: 2, output: 1 } })),
    ).toEqual([]);
    // message_end is the authoritative figure and is never throttled.
    clock = 20;
    expect(
      only(
        m.map({
          type: "message_end",
          message: { stopReason: "stop", usage: { input: 9, output: 4 } },
        }),
      ),
    ).toEqual([{ type: "usage", input: 9, output: 4 }]);
  });

  it("treats a thinking delta as thinking, not as answer text", () => {
    expect(
      stream(
        mapper().map({
          type: "message_update",
          usage: { input: 1, output: 0 },
          assistantMessageEvent: {
            type: "thinking_delta",
            contentIndex: 0,
            delta: "hmm",
          },
        }),
      ),
    ).toEqual([{ type: "thinking_delta", text: "hmm" }]);
  });

  it("ignores a text delta that is not a string", () => {
    expect(
      stream(
        mapper().map({
          type: "message_update",
          usage: { input: 1, output: 0 },
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: 42,
          },
        }),
      ),
    ).toEqual([]);
  });

  it("ignores an empty text delta, which pi sends to open a block", () => {
    expect(
      stream(
        mapper().map({
          type: "message_update",
          usage: { input: 1, output: 0 },
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "",
          },
        }),
      ),
    ).toEqual([]);
  });

  it("defaults a text block to index 0 when pi omits one", () => {
    expect(
      stream(
        mapper().map({
          type: "message_update",
          usage: { input: 1, output: 0 },
          assistantMessageEvent: { type: "text_end" },
        }),
      ),
    ).toEqual([{ type: "text_end", block: 0 }]);
  });

  it("handles a message_update with no assistant event at all", () => {
    // pi sends usage on the record, so the only event is that figure.
    expect(
      only(
        mapper().map({
          type: "message_update",
          usage: { input: 1, output: 0 },
        }),
      ),
    ).toEqual([{ type: "usage", input: 1, output: 0 }]);
    // A record with neither usage nor an assistant event yields nothing, and a
    // mapper that already announced its turn yields nothing at all.
    expect(stream(mapper().map({ type: "message_update" }))).toEqual([]);
  });

  it("falls back to a retry count when pi omits its numbers", () => {
    expect(only(mapper().map({ type: "auto_retry_start" }))).toEqual([
      {
        type: "retry",
        attempt: 1,
        max: 1,
        delayMs: 0,
        reason: "pi reported a retryable failure",
      },
    ]);
  });

  it("reports a retry that gave up with no final error text", () => {
    expect(
      only(
        mapper().map({ type: "auto_retry_end", success: false, attempt: 2 }),
      ),
    ).toEqual([
      { type: "notice", level: "error", text: "pi gave up after 2 retries" },
    ]);
  });

  it("lets an explicit reason override the message's stop reason", () => {
    const m = mapper();
    m.map({ type: "message_end", message: { stopReason: "aborted" } });
    expect(m.settle("error")).toEqual({ type: "settled", stopReason: "error" });
  });
});

describe("mapping fallbacks for records pi has not sent yet", () => {
  it("ignores a record that is not an object", () => {
    const m = mapper();
    expect(m.map(null as never)).toEqual([]);
    expect(m.map("nope" as never)).toEqual([]);
  });

  it("takes a failure from a message with no stop reason of its own", () => {
    const m = mapper();
    m.map({
      type: "message_end",
      message: { errorMessage: "no reason given" },
    });
    expect(m.settle()).toEqual({
      type: "settled",
      stopReason: "error",
      error: "no reason given",
    });
  });

  it("drops a tool update with no preview to show", () => {
    const m = mapper();
    m.map({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "ls" },
    });
    expect(
      m.map({
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "bash",
        args: {},
        partialResult: {},
      }),
    ).toEqual([]);
  });

  it("copes with a retry that gave up, with no attempt number", () => {
    expect(
      only(mapper().map({ type: "auto_retry_end", success: false })),
    ).toEqual([
      {
        type: "notice",
        level: "error",
        text: "pi gave up after ? retries",
      },
    ]);
  });

  it("names an unlabelled compaction as manual", () => {
    expect(only(mapper().map({ type: "compaction_start" }))).toEqual([
      { type: "compaction", phase: "start", reason: "manual" },
    ]);
  });

  it("reads an assistant error that is a bare string", () => {
    const m = mapper();
    only(
      m.map({
        type: "message_update",
        usage: { input: 1, output: 0 },
        assistantMessageEvent: { type: "error", error: "flat failure" },
      }),
    );
    expect(m.settle()).toMatchObject({
      stopReason: "error",
      error: "flat failure",
    });
  });

  it("keeps the previous token counts when usage omits them", () => {
    const m = new TurnMapper({ now: () => 0, usageThrottleMs: 0 });
    only(m.map({ type: "message_update", usage: { input: 7, output: 3 } }));
    // Only input moves, so output is carried over rather than reset to zero.
    expect(
      only(
        m.map({ type: "message_update", usage: { input: 9, cacheRead: 1 } }),
      ),
    ).toEqual([{ type: "usage", input: 9, output: 3 }]);
  });

  it("reads a cost object that names only one side", () => {
    // pi may report only what it charged for, so the other side counts as zero.
    const inputOnly = new TurnMapper({ now: () => 0 });
    expect(
      only(
        inputOnly.map({
          type: "message_update",
          usage: { input: 1, output: 1, cost: { input: 2 } },
        }),
      ),
    ).toEqual([{ type: "usage", input: 1, output: 1, costUsd: 2 }]);

    const outputOnly = new TurnMapper({ now: () => 0 });
    expect(
      only(
        outputOnly.map({
          type: "message_update",
          usage: { input: 2, output: 2, cost: { output: 4 } },
        }),
      ),
    ).toEqual([{ type: "usage", input: 2, output: 2, costUsd: 4 }]);
  });

  it("says so when pi asks for a dialog prefaix cannot show", () => {
    // A newer pi may add a method; silence would be worse than a warning.
    expect(
      only(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "future_method",
        }),
      ),
    ).toEqual([
      {
        type: "notice",
        level: "warn",
        text: "pi asked for future_method, which this prefaix cannot show",
        source: "pi",
      },
    ]);
    expect(
      only(mapper().map({ type: "extension_ui_request", id: "x" })),
    ).toEqual([
      {
        type: "notice",
        level: "warn",
        text: "pi asked for something, which this prefaix cannot show",
        source: "pi",
      },
    ]);
  });

  it("reports a notification with no message", () => {
    expect(
      only(
        mapper().map({
          type: "extension_ui_request",
          id: "x",
          method: "notify",
        }),
      ),
    ).toEqual([
      {
        type: "notice",
        level: "info",
        text: "pi sent a notification",
        source: "pi",
      },
    ]);
  });
});

describe("tool summaries, exhaustively", () => {
  it("falls back to the tool name for a list-shaped preview", () => {
    // pi may hand back an array of lines rather than a string.
    expect(toolPreview([{ output: "a" }])).toBeUndefined();
  });

  it("prefers a path over a pattern when a list tool has both", () => {
    expect(toolSummary("ls", { pattern: "", path: "src" })).toBe("src");
  });

  it("takes the last line of a preview with no trailing newline", () => {
    expect(toolPreview("one\ntwo")).toBe("two");
    expect(toolPreview("only")).toBe("only");
  });

  it("reads a nested object's last line", () => {
    expect(toolPreview({ content: "x\ny" })).toBe("y");
    expect(toolPreview({ content: "" })).toBeUndefined();
  });

  it("reports edit counts when only one side is present", () => {
    expect(toolEndSummary({ added: 5 })).toBe("+5 −0");
    expect(toolEndSummary({ removed: 2 })).toBe("+0 −2");
  });

  it("returns nothing for a blank result", () => {
    expect(toolEndSummary("   ")).toBeUndefined();
    expect(toolEndSummary("")).toBeUndefined();
    expect(toolEndSummary(42)).toBeUndefined();
  });

  it("handles a first line that is only whitespace", () => {
    expect(toolSummary("bash", { command: "\n\n  real command  " })).toBe(
      "$ real command",
    );
  });
});

describe("tool summaries, last corners", () => {
  it("returns no preview for a blank or single-line result", () => {
    expect(toolPreview("")).toBeUndefined();
    expect(toolPreview("   ")).toBeUndefined();
    expect(toolPreview({ output: "   " })).toBeUndefined();
  });

  it("summarises a result that is only whitespace as nothing", () => {
    expect(toolEndSummary("\n\n")).toBeUndefined();
    expect(toolEndSummary("  done  ")).toBe("done");
  });

  it("falls back to the tool name when a shell command is blank", () => {
    expect(toolSummary("bash", { command: "   " })).toBe("bash");
  });

  it("keeps a usage figure it has already seen when input is absent", () => {
    const m = new TurnMapper({ now: () => 0, usageThrottleMs: 0 });
    only(m.map({ type: "message_update", usage: { input: 4, output: 0 } }));
    // Only output moves, so input is carried over.
    expect(
      only(m.map({ type: "message_update", usage: { output: 9 } })),
    ).toEqual([{ type: "usage", input: 4, output: 9 }]);
  });

  it("treats a dialog method pi has not documented as unknown, not as an input", () => {
    // The default case warns, so an unmapped method never silently becomes a
    // dialog the client cannot answer correctly.
    const request = only(
      mapper().map({
        type: "extension_ui_request",
        id: "x",
        method: "brand_new",
        title: "t",
      }),
    );
    expect(request[0]?.type).toBe("notice");
  });
});

describe("tool previews, last corners", () => {
  it("has no preview for a blank string or object", () => {
    expect(toolPreview("")).toBeUndefined();
    expect(toolPreview({ output: "" })).toBeUndefined();
  });

  it("trims a result that has padding around it", () => {
    expect(toolEndSummary("  done  ")).toBe("done");
  });
});
