// The operations layer: every op in DESIGN §4.3.2, resolved against the store,
// the pool, and the turn manager. This is where a `:` becomes a turn, and where
// a conversation's identity, root, and native session are decided.
//
// The cwd policy lives here because it is a conversation-level decision, not an
// adapter one: the model is told the shell's cwd every turn either way, but
// which child runs, and whether a `cd` out of the root starts a new
// conversation, is prefaix's call (DESIGN §4.3.6).

import { execFile } from "node:child_process";
import { PrefaixError, unsupported, messageOf } from "../core/errors.js";
import { newRecord, summarize } from "./store.js";
import type { ConversationRecord, ConversationStore } from "./store.js";
import type {
  AgentEvent,
  AgentSession,
  PersonaSpec,
  UiResponse,
} from "../core/agent-port.js";
import type { AgentPool } from "./pool.js";
import type { TurnHandle, TurnManager } from "./turns.js";
import { personaSpec } from "../core/config/index.js";
import type { PrefaixConfig } from "../core/config/schema.js";
import type {
  ConvGetParams,
  ConvLastTextParams,
  ConvListParams,
  ConvNewParams,
  ConvRenameParams,
  ConversationSummary,
  ModelSetParams,
  StatusSnapshot,
  ThinkingSetParams,
  TurnStartParams,
  TurnStartResult,
  TurnSummary,
  UiRespondParams,
} from "../core/protocol.js";
import type { Connection } from "./server.js";
import type { DaemonMessage } from "../core/protocol.js";

/** How long a git toplevel lookup may take before cwd falls back to itself. */
const GIT_TIMEOUT_MS = 1_500;

export interface GitRootOptions {
  readonly run?: (
    bin: string,
    args: readonly string[],
    options: { cwd: string },
  ) => Promise<string | undefined>;
}

/**
 * The git toplevel of a directory, or the directory itself. A repository whose
 * git call is slow or absent must still get a root, because the alternative is
 * a conversation that cannot be anchored at all.
 */
export async function workspaceRoot(
  cwd: string,
  options: GitRootOptions = {},
): Promise<string> {
  const run =
    options.run ??
    ((bin, args, opts) =>
      new Promise((resolve) => {
        execFile(
          bin,
          [...args],
          { cwd: opts.cwd, timeout: GIT_TIMEOUT_MS },
          (error, stdout) => {
            resolve(error ? undefined : stdout.trim());
          },
        );
      }));
  const toplevel = await run("git", ["rev-parse", "--show-toplevel"], { cwd });
  const root = toplevel?.trim() ?? "";
  return root === "" ? cwd : root;
}

