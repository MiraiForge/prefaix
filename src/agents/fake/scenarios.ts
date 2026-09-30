import { SCENARIO_NAMES, type ScenarioName } from "./scenario-names.js";
export { SCENARIO_NAMES, type ScenarioName } from "./scenario-names.js";

// Scripted turns for the fake backend. A scenario is the literal event
// sequence one turn emits, so a test asserts on the same data the fake runs.
//
// Timing is not part of a scenario. The fake paces itself with one tick
// between steps, and a test replaces the tick with a gate to choose exactly
// when a turn yields control. A `retry` event's `delayMs` is advertised to the
// renderer; the fake does not actually wait that long.

import type { AgentEvent, UiResponse } from "../../core/agent-port.js";

// A turn pauses until `respondUi` answers the `ui_request` it just emitted.
// `into` reflects the answer into the text stream, so a round trip is visible
// in the events a renderer sees and not only in the session's own state.
export interface AwaitUiStep {
  readonly type: "await_ui";
  readonly into?: {
    readonly block: number;
    readonly prefix?: string;
    readonly suffix?: string;
  };
}

export type ScenarioStep = AgentEvent | AwaitUiStep;

export type Scenario = readonly ScenarioStep[];

export function answerText(response: UiResponse): string {
  if ("value" in response) {
    return response.value;
  }
  if ("cancelled" in response) {
    return "cancelled";
  }
  return response.confirmed ? "yes" : "no";
}

export const HELLO: Scenario = [
  { type: "turn_start" },
  { type: "text_delta", block: 0, text: "Hello from the fake backend.\n" },
  {
    type: "text_delta",
    block: 0,
    text: "This turn is scripted, so the output is byte-for-byte predictable.\n",
  },
  { type: "text_end", block: 0 },
  { type: "usage", input: 128, output: 137, costUsd: 0 },
  { type: "settled", stopReason: "stop" },
];

export const TOOLS: Scenario = [
  { type: "turn_start" },
  { type: "tool_start", id: "t1", name: "read", summary: "src/core/config.ts" },
  {
    type: "tool_update",
    id: "t1",
    preview: 'import { parse } from "smol-toml";',
  },
  { type: "tool_end", id: "t1", ok: true, summary: "+241 −0", ms: 12 },
  { type: "tool_start", id: "t2", name: "bash", summary: "$ bun run check" },
  { type: "tool_update", id: "t2", preview: "$ tsc --noEmit" },
  {
    type: "tool_end",
    id: "t2",
    ok: true,
    summary: "191 tests passed",
    ms: 740,
  },
  { type: "tool_start", id: "t3", name: "grep", summary: "loadConfig" },
  { type: "tool_end", id: "t3", ok: false, summary: "no matches", ms: 8 },
  {
    type: "text_delta",
    block: 0,
    text: "Read the config loader and ran the checks.\n",
  },
  {
    type: "text_delta",
    block: 0,
    text: "The grep found nothing, as scripted.\n",
  },
  { type: "text_end", block: 0 },
  { type: "usage", input: 4210, output: 96, costUsd: 0 },
  { type: "settled", stopReason: "stop" },
];

// Long enough to abort by hand at the fake's default pacing, short enough to
// read in a demo.
const LONG_LINES = 120;

export const LONG: Scenario = [
  { type: "turn_start" },
  {
    type: "text_delta",
    block: 0,
    text: "Streaming a long answer, one line at a time:\n",
  },
  ...Array.from({ length: LONG_LINES }, (_unused, index) => ({
    type: "text_delta" as const,
    block: 0,
    text: `  ${String(index + 1).padStart(3, "0")}  line ${index + 1} of ${LONG_LINES}\n`,
  })),
  { type: "text_end", block: 0 },
  {
    type: "status",
    key: "fake",
    text: `${LONG_LINES} lines emitted; abort me and I stop mid-stream`,
  },
  { type: "usage", input: 512, output: 1600, costUsd: 0 },
  { type: "settled", stopReason: "stop" },
];

export const DIALOG: Scenario = [
  { type: "turn_start" },
  {
    type: "text_delta",
    block: 0,
    text: "Before I change anything, I need one answer.\n",
  },
  { type: "text_end", block: 0 },
  {
    type: "ui_request",
    id: "d1",
    kind: "select",
    title: "Which branch?",
    message: "Two branches match the failing test.",
    options: ["main", "release/2.1"],
  },
  {
    type: "await_ui",
    into: { block: 1, prefix: "Working on ", suffix: ", as you chose.\n" },
  },
  { type: "usage", input: 260, output: 41, costUsd: 0 },
  { type: "settled", stopReason: "stop" },
];

