import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentEventOf,
  OpenOptions,
  PromptInput,
  ShellContext,
} from "../../src/core/agent-port.js";
import { PrefaixError } from "../../src/core/errors.js";
import {
  FAKE_MODELS,
  createFakeAgent,
  type FakeAgent,
  type FakeSession,
} from "../../src/agents/fake/adapter.js";
import {
  SCENARIO_NAMES,
  answerText,
  type ScenarioName,
} from "../../src/agents/fake/scenarios.js";

const ROOT = "/Users/tester/proj";

const CONTEXT: ShellContext = {
  shell: { kind: "zsh", version: "5.9", shellId: "4242-1-abc", pid: 4242 },
  cwd: `${ROOT}/packages/api`,
  recent: [{ cmd: "git pull", exit: 0 }],
  os: "macOS 27.0",
  term: { cols: 100, rows: 30, colors: 256 },
};

function input(text = "hello"): PromptInput {
  return { text, context: CONTEXT };
}

function openOptions(overrides: Partial<OpenOptions> = {}): OpenOptions {
  return { root: ROOT, env: { PATH: "/usr/bin" }, ...overrides };
}

interface Gate {
  sleep: () => Promise<void>;
  /** Lets the parked step through. */
  release: () => void;
  /** Resolves when the turn is parked, or already parked. */
  parked: () => Promise<void>;
}

// A gate instead of a real sleep, so a test decides when the turn yields
// control and can abort at a known point in the scenario.
function makeGate(): Gate {
  let waiting: (() => void) | undefined;
  let isParked = false;
  let watchers: (() => void)[] = [];
  const flush = (): void => {
    const pending = watchers;
    watchers = [];
    for (const watch of pending) {
      watch();
    }
  };
  return {
    sleep: () =>
      new Promise<void>((resolve) => {
        waiting = resolve;
        isParked = true;
        flush();
      }),
    release: () => {
      isParked = false;
      const next = waiting;
      waiting = undefined;
      next?.();
    },
    parked: () => {
      if (isParked) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => watchers.push(resolve));
    },
  };
}

// Runs a gated turn to completion, releasing each step boundary as the turn
// reaches it, and returning every event it emitted.
async function drive(
  open: FakeSession,
  gate: Gate,
  options: {
    signal?: AbortSignal;
    onEvent?: (event: AgentEvent) => void | Promise<void>;
  } = {},
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const run = (async () => {
    for await (const event of open.prompt(
      input(),
      options.signal ?? new AbortController().signal,
    )) {
      events.push(event);
      await options.onEvent?.(event);
    }
  })();
  for (;;) {
    const outcome = await Promise.race([
      gate.parked().then(() => "parked" as const),
      run.then(() => "done" as const),
    ]);
    if (outcome === "done") {
      break;
    }
    gate.release();
  }
  return run.then(() => events);
}

