import { describe, expect, it } from "vitest";
import {
  asCommands,
  asCompaction,
  asLevels,
  asModels,
  asRecord,
  asState,
  asStats,
  asText,
  isAgentEnd,
  isAgentStart,
  isCompactionEnd,
  isCompactionStart,
  isMessageUpdate,
  isPiResponse,
  isRetryEnd,
  isRetryStart,
  isSettled,
  isToolEnd,
  isToolStart,
  isToolUpdate,
  isUiRequest,
  isUiResponse,
  type PiRecord,
} from "../../src/agents/pi/types.js";

const record = (value: unknown): PiRecord => value as PiRecord;

describe("record guards", () => {
  it("tells a reply from an event", () => {
    expect(
      isPiResponse({
        id: "r1",
        type: "response",
        command: "get_state",
        success: true,
      }),
    ).toBe(true);
    expect(isPiResponse({ type: "agent_start" })).toBe(false);
  });

  it("names every turn event it must recognize", () => {
    expect(isAgentStart({ type: "agent_start" })).toBe(true);
    expect(isAgentEnd({ type: "agent_end" })).toBe(true);
    expect(isMessageUpdate({ type: "message_update" })).toBe(true);
    expect(isToolStart({ type: "tool_execution_start" })).toBe(true);
    expect(isToolUpdate({ type: "tool_execution_update" })).toBe(true);
    expect(isToolEnd({ type: "tool_execution_end" })).toBe(true);
    expect(isCompactionStart({ type: "compaction_start" })).toBe(true);
    expect(isCompactionEnd({ type: "compaction_end" })).toBe(true);
    expect(isRetryStart({ type: "auto_retry_start" })).toBe(true);
    expect(isRetryEnd({ type: "auto_retry_end" })).toBe(true);
    expect(isSettled({ type: "agent_settled" })).toBe(true);
    expect(isUiRequest({ type: "extension_ui_request" })).toBe(true);
    expect(isUiResponse({ type: "extension_ui_response" })).toBe(true);
  });

  it("does not confuse neighbouring event types", () => {
    expect(isSettled({ type: "agent_end" })).toBe(false);
    expect(isUiResponse({ type: "extension_ui_request" })).toBe(false);
    expect(isToolEnd({ type: "tool_execution_start" })).toBe(false);
    expect(isRetryEnd({ type: "auto_retry_start" })).toBe(false);
    expect(isCompactionEnd({ type: "compaction_start" })).toBe(false);
  });
});

describe("narrowing untyped response data", () => {
  it("recognises only a plain object as a record", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1, 2])).toBeUndefined();
    expect(asRecord("text")).toBeUndefined();
    expect(asRecord(null)).toBeUndefined();
    expect(asRecord(undefined)).toBeUndefined();
  });

  it("treats a data payload that is not a table as no state at all", () => {
    expect(asState({ sessionId: "s" })).toEqual({ sessionId: "s" });
    expect(asState("nope")).toBeUndefined();
    expect(asState([1])).toBeUndefined();
  });

  it("reads a model list, or nothing", () => {
    expect(asModels({ models: [{ id: "m", provider: "p" }] })).toEqual([
      { id: "m", provider: "p" },
    ]);
    expect(asModels({})).toEqual([]);
    expect(asModels({ models: "no" })).toEqual([]);
    expect(asModels(undefined)).toEqual([]);
  });

  it("reads thinking levels, dropping anything that is not a string", () => {
    expect(asLevels({ levels: ["off", "high"] })).toEqual(["off", "high"]);
    expect(asLevels({ levels: ["off", 3, null] })).toEqual(["off"]);
    expect(asLevels({})).toEqual([]);
    expect(asLevels("nope")).toEqual([]);
  });

  it("reads slash commands, or nothing", () => {
    expect(asCommands({ commands: [{ name: "c" }] })).toEqual([{ name: "c" }]);
    expect(asCommands({ commands: "no" })).toEqual([]);
    expect(asCommands(undefined)).toEqual([]);
  });

  it("reads session stats, defaulting to an empty record", () => {
    expect(asStats({ cost: 1 })).toEqual({ cost: 1 });
    expect(asStats(undefined)).toEqual({});
  });

  it("reads assistant text, including the empty {} pi sends when idle", () => {
    expect(asText({ text: "hello" })).toBe("hello");
    expect(asText({})).toBeNull();
    expect(asText({ text: 42 })).toBeNull();
    expect(asText("raw")).toBeNull();
  });

  it("reads a compaction result, omitting what pi did not report", () => {
    expect(asCompaction({ summary: "s", tokensBefore: 10 })).toEqual({
      summary: "s",
      tokensBefore: 10,
    });
    expect(asCompaction({ summary: 5 })).toEqual({});
    expect(asCompaction(undefined)).toEqual({});
  });

  it("ignores a record that is not an object at all", () => {
    expect(() => isPiResponse(record(null))).not.toThrow();
    expect(isPiResponse(record("nope"))).toBe(false);
  });
});

describe("guards on a record whose type is not a string", () => {
  it("treats a non-string type as no type at all", () => {
    expect(isPiResponse({ type: 5 } as never)).toBe(false);
    expect(isSettled({ type: null } as never)).toBe(false);
    expect(isUiRequest({} as never)).toBe(false);
  });
});
