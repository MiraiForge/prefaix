// A minimal typed subset of pi's RPC protocol, vendored rather than imported.
//
// pi 0.87.1 ships no importable rpc-types from a CLI install; the declarations
// live in the managed release. DESIGN §4.5.2 allows a vendored subset, and
// docs/spikes/S1-pi-rpc-lifecycle.md records the exact paths this mirrors:
//
//   @earendil-works/pi-coding-agent/dist/modes/rpc/rpc-types.d.ts
//   @earendil-works/pi-coding-agent/dist/core/agent-session.d.ts
//   @earendil-works/pi-agent-core/dist/types.d.ts
//
// The protocol is not JSON-RPC 2.0: the command name is the `type` field, and
// a failure carries a flat error string with no code.

export type PiCommandType =
  | "prompt"
  | "steer"
  | "follow_up"
  | "abort"
  | "abort_retry"
  | "abort_bash"
  | "clear_queue"
  | "new_session"
  | "get_state"
  | "set_model"
  | "cycle_model"
  | "get_available_models"
  | "set_thinking_level"
  | "cycle_thinking_level"
  | "get_available_thinking_levels"
  | "set_steering_mode"
  | "set_follow_up_mode"
  | "compact"
  | "set_auto_compaction"
  | "set_auto_retry"
  | "bash"
  | "get_session_stats"
  | "get_fork_messages"
  | "get_entries"
  | "get_tree"
  | "get_last_assistant_text"
  | "set_session_name"
  | "get_messages"
  | "get_commands";

export type PiCommand = {
  readonly id?: string;
  readonly type: PiCommandType;
  readonly [field: string]: unknown;
};

export interface PiResponseSuccess {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: true;
  readonly data?: unknown;
}

export interface PiResponseFailure {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: false;
  /** pi's only error signal: a string, which may be a leaked internal error. */
  readonly error: string;
}

export type PiResponse = PiResponseSuccess | PiResponseFailure;

