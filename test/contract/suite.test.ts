// The contract suite is only worth anything if it fails on a backend that
// breaks the port. This exercises the invariants directly, and runs the suite
// against a deliberately broken target to prove the failures are real.

import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentEventOf,
  Capabilities,
} from "../../src/core/agent-port.js";
import {
  CONTRACT_CASES,
  expectBlockInvariants,
  expectOneSettled,
  expectRetryInvariants,
  expectToolInvariants,
  expectTurnInvariants,
  expectTurnStarted,
  expectUiRequestInvariants,
  expectUsageInvariants,
  lastBlockText,
  runContractSuite,
  type ContractTarget,
  type TurnRun,
} from "./suite.js";
import { fakeTarget } from "./fake-target.js";

const GOOD: AgentEvent[] = [
  { type: "turn_start" },
  { type: "text_delta", block: 0, text: "hello " },
  { type: "text_delta", block: 0, text: "world\n" },
  { type: "text_end", block: 0 },
  { type: "usage", input: 40, output: 12, costUsd: 0 },
  { type: "settled", stopReason: "stop" },
];

function settled(
  stopReason: AgentEventOf<"settled">["stopReason"],
): AgentEventOf<"settled"> {
  return { type: "settled", stopReason };
}

describe("turn invariants accept a well-formed turn", () => {
  it("passes a plain turn", () => {
    expect(() => expectTurnInvariants(GOOD)).not.toThrow();
    expect(expectOneSettled(GOOD).stopReason).toBe("stop");
    expect(lastBlockText(GOOD)).toBe("hello world\n");
  });

  it("accepts a turn that only settles", () => {
    expect(() => expectTurnInvariants([settled("aborted")])).not.toThrow();
    expect(lastBlockText([settled("aborted")])).toBeNull();
  });
});

describe("turn invariants catch a broken backend", () => {
  it("catches a turn that never settles", () => {
    expect(() => expectOneSettled(GOOD.slice(0, 3))).toThrow(
      /exactly one settled/,
    );
  });

  it("catches a turn that settles twice", () => {
    expect(() => expectOneSettled([...GOOD, settled("error")])).toThrow(
      /exactly one settled/,
    );
  });

  it("catches anything after the settled event", () => {
    expect(() =>
      expectOneSettled([
        settled("stop"),
        { type: "text_delta", block: 0, text: "late\n" },
      ]),
    ).toThrow(/nothing may follow/);
  });

  it("catches a late turn_start", () => {
    expect(() =>
      expectTurnStarted([
        { type: "text_delta", block: 0, text: "x" },
        { type: "turn_start" },
      ]),
    ).toThrow(/turn_start comes first/);
  });

  it("catches a second turn_start in one turn", () => {
    expect(() =>
      expectTurnStarted([
        { type: "turn_start" },
        { type: "turn_start" },
        settled("stop"),
      ]),
    ).toThrow(/at most one turn_start/);
  });

  it("catches text streaming after a block ended", () => {
    expect(() =>
      expectBlockInvariants([
        { type: "text_delta", block: 0, text: "a" },
        { type: "text_end", block: 0 },
        { type: "text_delta", block: 0, text: "b" },
      ]),
    ).toThrow(/streamed after its text_end/);
  });

  it("catches a block that ends without streaming", () => {
    expect(() =>
      expectBlockInvariants([{ type: "text_end", block: 0 }]),
    ).toThrow(/without streaming text/);
  });

  it("catches a tool event with no start", () => {
    expect(() =>
      expectToolInvariants([{ type: "tool_end", id: "t1", ok: true }]),
    ).toThrow(/arrived before its tool_start/);
  });

  it("catches a tool_start with no summary for the renderer", () => {
    expect(() =>
      expectToolInvariants([
        { type: "tool_start", id: "t1", name: "bash", summary: "" },
      ]),
    ).toThrow(/adapter-built summary/);
  });

  it("catches a repeated tool id", () => {
    expect(() =>
      expectToolInvariants([
        { type: "tool_start", id: "t1", name: "read", summary: "a.ts" },
        { type: "tool_start", id: "t1", name: "read", summary: "b.ts" },
      ]),
    ).toThrow(/must be unique/);
  });

  it("catches usage that goes backwards", () => {
    expect(() =>
      expectUsageInvariants([
        { type: "usage", input: 100, output: 20 },
        { type: "usage", input: 40, output: 5 },
      ]),
    ).toThrow(/cumulative/);
  });

  it("catches retries that do not count from one", () => {
    expect(() =>
      expectRetryInvariants([
        { type: "retry", attempt: 2, max: 3, delayMs: 10, reason: "x" },
      ]),
    ).toThrow(/count from 1/);
  });

  it("catches a retry past its own ceiling", () => {
    expect(() =>
      expectRetryInvariants([
        { type: "retry", attempt: 1, max: 1, delayMs: 10, reason: "x" },
        { type: "retry", attempt: 2, max: 1, delayMs: 10, reason: "x" },
      ]),
    ).toThrow(/less than or equal|ceiling/);
  });

  it("catches a select with nothing to select", () => {
    expect(() =>
      expectUiRequestInvariants([
        {
          type: "ui_request",
          id: "d1",
          kind: "select",
          title: "Which?",
          options: [],
        },
      ]),
    ).toThrow(/needs options/);
  });

  it("catches a dialog kind the client cannot render", () => {
    expect(() =>
      expectUiRequestInvariants([
        {
          type: "ui_request",
          id: "d1",
          // Deliberately not a kind the port defines.
          kind: "hologram" as "select",
          title: "Which?",
        },
      ]),
    ).toThrow();
  });
});

