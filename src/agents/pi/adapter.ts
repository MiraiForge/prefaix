// The pi adapter: AgentPort on top of the JSONL transport (DESIGN §4.5).
//
// A turn owns the records from its `agent_start` to its settle, which is what
// makes a turn safe to abandon: after an abort the leftover records are dropped
// rather than leaking into the next turn's stream.

import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { PrefaixError, messageOf } from "../../core/errors.js";
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
import { BRIDGE_DIR_ENV } from "./bridge.js";
import {
  bridgeReadyFile,
  prependBlock,
  removeTurnContext,
  turnContextFile,
  writeTurnContext,
  BRIDGE_VERSION,
  type TurnContextFile,
} from "./bridge-context.js";
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
  type PiRecord,
} from "./types.js";

import { PI_ID, piCapabilities, bridgeConfigured } from "./capabilities.js";
import { assertResumeRoot } from "./resume-root.js";
export { PI_ID, bridgeConfigured } from "./capabilities.js";

export interface PiAdapterOptions {
  readonly bin?: string;
  /** The bridge extension bundle, when the capability probe passed. */
  readonly bridgePath?: string;
  /** Where per-turn context files live; required for the bridge to work. */
  readonly turnsDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Explicit provider selection; development live gates must set this. */
  readonly provider?: string;
  readonly model?: string | null;
  readonly thinking?: string | null;
  readonly personaTools?: readonly string[] | undefined;
  readonly requestTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly rpc?: Partial<PiRpcOptions>;
  readonly mapper?: MapperOptions;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Injectable so a test can decide what the probe sees. */
  readonly bridgeReady?: (file: string) => boolean;
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

