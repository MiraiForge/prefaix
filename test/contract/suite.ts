// The AgentPort contract (DESIGN §12.2). One suite runs against every backend:
// today the scripted fake, later PiAdapter with fixture replay. A target
// supplies the scripted turns; everything else here is the port's promise, so a
// new adapter inherits the checks instead of re-deriving them.

import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentEventOf,
  AgentEventType,
  AgentSession,
  Capabilities,
  ProbeResult,
  StopReason,
  UiRequestKind,
} from "../../src/core/agent-port.js";

// Each case is a scripted turn a target has to be able to produce. `unsupported`
// is for a target that genuinely cannot, with the reason, so a missing case is
// always a stated decision rather than a silent hole.
export const CONTRACT_CASES = [
  "stream",
  "tools",
  "dialog",
  "error",
  "retry",
  "abortDuringTool",
  "abortFromSignal",
  "abortFromMethod",
] as const;

export type ContractCase = (typeof CONTRACT_CASES)[number];

export interface TurnRun {
  readonly events: AgentEvent[];
  readonly session: AgentSession;
  /** Resolves on the first event the predicate matches. Rejects if the turn ends first. */
  until(match: (event: AgentEvent) => boolean, what?: string): Promise<void>;
  /** Ends the turn the way Esc does: the signal, the method, or both. */
  stop(via?: "signal" | "method" | "both"): Promise<void>;
  readonly done: Promise<void>;
}

export interface ContractSuiteOptions {
  /**
   * Registers a case test. A negative run passes `it.fails`, so the suite can be
   * pointed at a broken backend to prove it actually catches the breakage.
   */
  readonly register?: (title: string, body: () => Promise<void>) => void;
}

export interface ContractTarget {
  readonly name: string;
  readonly capabilities: Capabilities;
  probe(): Promise<ProbeResult>;
  open(): Promise<AgentSession>;
  start(caseName: ContractCase): Promise<TurnRun>;
  readonly unsupported?: Partial<Record<ContractCase, string>>;
}

const UI_KINDS: readonly UiRequestKind[] = [
  "select",
  "confirm",
  "input",
  "editor",
];

// A capability that is claimed must be a method the session really has, or a
// caller that trusts the capability crashes on `undefined is not a function`.
const CAPABILITY_METHODS: readonly (readonly [
  keyof Capabilities,
  keyof AgentSession,
])[] = [
  ["steer", "steer"],
  ["thinkingLevels", "setThinking"],
  ["compact", "compact"],
  ["slashCommands", "listCommands"],
  ["skills", "listCommands"],
  ["uiDialogs", "respondUi"],
  ["personasWithoutRespawn", "setPersona"],
  ["handoffTui", "tuiCommand"],
];

export function expectOneSettled(
  events: readonly AgentEvent[],
): AgentEventOf<"settled"> {
  const settled = events.filter((event) => event.type === "settled");
  expect(
    settled,
    `a turn must end with exactly one settled event, saw ${settled.length}`,
  ).toHaveLength(1);
  const last = events.at(-1);
  expect(last, "nothing may follow the settled event").toEqual(settled[0]);
  return settled[0] as AgentEventOf<"settled">;
}

export function expectTurnStarted(events: readonly AgentEvent[]): void {
  const starts = events.filter((event) => event.type === "turn_start");
  expect(starts.length, "at most one turn_start per turn").toBeLessThanOrEqual(
    1,
  );
  if (starts.length === 1 && events.length > 1) {
    expect(events[0], "turn_start comes first").toEqual(starts[0]);
  }
}

export function expectToolInvariants(events: readonly AgentEvent[]): void {
  const started: string[] = [];
  for (const event of events) {
    if (event.type === "tool_start") {
      expect(
        started,
        `tool_start ids must be unique, ${event.id} repeated`,
      ).not.toContain(event.id);
      expect(
        event.summary,
        "a tool_start needs an adapter-built summary for the renderer",
      ).toBeTruthy();
      started.push(event.id);
      continue;
    }
    if (event.type === "tool_update" || event.type === "tool_end") {
      expect(
        started,
        `${event.type} for ${event.id} arrived before its tool_start`,
      ).toContain(event.id);
    }
  }
}