// A target that claims a capability it does not implement, ends a turn twice,
// and forgets to settle.
const MINIMAL_CAPABILITIES: Capabilities = {
  steer: false,
  followUp: false,
  abort: true,
  models: false,
  thinkingLevels: false,
  compact: false,
  slashCommands: false,
  skills: false,
  uiDialogs: false,
  contextSections: false,
  personasWithoutRespawn: false,
  handoffTui: false,
};

function brokenRun(events: AgentEvent[]): TurnRun {
  const session = {
    native: {},
    prompt: async function* () {
      yield* events;
    },
    abort: async () => {},
    respondUi: () => {},
    state: async () => ({ busy: false }),
    listModels: async () => [],
    setModel: async () => {},
    lastAssistantText: async () => null,
    close: async () => {},
  } as unknown as Awaited<ReturnType<ContractTarget["open"]>>;
  return {
    events,
    session,
    until: async () => {},
    stop: async () => {},
    done: Promise.resolve(),
  };
}

function brokenTarget(): ContractTarget {
  return {
    name: "broken",
    capabilities: MINIMAL_CAPABILITIES,
    probe: async () => ({ installed: true, usable: true }),
    open: async () =>
      ({
        native: {},
        prompt: async function* () {},
        abort: async () => {},
        respondUi: () => {},
        state: async () => ({ busy: false }),
        listModels: async () => [],
        setModel: async () => {},
        lastAssistantText: async () => null,
        close: async () => {},
      }) as unknown as Awaited<ReturnType<ContractTarget["open"]>>,
    // The same broken turn for every case: the suite must catch it in each one.
    start: () =>
      Promise.resolve(
        brokenRun([
          { type: "turn_start" },
          { type: "text_delta", block: 0, text: "hi\n" },
          { type: "text_end", block: 0 },
          settled("stop"),
          { type: "text_delta", block: 0, text: "after\n" },
        ]),
      ),
  };
}

describe("the suite fails a backend that breaks the port", () => {
  // The same suite, pointed at a backend that keeps talking after settled and
  // never reports tools. Every case has to fail, which is what proves the suite
  // is not vacuous.
  runContractSuite(brokenTarget(), { register: it.fails });

  it("fails the stream case on a turn that keeps talking after settled", () => {
    const run = brokenRun([
      { type: "turn_start" },
      { type: "text_delta", block: 0, text: "hi\n" },
      { type: "text_end", block: 0 },
      settled("stop"),
      { type: "text_delta", block: 0, text: "after\n" },
    ]);
    expect(() => expectTurnInvariants(run.events)).toThrow(
      /nothing may follow/,
    );
  });
});

describe("the fake target runs every case", () => {
  it("supports the whole case list, so nothing is skipped", () => {
    expect(fakeTarget().unsupported).toBeUndefined();
  });

  it("names every case the suite knows", () => {
    expect(CONTRACT_CASES.length).toBeGreaterThanOrEqual(8);
  });
});