function fake(
  scenario: string,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): FakeAgent {
  return createFakeAgent({
    scenario,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

async function collect(
  session: FakeSession,
  prompt: PromptInput = input(),
  signal: AbortSignal = new AbortController().signal,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.prompt(prompt, signal)) {
    events.push(event);
  }
  return events;
}

function types(events: readonly AgentEvent[]): string[] {
  return events.map((event) => event.type);
}

function settled(events: readonly AgentEvent[]): AgentEventOf<"settled"> {
  const last = events.at(-1);
  if (last === undefined || last.type !== "settled") {
    throw new Error(`expected a settled event, got ${JSON.stringify(last)}`);
  }
  return last;
}

function text(events: readonly AgentEvent[]): string {
  return events
    .filter(
      (event): event is AgentEventOf<"text_delta"> =>
        event.type === "text_delta",
    )
    .map((event) => event.text)
    .join("");
}

async function session(
  scenario: ScenarioName,
  options: {
    sleep?: (ms: number) => Promise<void>;
    open?: Partial<OpenOptions>;
  } = {},
): Promise<FakeSession> {
  const agent = fake(scenario, options);
  return (await agent.open(openOptions(options.open))) as FakeSession;
}

describe("fake backend selection", () => {
  it("defaults to the hello scenario", () => {
    expect(createFakeAgent().scenarioName).toBe("hello");
  });

  it("reads PREFAIX_FAKE_SCENARIO", () => {
    expect(
      createFakeAgent({ env: { PREFAIX_FAKE_SCENARIO: "tools" } }).scenarioName,
    ).toBe("tools");
  });

  it("prefers an explicit scenario over the environment", () => {
    expect(
      createFakeAgent({
        scenario: "buffer",
        env: { PREFAIX_FAKE_SCENARIO: "tools" },
      }).scenarioName,
    ).toBe("buffer");
  });

  it("names every scenario it ships", () => {
    expect(SCENARIO_NAMES).toEqual([
      "buffer",
      "dialog",
      "error",
      "hello",
      "long",
      "retry",
      "tools",
    ]);
  });

  it("probes usable for a known scenario", async () => {
    await expect(fake("tools").probe()).resolves.toEqual({
      installed: true,
      usable: true,
      version: "fake/tools",
    });
  });

  it("probes unusable and lists the scenarios for an unknown one", async () => {
    await expect(fake("nope").probe()).resolves.toEqual({
      installed: true,
      usable: false,
      problem: 'unknown fake scenario "nope"',
      hint: "Set PREFAIX_FAKE_SCENARIO to one of: buffer, dialog, error, hello, long, retry, tools",
    });
  });

  it("refuses to open an unknown scenario", async () => {
    const agent = fake("nope");
    await expect(agent.open(openOptions())).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      message: 'unknown fake scenario "nope"',
    });
  });

  it("runs a caller-supplied script instead of a named scenario", async () => {
    const agent = createFakeAgent({
      scenario: "custom",
      sleep: async () => {},
      steps: [
        { type: "turn_start" },
        { type: "text_delta", block: 0, text: "only this\n" },
        { type: "text_end", block: 0 },
      ],
    });
    await expect(agent.probe()).resolves.toMatchObject({
      usable: true,
      version: "fake/custom",
    });
    const open = (await agent.open(openOptions())) as FakeSession;
    const events = await collect(open);
    // The script has no usage or settled step, so the fake appends both: usage
    // is derived from the text that was actually emitted.
    expect(types(events)).toEqual([
      "turn_start",
      "text_delta",
      "text_end",
      "usage",
      "settled",
    ]);
    // input is the prompt length plus a fixed overhead, output is the text.
    expect(events[3]).toEqual({
      type: "usage",
      input: "hello".length + 40,
      output: 10,
      costUsd: 0.000013,
    });
    expect((await open.state()).usage).toEqual({
      input: 45,
      output: 10,
      costUsd: 0.000013,
    });
  });

  it("stops at the first settled a script declares", async () => {
    const open = (await createFakeAgent({
      steps: [
        { type: "turn_start" },
        { type: "text_delta", block: 0, text: "kept\n" },
        { type: "text_end", block: 0 },
        { type: "settled", stopReason: "stop" },
        { type: "text_delta", block: 1, text: "unreachable\n" },
        { type: "settled", stopReason: "error", error: "never reached" },
      ],
      sleep: async () => {},
    }).open(openOptions())) as FakeSession;
    const events = await collect(open);
    expect(settled(events)).toEqual({ type: "settled", stopReason: "stop" });
    expect(text(events)).toBe("kept\n");
  });
});

describe("fake capabilities", () => {
  it("claims only what it implements", () => {
    const { capabilities } = fake("hello");
    expect(capabilities).toEqual({
      steer: false,
      followUp: false,
      abort: true,
      models: true,
      thinkingLevels: true,
      compact: true,
      slashCommands: true,
      skills: true,
      uiDialogs: true,
      contextSections: true,
      personasWithoutRespawn: true,
      handoffTui: false,
    });
  });

  it("leaves the M4 and pi-only methods off the session", async () => {
    const open = await session("hello", { sleep: async () => {} });
    expect(typeof open.prompt).toBe("function");
    expect("steer" in open).toBe(false);
    expect("tuiCommand" in open).toBe(false);
  });

  it("accepts capability overrides", () => {
    const agent = createFakeAgent({ capabilities: { models: false } });
    expect(agent.capabilities.models).toBe(false);
    expect(agent.capabilities.compact).toBe(true);
  });
});