export function expectBlockInvariants(events: readonly AgentEvent[]): void {
  const deltas = new Map<number, number>();
  const ended = new Set<number>();
  for (const event of events) {
    if (event.type === "text_delta") {
      expect(
        ended.has(event.block),
        `block ${event.block} streamed after its text_end`,
      ).toBe(false);
      deltas.set(event.block, (deltas.get(event.block) ?? 0) + 1);
      continue;
    }
    if (event.type === "text_end") {
      expect(ended.has(event.block), `block ${event.block} ended twice`).toBe(
        false,
      );
      expect(
        deltas.has(event.block),
        `block ${event.block} ended without streaming text`,
      ).toBe(true);
      ended.add(event.block);
    }
  }
}

export function expectUsageInvariants(events: readonly AgentEvent[]): void {
  let input = 0;
  let output = 0;
  for (const event of events) {
    if (event.type !== "usage") {
      continue;
    }
    expect(
      event.input,
      "usage is cumulative for the turn",
    ).toBeGreaterThanOrEqual(input);
    expect(
      event.output,
      "usage is cumulative for the turn",
    ).toBeGreaterThanOrEqual(output);
    expect(event.input).toBeGreaterThanOrEqual(0);
    expect(event.output).toBeGreaterThanOrEqual(0);
    if (event.costUsd !== undefined) {
      expect(event.costUsd).toBeGreaterThanOrEqual(0);
    }
    input = event.input;
    output = event.output;
  }
}

export function expectRetryInvariants(events: readonly AgentEvent[]): void {
  const retries = events.filter((event) => event.type === "retry");
  retries.forEach((retry, index) => {
    expect(retry.attempt, "retries count from 1").toBe(index + 1);
    expect(retry.max, "a retry announces its ceiling").toBeGreaterThan(0);
    expect(retry.attempt).toBeLessThanOrEqual(retry.max);
    expect(retry.delayMs).toBeGreaterThanOrEqual(0);
    expect(retry.reason).toBeTruthy();
  });
}

export function expectUiRequestInvariants(events: readonly AgentEvent[]): void {
  for (const event of events) {
    if (event.type !== "ui_request") {
      continue;
    }
    expect(UI_KINDS).toContain(event.kind);
    expect(event.id, "a ui_request needs an id to answer").toBeTruthy();
    expect(event.title).toBeTruthy();
    if (event.kind === "select") {
      expect(
        event.options?.length,
        "a select needs options to choose from",
      ).toBeGreaterThan(0);
    }
  }
}

// Everything that must hold for any scripted turn, whatever it contains.
export function expectTurnInvariants(events: readonly AgentEvent[]): void {
  expectTurnStarted(events);
  expectOneSettled(events);
  expectBlockInvariants(events);
  expectToolInvariants(events);
  expectUsageInvariants(events);
  expectRetryInvariants(events);
  expectUiRequestInvariants(events);
}

export function lastBlockText(events: readonly AgentEvent[]): string | null {
  const ended: number[] = [];
  for (const event of events) {
    if (event.type === "text_end") {
      ended.push(event.block);
    }
  }
  const last = ended.at(-1);
  if (last === undefined) {
    return null;
  }
  let text = "";
  for (const event of events) {
    if (event.type === "text_delta" && event.block === last) {
      text += event.text;
    }
  }
  return text;
}

export function firstOfType<T extends AgentEventType>(
  events: readonly AgentEvent[],
  type: T,
): AgentEventOf<T> | undefined {
  return events.find((event): event is AgentEventOf<T> => event.type === type);
}

function abortReason(run: TurnRun): StopReason | "none" {
  return firstOfType(run.events, "settled")?.stopReason ?? "none";
}

