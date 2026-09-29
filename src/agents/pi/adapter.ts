// The pi adapter: AgentPort on top of the JSONL transport (DESIGN §4.5).
//
// A turn owns the records from its `agent_start` to its settle, which is what
// makes a turn safe to abandon: after an abort the leftover records are dropped
// rather than leaking into the next turn's stream.

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { PrefaixError } from "../../core/errors.js";
import { ulid } from "../../core/ids.js";
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
  UiResponse,
} from "../../core/agent-port.js";
import { ABORTED, raceAbort } from "../../core/abort.js";
import { PiRpc, type PiRpcOptions } from "./rpc.js";
import { TurnMapper, type MapperOptions } from "./mapping.js";
import {
  asCommands,
  asCompaction,
  asModels,
  asRecord,
  asState,
  asStats,
  asText,
  isAgentStart,
} from "./types.js";

export const PI_ID = "pi";

const PI_CAPABILITIES: Capabilities = {
  steer: true,
  followUp: true,
  abort: true,
  models: true,
  thinkingLevels: true,
  compact: true,
  slashCommands: true,
  skills: true,
  uiDialogs: true,
  contextSections: true,
  // A persona is applied by the spawn arguments, so a change made after open is
  // only recorded locally. M2-7's bridge makes a live switch real; until then
  // claiming it would leave a caller believing a read-only persona is active
  // while pi still has the original tools.
  personasWithoutRespawn: false,
  handoffTui: true,
};

export interface PiAdapterOptions {
  readonly bin?: string;
  /** The bridge extension bundle, when the capability probe passed. */
  readonly bridgePath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly model?: string | null;
  readonly thinking?: string | null;
  readonly personaTools?: readonly string[] | undefined;
  readonly requestTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly rpc?: Partial<PiRpcOptions>;
  readonly mapper?: MapperOptions;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

// pi's native ids must match [A-Za-z0-9._-] and start and end alphanumeric.
export function newPiSessionId(): string {
  return `pfx-${ulid()}`;
}

interface SpawnPlan {
  readonly bin: string;
  readonly args: string[];
}

export function buildSpawnPlan(
  options: OpenOptions,
  config: PiAdapterOptions = {},
): SpawnPlan {
  const bin = config.bin ?? "pi";
  const args = ["--mode", "rpc"];

  // Resume is by file, which is robust across roots; create uses a
  // deterministic id so the conversation file is reproducible.
  const resumeFile = options.resume?.sessionFile;
  const resumeId = options.resume?.sessionId;
  if (resumeFile !== undefined && resumeFile !== "") {
    args.push("--session", resumeFile);
  } else if (resumeId !== undefined && resumeId !== "") {
    args.push("--session-id", resumeId);
  } else {
    args.push("--session-id", newPiSessionId());
  }

  const title = options.title ?? options.resume?.sessionId;
  if (title !== undefined && title !== "") {
    args.push("--name", title);
  }

  const bridge = config.bridgePath;
  if (bridge !== undefined && bridge !== "") {
    args.push("-e", bridge);
  }

  // pi's configured default is openai-codex, so a model is only ever passed
  // when the user asked for one.
  const model =
    options.model === undefined
      ? undefined
      : `${options.model.provider}/${options.model.id}`;
  if (model !== undefined && model !== "/") {
    args.push("--model", model);
  } else if (typeof config.model === "string" && config.model.includes("/")) {
    // A config model is a "provider/id" string. A bare name is refused rather
    // than passed, because pi would fuzzy-match it to its configured default,
    // which is exactly the fallback DESIGN §12.4 forbids.
    args.push("--model", config.model);
  }
  const thinking = options.thinking ?? config.thinking ?? undefined;
  if (thinking !== undefined) {
    args.push("--thinking", thinking);
  }

  const tools = options.persona?.tools ?? config.personaTools;
  if (tools !== undefined) {
    args.push("--tools", tools.join(","));
  }
  return { bin, args };
}

export class PiSession implements AgentSession {
  readonly native: NativeRef;
  readonly #bin: string;
  readonly #root: string;
  readonly #rpc: PiRpc;
  readonly #mapperOptions: MapperOptions;
  #busy = false;
  #turnAbort: AbortController | undefined;
  #persona: PersonaSpec | undefined;
  // The mapper of the running turn, which knows pi's own id for each dialog.
  #mapper: TurnMapper | undefined;