describe("fake hello turn", () => {
  it("streams, then settles exactly once", async () => {
    const open = await session("hello", { sleep: async () => {} });
    const events = await collect(open);
    expect(types(events)).toEqual([
      "turn_start",
      "text_delta",
      "text_delta",
      "text_end",
      "usage",
      "settled",
    ]);
    expect(text(events)).toBe(
      "Hello from the fake backend.\nThis turn is scripted, so the output is byte-for-byte predictable.\n",
    );
    expect(settled(events)).toEqual({ type: "settled", stopReason: "stop" });
  });

  it("is byte-for-byte identical across runs", async () => {
    const first = types(
      await collect(await session("hello", { sleep: async () => {} })),
    );
    const second = types(
      await collect(await session("hello", { sleep: async () => {} })),
    );
    expect(first).toEqual(second);
  });

  it("ends the last block and records the turn", async () => {
    const open = await session("hello", { sleep: async () => {} });
    await collect(open);
    expect(await open.lastAssistantText()).toBe(
      "Hello from the fake backend.\nThis turn is scripted, so the output is byte-for-byte predictable.\n",
    );
    expect(open.transcript.turns).toHaveLength(1);
    expect(open.transcript.turns[0]?.user).toBe("hello");
  });

  it("accumulates usage and context across turns", async () => {
    const open = await session("hello", { sleep: async () => {} });
    await collect(open);
    await collect(open, input("again"));
    const state = await open.state();
    expect(state.usage).toEqual({ input: 256, output: 274, costUsd: 0 });
    expect(state.busy).toBe(false);
    expect(open.transcript.turns).toHaveLength(2);
  });

  it("receives the shell context and persona it was opened with", async () => {
    const open = await session("hello", {
      sleep: async () => {},
      open: { persona: { name: "ask", tools: ["read"] } },
    });
    await collect(open);
    expect(open.lastRoot).toBe(ROOT);
    expect(open.lastPrompt?.context.cwd).toBe(`${ROOT}/packages/api`);
    expect(open.lastPrompt?.context.recent).toEqual([
      { cmd: "git pull", exit: 0 },
    ]);
    expect(open.persona).toEqual({ name: "ask", tools: ["read"] });
  });
});

describe("fake tools turn", () => {
  it("emits paired tool lines with adapter-built summaries", async () => {
    const events = await collect(
      await session("tools", { sleep: async () => {} }),
    );
    expect(types(events)).toEqual([
      "turn_start",
      "tool_start",
      "tool_update",
      "tool_end",
      "tool_start",
      "tool_update",
      "tool_end",
      "tool_start",
      "tool_end",
      "text_delta",
      "text_delta",
      "text_end",
      "usage",
      "settled",
    ]);
    const starts = events.filter(
      (event): event is AgentEventOf<"tool_start"> =>
        event.type === "tool_start",
    );
    expect(starts.map((event) => event.summary)).toEqual([
      "src/core/config.ts",
      "$ bun run check",
      "loadConfig",
    ]);
    const ends = events.filter(
      (event): event is AgentEventOf<"tool_end"> => event.type === "tool_end",
    );
    expect(ends.map((event) => event.ok)).toEqual([true, true, false]);
    // Every tool_end pairs with the tool_start of the same id, in order.
    expect(ends.map((event) => event.id)).toEqual(
      starts.map((event) => event.id),
    );
  });
});

describe("fake long turn", () => {
  it("streams 120 lines and sets a status", async () => {
    const events = await collect(
      await session("long", { sleep: async () => {} }),
    );
    const deltas = events.filter(
      (event): event is AgentEventOf<"text_delta"> =>
        event.type === "text_delta",
    );
    expect(deltas).toHaveLength(121);
    expect(deltas.at(-1)?.text).toBe("  120  line 120 of 120\n");
    expect(types(events)).toContain("status");
  });
});

