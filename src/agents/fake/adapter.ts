// A scripted AgentPort backend (DESIGN §12.2). Tests, the shell end-to-end
// harness, and demos run against it, so nothing depends on a real model and
// every turn is byte-for-byte predictable.

import { ulid } from "../../core/ids.js";
import { PrefaixError } from "../../core/errors.js";
import type {
  AgentBackend,
  AgentCommand,
  AgentEvent,
  AgentSession,
  AgentState,
  Capabilities,
  CompactResult,
  ModelInfo,
  ModelRef,
  NativeRef,
  OpenOptions,
  PersonaSpec,
  ProbeResult,
  PromptInput,
  StopReason,
  UiResponse,
  Usage,
} from "../../core/agent-port.js";
import {
  DEFAULT_SCENARIO,
  SCENARIOS,
  answerText,
  isScenarioName,
  scenarioNames,
  type AwaitUiStep,
  type Scenario,
} from "./scenarios.js";

import { FAKE_ID, FAKE_CAPABILITIES } from "./capabilities.js";
export { FAKE_ID } from "./capabilities.js";

const CONTEXT_WINDOW = 200_000;

export const FAKE_MODELS: readonly ModelInfo[] = [
  {
    provider: "fake",
    id: "fake-fast",
    name: "Fake (fast)",
    contextWindow: CONTEXT_WINDOW,
  },
  {
    provider: "fake",
    id: "fake-slow",
    name: "Fake (slow, thorough)",
    contextWindow: CONTEXT_WINDOW,
    reasoning: true,
  },
];

export const FAKE_THINKING_LEVELS = ["off", "low", "medium", "high"] as const;

const FAKE_COMMANDS: readonly AgentCommand[] = [
  { name: "review", kind: "skill", description: "Review the current diff" },
  { name: "explain", kind: "template", description: "Explain a file" },
  { name: "init-rules", kind: "extension", description: "Write agent rules" },
];

// Synthetic and deterministic: no clock, no randomness, so a golden test can
// assert on the footer.
const INPUT_OVERHEAD = 40;
const COST_PER_INPUT_TOKEN = 0.15e-6;
const COST_PER_OUTPUT_TOKEN = 0.6e-6;

export interface FakeTurn {
  readonly user: string;
  readonly assistant: string;
  readonly stopReason: StopReason;
}

export interface FakeTranscript {
  readonly sessionId: string;
  title: string;
  model: ModelRef;
  thinking: string;
  usage: Usage;
  contextPct: number | null;
  turns: FakeTurn[];
}