  const provider = options.model?.provider ?? config.provider;
  if (provider !== undefined && provider !== "") {
    args.push("--provider", provider);
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

  // Capture the normal runtime loadout, not a persona's narrowed spawn
  // loadout, so the bridge can later restore all normal tools for :go.
  const tools = bridgeConfigured(config)
    ? config.personaTools
    : (options.persona?.tools ?? config.personaTools);
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
  #closePromise: Promise<void> | undefined;
  #turnAbort: AbortController | undefined;
  #persona: PersonaSpec | undefined;
  // The mapper of the running turn, which knows pi's own id for each dialog.
  #mapper: TurnMapper | undefined;
  // Whether the bridge extension actually loaded for this child. A spawn that
  // asked for the bridge and did not get it falls back to prepending, which is
  // correct but leaves the context in the visible user message.
  #bridgeLive = false;
  #turnsDir: string | undefined;
  #pid: number | undefined;

  constructor(
    rpc: PiRpc,
    native: NativeRef,
    options: PiAdapterOptions,
    origin: {
      readonly bin: string;
      readonly root: string;
      readonly turnsDir?: string;
      /** Omit to bind the pid later, once the child exists. */
      readonly pid?: number;
      readonly persona?: PersonaSpec;
    },
  ) {
    this.#rpc = rpc;
    this.native = native;
    this.#bin = origin.bin;
    // An empty root is not a directory, so it is normalised once here rather
    // than at every use.
    this.#root = origin.root === "" ? "." : origin.root;
    this.#mapperOptions = options.mapper ?? {};
    this.#turnsDir = origin.turnsDir;
    this.#pid = origin.pid;
    this.#persona = origin.persona;
  }

  /** pi's pid, which names this child's context and ready files. */
  attachChild(pid: number | undefined): void {
    this.#pid = pid;
  }

  /** The child pid, once it is known; undefined before the child spawns. */
  get pid(): number | undefined {
    return this.#pid;
  }

  get isAlive(): boolean {
    return !this.#rpc.exited;
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** True when per-turn context goes out of band rather than in the message. */
  get bridgeLive(): boolean {
    return this.#bridgeLive;
  }

  /**
   * Decides whether the bridge extension loaded. The extension announces
   * itself with a ready file while loading, and pi answers its first command
   * only after every extension has been loaded, so by the time `ready()`
   * resolved the file is either there or never going to be.
   */
  probeBridge(options: {
    readonly bridgePath?: string;
    readonly ready?: (file: string) => boolean;
  }): boolean {
    const turnsDir = this.#turnsDir;
    const pid = this.#pid;
    if (
      options.bridgePath === undefined ||
      turnsDir === undefined ||
      pid === undefined
    ) {
      this.#bridgeLive = false;
      return false;
    }
    const exists = options.ready ?? ((path: string) => existsSync(path));
    this.#bridgeLive = exists(bridgeReadyFile(turnsDir, pid));
    return this.#bridgeLive;
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
    let iterator: AsyncIterator<PiRecord> | undefined;

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
      // before_agent_start can request a dialog BEFORE acknowledging prompt.
      // Read concurrently or neither pi nor the foreground can make progress.
      const accepted = this.#rpc.request("prompt", { message });
      const failure = accepted.then(() => new Promise<never>(() => {}));
      // A terminal/abort can win before the acknowledgment: no later rejection
      // may become an unhandled promise or corrupt a subsequent turn.
      void failure.catch(() => undefined);
      iterator = this.#rpc.events[Symbol.asyncIterator]();
      let started = false;
      for (;;) {
        // An abort has to end the turn even if pi goes quiet afterwards, so it
        // is raced rather than polled between records.
        const step = await raceAbort(
          Promise.race([iterator.next(), failure]),
          turn,
        );
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
          if (record.type !== "agent_start") {
            if (record.type === "extension_ui_request") {
              for (const event of mapper.map(record)) yield event;
            }
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
      const message = messageOf(cause);
      if (turn.aborted) {
        yield mapper.settle("aborted");
        return;
      }
      yield mapper.settleWithError(message);
    } finally {
      // A turn the bridge never picked up (an abort before before_agent_start,
      // a pi that died) must not leave its context on disk for the next turn.
      await iterator?.return?.();
      this.#clearContextFile();
      this.#busy = false;
      this.#turnAbort = undefined;
      this.#mapper = undefined;
    }
  }

  /**
   * Sends the prompt, carrying the turn's shell context out of band when the
   * bridge extension is live and prepending it otherwise. Writes are sequential
   * per child, so there is no race between the file and the prompt (ADR 0004).
   */
  #compose(input: PromptInput): string {
    if (this.#publishContext(input)) {
      return input.text;
    }
    if (this.#bridgeLive) {
      // Spawn kept the normal tools so the bridge can restore them later.
      // Without this turn's file, neither restriction nor restoration is
      // guaranteed. Never replace enforced persona state with prose alone.
      throw new PrefaixError(
        "AGENT_ERROR",
        "could not deliver turn context to the pi bridge; prompt not sent",
        { hint: "Restore the runtime turns directory and retry the turn." },
      );
    }
    // The bridge is absent or did not load. Dropping the block instead would
    // silently remove cwd, recent commands, the terminal, and the persona from
    // every request, so the same text is prepended to the message.
    return `${prependBlock(input.context, input.persona ?? this.#persona)}\n\n${input.text}`;
  }

  #publishContext(input: PromptInput): boolean {
    const turnsDir = this.#turnsDir;
    const pid = this.#pid;
    if (!this.#bridgeLive || turnsDir === undefined || pid === undefined) {
      return false;
    }
    const payload: TurnContextFile = {
      version: BRIDGE_VERSION,
      context: input.context,
      ...(input.persona === undefined && this.#persona === undefined
        ? {}
        : { persona: input.persona ?? (this.#persona as PersonaSpec) }),
    };
    if (!writeTurnContext(turnContextFile(turnsDir, pid), payload)) {
      // The caller must refuse a live-bridge turn rather than trust missing
      // context or send it without the intended tool switch.
      return false;
    }
    return true;
  }

  #clearContextFile(): void {
    if (
      !this.#bridgeLive ||
      this.#turnsDir === undefined ||
      this.#pid === undefined
    ) {
      return;
    }
    removeTurnContext(turnContextFile(this.#turnsDir, this.#pid));
  }

  /** The ready file is named after the child, so it goes when the child does. */
  #clearReadyFile(): void {
    if (this.#turnsDir === undefined || this.#pid === undefined) {
      return;
    }
    removeTurnContext(bridgeReadyFile(this.#turnsDir, this.#pid));
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

  async listThinkingLevels(): Promise<string[]> {
    const data: unknown = await this.#rpc.request(
      "get_available_thinking_levels",
    );
    if (
      typeof data !== "object" ||
      data === null ||
      !("levels" in data) ||
      !Array.isArray(data.levels)
    ) {
      return [];
    }
    return data.levels.filter(
      (level): level is string => typeof level === "string",
    );
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

  async setPersona(persona: PersonaSpec | undefined): Promise<void> {
    if (!this.#bridgeLive) {
      throw new PrefaixError(
        "UNSUPPORTED",
        "this pi child cannot switch personas because the bridge is unavailable",
        { hint: "Respawn the child with the requested persona." },
      );
    }
    // Recorded here and published with the next turn's context file, where the
    // bridge swaps pi's active tools. A persona set outside a turn therefore
    // takes effect on the next `:` rather than immediately, which is the first
    // moment it is observable.
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

  close(): Promise<void> {
    this.#closePromise ??= (async () => {
      this.#clearReadyFile();
      this.#clearContextFile();
      await this.#rpc.close();
    })();
    return this.#closePromise;
  }
}

// The fallback context block, used when the bridge did not load. The prose and
// the tags come from bridge-context so the two paths are the same text.
export function contextBlock(input: PromptInput): string {
  return prependBlock(input.context, input.persona);
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

async function piVersion(
  bin: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const { execFile } = await import("node:child_process");
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
  readonly capabilities: Capabilities;
  readonly #options: PiAdapterOptions;
  readonly #sessions = new Set<PiSession>();

  constructor(options: PiAdapterOptions = {}) {
    this.#options = options;
    this.capabilities = piCapabilities(options);
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
    return this.#open(opts);
  }

  async #open(opts: OpenOptions, fallback = false): Promise<PiSession> {
    await assertResumeRoot(opts.resume?.sessionFile, opts.root);
    const plan = buildSpawnPlan(
      opts,
      fallback
        ? { ...this.#options, bridgePath: "", turnsDir: "" }
        : this.#options,
    );
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(opts.env)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    // The bridge finds its per-turn files through this one variable rather
    // than reconstructing the runtime layout inside pi's process.
    if (this.#options.turnsDir !== undefined && this.#options.turnsDir !== "") {
      env[BRIDGE_DIR_ENV] = this.#options.turnsDir;
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
    const turnsDir = this.#options.turnsDir;
    const session = new PiSession(rpc, native, this.#options, {
      // The binary the child actually ran under, which a transport override
      // may have changed, so a handoff launches the same pi.
      bin: this.#options.rpc?.bin ?? plan.bin,
      root: opts.root,
      ...(turnsDir === undefined ? {} : { turnsDir }),
      ...(opts.persona === undefined ? {} : { persona: opts.persona }),
    });
    this.#sessions.add(session);
    try {
      await session.ready();
      if (turnsDir !== undefined) {
        // The pid is what names the turn context and ready files, so it is
        // captured from the live child rather than guessed.
        session.attachChild(rpc.pid);
        if (
          !session.probeBridge({
            ...(this.#options.bridgePath === undefined
              ? {}
              : { bridgePath: fallback ? "" : this.#options.bridgePath }),
            ...(this.#options.bridgeReady === undefined
              ? {}
              : { ready: this.#options.bridgeReady }),
          })
        ) {
          this.#options.log?.("the pi bridge extension did not load", {
            root: opts.root,
            ...(this.#options.bridgePath === undefined
              ? {}
              : { bridgePath: this.#options.bridgePath }),
          });
        }
      }
      if (
        !fallback &&
        bridgeConfigured(this.#options) &&
        !session.bridgeLive &&
        opts.persona?.tools !== undefined
      ) {
        // No prompt has been sent. Restart once with spawn-time restrictions
        // rather than silently running a read-only persona with full tools.
        this.#sessions.delete(session);
        await session.close();
        return await this.#open(
          { ...opts, resume: { ...session.native } },
          true,
        );
      }
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