  constructor(
    rpc: PiRpc,
    native: NativeRef,
    options: PiAdapterOptions,
    origin: { readonly bin: string; readonly root: string },
  ) {
    this.#rpc = rpc;
    this.native = native;
    this.#bin = origin.bin;
    // An empty root is not a directory, so it is normalised once here rather
    // than at every use.
    this.#root = origin.root === "" ? "." : origin.root;
    this.#mapperOptions = options.mapper ?? {};
  }

  get busy(): boolean {
    return this.#busy;
  }

  get persona(): PersonaSpec | undefined {
    return this.#persona;
  }

  async ready(): Promise<void> {
    await this.#rpc.waitReady((state) => {
      const session = asState(state);
      const file = session?.sessionFile;
      if (file !== undefined && this.native.sessionFile === undefined) {
        // The resume handle is only known once pi has a session file.
        (this.native as { sessionFile?: string }).sessionFile = file;
      }
    });
  }

  async *prompt(
    input: PromptInput,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    if (this.#busy) {
      throw new PrefaixError(
        "CONVERSATION_BUSY",
        "this pi session already has a turn running",
      );
    }
    this.#busy = true;
    const controller = new AbortController();
    this.#turnAbort = controller;
    const turn = AbortSignal.any([signal, controller.signal]);
    const mapper = new TurnMapper(this.#mapperOptions);
    this.#mapper = mapper;

    try {
      // A prompt that is already aborted must not reach pi at all.
      if (turn.aborted) {
        yield mapper.settle("aborted");
        return;
      }

      // Whatever pi wrote before its first reply is startup output, not an
      // abandoned turn, so it is mapped into this turn rather than discarded.
      for (const record of this.#rpc.takeStartupRecords()) {
        for (const event of mapper.map(record)) {
          yield event;
        }
      }

      const message = this.#compose(input);
      await this.#rpc.request("prompt", { message });

      // pi only starts streaming once it has the prompt, so the turn's records
      // begin here. Anything before this turn's agent_start is left over from a
      // turn that was abandoned, most often by an abort.
      const iterator = this.#rpc.events[Symbol.asyncIterator]();
      let started = false;
      for (;;) {
        // An abort has to end the turn even if pi goes quiet afterwards, so it
        // is raced rather than polled between records.
        const step = await raceAbort(iterator.next(), turn);
        if (step === ABORTED) {
          // The user pressed Esc: give the prompt back now rather than waiting
          // on a settle this build cannot prove arrives. The abandoned read is
          // cancelled first, or it would swallow the next turn's first record.
          await iterator.return?.();
          yield mapper.settle("aborted");
          return;
        }
        if (step.done) {
          // The stream ended without a settle, which means pi is gone.
          yield mapper.settleWithError("pi ended the turn without settling");
          return;
        }
        const record = step.value;
        if (!started) {
          if (!isAgentStart(record)) {
            continue;
          }
          started = true;
        }
        for (const event of mapper.map(record)) {
          yield event;
        }
        if (record.type === "agent_settled") {
          yield mapper.settle();
          return;
        }
      }
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "the pi turn failed";
      if (turn.aborted) {
        yield mapper.settle("aborted");
        return;
      }
      yield mapper.settleWithError(message);
    } finally {
      this.#busy = false;
      this.#turnAbort = undefined;
      this.#mapper = undefined;
    }
  }

  #compose(input: PromptInput): string {
    // Context is always included here. The bridge is meant to carry it out of
    // band so the visible message stays exactly what the user typed, but until
    // the bridge can actually read the turn context, dropping this block would
    // silently remove cwd, recent commands, the terminal, and the persona from
    // every request. M2-7 takes this over once it writes the turn file.
    return `${contextBlock(input)}\n\n${input.text}`;
  }

  async steer(text: string): Promise<void> {
    await this.#rpc.request("steer", { message: text });
  }

  async abort(): Promise<void> {
    // The local turn is released first. If pi is alive but unresponsive, waiting
    // on its replies would hold the user's prompt for the sum of both timeouts.
    this.#turnAbort?.abort();
    // Queued text is restored into the buffer rather than dropped, so the
    // user's half-typed text survives the abort. This is best effort, and must
    // not delay the release above.
    const cleared = await this.#rpc
      .request("clear_queue")
      .catch(() => undefined);
    const steering = asRecord(cleared)?.["steering"];
    const followUp = asRecord(cleared)?.["followUp"];
    const queued = [
      ...(Array.isArray(steering) ? steering : []),
      ...(Array.isArray(followUp) ? followUp : []),
    ].filter((text): text is string => typeof text === "string" && text !== "");
    if (queued.length > 0) {
      this.#onQueuedText?.(queued.join(" "));
    }
    await this.#rpc.request("abort").catch(() => undefined);
  }

  // Set by the adapter so an abort can hand queued text back to the shell.
  #onQueuedText: ((text: string) => void) | undefined;

  onQueuedText(listener: (text: string) => void): void {
    this.#onQueuedText = listener;
  }

  respondUi(requestId: string, response: UiResponse): void {
    // prefaix numbers dialogs itself, so the reply has to quote pi's id or pi
    // will never match it to the request it is holding.
    const piId = this.#mapper?.piRequestId(requestId);
    if (piId === undefined) {
      // A stale or unknown answer is ignored rather than sent into the void.
      return;
    }
    const payload =
      "value" in response
        ? { value: response.value }
        : "cancelled" in response
          ? { cancelled: true as const }
          : { confirmed: response.confirmed };
    this.#rpc.writeRaw(
      `${JSON.stringify({ type: "extension_ui_response", id: piId, ...payload })}\n`,
    );
  }

  async state(): Promise<AgentState> {
    const state = asState(await this.#rpc.request("get_state"));
    if (state === undefined) {
      return { busy: this.#busy };
    }
    // Fetched whether or not a turn is running: `:info` shows tokens and cost
    // for a conversation at rest, not only mid-turn.
    const stats = asStats(
      await this.#rpc.request("get_session_stats").catch(() => undefined),
    );
    const model: ModelRef | undefined =
      state.model === undefined
        ? undefined
        : { provider: state.model.provider, id: state.model.id };
    return {
      ...(model === undefined ? {} : { model }),
      thinking: state.thinkingLevel,
      busy: state.isStreaming,
      ...(stats?.tokens === undefined
        ? {}
        : {
            usage: {
              input: stats.tokens.input ?? 0,
              output: stats.tokens.output ?? 0,
              ...(stats.cost === undefined ? {} : { costUsd: stats.cost }),
            },
          }),
      contextPct: stats?.contextPercent ?? null,
      ...(state.sessionName === undefined ? {} : { name: state.sessionName }),
    };
  }

  async listModels(): Promise<ModelInfo[]> {
    return asModels(await this.#rpc.request("get_available_models")).map(
      (model) => ({
        provider: model.provider,
        id: model.id,
        ...(model.name === undefined ? {} : { name: model.name }),
        ...(model.contextWindow === undefined
          ? {}
          : { contextWindow: model.contextWindow }),
        ...(model.reasoning === true ? { reasoning: true } : {}),
      }),
    );
  }

  async setModel(ref: ModelRef): Promise<void> {
    await this.#rpc.request("set_model", {
      provider: ref.provider,
      modelId: ref.id,
    });
  }

  async setThinking(level: string): Promise<void> {
    await this.#rpc.request("set_thinking_level", { level });
  }

  async listCommands(): Promise<AgentCommand[]> {
    return asCommands(await this.#rpc.request("get_commands")).map(
      (command) => ({
        name: command.name,
        kind:
          command.source === "skill"
            ? "skill"
            : command.source === "prompt"
              ? "template"
              : "extension",
        ...(command.description === undefined
          ? {}
          : { description: command.description }),
      }),
    );
  }

  async compact(focus?: string): Promise<CompactResult> {
    const result = asCompaction(
      await this.#rpc.request(
        "compact",
        focus === undefined || focus === ""
          ? {}
          : { customInstructions: focus },
      ),
    );
    return result;
  }

  async lastAssistantText(): Promise<string | null> {
    // pi sends {} when there is no completed turn, though its type says
    // { text: string | null }.
    return asText(await this.#rpc.request("get_last_assistant_text"));
  }

  async setPersona(persona: PersonaSpec): Promise<void> {
    this.#persona = persona;
  }

  async rename(title: string): Promise<void> {
    await this.#rpc.request("set_session_name", { name: title });
  }

  tuiCommand(): { argv: string[]; cwd: string } {
    const file = this.native.sessionFile;
    if (file === undefined || file === "") {
      throw new PrefaixError(
        "AGENT_UNAVAILABLE",
        "this pi session has no session file to hand off to",
        { hint: "Run one turn first." },
      );
    }
    return {
      argv: [this.#bin, "--session", file],
      // The conversation's own root, not the daemon's working directory, or the
      // TUI opens the wrong repository.
      cwd: this.#root,
    };
  }

  async close(): Promise<void> {
    await this.#rpc.close();
  }
}

// The fallback context block, used when the bridge did not load.
export function contextBlock(input: PromptInput): string {
  const { context, persona } = input;
  const recent = context.recent
    .map((entry, index) => `  [${index}] ${entry.cmd}${exitSuffix(entry.exit)}`)
    .join("\n");
  return [
    "<shell-context>",
    `Shell: ${context.shell.kind} ${context.shell.version} on ${context.os} · cwd: ${context.cwd}`,
    recent === "" ? "Recent commands: (none)" : `Recent commands:\n${recent}`,
    `Output is rendered as streaming markdown in a terminal (${String(context.term.cols)} cols). Keep answers concise.`,
    ...(persona?.guideline === undefined || persona.guideline === ""
      ? []
      : [`Persona: ${persona.guideline}`]),
    "</shell-context>",
  ].join("\n");
}

function exitSuffix(exit: number | null): string {
  return exit === null ? "" : ` (exit ${String(exit)})`;
}

function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** The absolute path of `bin`, or undefined when it is not installed. */
async function resolveOnPath(
  bin: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<string | undefined> {
  if (isAbsolute(bin)) {
    return (await exists(bin)) ? bin : undefined;
  }
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir === "") {
      // An empty segment means the current directory, which is not somewhere a
      // daemon should be finding an agent from.
      continue;
    }
    const candidate = join(dir, bin);
    if (await exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function piVersion(
  bin: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = execFile(
      bin,
      ["--version"],
      { timeout: 2_000, env: { ...env } },
      (error, stdout) => {
        resolve(error ? undefined : stdout.trim().split("\n")[0]);
      },
    );
    child.on("error", () => resolve(undefined));
  });
}

export class PiAdapter implements AgentBackend {
  readonly id = PI_ID;
  readonly capabilities: Capabilities = PI_CAPABILITIES;
  readonly #options: PiAdapterOptions;
  readonly #sessions = new Set<PiSession>();

  constructor(options: PiAdapterOptions = {}) {
    this.#options = options;
  }

  get sessions(): readonly PiSession[] {
    return [...this.#sessions];
  }

  async probe(): Promise<ProbeResult> {
    const requested = this.#options.bin ?? "pi";
    const env = this.#options.env ?? process.env;
    // Resolved once, because a child process does not search the PATH it was
    // handed any more reliably than the parent does.
    const resolved = await resolveOnPath(requested, env);
    if (resolved === undefined) {
      return {
        installed: false,
        usable: false,
        problem: "pi not found on PATH",
        hint: "Install pi, then run prefaix doctor.",
      };
    }
    // pi's own version is the truth, and doctor is the one place the extra
    // process is affordable.
    const version = await piVersion(resolved, env);
    return {
      installed: true,
      usable: true,
      ...(version === undefined ? {} : { version }),
    };
  }

  async open(opts: OpenOptions): Promise<AgentSession> {
    const plan = buildSpawnPlan(opts, this.#options);
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(opts.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    const rpc = new PiRpc({
      bin: plan.bin,
      args: plan.args,
      cwd: opts.root,
      env,
      ...(this.#options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: this.#options.requestTimeoutMs }),
      ...(this.#options.readyTimeoutMs === undefined
        ? {}
        : { readyTimeoutMs: this.#options.readyTimeoutMs }),
      ...(this.#options.rpc ?? {}),
      ...(this.#options.log === undefined ? {} : { log: this.#options.log }),
    });
    const native: NativeRef = {
      ...(plan.args.includes("--session-id")
        ? { sessionId: plan.args[plan.args.indexOf("--session-id") + 1] }
        : {}),
      ...(opts.resume?.sessionFile === undefined
        ? {}
        : { sessionFile: opts.resume.sessionFile }),
    };
    const session = new PiSession(rpc, native, this.#options, {
      // The binary the child actually ran under, which a transport override
      // may have changed, so a handoff launches the same pi.
      bin: this.#options.rpc?.bin ?? plan.bin,
      root: opts.root,
    });
    this.#sessions.add(session);
    try {
      await session.ready();
    } catch (cause) {
      this.#sessions.delete(session);
      await session.close().catch(() => undefined);
      throw cause;
    }
    return session;
  }
}

export function createPiAdapter(options: PiAdapterOptions = {}): PiAdapter {
  return new PiAdapter(options);
}
