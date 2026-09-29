// pi records to AgentEvents (DESIGN §4.5.3). Pure: no I/O, no process, so the
// whole mapping table is testable by feeding it recorded JSONL.
//
// Field names and the event union are vendored from pi's own types; see
// src/agents/pi/types.ts and docs/spikes/S1-pi-rpc-lifecycle.md for what
// differs from the design as written.
//
// Two invariants the port requires and this file enforces:
//   - exactly one `settled`, and nothing after it
//   - `agent_end { willRetry: true }` is not the end, because more work follows

import type {
  AgentEvent,
  StopReason,
  UiRequestKind,
} from "../../core/agent-port.js";
import {
  asRecord,
  isAgentEnd,
  isCompactionEnd,
  isCompactionStart,
  isRetryEnd,
  isRetryStart,
  isToolEnd,
  isToolStart,
  isToolUpdate,
  type PiRecord,
} from "./types.js";
import { toolEndSummary, toolPreview, toolSummary } from "./tool-summaries.js";

type DialogMethod = "select" | "confirm" | "input" | "editor";

// Total over the four dialog kinds, so the lookup cannot be undefined and the
// port's kind is never invented.
const UI_KINDS: Readonly<Record<DialogMethod, UiRequestKind>> = {
  select: "select",
  confirm: "confirm",
  input: "input",
  editor: "editor",
};

export interface MapperOptions {
  /** Minimum gap between tool_update events, per DESIGN §4.5.3. */
  readonly toolUpdateThrottleMs?: number;
  /**
   * Minimum gap between usage events. pi reports cumulative usage on every
   * delta, so without this the footer redraws per token. The final figure is
   * always emitted.
   */
  readonly usageThrottleMs?: number;
  readonly now?: () => number;
}

interface ToolState {
  name: string;
  startedAt: number;
  // The first update always shows; only later ones are throttled, so a tool
  // that reports progress immediately is not silent.
  hasUpdate: boolean;
  lastUpdateAt: number;
}

