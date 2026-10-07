import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TurnMapper } from "../../src/agents/pi/mapping.js";
import type { PiRecord } from "../../src/agents/pi/types.js";
import type { AgentEvent } from "../../src/core/agent-port.js";

const usageEvents = (events: AgentEvent[]) =>
  events.filter((e) => e.type === "usage");
const start = (m: TurnMapper, role = "assistant") =>
  m.map({ type: "message_start", message: { role } });
const update = (m: TurnMapper, usage: object) =>
  usageEvents(m.map({ type: "message_update", usage }));
const end = (m: TurnMapper, usage: object) =>
  usageEvents(
    m.map({ type: "message_end", message: { role: "assistant", usage } }),
  );
const mapper = () => new TurnMapper({ usageThrottleMs: 0, now: () => 0 });

describe("pi per-response usage normalized into cumulative turn totals", () => {
  it("adds new tool/retry responses, never their repeated cumulative deltas", () => {
    const m = mapper();
    start(m);
    update(m, { input: 10, output: 2, cost: 0.1 });
    update(m, { input: 10, output: 4, cost: 0.2 });
    expect(end(m, { input: 10, output: 4, cost: 0.2 })).toEqual([]);
    start(m, "toolResult");
    start(m, "user");
    start(m);
    expect(update(m, { input: 3, output: 1, cost: 0.05 })).toMatchObject([
      { input: 13, output: 5, costUsd: 0.25 },
    ]);
    expect(end(m, { input: 3, output: 1, cost: 0.05 })).toEqual([]);
    start(m);
    expect(end(m, { input: 0, output: 0, cost: 0 })).toEqual([]);
    start(m);
    expect(end(m, { input: 2, output: 2 })).toMatchObject([
      { input: 15, output: 7, costUsd: 0.25 },
    ]);
  });
  it("retains partial fields within one response but not across response boundaries", () => {
    const m = mapper();
    update(m, { input: 7, output: 3, cost: 2 });
    expect(update(m, { input: 9 })).toMatchObject([
      { input: 9, output: 3, costUsd: 2 },
    ]);
    start(m);
    expect(update(m, { output: 2 })).toMatchObject([
      { input: 9, output: 5, costUsd: 2 },
    ]);
    expect(end(m, { input: 1, output: 3, cost: 1 })).toMatchObject([
      { input: 10, output: 6, costUsd: 3 },
    ]);
  });
  it("flushes an identical terminal figure that was previously throttled", () => {
    const m = new TurnMapper({ now: () => 0, usageThrottleMs: 1000 });
    update(m, { input: 1, output: 1 });
    expect(update(m, { input: 2, output: 2 })).toEqual([]);
    expect(end(m, { input: 2, output: 2 })).toMatchObject([
      { input: 2, output: 2 },
    ]);
    expect(end(m, { input: 2, output: 2 })).toEqual([]);
  });
  it.each([
    [{ total: 3, input: 1, output: 2, cacheRead: 4, cacheWrite: 5 }, 3],
    [{ total: 0, input: 1 }, 0],
    [{ input: 1, output: 2, cacheRead: 4, cacheWrite: 5 }, 12],
    [{ cacheRead: 4 }, 4],
    [{ cacheWrite: 5 }, 5],
    [{ total: NaN, input: 1 }, 1],
    [{ input: -1, output: 2 }, 2],
  ])(
    "prefers reported total, otherwise includes valid cache components: %j",
    (cost, expected) => {
      expect(update(mapper(), { input: 1, cost })).toMatchObject([
        { costUsd: expected },
      ]);
    },
  );
  it.each([NaN, Infinity, -1, "invalid", {}, { total: -1, input: NaN }])(
    "does not invent invalid or missing cost: %j",
    (cost) => {
      expect(update(mapper(), { input: 1, cost })).toEqual([
        { type: "usage", input: 1, output: 0 },
      ]);
    },
  );
  it("ignores invalid/backwards counters and preserves monotonic port figures", () => {
    const m = mapper();
    update(m, { input: 7, output: 3, cost: 2 });
    expect(update(m, { input: NaN, output: Infinity, cost: -1 })).toEqual([]);
    expect(update(m, { input: 2, output: 0, cost: 1 })).toEqual([]);
  });
  it.each(["abort-tool", "abort-text", "compact-overflow", "retry-success"])(
    "normalizes reviewed native %s records without cumulative regression",
    (name) => {
      const records = readFileSync(
        resolve("test/fixtures/pi/recorded", name + ".jsonl"),
        "utf8",
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as PiRecord);
      const m = mapper();
      const events = usageEvents(records.flatMap((record) => m.map(record)));
      expect(events.length).toBeGreaterThan(0);
      let input = 0,
        output = 0,
        cost = 0;
      for (const event of events) {
        expect(event.input).toBeGreaterThanOrEqual(input);
        expect(event.output).toBeGreaterThanOrEqual(output);
        expect(event.costUsd ?? 0).toBeGreaterThanOrEqual(cost);
        input = event.input;
        output = event.output;
        cost = event.costUsd ?? 0;
      }
      if (name === "abort-tool")
        expect({ input, output }).toEqual({ input: 667, output: 107 });
      if (name === "abort-text") expect(cost).toBeCloseTo(0.0003186, 10);
    },
  );
});