export function runContractSuite(
  target: ContractTarget,
  options: ContractSuiteOptions = {},
): void {
  const register = options.register ?? it;
  // A case the target cannot run is skipped with its reason, so a missing case
  // is a stated decision in the report rather than a silent hole.
  const check = (
    caseName: ContractCase,
    title: string,
    body: () => Promise<void>,
  ): void => {
    const why = target.unsupported?.[caseName];
    if (why === undefined) {
      register(title, body);
      return;
    }
    it.skip(`${title} — skipped: ${why}`, body);
  };

  describe(`AgentPort contract: ${target.name}`, () => {
    it("probes as installed and usable", async () => {
      const probe = await target.probe();
      expect(probe.installed).toBe(true);
      expect(probe.usable, probe.problem ?? "no problem reported").toBe(true);
    });

    it("implements every method it claims, and no more than it must", async () => {
      const session = await target.open();
      for (const [capability, method] of CAPABILITY_METHODS) {
        if (!target.capabilities[capability]) {
          continue;
        }
        expect(
          typeof session[method],
          `${capability} is claimed, so ${method} must exist`,
        ).toBe("function");
      }
      expect(typeof session.abort).toBe("function");
      expect(typeof session.close).toBe("function");
      expect(typeof session.lastAssistantText).toBe("function");
      await session.close();
    });

    describe("stream", () => {
      check("stream", "streams text and settles once", async () => {
        const run = await target.start("stream");
        await run.done;
        expectTurnInvariants(run.events);
        expect(
          firstOfType(run.events, "turn_start"),
          "a turn announces itself",
        ).toBeDefined();
        expect(
          firstOfType(run.events, "settled")?.stopReason,
          "an unopposed turn stops normally",
        ).toBe("stop");
        const text = lastBlockText(run.events);
        expect(text, "a turn that claims to answer streams text").toBeTruthy();
        await run.session.close();
      });
    });

    describe("tools", () => {
      check(
        "tools",
        "pairs every tool with a start, an end, and a summary",
        async () => {
          const run = await target.start("tools");
          await run.done;
          expectTurnInvariants(run.events);
          const starts = run.events.filter(
            (event) => event.type === "tool_start",
          );
          expect(
            starts.length,
            "the script runs at least one tool",
          ).toBeGreaterThan(0);
          expect(
            run.events.filter((event) => event.type === "tool_end").length,
            "a tool that starts must end",
          ).toBe(starts.length);
          await run.session.close();
        },
      );
    });

    describe("dialog round trip", () => {
      check(
        "dialog",
        "answers a request and lets the turn finish",
        async () => {
          const run = await target.start("dialog");
          await run.until((event) => event.type === "ui_request", "ui_request");
          const request = firstOfType(run.events, "ui_request");
          expect(request).toBeDefined();
          const answer = request?.options?.[1] ?? request?.options?.[0] ?? "ok";
          run.session.respondUi(request?.id ?? "", { value: answer });
          await run.done;
          expectTurnInvariants(run.events);
          expect(
            abortReason(run),
            "answering a dialog lets the turn finish",
          ).not.toBe("aborted");
          await run.session.close();
        },
      );

      it("ignores an answer to a request it never made", async () => {
        const session = await target.open();
        expect(() =>
          session.respondUi("no-such-request", { value: "x" }),
        ).not.toThrow();
        await session.close();
      });
    });

    describe("error", () => {
      check(
        "error",
        "settles with an error and says what went wrong",
        async () => {
          const run = await target.start("error");
          await run.done;
          expectTurnInvariants(run.events);
          const settled = firstOfType(run.events, "settled");
          expect(settled?.stopReason, "the script fails on purpose").toBe(
            "error",
          );
          expect(
            settled?.error,
            "a failure has to say what went wrong",
          ).toBeTruthy();
          await run.session.close();
        },
      );
    });

    describe("retry", () => {
      check("retry", "counts retries and still settles once", async () => {
        const run = await target.start("retry");
        await run.done;
        expectTurnInvariants(run.events);
        const retries = run.events.filter((event) => event.type === "retry");
        expect(retries.length, "the script retries").toBeGreaterThan(0);
        expect(
          abortReason(run),
          "a retried turn still settles once, on its own terms",
        ).toMatch(/^(stop|error)$/);
        await run.session.close();
      });
    });

    describe("abort", () => {
      check(
        "abortDuringTool",
        "stops mid-tool and starts nothing new",
        async () => {
          const run = await target.start("abortDuringTool");
          await run.until((event) => event.type === "tool_start", "tool_start");
          const before = run.events.length;
          await run.stop();
          await run.done;
          expectTurnInvariants(run.events);
          expect(
            abortReason(run),
            "aborting mid-tool ends the turn as aborted",
          ).toBe("aborted");
          expect(
            run.events
              .slice(before)
              .some((event) => event.type === "tool_start"),
            "no new tool may start after an abort",
          ).toBe(false);
          await run.session.close();
        },
      );

      check(
        "abortFromSignal",
        "honours the prompt signal on its own",
        async () => {
          const run = await target.start("abortFromSignal");
          await run.until((event) => event.type === "text_delta", "text_delta");
          await run.stop("signal");
          await run.done;
          expectTurnInvariants(run.events);
          expect(abortReason(run)).toBe("aborted");
          await run.session.close();
        },
      );

      check(
        "abortFromMethod",
        "honours session.abort() on its own",
        async () => {
          const run = await target.start("abortFromMethod");
          await run.until((event) => event.type === "text_delta", "text_delta");
          await run.stop("method");
          await run.done;
          expectTurnInvariants(run.events);
          expect(abortReason(run)).toBe("aborted");
          await run.session.close();
        },
      );

      it("is a no-op while idle", async () => {
        const session = await target.open();
        await expect(session.abort()).resolves.not.toThrow();
        const run = await target.start("stream");
        await run.until((event) => event.type === "turn_start", "turn_start");
        await run.stop();
        await run.done;
        await session.close();
      });
    });

    describe("state and last text", () => {
      check(
        "stream",
        "reports the answer of the last completed block",
        async () => {
          const run = await target.start("stream");
          await run.done;
          const expected = lastBlockText(run.events);
          await expect(run.session.lastAssistantText()).resolves.toBe(expected);
          await run.session.close();
        },
      );

      check(
        "stream",
        "is not busy between turns, and busy during one",
        async () => {
          const run = await target.start("stream");
          await run.until((event) => event.type === "turn_start", "turn_start");
          expect(
            (await run.session.state()).busy,
            "a turn in flight means busy",
          ).toBe(true);
          await run.stop();
          await run.done;
          expect((await run.session.state()).busy).toBe(false);
          await run.session.close();
        },
      );

      it("has no last text before any turn", async () => {
        const session = await target.open();
        await expect(session.lastAssistantText()).resolves.toBeNull();
        await session.close();
      });

      // Not a must-fail: a backend is allowed to have no conversation name.
      it("names the conversation, and renames it", async () => {
        const run = await target.start("stream");
        await run.done;
        const before = await run.session.state();
        expect(before.name === undefined || before.name.length > 0).toBe(true);
        if (typeof run.session.rename === "function") {
          await run.session.rename("contract suite");
          expect((await run.session.state()).name).toBe("contract suite");
        }
        await run.session.close();
      });
    });

    describe("models", () => {
      const skip = !target.capabilities.models;
      it.skipIf(skip)("lists models it can switch to", async () => {
        const session = await target.open();
        const models = await session.listModels();
        expect(
          models.length,
          "a models backend offers something to pick",
        ).toBeGreaterThan(0);
        for (const model of models) {
          expect(model.provider).toBeTruthy();
          expect(model.id).toBeTruthy();
        }
        await session.setModel({
          provider: models[0]?.provider ?? "",
          id: models[0]?.id ?? "",
        });
        expect((await session.state()).model).toEqual({
          provider: models[0]?.provider,
          id: models[0]?.id,
        });
        await session.close();
      });
    });

    describe("thinking", () => {
      const skip = !target.capabilities.thinkingLevels;
      it.skipIf(skip)("reports and changes the thinking level", async () => {
        const session = await target.open();
        const before = (await session.state()).thinking;
        expect(before === undefined || before.length > 0).toBe(true);
        await session.setThinking?.("high");
        expect((await session.state()).thinking).toBe("high");
        await session.setThinking?.(before ?? "off");
        await session.close();
      });
    });

    describe("commands", () => {
      const skip = !target.capabilities.slashCommands;
      it.skipIf(skip)("lists commands with a kind", async () => {
        const session = await target.open();
        const commands = (await session.listCommands?.()) ?? [];
        expect(Array.isArray(commands)).toBe(true);
        for (const command of commands) {
          expect(["skill", "template", "extension"]).toContain(command.kind);
          expect(command.name).toBeTruthy();
        }
        await session.close();
      });
    });

    describe("compaction", () => {
      const skip = !target.capabilities.compact;
      it.skipIf(skip)("reports what it compacted", async () => {
        // A fresh session: a run's session is closed once its turn ends.
        const session = await target.open();
        const result = await session.compact?.("contract suite");
        expect(result, "a compacting backend returns a result").toBeDefined();
        expect(
          result?.tokensBefore === undefined || result.tokensBefore >= 0,
        ).toBe(true);
        await session.close();
      });
    });
  });
}