// pi's StopReason has more values than the port; the extra ones are a normal end.
function toStopReason(reason: unknown): StopReason {
  switch (reason) {
    case "aborted":
      return "aborted";
    case "error":
      return "error";
    case "length":
      return "length";
    default:
      return "stop";
  }
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Stateful across the records of one turn. The adapter creates one per turn so
 * nothing leaks between turns, and a second `settled` is impossible because
 * the mapper refuses to emit after one.
 */
export class TurnMapper {
  readonly #options: Required<MapperOptions>;
  #announced = false;
  #settled = false;
  #lastStopReason: StopReason = "stop";
  #lastError: string | undefined;
  #usage: { input: number; output: number; costUsd?: number | undefined } = {
    input: 0,
    output: 0,
  };
  readonly #tools = new Map<string, ToolState>();
  #uiCounter = 0;
  // Undefined until the first usage is emitted: a clock that starts near zero
  // must not swallow the opening figure.
  #lastUsageAt: number | undefined;
  #blockCounter = 0;
  // pi's contentIndex is scoped to one assistant message, and a tool call makes
  // a turn emit several. The port numbers blocks per turn, so each message's
  // indices are re-issued rather than reused.
  #blocksByIndex = new Map<number, number>();
  // prefaix dialog id -> the pi request id a reply has to quote.
  #piIds = new Map<string, string>();

  constructor(options: MapperOptions = {}) {
    this.#options = {
      toolUpdateThrottleMs: options.toolUpdateThrottleMs ?? 100,
      usageThrottleMs: options.usageThrottleMs ?? 250,
      now: options.now ?? (() => Date.now()),
    };
  }

  get settled(): boolean {
    return this.#settled;
  }

  /** The `turn_start` has to precede everything else, exactly once. */
  #begin(): AgentEvent[] {
    if (this.#announced) {
      return [];
    }
    this.#announced = true;
    return [{ type: "turn_start" }];
  }

  map(record: PiRecord): AgentEvent[] {
    if (this.#settled) {
      // pi writes agent_settled last, but a stray record after it must not
      // break the one-settled promise the port makes.
      return [];
    }
    const out: AgentEvent[] = [];
    const fields = asRecord(record) ?? {};
    const type = typeof fields["type"] === "string" ? fields["type"] : "";

    if (type === "agent_start") {
      out.push(...this.#begin());
      return out;
    }

    if (type === "message_update") {
      out.push(...this.#begin());
      out.push(...this.#mapMessageUpdate(fields));
      return out;
    }

    if (type === "message_start") {
      this.#blocksByIndex = new Map();
    }

    if (type === "message_end") {
      const message = asRecord(fields["message"]);
      if (message !== undefined) {
        const reason = message["stopReason"];
        if (typeof reason === "string") {
          this.#lastStopReason = toStopReason(reason);
        }
        const error = textOf(message["errorMessage"]);
        if (error !== "") {
          // A failure has to say what went wrong, per DESIGN §8.
          this.#lastError = error;
          this.#lastStopReason = toStopReason(reason ?? "error");
        }
      }
      const usage = asRecord(message?.["usage"]);
      if (usage !== undefined) {
        const event = this.#usageEvent(usage, { final: true });
        if (event !== undefined) {
          out.push(event);
        }
      }
      return out;
    }

    if (isToolStart(record)) {
      out.push(...this.#begin());
      const id = textOf(record["toolCallId"]);
      const startedAt = this.#options.now();
      this.#tools.set(id, {
        name: textOf(record["toolName"]),
        startedAt,
        hasUpdate: false,
        lastUpdateAt: startedAt,
      });
      out.push({
        type: "tool_start",
        id,
        name: textOf(record["toolName"]),
        // The tool line starts here, where args are complete.
        summary: toolSummary(textOf(record["toolName"]), record["args"]),
      });
      return out;
    }

    if (isToolUpdate(record)) {
      const id = textOf(record["toolCallId"]);
      const tool = this.#tools.get(id);
      if (tool === undefined) {
        // An update for a tool that never started would break the renderer's
        // pairing, so it is dropped rather than drawn.
        return out;
      }
      const now = this.#options.now();
      if (
        tool.hasUpdate &&
        now - tool.lastUpdateAt < this.#options.toolUpdateThrottleMs
      ) {
        return out;
      }
      tool.hasUpdate = true;
      tool.lastUpdateAt = now;
      const preview = toolPreview(record["partialResult"]);
      if (preview === undefined) {
        return out;
      }
      out.push({ type: "tool_update", id, preview });
      return out;
    }

    if (isToolEnd(record)) {
      const id = textOf(record["toolCallId"]);
      const tool = this.#tools.get(id);
      const summary = toolEndSummary(record["result"]);
      const isError = record["isError"] === true;
      out.push({
        type: "tool_end",
        id,
        ok: !isError,
        ...(summary === undefined ? {} : { summary }),
        ...(tool === undefined
          ? {}
          : { ms: Math.max(0, this.#options.now() - tool.startedAt) }),
      });
      this.#tools.delete(id);
      return out;
    }

    if (isRetryStart(record)) {
      out.push(...this.#begin());
      out.push({
        type: "retry",
        attempt: typeof record["attempt"] === "number" ? record["attempt"] : 1,
        max:
          typeof record["maxAttempts"] === "number" ? record["maxAttempts"] : 1,
        delayMs: typeof record["delayMs"] === "number" ? record["delayMs"] : 0,
        reason:
          textOf(record["errorMessage"]) || "pi reported a retryable failure",
      });
      return out;
    }

    if (isRetryEnd(record)) {
      if (record["success"] !== true) {
        out.push({
          type: "notice",
          level: "error",
          text:
            textOf(record["finalError"]) ||
            `pi gave up after ${String(record["attempt"] ?? "?")} retries`,
        });
      }
      return out;
    }

    if (isCompactionStart(record)) {
      out.push(...this.#begin());
      out.push({
        type: "compaction",
        phase: "start",
        reason: textOf(record["reason"]) || "manual",
      });
      return out;
    }

    if (isCompactionEnd(record)) {
      out.push({
        type: "compaction",
        phase: "end",
        reason: textOf(record["reason"]) || "manual",
        ok: record["aborted"] !== true && record["errorMessage"] === undefined,
      });
      return out;
    }

    if (isAgentEnd(record)) {
      // willRetry means more work follows, so this is deliberately not a settle.
      return out;
    }

    if (type === "extension_ui_request") {
      out.push(...this.#begin());
      out.push(...this.#mapUiRequest(fields));
      return out;
    }

    if (type === "extension_error") {
      out.push({
        type: "notice",
        level: "warn",
        text: textOf(fields["message"]) || "a pi extension failed",
      });
      return out;
    }

    if (type === "thinking_level_changed") {
      out.push({
        type: "status",
        key: "thinking",
        text: textOf(fields["level"]),
      });
      return out;
    }

    if (type === "queue_update") {
      const steering = fields["steering"];
      const followUp = fields["followUp"];
      const queued =
        (Array.isArray(steering) ? steering.length : 0) +
        (Array.isArray(followUp) ? followUp.length : 0);
      if (queued > 0) {
        out.push({
          type: "status",
          key: "queue",
          text: `${String(queued)} queued`,
        });
      }
      return out;
    }

    return out;
  }

  #block(contentIndex: number): number {
    const existing = this.#blocksByIndex.get(contentIndex);
    if (existing !== undefined) {
      return existing;
    }
    const block = this.#blockCounter++;
    this.#blocksByIndex.set(contentIndex, block);
    return block;
  }

  /** The pi request id a prefaix dialog id has to be answered with. */
  piRequestId(prefaixId: string): string | undefined {
    return this.#piIds.get(prefaixId);
  }

  #mapMessageUpdate(fields: Record<string, unknown>): AgentEvent[] {
    const out: AgentEvent[] = [];
    const usage = asRecord(fields["usage"]);
    if (usage !== undefined) {
      const event = this.#usageEvent(usage);
      if (event !== undefined) {
        out.push(event);
      }
    }
    const inner = asRecord(fields["assistantMessageEvent"]);
    if (inner === undefined) {
      return out;
    }
    const contentIndex =
      typeof inner["contentIndex"] === "number" ? inner["contentIndex"] : 0;
    const block = this.#block(contentIndex);
    switch (inner["type"]) {
      case "text_delta": {
        const text = textOf(inner["delta"]);
        if (text !== "") {
          out.push({ type: "text_delta", block, text });
        }
        return out;
      }
      case "text_end": {
        out.push({ type: "text_end", block });
        return out;
      }
      case "thinking_delta": {
        const text = textOf(inner["delta"]);
        if (text !== "") {
          out.push({ type: "thinking_delta", text });
        }
        return out;
      }
      case "error": {
        const failure = asRecord(inner["error"]);
        const text = textOf(failure?.["message"]) || textOf(inner["error"]);
        if (text !== "") {
          this.#lastError = text;
          this.#lastStopReason = "error";
        }
        return out;
      }
      default:
        // toolcall_start is buffered: the line starts at tool_execution_start,
        // and `done` only ends the assistant message.
        return out;
    }
  }

  // pi reports cumulative usage on every delta, so an event is only worth
  // emitting when a number actually moved, and then not faster than the footer
  // can be redrawn. The final figure is always emitted.
  #usageEvent(
    usage: Record<string, unknown>,
    options: { readonly final?: boolean } = {},
  ): AgentEvent | undefined {
    const next = {
      input:
        typeof usage["input"] === "number" ? usage["input"] : this.#usage.input,
      output:
        typeof usage["output"] === "number"
          ? usage["output"]
          : this.#usage.output,
      costUsd: this.#readCost(usage) ?? this.#usage.costUsd,
    };
    const changed =
      next.input !== this.#usage.input ||
      next.output !== this.#usage.output ||
      next.costUsd !== this.#usage.costUsd;
    this.#usage = next;
    if (!changed) {
      return undefined;
    }
    const now = this.#options.now();
    if (
      options.final !== true &&
      this.#lastUsageAt !== undefined &&
      now - this.#lastUsageAt < this.#options.usageThrottleMs
    ) {
      return undefined;
    }
    this.#lastUsageAt = now;
    return {
      type: "usage",
      input: next.input,
      output: next.output,
      ...(next.costUsd === undefined ? {} : { costUsd: next.costUsd }),
    };
  }

  #readCost(usage: Record<string, unknown>): number | undefined {
    const direct = usage["cost"];
    if (typeof direct === "number") {
      return direct;
    }
    const cost = asRecord(usage["cost"]);
    if (cost === undefined) {
      return undefined;
    }
    const input = typeof cost["input"] === "number" ? cost["input"] : 0;
    const output = typeof cost["output"] === "number" ? cost["output"] : 0;
    return input + output;
  }

  #mapUiRequest(fields: Record<string, unknown>): AgentEvent[] {
    const method = textOf(fields["method"]);
    // pi numbers its own ids; prefaix keeps its own so a stale reply from a
    // previous turn can never answer a new dialog.
    const id = `u${++this.#uiCounter}`;
    this.#piIds.set(id, textOf(fields["id"]));
    const title = textOf(fields["title"]);

    switch (method) {
      case "select":
      case "confirm":
      case "input":
      case "editor": {
        const options = fields["options"];
        const placeholder = textOf(fields["placeholder"]);
        const prefill = textOf(fields["prefill"]);
        const timeout = fields["timeout"];
        return [
          {
            type: "ui_request",
            id,
            kind: UI_KINDS[method as DialogMethod],
            title: title === "" ? method : title,
            ...(textOf(fields["message"]) === ""
              ? {}
              : { message: textOf(fields["message"]) }),
            ...(method === "select" && Array.isArray(options)
              ? {
                  options: options.filter(
                    (o): o is string => typeof o === "string",
                  ),
                }
              : {}),
            // input and editor carry no message of their own; the title is the
            // prompt. Overwriting an existing message with the title would lose
            // whatever wording pi chose.
            ...(placeholder === "" ? {} : { prefill: placeholder }),
            ...(prefill === "" ? {} : { prefill }),
            ...(typeof timeout === "number" ? { timeoutMs: timeout } : {}),
          },
        ];
      }
      case "notify": {
        const level = textOf(fields["notifyType"]);
        return [
          {
            type: "notice",
            level:
              level === "error"
                ? "error"
                : level === "warning"
                  ? "warn"
                  : "info",
            text: textOf(fields["message"]) || "pi sent a notification",
            source: "pi",
          },
        ];
      }
      case "setStatus": {
        const text = fields["statusText"];
        return [
          {
            type: "status",
            key: textOf(fields["statusKey"]) || "pi",
            ...(typeof text === "string" ? { text } : {}),
          },
        ];
      }
      case "set_editor_text": {
        // Never executed, only offered back to the shell as buffer data.
        return [{ type: "set_buffer", text: textOf(fields["text"]) }];
      }
      case "setWidget":
      case "setTitle":
        // Widgets and titles belong to pi's own UI, which prefaix does not draw.
        return [];
      default: {
        // A method this build does not know must not vanish: the user is told
        // pi wants something prefaix cannot show.
        const name = method === "" ? "something" : method;
        return [
          {
            type: "notice",
            level: "warn",
            text: `pi asked for ${name}, which this prefaix cannot show`,
            source: "pi",
          },
        ];
      }
    }
  }

  /**
   * Ends the turn. `agent_settled` is pi's terminal event, and the port's stop
   * reason comes from the last assistant message, not from the settled record.
   */
  settle(reason?: StopReason): AgentEvent {
    this.#settled = true;
    const stopReason = reason ?? this.#lastStopReason;
    return {
      type: "settled",
      stopReason,
      ...(stopReason === "error" && this.#lastError !== undefined
        ? { error: this.#lastError }
        : {}),
    };
  }

  /**
   * The failure the port reports when pi dies or the stream throws. The turn
   * still ends with exactly one settled, per DESIGN §4.4.
   */
  settleWithError(message: string): AgentEvent {
    this.#settled = true;
    return { type: "settled", stopReason: "error", error: message };
  }
}