describe("fake dialog turn", () => {
  it("waits for the answer and reflects it into the stream", async () => {
    const open = await session("dialog", { sleep: async () => {} });
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const turn = open.prompt(input("which branch?"), controller.signal);
    const iterator = turn[Symbol.asyncIterator]();

    for (
      let step = await iterator.next();
      !step.done;
      step = await iterator.next()
    ) {
      const event = step.value;
      events.push(event);
      if (event.type === "ui_request") {
        expect(event).toEqual({
          type: "ui_request",
          id: "d1",
          kind: "select",
          title: "Which branch?",
          message: "Two branches match the failing test.",
          options: ["main", "release/2.1"],
        });
        // The turn is parked until the answer arrives.
        open.respondUi(event.id, { value: "release/2.1" });
      }
    }

    expect(types(events)).toEqual([
      "turn_start",
      "text_delta",
      "text_end",
      "ui_request",
      "text_delta",
      "text_end",
      "usage",
      "settled",
    ]);
    expect(text(events)).toContain("Working on release/2.1, as you chose.\n");
    expect(await open.lastAssistantText()).toBe(
      "Working on release/2.1, as you chose.\n",
    );
  });

  it("accepts an answer that arrives before the turn asks for it", async () => {
    const open = await session("dialog", { sleep: async () => {} });
    const events: AgentEvent[] = [];
    const turn = open.prompt(input(), new AbortController().signal);
    const iterator = turn[Symbol.asyncIterator]();
    open.respondUi("d1", { value: "main" });
    for (
      let step = await iterator.next();
      !step.done;
      step = await iterator.next()
    ) {
      events.push(step.value);
    }
    expect(text(events)).toContain("Working on main, as you chose.\n");
  });

  it("abandons a parked dialog when the turn is aborted", async () => {
    const open = await session("dialog", { sleep: async () => {} });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    const turn = open.prompt(input(), controller.signal);
    const iterator = turn[Symbol.asyncIterator]();
    for (
      let step = await iterator.next();
      !step.done;
      step = await iterator.next()
    ) {
      events.push(step.value);
      // The user pressed Esc while the question was on screen, so the answer
      // is never coming and the turn has to end on its own.
      if (step.value.type === "ui_request") {
        controller.abort("client asked");
      }
    }
    expect(types(events)).toContain("settled");
    expect(events.at(-1)).toEqual({
      type: "settled",
      stopReason: "aborted",
    });
  });

  it("carries on when a parked dialog has nothing to wait for", async () => {
    // A scenario that parks without ever asking is a broken script rather than
    // a stuck turn: there is no answer coming, so the step is skipped.
    const agent = createFakeAgent({
      tickMs: 0,
      sleep: async () => {},
      steps: [
        { type: "turn_start" },
        { type: "text_delta", block: 0, text: "no question asked\n" },
        { type: "text_end", block: 0 },
        { type: "await_ui" },
        { type: "settled", stopReason: "stop" },
      ],
    });
    const open = (await agent.open(openOptions())) as FakeSession;
    const events = await collect(open, input());
    expect(types(events)).toEqual([
      "turn_start",
      "text_delta",
      "text_end",
      "settled",
    ]);
    expect(text(events)).toBe("no question asked\n");
    await open.close();
  });

  it("records the prompt in the transcript it keeps", async () => {
    const open = await session("hello", { sleep: async () => {} });
    // The transcript is what a test asserts a second turn against, so the user
    // side of it has to be the prompt that was actually sent.
    await collect(open, input(": remember this"));
    // The prompt is recorded exactly as it was sent; stripping the `:` is the
    // grammar's job, and it has already happened by the time it gets here.
    expect(open.transcript.turns.at(-1)?.user).toBe(": remember this");
    expect(open.transcript.turns.at(-1)?.assistant).toContain("Hello");
    await open.close();
  });

  it("reports no last answer before there has been one", async () => {
    const open = await session("hello", { sleep: async () => {} });
    expect(await open.lastAssistantText()).toBeNull();
    // A turn that produced no text has no answer to report either.
    const events = await collect(open, input());
    void events;
    expect(await open.lastAssistantText()).toContain(
      "Hello from the fake backend.",
    );
    await open.close();
  });

  it("spells out every answer shape", () => {
    expect(answerText({ value: "x" })).toBe("x");
    expect(answerText({ confirmed: true })).toBe("yes");
    expect(answerText({ confirmed: false })).toBe("no");
    expect(answerText({ cancelled: true })).toBe("cancelled");
  });
});

describe("fake error and retry turns", () => {
  it("warns, then settles with the error", async () => {
    const events = await collect(
      await session("error", { sleep: async () => {} }),
    );
    expect(types(events)).toEqual([
      "turn_start",
      "text_delta",
      "text_end",
      "notice",
      "usage",
      "settled",
    ]);
    expect(settled(events)).toMatchObject({
      stopReason: "error",
      error: "fake backend: scripted failure (PREFAIX_FAKE_SCENARIO=error)",
    });
  });

  it("does not record a failed turn as conversation", async () => {
    const open = await session("error", { sleep: async () => {} });
    await collect(open);
    expect(open.transcript.turns).toHaveLength(0);
  });

  it("surfaces retries before recovering", async () => {
    const events = await collect(
      await session("retry", { sleep: async () => {} }),
    );
    expect(types(events)).toEqual([
      "turn_start",
      "retry",
      "retry",
      "text_delta",
      "text_end",
      "usage",
      "settled",
    ]);
    const retries = events.filter(
      (event): event is AgentEventOf<"retry"> => event.type === "retry",
    );
    expect(retries.map((event) => event.attempt)).toEqual([1, 2]);
    expect(retries.map((event) => event.max)).toEqual([3, 3]);
    expect(settled(events).stopReason).toBe("stop");
  });
});

describe("fake buffer turn", () => {
  it("sets the buffer without running it", async () => {
    const events = await collect(
      await session("buffer", { sleep: async () => {} }),
    );
    const buffers = events.filter(
      (event): event is AgentEventOf<"set_buffer"> =>
        event.type === "set_buffer",
    );
    expect(buffers).toEqual([
      { type: "set_buffer", text: "git push --force-with-lease origin main" },
    ]);
    expect(settled(events).stopReason).toBe("stop");
  });
});

