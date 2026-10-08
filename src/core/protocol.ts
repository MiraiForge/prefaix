// The client <-> daemon wire protocol (DESIGN §4.3.2). Newline-delimited JSON
// over the unix socket, split on `\n` only and never through `readline`, so a
// U+2028 or U+2029 inside a string is data rather than a line break.
//
// This module lives in core/ because both ends speak it and neither end may
// learn anything about the other: the client never sees an adapter, and the
// daemon never sees a terminal.

import type { AgentEvent, ModelInfo, ShellKind } from "./agent-port.js";
import type { ErrorInfo } from "./errors.js";

/** Bumped only on a breaking wire change (DESIGN §13). */
export const PROTOCOL_VERSION = 1;

export type ShellVersionInfo = {
  kind: ShellKind;
  version: string;
  shellId: string;
  pid: number;
};

export interface TurnContextPayload {
  recent: { cmd: string; exit: number | null; at?: number }[];
  os: string;
  term: {
    cols: number;
    rows: number;
    colors: 0 | 16 | 256 | 16777216;
    program?: string;
  };
}

export interface TurnStartParams {
  conversationId?: string;
  newConversation?: boolean;
  shell: ShellVersionInfo;
  cwd: string;
  env: Record<string, string>;
  text: string;
  /** Omitted retains the conversation persona; null restores normal tools. */
  persona?: string | null;
  /** Execute a completed plan in this exact conversation, with normal tools. */
  executePlan?: boolean;
  context: TurnContextPayload;
  onDisconnect?: "abort" | "continue";
}

export const PLAN_EXECUTION_PROMPT =
  "Execute the plan above. Use the normal tools to implement it.";

export interface TurnAbortParams {
  turnId: string;
}

export interface UiRespondParams {
  turnId: string;
  requestId: string;
  response: { value: string } | { confirmed: boolean } | { cancelled: true };
}

export interface TurnStartResult {
  turnId: string;
  conversationId: string;
}

export interface TurnSummary {
  turnId: string;
  status: "stop" | "aborted" | "error" | "length";
  error?: string;
  usage?: {
    input: number;
    output: number;
    costUsd?: number;
    contextPct?: number | null;
  };
  /** Text the client should hand back to the prompt buffer. */
  buffer?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  root: string;
  backend: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  costUsd?: number;
  lastContextPct?: number;
  model?: { provider: string; id: string };
  thinking?: string;
  persona?: string;
  createdBy: { shell: ShellKind; host: string };
}

export interface ConvListParams {
  query?: string;
  limit?: number;
}

export interface ConvGetParams {
  conversationId: string;
}

export interface ConvRenameParams {
  conversationId: string;
  title: string;
}

export interface ConvNewParams {
  shell: ShellVersionInfo;
  cwd: string;
  env: Record<string, string>;
}

export interface ConvRemoveParams {
  conversationId: string;
}

export interface TurnAttachParams {
  conversationId?: string;
  /** Replay from this sequence; the daemon answers with the oldest it still has. */
  fromSeq: number;
}

export interface ConvLastTextParams {
  conversationId: string;
}

export interface ConvCompactParams {
  conversationId: string;
  focus?: string;
}

export interface ModelListParams {
  env?: Record<string, string>;
  conversationId?: string;
}

export interface ModelSetParams {
  env?: Record<string, string>;
  conversationId?: string;
  ref: { provider: string; id: string };
}

export interface ThinkingSetParams {
  env?: Record<string, string>;
  conversationId?: string;
  level: string;
}

export interface CommandsListParams {
  conversationId?: string;
  env?: Record<string, string>;
  cwd?: string;
}

export interface StatusGetParams {
  conversationId?: string;
}

export interface StatusSnapshot {
  version: string;
  pid: number;
  backend: string;
  uptimeMs: number;
  clients: number;
  turns: number;
  children: number;
  conversation?: ConversationSummary;
  model?: { provider: string; id: string };
  thinking?: string;
  usage?: { input: number; output: number; costUsd?: number };
  contextPct?: number | null;
  state: string;
}

export interface ModelListResult {
  models: ModelInfo[];
  thinkingLevels?: string[];
}