function newTranscript(id: string, opts: OpenOptions): FakeTranscript {
  return {
    sessionId: id,
    title: opts.title ?? id,
    model: opts.model ?? { provider: "fake", id: "fake-fast" },
    thinking: opts.thinking ?? "off",
    usage: { input: 0, output: 0, costUsd: 0 },
    contextPct: 0,
    turns: [],
  };
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function contextPct(usage: Usage): number {
  const used = (usage.input + usage.output) / CONTEXT_WINDOW;
  return round(Math.min(1, used) * 100, 2);
}

// The fake always reports a cost, so a footer has something to render even at
// zero, and a golden test never has to distinguish absent from zero.
function addUsage(usage: Usage, delta: Usage): Usage {
  return {
    input: usage.input + delta.input,
    output: usage.output + delta.output,
    costUsd: round((usage.costUsd ?? 0) + (delta.costUsd ?? 0), 6),
  };
}

function modelList(): string {
  return FAKE_MODELS.map((model) => `${model.provider}/${model.id}`).join(", ");
}

export interface FakeSessionOptions {
  readonly scenario: Scenario;
  /** One pacing tick between steps. A test replaces this with a gate. */
  readonly tick: () => Promise<void>;
}

export class FakeSession implements AgentSession {
  readonly native: NativeRef;
  readonly #scenario: Scenario;
  readonly #tick: () => Promise<void>;
  readonly #transcript: FakeTranscript;
  #blocks = new Map<number, string>();
  #lastBlock: number | undefined;
  #pendingUi: string | undefined;
  #turn: AbortController | undefined;
  #uiWaiters = new Map<string, (response: UiResponse) => void>();
  #earlyUi = new Map<string, UiResponse>();
  #closed = false;

  // Exposed for unit tests: what the session was opened and prompted with, so
  // the client, context, and persona plumbing is assertable without a model.
  persona: PersonaSpec | undefined;
  lastPrompt: PromptInput | undefined;
  lastRoot: string | undefined;
  turnsRun = 0;

  constructor(
    transcript: FakeTranscript,
    options: FakeSessionOptions,
    lastRoot?: string,
  ) {
    this.#transcript = transcript;
    this.#scenario = options.scenario;
    this.#tick = options.tick;
    this.native = { sessionId: transcript.sessionId };
    this.lastRoot = lastRoot;
  }

  get isAlive(): boolean {
    return !this.#closed;
  }

  get transcript(): FakeTranscript {
    return this.#transcript;
  }

  async *prompt(
    input: PromptInput,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    if (this.#closed) {
      throw new PrefaixError("AGENT_UNAVAILABLE", "fake session is closed");
    }
    if (this.#turn !== undefined) {
      throw new PrefaixError(
        "CONVERSATION_BUSY",
        "fake session already has a turn running",
      );
    }

    const controller = new AbortController();
    this.#turn = controller;
    this.#blocks = new Map();
    this.#lastBlock = undefined;
    this.lastPrompt = input;
    this.persona = input.persona ?? this.persona;
    this.turnsRun += 1;
    const turn = AbortSignal.any([signal, controller.signal]);

    try {
      yield* this.#runTurn(input, turn);
    } finally {
      this.#turn = undefined;
    }
  }

  async *#runTurn(
    input: PromptInput,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    const aborted = (): AgentEvent => ({
      type: "settled",
      stopReason: "aborted",
    });

    if (signal.aborted) {
      yield aborted();
      return;
    }

    let sawUsage = false;
    for (const step of this.#scenario) {
      if (step.type === "await_ui") {
        const answer = await this.#awaitUi(signal);
        if (signal.aborted) {
          yield aborted();
          return;
        }
        if (answer === undefined) {
          continue;
        }
        for (const event of this.#answerEvents(step, answer)) {
          yield this.#record(event);
        }
        continue;
      }
      if (step.type === "settled") {
        yield this.#record(step);
        return;
      }
      if (step.type === "usage") {
        sawUsage = true;
      }
      yield this.#record(step);
      await this.#tick();
      if (signal.aborted) {
        yield aborted();
        return;
      }
    }

    if (!sawUsage) {
      yield this.#record(this.#usageFor(input));
    }
    yield this.#record({ type: "settled", stopReason: "stop" });
  }

  // Reflects the answer into a text block, so a dialog round trip shows up in
  // the event stream the renderer consumes.
  #answerEvents(step: AwaitUiStep, answer: UiResponse): AgentEvent[] {
    const into = step.into;
    if (into === undefined) {
      return [];
    }
    return [
      {
        type: "text_delta",
        block: into.block,
        text: `${into.prefix ?? ""}${answerText(answer)}${into.suffix ?? ""}`,
      },
      { type: "text_end", block: into.block },
    ];
  }

  // Applies each event to the transcript before the renderer sees it, so
  // state() and lastAssistantText() agree with the stream.
  #record(event: AgentEvent): AgentEvent {
    switch (event.type) {
      case "text_delta": {
        this.#blocks.set(
          event.block,
          (this.#blocks.get(event.block) ?? "") + event.text,
        );
        break;
      }
      case "text_end": {
        this.#lastBlock = event.block;
        break;
      }
      case "ui_request": {
        this.#pendingUi = event.id;
        break;
      }
      case "usage": {
        this.#transcript.usage = addUsage(this.#transcript.usage, event);
        this.#transcript.contextPct = contextPct(this.#transcript.usage);
        break;
      }
      case "settled": {
        this.#finishTurn(event.stopReason);
        break;
      }
      default:
        break;
    }
    return event;
  }

  #usageFor(input: PromptInput): AgentEvent {
    const output = [...this.#blocks.values()].reduce(
      (total, block) => total + block.length,
      0,
    );
    const inputTokens = input.text.length + INPUT_OVERHEAD;
    return {
      type: "usage",
      input: inputTokens,
      output,
      costUsd: round(
        inputTokens * COST_PER_INPUT_TOKEN + output * COST_PER_OUTPUT_TOKEN,
        6,
      ),
    };
  }

  // Only a completed turn joins the conversation: an aborted or failed turn
  // produced no answer to carry into the next one. lastAssistantText() stays
  // empty too, because a block that never reached text_end is not an answer.
  #finishTurn(stopReason: StopReason): void {
    const last = this.#lastBlock;
    const assistant = last === undefined ? "" : (this.#blocks.get(last) ?? "");
    if (stopReason === "stop" && assistant !== "") {
      this.#transcript.turns.push({
        user: this.lastPrompt?.text ?? "",
        assistant,
        stopReason,
      });
    }
  }

  // Resolves with the answer, or undefined when the turn was aborted while
  // waiting for one.
  #awaitUi(signal: AbortSignal): Promise<UiResponse | undefined> {
    const id = this.#pendingUi;
    if (id === undefined) {
      return Promise.resolve(undefined);
    }
    const early = this.#earlyUi.get(id);
    if (early !== undefined) {
      this.#earlyUi.delete(id);
      return Promise.resolve(early);
    }
    return new Promise<UiResponse | undefined>((resolve) => {
      const done = (response: UiResponse | undefined): void => {
        this.#uiWaiters.delete(id);
        signal.removeEventListener("abort", onAbort);
        resolve(response);
      };
      const onAbort = (): void => done(undefined);
      this.#uiWaiters.set(id, done);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  async abort(): Promise<void> {
    this.#turn?.abort();
  }

  respondUi(requestId: string, response: UiResponse): void {
    const waiter = this.#uiWaiters.get(requestId);
    if (waiter === undefined) {
      // The turn has not reached its await_ui step yet; the answer waits.
      this.#earlyUi.set(requestId, response);
      return;
    }
    waiter(response);
  }

  async state(): Promise<AgentState> {
    return {
      model: this.#transcript.model,
      thinking: this.#transcript.thinking,
      busy: this.#turn !== undefined,
      usage: { ...this.#transcript.usage },
      contextPct: this.#transcript.contextPct,
      name: this.#transcript.title,
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return FAKE_MODELS.map((model) => ({ ...model }));
  }

  async setModel(ref: ModelRef): Promise<void> {
    const known = FAKE_MODELS.some(
      (model) => model.provider === ref.provider && model.id === ref.id,
    );
    if (!known) {
      throw new PrefaixError(
        "AGENT_ERROR",
        `fake backend has no model ${ref.provider}/${ref.id}`,
        { hint: `Known models: ${modelList()}` },
      );
    }
    this.#transcript.model = { provider: ref.provider, id: ref.id };
  }

  async listThinkingLevels(): Promise<string[]> {
    return [...FAKE_THINKING_LEVELS];
  }

  async setThinking(level: string): Promise<void> {
    const known = FAKE_THINKING_LEVELS as readonly string[];
    if (!known.includes(level)) {
      throw new PrefaixError(
        "AGENT_ERROR",
        `fake backend has no thinking level ${JSON.stringify(level)}`,
        { hint: `Known levels: ${known.join(", ")}` },
      );
    }
    this.#transcript.thinking = level;
  }

  async listCommands(): Promise<AgentCommand[]> {
    return FAKE_COMMANDS.map((command) => ({ ...command }));
  }

  async compact(focus?: string): Promise<CompactResult> {
    const tokensBefore =
      this.#transcript.usage.input + this.#transcript.usage.output;
    this.#transcript.usage = { input: 0, output: 0, costUsd: 0 };
    this.#transcript.contextPct = 0;
    this.#blocks = new Map();
    this.#lastBlock = undefined;
    return {
      summary: `fake: compacted ${tokensBefore} tokens${
        focus === undefined || focus === "" ? "" : ` around ${focus}`
      }`,
      tokensBefore,
    };
  }

  async lastAssistantText(): Promise<string | null> {
    const last = this.#lastBlock;
    if (last === undefined) {
      return null;
    }
    const text = this.#blocks.get(last) ?? "";
    return text === "" ? null : text;
  }

  async setPersona(persona: PersonaSpec | undefined): Promise<void> {
    this.persona = persona;
  }

  async rename(title: string): Promise<void> {
    this.#transcript.title = title;
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#turn?.abort();
    this.#uiWaiters.clear();
    this.#earlyUi.clear();
  }
}

export interface FakeAgentOptions {
  /** Overrides PREFAIX_FAKE_SCENARIO. */
  readonly scenario?: string;
  /** Replaces the named scenario outright, for a test that needs its own. */
  readonly steps?: Scenario;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Milliseconds between steps. */
  readonly tickMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly capabilities?: Partial<Capabilities>;
}

const DEFAULT_TICK_MS = 12;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// The same id shape pi uses, so a conversation file looks the same either way.
function newSessionId(): string {
  return `pfx-${ulid()}`;
}

function resolveScenario(name: string): Scenario {
  if (!isScenarioName(name)) {
    throw new PrefaixError(
      "AGENT_UNAVAILABLE",
      `unknown fake scenario ${JSON.stringify(name)}`,
      { hint: `Set PREFAIX_FAKE_SCENARIO to one of: ${scenarioNames()}` },
    );
  }
  return SCENARIOS[name];
}

export class FakeAgent implements AgentBackend {
  readonly id = FAKE_ID;
  readonly capabilities: Capabilities;
  readonly #scenarioName: string;
  readonly #steps: Scenario | undefined;
  readonly #tick: () => Promise<void>;
  // Transcripts live for the process, so a conversation resumed inside one
  // daemon keeps its history. Nothing survives a restart, which is fine: the
  // fake exists for tests and demos.
  readonly #transcripts = new Map<string, FakeTranscript>();

  constructor(options: FakeAgentOptions = {}) {
    const env = options.env ?? process.env;
    this.#scenarioName =
      options.scenario ?? env["PREFAIX_FAKE_SCENARIO"] ?? DEFAULT_SCENARIO;
    const burst =
      this.#scenarioName === "burst" &&
      options.steps === undefined &&
      options.tickMs === undefined;
    const tickMs = options.tickMs ?? (burst ? 0 : DEFAULT_TICK_MS);
    const sleep =
      options.sleep ?? (burst ? () => Promise.resolve() : defaultSleep);
    this.#tick = () => sleep(tickMs);
    this.#steps = options.steps;
    this.capabilities = { ...FAKE_CAPABILITIES, ...options.capabilities };
  }

  get scenarioName(): string {
    return this.#scenarioName;
  }

  get scenario(): Scenario {
    return this.#steps ?? resolveScenario(this.#scenarioName);
  }

  async probe(): Promise<ProbeResult> {
    // A caller-supplied script needs no named scenario, so the name is only
    // checked when one selects the script.
    if (this.#steps === undefined && !isScenarioName(this.#scenarioName)) {
      return {
        installed: true,
        usable: false,
        problem: `unknown fake scenario ${JSON.stringify(this.#scenarioName)}`,
        hint: `Set PREFAIX_FAKE_SCENARIO to one of: ${scenarioNames()}`,
      };
    }
    return {
      installed: true,
      usable: true,
      version: `fake/${this.#scenarioName}`,
    };
  }

  async open(opts: OpenOptions): Promise<AgentSession> {
    const steps = this.scenario;
    const resumed = opts.resume?.sessionId;
    let transcript =
      resumed === undefined ? undefined : this.#transcripts.get(resumed);
    if (transcript === undefined) {
      transcript = newTranscript(resumed ?? newSessionId(), opts);
      this.#transcripts.set(transcript.sessionId, transcript);
    } else {
      if (opts.title !== undefined) {
        transcript.title = opts.title;
      }
      if (opts.model !== undefined) {
        transcript.model = opts.model;
      }
      if (opts.thinking !== undefined) {
        transcript.thinking = opts.thinking;
      }
    }

    const session = new FakeSession(
      transcript,
      { scenario: steps, tick: this.#tick },
      opts.root,
    );
    if (opts.persona !== undefined) {
      await session.setPersona(opts.persona);
    }
    return session;
  }

  transcript(sessionId: string): FakeTranscript | undefined {
    return this.#transcripts.get(sessionId);
  }
}

export function createFakeAgent(options: FakeAgentOptions = {}): FakeAgent {
  return new FakeAgent(options);
}