export const ERROR: Scenario = [
  { type: "turn_start" },
  {
    type: "text_delta",
    block: 0,
    text: "Starting, then failing on purpose.\n",
  },
  { type: "text_end", block: 0 },
  {
    type: "notice",
    level: "warn",
    text: "fake: one retryable failure injected",
  },
  { type: "usage", input: 300, output: 12, costUsd: 0 },
  {
    type: "settled",
    stopReason: "error",
    error: "fake backend: scripted failure (PREFAIX_FAKE_SCENARIO=error)",
  },
];

export const RETRY: Scenario = [
  { type: "turn_start" },
  {
    type: "retry",
    attempt: 1,
    max: 3,
    delayMs: 500,
    reason: "fake: 429 rate limited",
  },
  {
    type: "retry",
    attempt: 2,
    max: 3,
    delayMs: 1500,
    reason: "fake: 503 upstream unavailable",
  },
  { type: "text_delta", block: 0, text: "Recovered on the third attempt.\n" },
  { type: "text_end", block: 0 },
  { type: "usage", input: 4100, output: 22, costUsd: 0 },
  { type: "settled", stopReason: "stop" },
];

export const BUFFER: Scenario = [
  { type: "turn_start" },
  { type: "text_delta", block: 0, text: "Here is the command, unexecuted:\n" },
  { type: "text_end", block: 0 },
  { type: "set_buffer", text: "git push --force-with-lease origin main" },
  { type: "usage", input: 220, output: 18, costUsd: 0 },
  { type: "settled", stopReason: "stop" },
];

// Every markdown shape the styler claims to handle, in one turn. This exists
// for a person looking at a terminal: the unit tests assert the bytes, and only
// an eye says whether they land as bold, fenced, and indented on a real screen.
export const MARKDOWN: Scenario = [
  { type: "turn_start" },
  { type: "text_delta", block: 0, text: "# Heading one\n\n" },
  { type: "text_delta", block: 0, text: "## Heading two\n\n" },
  // The emphasis marker is split across two deltas, so the hold-back window
  // has to rejoin it rather than styling half a word. This is the case a real
  // stream produces constantly and a hand-written fixture never does.
  { type: "text_delta", block: 0, text: "Body text with **bo" },
  {
    type: "text_delta",
    block: 0,
    text: "ld**, *italic*, `inline code`, and a [a link](https://example.com) ",
  },
  // The line also ends part-way, which leaves the cursor mid-row: the status
  // line has to wait rather than erase the half of the sentence on screen.
  { type: "text_delta", block: 0, text: "inside a sentence.\n\n" },
  {
    type: "text_delta",
    block: 0,
    text: "- first item\n- second item\n  - nested item\n- third item\n\n",
  },
  { type: "text_delta", block: 0, text: "1. one\n2. two\n3. three\n\n" },
  { type: "text_delta", block: 0, text: "> a quote\n> over two lines\n\n" },
  {
    type: "text_delta",
    block: 0,
    text: "```ts\nconst answer: number = 42;\n```\n\n",
  },
  { type: "text_delta", block: 0, text: "A table:\n\n" },
  {
    type: "text_delta",
    block: 0,
    text: "| option | what it does |\n| --- | --- |\n| `:new` | start a conversation |\n| `:info` | show this one |\n\n",
  },
  { type: "text_delta", block: 0, text: "---\n\nThat is every shape.\n" },
  { type: "text_end", block: 0 },
  { type: "usage", input: 900, output: 240, costUsd: 0 },
  { type: "settled", stopReason: "stop" },
];

/** Bounded, timer-free transport/renderer throughput fixture; never a model call. */
export const BURST_TEXT_EVENTS = 2000;
export const BURST: Scenario = [
  { type: "turn_start" },
  ...Array.from({ length: BURST_TEXT_EVENTS }, (_, index): AgentEvent => ({
    type: "text_delta",
    block: 0,
    text: `burst:${String(index)}\n`,
  })),
  { type: "text_end", block: 0 },
  { type: "usage", input: 1, output: BURST_TEXT_EVENTS, costUsd: 0 },
  { type: "settled", stopReason: "stop" },
];

export const SCENARIOS = {
  burst: BURST,
  hello: HELLO,
  tools: TOOLS,
  long: LONG,
  dialog: DIALOG,
  error: ERROR,
  retry: RETRY,
  buffer: BUFFER,
  markdown: MARKDOWN,
} as const satisfies Record<ScenarioName, Scenario>;

export const DEFAULT_SCENARIO: ScenarioName = "hello";

export function isScenarioName(value: string): value is ScenarioName {
  return Object.hasOwn(SCENARIOS, value);
}

export function scenarioNames(): string {
  return SCENARIO_NAMES.join(", ");
}