describe("fake abort", () => {
  it("stops mid-stream and settles as aborted", async () => {
    const gate = makeGate();
    const open = await session("long", { sleep: gate.sleep });
    const controller = new AbortController();
    const events = await drive(open, gate, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text_delta" && event.text.includes("line 3 of")) {
          controller.abort();
        }
      },
    });

    expect(settled(events).stopReason).toBe("aborted");
    expect(events.filter((event) => event.type === "settled")).toHaveLength(1);
    const deltas = events.filter((event) => event.type === "text_delta");
    expect(deltas.length).toBeLessThan(121);
  });

  it("stops mid-tool when the session is aborted, not the signal", async () => {
    const gate = makeGate();
    const open = await session("tools", { sleep: gate.sleep });
    const events = await drive(open, gate, {
      onEvent: async (event) => {
        if (event.type === "tool_start" && event.id === "t2") {
          await open.abort();
        }
      },
    });

    const tools = events.filter((event) => event.type.startsWith("tool_"));
    expect(types(tools)).toEqual([
      "tool_start",
      "tool_update",
      "tool_end",
      "tool_start",
    ]);
    expect(settled(events).stopReason).toBe("aborted");
  });

  it("settles immediately when the signal is already aborted", async () => {
    const open = await session("hello", { sleep: async () => {} });
    const controller = new AbortController();
    controller.abort();
    expect(types(await collect(open, input(), controller.signal))).toEqual([
      "settled",
    ]);
  });

  it("aborts while parked on a dialog", async () => {
    const gate = makeGate();
    const open = await session("dialog", { sleep: gate.sleep });
    const controller = new AbortController();
    const events = await drive(open, gate, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "ui_request") {
          controller.abort();
        }
      },
    });
    expect(types(events)).toEqual([
      "turn_start",
      "text_delta",
      "text_end",
      "ui_request",
      "settled",
    ]);
    expect(settled(events).stopReason).toBe("aborted");
  });

  it("records neither a turn nor a completed block for an aborted one", async () => {
    const gate = makeGate();
    const open = await session("long", { sleep: gate.sleep });
    const controller = new AbortController();
    await drive(open, gate, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "text_delta" && event.text.includes("line 5 of")) {
          controller.abort();
        }
      },
    });
    expect(open.transcript.turns).toHaveLength(0);
    // Block 0 never reached text_end, so there is no completed answer to copy.
    expect(await open.lastAssistantText()).toBeNull();
  });

  it("aborting while idle is a no-op", async () => {
    const open = await session("hello", { sleep: async () => {} });
    await expect(open.abort()).resolves.toBeUndefined();
    expect((await open.state()).busy).toBe(false);
  });
});

