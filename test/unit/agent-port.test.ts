import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AgentBackend,
  AgentEvent,
  AgentEventOf,
  AgentEventType,
  AgentSession,
  Capabilities,
  PromptInput,
  StopReason,
} from "../../src/core/agent-port.js";
import { PrefaixError, unsupported } from "../../src/core/errors.js";

// A minimal backend: it implements only the required AgentSession methods,
// which proves the optional ones really are optional for adapters.
const minimalCapabilities: Capabilities = {
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

function scriptedBackend(script: AgentEvent[]): AgentBackend {
  return {
    id: "scripted",
    capabilities: minimalCapabilities,
    probe: async () => ({ installed: true, usable: true, version: "0.0.0" }),
    open: async (opts) => {
      let last: string | null = null;
      const session: AgentSession = {
        native: opts.resume ?? { sessionId: "scripted-1" },
        async *prompt(_input, signal) {
          for (const event of script) {
            if (signal.aborted) {
              yield { type: "settled", stopReason: "aborted" };
              return;
            }
            if (event.type === "text_delta") last = (last ?? "") + event.text;
            yield event;
          }
        },
        abort: async () => {},
        respondUi: () => {},
        state: async () => ({ busy: false }),
        listModels: async () => [],
        setModel: async () => {},
        lastAssistantText: async () => last,
        close: async () => {},
      };
      return session;
    },
  };
}

const input: PromptInput = {
  text: "why does the auth test fail?",
  context: {
    shell: { kind: "zsh", version: "5.9", shellId: "42-1-a", pid: 42 },
    cwd: "/Users/allan/proj",
    recent: [{ cmd: "bun test auth", exit: 1 }],
    os: "macOS 27.0",
    term: { cols: 100, rows: 30, colors: 256 },
  },
};

// Exhaustive over the union: adding an event type without handling it here
// is a compile error.
function describeEvent(event: AgentEvent): string {
  switch (event.type) {
    case "turn_start":
      return "start";
    case "text_delta":
      return `text ${event.text}`;
    case "text_end":
      return `end ${event.block}`;
    case "thinking_delta":
      return "thinking";
    case "tool_start":
      return `tool ${event.name} ${event.summary}`;
    case "tool_update":
      return `update ${event.id}`;
    case "tool_end":
      return `tool ${event.ok ? "ok" : "failed"}`;
    case "ui_request":
      return `ui ${event.kind}`;
    case "set_buffer":
      return `buffer ${event.text}`;
    case "notice":
      return `${event.level} ${event.text}`;
    case "status":
      return `status ${event.key}`;
    case "retry":
      return `retry ${event.attempt}/${event.max}`;
    case "compaction":
      return `compaction ${event.phase}`;
    case "usage":
      return `usage ${event.input}/${event.output}`;
    case "settled":
      return `settled ${event.stopReason}`;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

describe("AgentPort", () => {
  it("streams normalized events from a minimal backend", async () => {
    const backend = scriptedBackend([
      { type: "turn_start" },
      { type: "tool_start", id: "1", name: "bash", summary: "$ bun test auth" },
      { type: "tool_end", id: "1", ok: true, ms: 1200 },
      { type: "text_delta", block: 0, text: "Fixed." },
      { type: "text_end", block: 0 },
      { type: "usage", input: 10, output: 2, contextPct: null },
      { type: "settled", stopReason: "stop" },
    ]);
    expect(await backend.probe()).toEqual({
      installed: true,
      usable: true,
      version: "0.0.0",
    });
    const session = await backend.open({ root: "/Users/allan/proj", env: {} });
    const seen: string[] = [];
    for await (const event of session.prompt(
      input,
      new AbortController().signal,
    )) {
      seen.push(describeEvent(event));
    }
    expect(seen).toEqual([
      "start",
      "tool bash $ bun test auth",
      "tool ok",
      "text Fixed.",
      "end 0",
      "usage 10/2",
      "settled stop",
    ]);
    expect(await session.lastAssistantText()).toBe("Fixed.");
  });

  it("ends an aborted turn with settled(aborted)", async () => {
    const session = await scriptedBackend([
      { type: "turn_start" },
      { type: "settled", stopReason: "stop" },
    ]).open({ root: "/", env: {}, resume: { sessionFile: "/tmp/s.jsonl" } });
    const controller = new AbortController();
    controller.abort();
    const events: AgentEvent[] = [];
    for await (const event of session.prompt(input, controller.signal)) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "settled", stopReason: "aborted" }]);
    expect(session.native).toEqual({ sessionFile: "/tmp/s.jsonl" });
  });

  it("lets callers degrade missing capabilities to a clear error", async () => {
    const backend = scriptedBackend([]);
    const session = await backend.open({ root: "/", env: {} });
    const think = async (level: string) => {
      if (!backend.capabilities.thinkingLevels || !session.setThinking) {
        throw unsupported(backend.id, ":think");
      }
      await session.setThinking(level);
    };
    await expect(think("high")).rejects.toThrow(PrefaixError);
    await expect(think("high")).rejects.toThrow(
      ":think isn't supported by scripted",
    );
  });

  it("exposes precise event types", () => {
    expectTypeOf<AgentEventType>().toEqualTypeOf<
      | "turn_start"
      | "text_delta"
      | "text_end"
      | "thinking_delta"
      | "tool_start"
      | "tool_update"
      | "tool_end"
      | "ui_request"
      | "set_buffer"
      | "notice"
      | "status"
      | "retry"
      | "compaction"
      | "usage"
      | "settled"
    >();
    expectTypeOf<
      AgentEventOf<"settled">["stopReason"]
    >().toEqualTypeOf<StopReason>();
    expectTypeOf<AgentEventOf<"tool_end">>().toEqualTypeOf<{
      type: "tool_end";
      id: string;
      ok: boolean;
      summary?: string;
      ms?: number;
    }>();
    expectTypeOf<Capabilities["abort"]>().toEqualTypeOf<true>();
    expectTypeOf<AgentSession["steer"]>().toEqualTypeOf<
      ((text: string) => Promise<void>) | undefined
    >();
  });
});