export interface OpsOptions {
  readonly store: ConversationStore;
  readonly pool: AgentPool;
  readonly turns: TurnManager;
  readonly config: PrefaixConfig;
  readonly version: string;
  readonly startedAt: number;
  readonly now?: () => number;
  readonly gitRoot?: GitRootOptions;
  /** Writes a line to a connection; the server's own send. */
  readonly send: (connection: Connection, message: DaemonMessage) => void;
  /** After a turn settles: status files, the pool's spare, and the log. */
  readonly onEnd: (
    turn: TurnHandle,
    summary: TurnSummary,
    info: { root: string; env: Record<string, string> },
  ) => void;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export class Operations {
  readonly #options: OpsOptions;
  /** turn id -> the connection that owns it, so a close knows what to abort. */
  readonly #owned = new Map<string, Connection>();

  constructor(options: OpsOptions) {
    this.#options = options;
  }

  /**
   * A client socket went away. The turn's own disconnect policy decides
   * between aborting and leaving it running for `:attach`; the default is
   * abort, which is the least surprising thing to do with a half-streamed
   * answer and matches closing a pi TUI.
   */
  releaseConnection(connection: Connection): void {
    for (const [turnId, owner] of [...this.#owned]) {
      if (owner.id !== connection.id) {
        continue;
      }
      this.#owned.delete(turnId);
      const turn = this.#options.turns.get(turnId);
      if (turn !== undefined) {
        this.#options.turns.release(turn, "close");
      }
    }
  }

  /**
   * Publishes one event on the turn's ring and forwards it to the client that
   * owns the turn. `seq` is monotonic per turn, so a client can tell a gap from
   * a duplicate without tracking anything else.
   */
  publish(turn: TurnHandle, event: AgentEvent): number {
    const seq = this.#options.turns.publish(turn, event);
    const owner = this.#owned.get(turn.id);
    if (owner !== undefined && !owner.closed) {
      this.#options.send(owner, { t: "evt", turnId: turn.id, seq, e: event });
    }
    return seq;
  }

  // ── conversations ──────────────────────────────────────────────────────

  async convNew(params: ConvNewParams): Promise<ConversationSummary> {
    const root = await workspaceRoot(params.cwd, this.#options.gitRoot ?? {});
    const record = newRecord({
      backend: this.#options.pool.backend.id,
      root,
      shell: params.shell.kind,
    });
    await this.#options.store.save(record);
    this.#options.log?.("new conversation", { id: record.id, root });
    return summarize(record);
  }

  async convList(
    params: ConvListParams,
  ): Promise<{ conversations: ConversationSummary[] }> {
    const records = await this.#options.store.search(
      params.query ?? "",
      params.limit ?? 20,
    );
    return { conversations: records.map(summarize) };
  }

  async convGet(params: ConvGetParams): Promise<ConversationSummary> {
    return summarize(await this.#require(params.conversationId));
  }

  async convRename(params: ConvRenameParams): Promise<ConversationSummary> {
    const record = await this.#require(params.conversationId);
    const title = params.title.trim().slice(0, 60);
    const session = this.#options.pool.session(record.id);
    if (session?.rename !== undefined) {
      // pi's own session name is what `:tui` and pi's picker show, so the two
      // are updated together; a backend that cannot rename is not a failure.
      await session.rename(title).catch(() => undefined);
    }
    return summarize(await this.#options.store.update(record.id, { title }));
  }

  /**
   * Removes a conversation from the index. The warm child is released with it,
   * or it would keep writing a transcript that nothing points at any more.
   */
  async convRemove(params: {
    conversationId: string;
  }): Promise<{ removed: true }> {
    const record = await this.#require(params.conversationId);
    const running = this.#options.turns.runningFor(record.id);
    if (running !== undefined) {
      throw new PrefaixError(
        "CONVERSATION_BUSY",
        "this conversation has a turn running",
        { hint: "Abort it first, then remove the conversation." },
      );
    }
    await this.#options.pool.release(record.id);
    await this.#options.store.remove(record.id);
    return { removed: true };
  }

  /**
   * Replays a turn's event ring to the caller. This is what `debug tap` reads
   * and what `:attach` will read; it works on a finished turn as well as a
   * running one, because the ring survives the turn.
   */
  async turnAttach(
    params: { conversationId?: string; fromSeq: number },
    connection: Connection,
  ): Promise<{ turnId: string; fromSeq: number }> {
    const conversationId = params.conversationId;
    if (conversationId === undefined || conversationId === "") {
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        "a conversation id is required to attach",
        { hint: "prefaix debug tap <conversation>" },
      );
    }
    const turn = this.#options.turns.lastFor(conversationId);
    if (turn === undefined) {
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        `no turn on record for ${JSON.stringify(conversationId)}`,
        { hint: "Run a `:` in that shell first." },
      );
    }
    // The replay goes to the socket that asked for it, not to whoever owned the
    // turn: the point of attaching is that the original client is gone.
    const from = Math.max(1, params.fromSeq);
    for (const entry of turn.ring.since(from)) {
      this.#options.send(connection, {
        t: "evt",
        turnId: turn.id,
        seq: entry.seq,
        e: entry.event,
      });
    }
    if (turn.summary !== undefined) {
      this.#options.send(connection, {
        t: "turn.end",
        turnId: turn.id,
        summary: turn.summary,
      });
    }
    // The oldest sequence still held, so a client that asked to replay from
    // further back can be told where the gap starts instead of being handed a
    // stream with a hole in it.
    return { turnId: turn.id, fromSeq: turn.ring.oldestSeq };
  }

  async convLastText(
    params: ConvLastTextParams,
  ): Promise<{ text: string | null }> {
    const session = this.#options.pool.session(params.conversationId);
    if (session === undefined) {
      // The child is not warm, so the answer is not one prefaix can produce
      // without paying a cold start for a `:` that may never come.
      return { text: null };
    }
    return { text: await session.lastAssistantText() };
  }

  async convCompact(
    params: ConvGetParams & { focus?: string },
  ): Promise<{ summary?: string; tokensBefore?: number }> {
    // The record is checked first so a conversation that does not exist is
    // reported as such, rather than as a missing capability.
    await this.#require(params.conversationId);
    const session = this.#options.pool.session(params.conversationId);
    if (session?.compact === undefined) {
      throw unsupported(this.#options.pool.backend.id, ":compact");
    }
    return session.compact(params.focus);
  }

  // ── turns ──────────────────────────────────────────────────────────────

  async turnStart(
    params: TurnStartParams,
    connection: Connection,
  ): Promise<TurnStartResult> {
    const resolved = await this.#resolveConversation(params);
    const record = await this.#applyCwdPolicy(resolved.record, params.cwd);
    const turn = this.#options.turns.start({
      conversationId: record.id,
      shellId: params.shell.shellId,
      promptText: params.text,
      ...(params.onDisconnect === undefined
        ? {}
        : { onDisconnect: params.onDisconnect }),
    });
    this.#owned.set(turn.id, connection);

    const persona = this.#persona(params.persona);
    // The native handle is what lets a respawn continue the same transcript,
    // so it is read from the warm child when there is one and from the record
    // otherwise.
    const warm = this.#options.pool.session(record.id);
    const native = warm?.native ?? record.native;

    const agent = await this.#options.pool.acquire({
      conversationId: record.id,
      root: record.root,
      env: params.env,
      title: record.title,
      ...(record.model === undefined ? {} : { model: record.model }),
      ...(record.thinking === undefined ? {} : { thinking: record.thinking }),
      ...(persona === undefined ? {} : { persona }),
      native,
    });

    if (persona !== undefined) {
      await this.#options.store
        .update(record.id, { persona: persona.name })
        .catch(() => undefined);
    }
    // The turn is already registered, so a prompt failure is reported through
    // the same event stream and settle path as any other turn outcome rather
    // than as a lost response to `turn.start`.
    void this.#pump(record, turn, agent, params, persona);
    for (const notice of resolved.notices) {
      this.publish(turn, notice);
    }
    return { turnId: turn.id, conversationId: record.id };
  }

  /**
   * Where the child runs (DESIGN §4.3.6). The conversation is anchored to a
   * root, and a `cd` out of that root is the only thing that can move it:
   *
   * - `follow` respawns the child in the new root on the same session.
   * - `split` leaves the old conversation alone and starts one for the new
   *   root, so the next `cd` back finds the old transcript.
   * - `stay` keeps the old root and only tells the model the new cwd.
   */
  async #applyCwdPolicy(
    record: ConversationRecord,
    cwd: string,
  ): Promise<ConversationRecord> {
    const policy = this.#options.config.workspace.cwdPolicy;
    if (policy === "stay") {
      return record;
    }
    const root = await workspaceRoot(cwd, this.#options.gitRoot ?? {});
    if (root === record.root) {
      return record;
    }
    if (policy === "split") {
      const existing = await this.#options.store.lastInRoot(root);
      if (existing !== undefined) {
        this.#options.log?.("cwd left the conversation root", {
          from: record.root,
          to: root,
          conversation: existing.id,
        });
        return existing;
      }
      const created = newRecord({
        backend: record.backend,
        root,
        shell: record.createdBy.shell,
      });
      await this.#options.store.save(created);
      this.#options.log?.("cwd left the conversation root", {
        from: record.root,
        to: root,
        conversation: created.id,
      });
      return created;
    }
    await this.#options.store.update(record.id, { root });
    return { ...record, root };
  }

  async #pump(
    record: ConversationRecord,
    turn: TurnHandle,
    session: AgentSession,
    params: TurnStartParams,
    persona: PersonaSpec | undefined,
  ): Promise<void> {
    let summary: TurnSummary = {
      turnId: turn.id,
      status: "error",
      error: "the turn ended without a settle",
    };
    try {
      for await (const event of session.prompt(
        {
          text: params.text,
          context: {
            shell: params.shell,
            cwd: params.cwd,
            recent: params.context.recent,
            os: params.context.os,
            term: params.context.term,
          },
          ...(persona === undefined ? {} : { persona }),
        },
        turn.controller.signal,
      )) {
        if (event.type === "settled") {
          summary = {
            turnId: turn.id,
            status: event.stopReason,
            ...(event.error === undefined ? {} : { error: event.error }),
          };
        }
        if (event.type === "ui_request") {
          this.#options.turns.openDialog(turn, event.id);
        }
        this.publish(turn, event);
      }
    } catch (cause) {
      const message = messageOf(cause);
      const aborted = turn.controller.signal.aborted;
      summary = aborted
        ? { turnId: turn.id, status: "aborted" }
        : { turnId: turn.id, status: "error", error: message };
      this.publish(turn, {
        type: "notice",
        level: aborted ? "info" : "error",
        text: aborted ? "turn aborted" : message,
        source: this.#options.pool.backend.id,
      });
      this.publish(turn, {
        type: "settled",
        stopReason: aborted ? "aborted" : "error",
        ...(summary.error === undefined ? {} : { error: summary.error }),
      });
    }

    this.#options.turns.finish(turn, summary);
    const owner = this.#owned.get(turn.id);
    this.#owned.delete(turn.id);
    // The record is written before the client is told the turn ended, so a
    // `:info` or `conversations show` immediately after a turn reads a
    // conversation that already includes it.
    await this.#recordOutcome(record.id, session, summary);
    if (owner !== undefined && !owner.closed) {
      this.#options.send(owner, { t: "turn.end", turnId: turn.id, summary });
    }
    this.#options.onEnd(turn, summary, { root: record.root, env: params.env });
  }

  async #recordOutcome(
    conversationId: string,
    session: AgentSession,
    summary: TurnSummary,
  ): Promise<void> {
    // Re-read rather than reuse the snapshot taken when the turn started: a
    // second turn on the same conversation must count on top of the first, and
    // two shells can finish turns close enough to interleave their writes.
    const record = await this.#options.store.get(conversationId);
    if (record === undefined) {
      return;
    }
    const state = await session.state().catch(() => undefined);
    // Only a completed turn joins the conversation, so an abort and a crash
    // leave the counters and the title alone.
    const turns =
      summary.status === "stop" ? record.stats.turns + 1 : record.stats.turns;
    const cost =
      state?.usage?.costUsd === undefined
        ? record.stats.costUsd
        : (record.stats.costUsd ?? 0) + state.usage.costUsd;
    const contextPct =
      state?.contextPct === undefined || state.contextPct === null
        ? record.stats.lastContextPct
        : state.contextPct;
    const patch: Partial<ConversationRecord> = {
      native: { ...record.native, ...session.native },
      stats: {
        turns,
        ...(cost === undefined ? {} : { costUsd: cost }),
        ...(contextPct === undefined ? {} : { lastContextPct: contextPct }),
      },
      ...(state?.model === undefined ? {} : { model: state.model }),
      ...(state?.thinking === undefined ? {} : { thinking: state.thinking }),
    };
    try {
      await this.#options.store.update(record.id, patch);
    } catch (cause) {
      this.#options.log?.("could not update the conversation record", {
        id: record.id,
        cause: messageOf(cause),
      });
    }
  }

  async turnAbort(params: { turnId: string }): Promise<{ turnId: string }> {
    const turn = this.#options.turns.get(params.turnId);
    if (turn === undefined) {
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        `no turn with id ${JSON.stringify(params.turnId)}`,
      );
    }
    this.#options.turns.abort(turn);
    return { turnId: turn.id };
  }

  async uiRespond(params: UiRespondParams): Promise<{ ok: true }> {
    const turn = this.#options.turns.checkUiRespond(
      params.turnId,
      params.requestId,
    );
    const session = this.#options.pool.session(turn.conversationId);
    if (session === undefined) {
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        "the agent for this turn is no longer available",
      );
    }
    session.respondUi(params.requestId, params.response as UiResponse);
    this.#options.turns.closeDialog(turn, params.requestId);
    return { ok: true };
  }

  // ── model, thinking, commands, status ──────────────────────────────────

  async modelList(params: {
    conversationId?: string;
  }): Promise<{ models: unknown[]; thinkingLevels?: string[] }> {
    const session = this.#requireWarm(params.conversationId);
    return { models: await session.listModels() };
  }

  async modelSet(
    params: ModelSetParams,
  ): Promise<{ model: { provider: string; id: string } }> {
    const record = await this.#resolveForModel(params.conversationId);
    await this.#requireWarm(params.conversationId).setModel(params.ref);
    await this.#options.store.update(record.id, { model: params.ref });
    return { model: params.ref };
  }

  async thinkingSet(params: ThinkingSetParams): Promise<{ level: string }> {
    const record = await this.#resolveForModel(params.conversationId);
    const session = this.#requireWarm(params.conversationId);
    if (session.setThinking === undefined) {
      throw unsupported(this.#options.pool.backend.id, ":think");
    }
    await session.setThinking(params.level);
    await this.#options.store.update(record.id, { thinking: params.level });
    return { level: params.level };
  }

  async commandsList(params: { conversationId?: string }): Promise<{
    commands: { name: string; kind: string; description?: string }[];
  }> {
    const session = this.#requireWarm(params.conversationId);
    if (session.listCommands === undefined) {
      throw unsupported(this.#options.pool.backend.id, ":skill");
    }
    return {
      commands: (await session.listCommands()).map((command) => ({
        name: command.name,
        kind: command.kind,
        ...(command.description === undefined
          ? {}
          : { description: command.description }),
      })),
    };
  }

  async statusGet(params: {
    conversationId?: string;
  }): Promise<StatusSnapshot> {
    // With no id, `:info` reports the most recent conversation, because that is
    // what a user asking "what is this?" means when they have not quoted an id.
    const record =
      params.conversationId === undefined || params.conversationId === ""
        ? (await this.#options.store.list().catch(() => []))[0]
        : await this.#options.store
            .get(params.conversationId)
            .catch(() => undefined);
    const pool = this.#options.pool.stats();
    const session =
      record === undefined ? undefined : this.#options.pool.session(record.id);
    const state =
      session === undefined
        ? undefined
        : await session.state().catch(() => undefined);
    return {
      version: this.#options.version,
      pid: process.pid,
      backend: this.#options.pool.backend.id,
      uptimeMs: (this.#options.now ?? Date.now)() - this.#options.startedAt,
      clients: this.#options.turns.count,
      turns: this.#options.turns.count,
      children: pool.children,
      ...(record === undefined ? {} : { conversation: summarize(record) }),
      ...(state?.model === undefined ? {} : { model: state.model }),
      ...(state?.thinking === undefined ? {} : { thinking: state.thinking }),
      ...(state?.usage === undefined ? {} : { usage: state.usage }),
      ...(state?.contextPct === undefined
        ? {}
        : { contextPct: state.contextPct }),
      state: this.#options.turns.count === 0 ? "idle" : "busy",
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  #requireWarm(conversationId: string | undefined): AgentSession {
    const id = conversationId ?? this.#options.turns.active[0]?.conversationId;
    if (id === undefined) {
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        "no conversation is in play",
        { hint: "Run a `:` first." },
      );
    }
    const session = this.#options.pool.session(id);
    if (session === undefined) {
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        "that conversation has no warm agent",
        { hint: "Run a `:` in that shell first." },
      );
    }
    return session;
  }

  async #require(conversationId: string): Promise<ConversationRecord> {
    const record = await this.#options.store.get(conversationId);
    if (record === undefined) {
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        `no conversation with id ${JSON.stringify(conversationId)}`,
      );
    }
    return record;
  }

  async #resolveForModel(
    conversationId: string | undefined,
  ): Promise<ConversationRecord> {
    if (conversationId !== undefined) {
      return this.#require(conversationId);
    }
    const active = this.#options.turns.active[0]?.conversationId;
    if (active === undefined) {
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        "no conversation is in play",
        { hint: "Run a `:` first." },
      );
    }
    return this.#require(active);
  }

  #persona(name: string | undefined): PersonaSpec | undefined {
    if (name === undefined || name === "") {
      return undefined;
    }
    const spec = personaSpec(this.#options.config, name);
    if (spec === undefined) {
      throw new PrefaixError(
        "USAGE",
        `unknown persona ${JSON.stringify(name)}`,
        {
          hint: `Known personas: ${Object.keys(this.#options.config.personas).join(", ")}`,
        },
      );
    }
    return spec;
  }

  /**
   * The conversation a turn belongs to. `:new` and an empty id both start a
   * fresh one; an existing id is honoured, so a second `:` in another shell
   * continues the same transcript.
   */
  async #resolveConversation(
    params: TurnStartParams,
  ): Promise<{ record: ConversationRecord; notices: AgentEvent[] }> {
    const wanted = params.conversationId;
    if (
      params.newConversation !== true &&
      wanted !== undefined &&
      wanted !== ""
    ) {
      return { record: await this.#require(wanted), notices: [] };
    }
    const root = await workspaceRoot(params.cwd, this.#options.gitRoot ?? {});
    const record = newRecord({
      backend: this.#options.pool.backend.id,
      root,
      prompt: params.text,
      shell: params.shell.kind,
    });
    await this.#options.store.save(record);
    return { record, notices: [] };
  }
}