describe("fake session lifecycle", () => {
  it("refuses a second turn while one is running", async () => {
    const gate = makeGate();
    const open = await session("hello", { sleep: gate.sleep });
    const first = drive(open, gate);
    await gate.parked();
    await expect(
      open.prompt(input(), new AbortController().signal).next(),
    ).rejects.toMatchObject({ code: "CONVERSATION_BUSY" });
    const events = await first;
    expect(settled(events).stopReason).toBe("stop");
  });

  it("refuses a turn after close", async () => {
    const open = await session("hello", { sleep: async () => {} });
    await open.close();
    await expect(
      open.prompt(input(), new AbortController().signal).next(),
    ).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
  });

  it("resumes the same transcript for a known session id", async () => {
    const agent = fake("hello", { sleep: async () => {} });
    const first = (await agent.open(
      openOptions({ title: "first" }),
    )) as FakeSession;
    await collect(first, input("one"));
    const native = first.native.sessionId ?? "";
    expect(native).toMatch(/^pfx-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

    const second = (await agent.open(
      openOptions({ resume: { sessionId: native }, title: "second" }),
    )) as FakeSession;
    await collect(second, input("two"));

    expect(second.native.sessionId).toBe(native);
    expect(
      agent.transcript(native ?? "")?.turns.map((turn) => turn.user),
    ).toEqual(["one", "two"]);
    expect((await second.state()).name).toBe("second");
  });

  it("creates a transcript for a session id it has never seen", async () => {
    const agent = fake("hello", { sleep: async () => {} });
    const open = (await agent.open(
      openOptions({ resume: { sessionId: "pfx-01ARZ3NDEKTSV4RRFFQ69G5FAV" } }),
    )) as FakeSession;
    expect(open.native.sessionId).toBe("pfx-01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(agent.transcript("pfx-01ARZ3NDEKTSV4RRFFQ69G5FAV")?.turns).toEqual(
      [],
    );
  });

  it("mints a distinct session id per conversation", async () => {
    const agent = fake("hello", { sleep: async () => {} });
    const first = await agent.open(openOptions());
    const second = await agent.open(openOptions());
    expect(first.native.sessionId).not.toBe(second.native.sessionId);
  });
});

describe("fake session commands", () => {
  it("lists, sets, and rejects models", async () => {
    const open = await session("hello", { sleep: async () => {} });
    expect(await open.listModels()).toEqual([...FAKE_MODELS]);
    expect((await open.state()).model).toEqual({
      provider: "fake",
      id: "fake-fast",
    });
    await open.setModel({ provider: "fake", id: "fake-slow" });
    expect((await open.state()).model).toEqual({
      provider: "fake",
      id: "fake-slow",
    });
    await expect(
      open.setModel({ provider: "openai", id: "gpt-5" }),
    ).rejects.toMatchObject({
      code: "AGENT_ERROR",
      message: "fake backend has no model openai/gpt-5",
      hint: "Known models: fake/fake-fast, fake/fake-slow",
    });
  });

  it("sets and rejects thinking levels", async () => {
    const open = await session("hello", { sleep: async () => {} });
    expect((await open.state()).thinking).toBe("off");
    await open.setThinking("high");
    expect((await open.state()).thinking).toBe("high");
    await expect(open.setThinking("ludicrous")).rejects.toMatchObject({
      code: "AGENT_ERROR",
      hint: "Known levels: off, low, medium, high",
    });
  });

  it("lists slash commands, skills, and extensions", async () => {
    const open = await session("hello", { sleep: async () => {} });
    const commands = await open.listCommands?.();
    expect(commands?.map((command) => command.kind)).toEqual([
      "skill",
      "template",
      "extension",
    ]);
  });

  it("renames the conversation", async () => {
    const open = await session("hello", { sleep: async () => {} });
    await open.rename("auth bug");
    expect((await open.state()).name).toBe("auth bug");
  });

  it("compacts the accumulated context", async () => {
    const open = await session("hello", { sleep: async () => {} });
    await collect(open);
    const before = (await open.state()).usage ?? { input: 0, output: 0 };
    const result = await open.compact("auth");
    expect(result.tokensBefore).toBe(before.input + before.output);
    expect(result.summary).toBe(
      `fake: compacted ${result.tokensBefore} tokens around auth`,
    );
    const after = await open.state();
    expect(after.usage).toEqual({ input: 0, output: 0, costUsd: 0 });
    expect(after.contextPct).toBe(0);
  });

  it("has no last text before any turn", async () => {
    const open = await session("hello", { sleep: async () => {} });
    expect(await open.lastAssistantText()).toBeNull();
  });

  it("reports busy while a turn runs", async () => {
    const gate = makeGate();
    const open = await session("hello", { sleep: gate.sleep });
    const seen: boolean[] = [];
    const first = drive(open, gate, {
      onEvent: async () => {
        seen.push((await open.state()).busy);
      },
    });
    await gate.parked();
    expect((await open.state()).busy).toBe(true);
    await first;
    expect(seen.every((busy) => busy)).toBe(true);
    expect((await open.state()).busy).toBe(false);
  });
});

describe("fake registry wiring", () => {
  it("builds the fake backend by id", async () => {
    const { createBackend, BACKEND_IDS, isBackendId } =
      await import("../../src/agents/registry.js");
    expect(BACKEND_IDS).toEqual(["fake", "pi"]);
    expect(isBackendId("fake")).toBe(true);
    const backend = createBackend("fake", {
      env: { PREFAIX_FAKE_SCENARIO: "tools" },
    });
    expect(backend.id).toBe("fake");
    expect((backend as FakeAgent).scenarioName).toBe("tools");
  });

  it("refuses a backend it cannot build", async () => {
    const { createBackend } = await import("../../src/agents/registry.js");
    expect(() => createBackend("claude")).toThrow(PrefaixError);
    expect(() => createBackend("claude")).toThrow(
      /No agent backend named "claude"/,
    );
    try {
      createBackend("claude");
    } catch (error) {
      expect((error as PrefaixError).code).toBe("AGENT_UNAVAILABLE");
      expect((error as PrefaixError).hint).toContain("agent.backend");
    }
  });
});

describe("fake agent options and edges", () => {
  it("runs a caller-supplied script with the default tick", async () => {
    // The default tick is a real delay, which is what a demo and a pty run use.
    const agent = createFakeAgent({
      steps: [
        { type: "turn_start" },
        { type: "text_delta", block: 0, text: "ticked\n" },
        { type: "text_end", block: 0 },
      ],
      tickMs: 1,
    });
    const open = (await agent.open({ root: "/x", env: {} })) as FakeSession;
    const events = await collect(open);
    expect(events.map((event) => event.type)).toEqual([
      "turn_start",
      "text_delta",
      "text_end",
      "usage",
      "settled",
    ]);
    await open.close();
  });

  it("uses a real timer when no sleep is injected", async () => {
    const agent = createFakeAgent({ scenario: "hello", tickMs: 5 });
    const open = (await agent.open({ root: "/x", env: {} })) as FakeSession;
    const started = Date.now();
    await collect(open);
    // Four ticks at 5ms, so at least a few milliseconds really elapsed.
    expect(Date.now() - started).toBeGreaterThanOrEqual(5);
    await open.close();
  });

  it("derives usage from a script that declares none", async () => {
    const agent = createFakeAgent({
      steps: [
        { type: "turn_start" },
        { type: "text_delta", block: 0, text: "abc" },
        { type: "text_end", block: 0 },
      ],
      sleep: async () => {},
    });
    const open = (await agent.open({ root: "/x", env: {} })) as FakeSession;
    const events = await collect(open);
    expect(events.at(-2)).toEqual({
      type: "usage",
      input: "hello".length + 40,
      output: 3,
      costUsd: expect.any(Number),
    });
  });

  it("keeps a persona across turns when a prompt does not set one", async () => {
    const open = (await createFakeAgent({ sleep: async () => {} }).open({
      root: "/x",
      env: {},
      persona: { name: "plan", guideline: "Numbered steps" },
    })) as FakeSession;
    await collect(open);
    expect(open.persona).toEqual({ name: "plan", guideline: "Numbered steps" });
    // A prompt may override it for one turn.
    await collect(open, {
      text: "hi",
      context: CONTEXT,
      persona: { name: "ask" },
    });
    expect(open.persona).toEqual({ name: "ask" });
  });

  it("aborts a running turn when closed", async () => {
    const gate = makeGate();
    const open = (await createFakeAgent({
      scenario: "long",
      sleep: gate.sleep,
    }).open({ root: "/x", env: {} })) as FakeSession;
    const events: AgentEvent[] = [];
    const run = (async () => {
      for await (const event of open.prompt(
        input(),
        new AbortController().signal,
      )) {
        events.push(event);
        gate.release();
      }
    })();
    await gate.parked();
    await open.close();
    gate.release();
    await run;
    // Closing reclaims the child, so the turn ends rather than hanging.
    expect(events.at(-1)?.type).toBe("settled");
  });

  it("exposes the scenario it is playing", () => {
    expect(
      createFakeAgent({ scenario: "tools" }).scenario.map((step) => step.type),
    ).toContain("tool_start");
    expect(() => createFakeAgent({ scenario: "nope" }).scenario).toThrow(
      /unknown fake scenario/,
    );
  });

  it("falls back to the file's model, thinking level, and title on resume", async () => {
    const agent = createFakeAgent({ sleep: async () => {} });
    const first = (await agent.open({
      root: "/x",
      env: {},
      title: "one",
    })) as FakeSession;
    await collect(first);
    const id = first.native.sessionId ?? "";
    const second = (await agent.open({
      root: "/x",
      env: {},
      resume: { sessionId: id },
      title: "two",
      model: { provider: "fake", id: "fake-slow" },
      thinking: "high",
    })) as FakeSession;
    const state = await second.state();
    expect(state.name).toBe("two");
    expect(state.model).toEqual({ provider: "fake", id: "fake-slow" });
    expect(state.thinking).toBe("high");
  });

  it("keeps the resume title when the reopen names nothing", async () => {
    const agent = createFakeAgent({ sleep: async () => {} });
    const first = (await agent.open({
      root: "/x",
      env: {},
      title: "one",
    })) as FakeSession;
    const second = (await agent.open({
      root: "/x",
      env: {},
      resume: first.native,
    })) as FakeSession;
    expect((await second.state()).name).toBe("one");
  });
});

describe("fake agent edges", () => {
  it("settles immediately when the signal is aborted before the turn", async () => {
    const controller = new AbortController();
    controller.abort();
    const open = (await createFakeAgent({ sleep: async () => {} }).open({
      root: "/x",
      env: {},
    })) as FakeSession;
    expect(types(await collect(open, input(), controller.signal))).toEqual([
      "settled",
    ]);
  });

  it("skips an await_ui step with no `into` and no answer", async () => {
    const open = (await createFakeAgent({
      sleep: async () => {},
      steps: [
        { type: "turn_start" },
        // The port's own dialog event, which the fake emits directly.
        { type: "ui_request", id: "d1", kind: "confirm", title: "ok?" },
        { type: "await_ui" },
        { type: "text_end", block: 0 },
        { type: "settled", stopReason: "stop" },
      ],
    }).open({ root: "/x", env: {} })) as FakeSession;
    const events: AgentEvent[] = [];
    const turn = open.prompt(input(), new AbortController().signal);
    for await (const event of turn) {
      events.push(event);
      if (event.type === "ui_request") {
        open.respondUi(event.id, { confirmed: false });
      }
    }
    // No text is synthesised when the script did not ask for it.
    expect(events.filter((event) => event.type === "text_delta")).toEqual([]);
    expect(settled(events).stopReason).toBe("stop");
  });

  it("synthesises a dialog answer with no prefix or suffix", async () => {
    const open = (await createFakeAgent({
      sleep: async () => {},
      steps: [
        { type: "turn_start" },
        { type: "ui_request", id: "d1", kind: "input", title: "name?" },
        { type: "await_ui", into: { block: 0 } },
        { type: "settled", stopReason: "stop" },
      ],
    }).open({ root: "/x", env: {} })) as FakeSession;
    const events: AgentEvent[] = [];
    for await (const event of open.prompt(
      input(),
      new AbortController().signal,
    )) {
      events.push(event);
      if (event.type === "ui_request") {
        open.respondUi(event.id, { value: "typed" });
      }
    }
    expect(text(events)).toBe("typed");
  });

  it("compact names no focus when the caller gives none or an empty one", async () => {
    const open = (await createFakeAgent({ sleep: async () => {} }).open({
      root: "/x",
      env: {},
    })) as FakeSession;
    await collect(open);
    expect((await open.compact())?.summary).toMatch(/tokens$/);
    await collect(open);
    expect((await open.compact(""))?.summary).toMatch(/tokens$/);
  });

  it("has no last text when the last block was empty", async () => {
    const open = (await createFakeAgent({
      sleep: async () => {},
      steps: [
        { type: "turn_start" },
        { type: "text_delta", block: 0, text: "" },
        { type: "text_end", block: 0 },
        { type: "settled", stopReason: "stop" },
      ],
    }).open({ root: "/x", env: {} })) as FakeSession;
    await collect(open);
    expect(await open.lastAssistantText()).toBeNull();
  });

  it("records a cost even when both sides are zero", async () => {
    const open = (await createFakeAgent({
      sleep: async () => {},
      steps: [
        { type: "turn_start" },
        { type: "usage", input: 0, output: 0 },
        { type: "settled", stopReason: "stop" },
      ],
    }).open({ root: "/x", env: {} })) as FakeSession;
    await collect(open);
    expect((await open.state()).usage).toEqual({
      input: 0,
      output: 0,
      costUsd: 0,
    });
  });
});

describe("fake agent last corners", () => {
  it("parks a turn on a dialog until it is answered or aborted", async () => {
    // Faithful to pi: an unanswered dialog parks the turn. The client is
    // responsible for answering it or pressing Esc, and a test script that
    // waits must do one or the other.
    const open = (await createFakeAgent({
      sleep: async () => {},
      steps: [
        { type: "turn_start" },
        { type: "ui_request", id: "d1", kind: "confirm", title: "ok?" },
        { type: "await_ui" },
        { type: "text_delta", block: 0, text: "answered\n" },
        { type: "text_end", block: 0 },
        { type: "settled", stopReason: "stop" },
      ],
    }).open({ root: "/x", env: {} })) as FakeSession;
    const events: AgentEvent[] = [];
    for await (const event of open.prompt(
      input(),
      new AbortController().signal,
    )) {
      events.push(event);
      if (event.type === "ui_request") {
        open.respondUi(event.id, { confirmed: true });
      }
    }
    expect(settled(events).stopReason).toBe("stop");
  });

  it("ignores a dialog answer for a request the turn never made", async () => {
    const open = (await createFakeAgent({ sleep: async () => {} }).open({
      root: "/x",
      env: {},
    })) as FakeSession;
    expect(() => open.respondUi("never-asked", { value: "x" })).not.toThrow();
  });

  it("records a turn whose prompt text is empty", async () => {
    const open = (await createFakeAgent({ sleep: async () => {} }).open({
      root: "/x",
      env: {},
    })) as FakeSession;
    await collect(open, input(""));
    expect(open.transcript.turns[0]?.user).toBe("");
  });
});

describe("fake registry wiring without options", () => {
  it("builds the fake with no env at all", async () => {
    const { createBackend } = await import("../../src/agents/registry.js");
    // No options at all: the factory must not require an env object.
    const backend = createBackend("fake");
    await expect(backend.probe()).resolves.toMatchObject({ usable: true });
  });
});