/** The session state pi reports, and the source for `AgentState`. */
export interface PiSessionState {
  model?: PiModel;
  thinkingLevel: string;
  isStreaming: boolean;
  isCompacting: boolean;
  steeringMode: "all" | "one-at-a-time";
  followUpMode: "all" | "one-at-a-time";
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface PiModel {
  id: string;
  name?: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  cost?: { input?: number; output?: number };
}

export interface PiSessionStats {
  sessionId?: string;
  sessionFile?: string;
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
  totalMessages?: number;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  contextPercent?: number | null;
}

export type PiSlashCommandKind = "extension" | "prompt" | "skill";

export interface PiSlashCommand {
  name: string;
  description?: string;
  source: PiSlashCommandKind;
}

export const EXTENSION_UI_METHODS = [
  "select",
  "confirm",
  "input",
  "editor",
  "notify",
  "setStatus",
  "setWidget",
  "setTitle",
  "set_editor_text",
] as const;

export type ExtensionUiMethod = (typeof EXTENSION_UI_METHODS)[number];

export interface PiExtensionUiRequest {
  readonly type: "extension_ui_request";
  readonly id: string;
  readonly method: ExtensionUiMethod;
  readonly [field: string]: unknown;
}

export interface PiExtensionUiResponse {
  readonly type: "extension_ui_response";
  readonly id: string;
  readonly value?: string;
  readonly confirmed?: boolean;
  readonly cancelled?: true;
  readonly [field: string]: unknown;
}

export interface PiToolStart {
  readonly type: "tool_execution_start";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly [field: string]: unknown;
}

export interface PiToolUpdate {
  readonly type: "tool_execution_update";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly partialResult: unknown;
  readonly [field: string]: unknown;
}

export interface PiToolEnd {
  readonly type: "tool_execution_end";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly isError: boolean;
  readonly [field: string]: unknown;
}

export interface PiRetryStart {
  readonly type: "auto_retry_start";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorMessage: string;
  readonly [field: string]: unknown;
}

export interface PiRetryEnd {
  readonly type: "auto_retry_end";
  readonly success: boolean;
  readonly attempt: number;
  readonly finalError?: string;
  readonly [field: string]: unknown;
}

export interface PiCompactionStart {
  readonly type: "compaction_start";
  readonly reason: string;
  readonly [field: string]: unknown;
}

export interface PiCompactionEnd {
  readonly type: "compaction_end";
  readonly reason: string;
  readonly aborted: boolean;
  readonly willRetry: boolean;
  readonly errorMessage?: string;
  readonly [field: string]: unknown;
}

// Every record pi writes to stdout that is not a reply to a request.
export interface PiEvent {
  readonly type: string;
  readonly [field: string]: unknown;
}

export type PiRecord = PiResponse | PiEvent;

// pi's stdout is untrusted input, and every guard runs inside the transport's
// read loop where a throw would take the process down. `null` is valid JSON, so
// the type field is read defensively rather than assumed.
function typeOf(record: unknown): string | undefined {
  if (typeof record !== "object" || record === null) {
    return undefined;
  }
  const type = (record as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

export function isPiResponse(record: PiRecord): record is PiResponse {
  return typeOf(record) === "response";
}

export function isUiRequest(record: PiRecord): record is PiEvent {
  return typeOf(record) === "extension_ui_request";
}

export function isUiResponse(
  record: PiRecord,
): record is PiExtensionUiResponse {
  return typeOf(record) === "extension_ui_response";
}

export function isSettled(record: PiRecord): record is PiEvent {
  return typeOf(record) === "agent_settled";
}

export function isCompactionStart(
  record: PiRecord,
): record is PiCompactionStart {
  return typeOf(record) === "compaction_start";
}

export function isCompactionEnd(record: PiRecord): record is PiEvent {
  return typeOf(record) === "compaction_end";
}

export function isRetryStart(record: PiRecord): record is PiEvent {
  return typeOf(record) === "auto_retry_start";
}

export function isRetryEnd(record: PiRecord): record is PiEvent {
  return typeOf(record) === "auto_retry_end";
}

export function isMessageUpdate(record: PiRecord): record is PiEvent {
  return typeOf(record) === "message_update";
}

export function isToolStart(record: PiRecord): record is PiEvent {
  return typeOf(record) === "tool_execution_start";
}

export function isToolUpdate(record: PiRecord): record is PiEvent {
  return typeOf(record) === "tool_execution_update";
}

export function isToolEnd(record: PiRecord): record is PiEvent {
  return typeOf(record) === "tool_execution_end";
}

// Not type predicates: PiEvent is one broad interface, so a predicate on it
// would narrow every other record away in the else branch.
export function isAgentStart(record: PiRecord): record is PiEvent {
  return typeOf(record) === "agent_start";
}

export function isAgentEnd(record: PiRecord): record is PiEvent {
  return typeOf(record) === "agent_end";
}

// pi's response `data` is untyped JSON; these narrow the parts the port needs.
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asState(value: unknown): PiSessionState | undefined {
  return asRecord(value) as PiSessionState | undefined;
}

export function asModels(value: unknown): PiModel[] {
  const data = asRecord(value);
  const models = data?.["models"];
  return Array.isArray(models) ? (models as PiModel[]) : [];
}

export function asLevels(value: unknown): string[] {
  const levels = asRecord(value)?.["levels"];
  return Array.isArray(levels)
    ? levels.filter((l): l is string => typeof l === "string")
    : [];
}

export function asCommands(value: unknown): PiSlashCommand[] {
  const commands = asRecord(value)?.["commands"];
  return Array.isArray(commands) ? (commands as PiSlashCommand[]) : [];
}

export function asStats(value: unknown): PiSessionStats {
  return (asRecord(value) ?? {}) as PiSessionStats;
}

// pi declares `{ text: string | null }` but sends `{}` when there is no turn.
export function asText(value: unknown): string | null {
  const text = asRecord(value)?.["text"];
  return typeof text === "string" ? text : null;
}

export function asCompaction(value: unknown): {
  summary?: string;
  tokensBefore?: number;
} {
  const data = asRecord(value) ?? {};
  const summary = data["summary"];
  const tokensBefore = data["tokensBefore"];
  return {
    ...(typeof summary === "string" ? { summary } : {}),
    ...(typeof tokensBefore === "number" ? { tokensBefore } : {}),
  };
}
