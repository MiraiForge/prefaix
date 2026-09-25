// The swap boundary between prefaix and a coding-agent backend (DESIGN §4.4).
// Everything here is backend-independent: the daemon, client, and renderer
// speak only these types, and concrete adapters in src/agents/ translate their
// native protocol into them. Only src/agents/registry.ts knows the adapters.

export type ShellKind = "zsh" | "fish" | "bash";

export interface ShellInfo {
  kind: ShellKind;
  version: string;
  shellId: string;
  pid: number;
}

export interface RecentCommand {
  cmd: string;
  exit: number | null;
  at?: number; // epoch ms
}

export type ColorDepth = 0 | 16 | 256 | 16777216;

export interface TerminalInfo {
  cols: number;
  rows: number;
  colors: ColorDepth;
  program?: string;
}

// What the model is told about the invoking shell each turn (DESIGN §7.1).
// The recent-commands list is redacted before it leaves the client.
export interface ShellContext {
  shell: ShellInfo;
  cwd: string;
  recent: RecentCommand[];
  os: string;
  term: TerminalInfo;
}

export interface AgentBackend {
  readonly id: string; // "pi", "fake", …
  readonly capabilities: Capabilities;
  probe(): Promise<ProbeResult>; // for doctor: installed? version? usable?
  open(opts: OpenOptions): Promise<AgentSession>;
}

// A false capability means the matching optional AgentSession method may be
// absent. Callers report a clear unsupported-feature error instead of crashing.
export interface Capabilities {
  steer: boolean;
  followUp: boolean;
  abort: true;
  models: boolean;
  thinkingLevels: boolean;
  compact: boolean;
  slashCommands: boolean;
  skills: boolean;
  uiDialogs: boolean;
  contextSections: boolean; // can take per-turn context out-of-band
  personasWithoutRespawn: boolean;
  handoffTui: boolean;
}

export interface ProbeResult {
  installed: boolean;
  usable: boolean;
  version?: string;
  problem?: string; // one line: why the backend is missing or unusable
  hint?: string; // how to fix it, such as an install command
}

// Adapter-owned handle to a native session, stored verbatim in
// ConversationRecord.native and never interpreted by core.
export interface NativeRef {
  sessionFile?: string;
  sessionId?: string;
}

export interface ModelRef {
  provider: string;
  id: string;
}

export interface ModelInfo extends ModelRef {
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
}

export interface PersonaSpec {
  name: string; // "ask", "plan", or user-defined
  tools?: string[];
  guideline?: string;
}

export interface OpenOptions {
  root: string;
  env: Record<string, string>;
  resume?: NativeRef; // from ConversationRecord.native
  title?: string;
  model?: ModelRef;
  thinking?: string;
  persona?: PersonaSpec;
}

export interface AgentSession {
  readonly native: NativeRef;
  prompt(input: PromptInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
  steer?(text: string): Promise<void>;
  abort(): Promise<void>;
  respondUi(requestId: string, response: UiResponse): void;
  state(): Promise<AgentState>;
  listModels(): Promise<ModelInfo[]>;
  setModel(ref: ModelRef): Promise<void>;
  setThinking?(level: string): Promise<void>;
  listCommands?(): Promise<AgentCommand[]>; // skills, templates, extension commands
  compact?(focus?: string): Promise<CompactResult>;
  lastAssistantText(): Promise<string | null>;
  setPersona?(p: PersonaSpec): Promise<void>;
  rename?(title: string): Promise<void>;
  tuiCommand?(): { argv: string[]; cwd: string }; // for :tui handoff
  close(): Promise<void>;
}

export interface PromptInput {
  text: string;
  context: ShellContext;
  persona?: PersonaSpec;
}

export type UiResponse =
  { value: string } | { confirmed: boolean } | { cancelled: true };

export interface Usage {
  input: number;
  output: number;
  costUsd?: number;
}

export interface AgentState {
  model?: ModelRef;
  thinking?: string;
  busy: boolean;
  usage?: Usage;
  contextPct?: number | null;
  name?: string;
}

export interface AgentCommand {
  name: string;
  kind: "skill" | "template" | "extension";
  description?: string;
}

export interface CompactResult {
  summary?: string;
  tokensBefore?: number;
}

export type UiRequestKind = "select" | "confirm" | "input" | "editor";
export type NoticeLevel = "info" | "warn" | "error";
export type StopReason = "stop" | "aborted" | "error" | "length";

// Every turn ends with exactly one `settled`, including aborts and crashes.
// Tool summaries are built by the adapter so the renderer never learns tool
// schemas.
export type AgentEvent =
  | { type: "turn_start" }
  | { type: "text_delta"; block: number; text: string }
  | { type: "text_end"; block: number }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; summary: string }
  | { type: "tool_update"; id: string; preview?: string }
  | { type: "tool_end"; id: string; ok: boolean; summary?: string; ms?: number }
  | {
      type: "ui_request";
      id: string;
      kind: UiRequestKind;
      title: string;
      message?: string;
      options?: string[];
      prefill?: string;
      timeoutMs?: number;
    }
  | { type: "set_buffer"; text: string }
  | { type: "notice"; level: NoticeLevel; text: string; source?: string }
  | { type: "status"; key: string; text?: string }
  | {
      type: "retry";
      attempt: number;
      max: number;
      delayMs: number;
      reason: string;
    }
  | {
      type: "compaction";
      phase: "start" | "end";
      reason: string;
      ok?: boolean;
    }
  | {
      type: "usage"; // cumulative for the turn
      input: number;
      output: number;
      costUsd?: number;
      contextPct?: number | null;
    }
  | { type: "settled"; stopReason: StopReason; error?: string };

export type AgentEventType = AgentEvent["type"];
export type AgentEventOf<T extends AgentEventType> = Extract<
  AgentEvent,
  { type: T }
>;