/** Every operation the router knows, so a typo is a type error. */
export interface Operations {
  "turn.start": { params: TurnStartParams; result: TurnStartResult };
  "turn.abort": { params: TurnAbortParams; result: { turnId: string } };
  "ui.respond": { params: UiRespondParams; result: { ok: true } };
  "turn.attach": {
    params: TurnAttachParams;
    result: { turnId: string; fromSeq: number };
  };
  "conv.new": { params: ConvNewParams; result: ConversationSummary };
  "conv.select": {
    params: {
      conversationId: string;
      shell: ShellVersionInfo;
      previousConversationId?: string;
    };
    result: ConversationSummary;
  };
  "conv.previous": {
    params: { shellId: string; fallback?: string };
    result: ConversationSummary;
  };
  "conv.list": {
    params: ConvListParams;
    result: { conversations: ConversationSummary[] };
  };
  "conv.get": { params: ConvGetParams; result: ConversationSummary };
  "conv.rename": { params: ConvRenameParams; result: ConversationSummary };
  "conv.rm": { params: ConvRemoveParams; result: { removed: true } };
  "conv.lastText": {
    params: ConvLastTextParams;
    result: { text: string | null };
  };
  "conv.compact": {
    params: ConvCompactParams;
    result: { summary?: string; tokensBefore?: number };
  };
  "model.list": { params: ModelListParams; result: ModelListResult };
  "model.set": {
    params: ModelSetParams;
    result: { model: { provider: string; id: string } };
  };
  "thinking.list": { params: ModelListParams; result: { levels: string[] } };
  "thinking.set": { params: ThinkingSetParams; result: { level: string } };
  "commands.list": {
    params: CommandsListParams;
    result: {
      commands: { name: string; kind: string; description?: string }[];
    };
  };
  "status.get": { params: StatusGetParams; result: StatusSnapshot };
  "daemon.ping": {
    params: Record<string, never>;
    result: { version: string; pid: number; v: number };
  };
  "daemon.stop": { params: Record<string, never>; result: { stopping: true } };
}

export type OperationName = keyof Operations;

export const OPERATION_NAMES: readonly OperationName[] = [
  "turn.start",
  "turn.abort",
  "ui.respond",
  "turn.attach",
  "conv.new",
  "conv.select",
  "conv.previous",
  "conv.list",
  "conv.get",
  "conv.rename",
  "conv.rm",
  "conv.lastText",
  "conv.compact",
  "model.list",
  "model.set",
  "thinking.list",
  "thinking.set",
  "commands.list",
  "status.get",
  "daemon.ping",
  "daemon.stop",
];

export function isOperationName(value: unknown): value is OperationName {
  return (
    typeof value === "string" &&
    (OPERATION_NAMES as readonly unknown[]).includes(value)
  );
}

export type ClientMessage =
  | { t: "hello"; v: number; version: string; pid: number }
  | {
      t: "req";
      id: string;
      op: OperationName;
      params: unknown;
    };

export type DaemonMessage =
  | { t: "hello"; v: number; version: string; pid: number }
  | { t: "res"; id: string; ok: true; data: unknown }
  | { t: "res"; id: string; ok: false; error: ErrorInfo }
  | { t: "evt"; turnId: string; seq: number; e: AgentEvent }
  | { t: "turn.end"; turnId: string; summary: TurnSummary };

export function isErrorInfo(value: unknown): value is ErrorInfo {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ErrorInfo).code === "string" &&
    typeof (value as ErrorInfo).message === "string"
  );
}

/**
 * Splits a chunk into complete records. Splitting is on LF alone, so a record
 * containing a bare CR or a Unicode line separator survives intact; a trailing
 * CR is stripped because pi and node both write one on some platforms.
 */
export function splitRecords(buffer: string): {
  lines: string[];
  rest: string;
} {
  const lines: string[] = [];
  let from = 0;
  for (;;) {
    const at = buffer.indexOf("\n", from);
    if (at === -1) {
      break;
    }
    const raw = buffer.slice(from, at);
    lines.push(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    from = at + 1;
  }
  return { lines, rest: buffer.slice(from) };
}

export function encodeRecord(message: DaemonMessage | ClientMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Parses one line. Returns undefined for anything that is not a message this
 * protocol defines, so a stray write cannot be mistaken for a reply and
 * answered with the wrong id.
 */
const CLIENT_KINDS = new Set(["hello", "req"]);
const DAEMON_KINDS = new Set(["hello", "res", "evt", "turn.end"]);

function parseLine(line: string): Record<string, unknown> | undefined {
  if (line === "") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parses one line sent by a client. Returns undefined for anything this
 * protocol does not define, so a stray write cannot be mistaken for a request
 * and answered with the wrong id. The op is checked here as well as by the
 * router, so a client built against a newer protocol gets silence rather than a
 * confident "unknown operation" for something that does exist.
 */
export function parseClientRecord(line: string): ClientMessage | undefined {
  const record = parseLine(line);
  if (record === undefined) {
    return undefined;
  }
  const kind = record["t"];
  if (typeof kind !== "string" || !CLIENT_KINDS.has(kind)) {
    return undefined;
  }
  if (kind === "req" && !isOperationName(record["op"])) {
    return undefined;
  }
  return record as unknown as ClientMessage;
}

/** The same check from the client's side, for a message off the socket. */
export function parseDaemonRecord(line: string): DaemonMessage | undefined {
  const record = parseLine(line);
  if (record === undefined) {
    return undefined;
  }
  const kind = record["t"];
  if (typeof kind !== "string" || !DAEMON_KINDS.has(kind)) {
    return undefined;
  }
  return record as unknown as DaemonMessage;
}
