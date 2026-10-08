// The operations layer: every op in DESIGN §4.3.2, resolved against the store,
// the pool, and the turn manager. This is where a `:` becomes a turn, and where
// a conversation's identity, root, and native session are decided.
//
// The cwd policy lives here because it is a conversation-level decision, not an
// adapter one: the model is told the shell's cwd every turn either way, but
// which child runs, and whether a `cd` out of the root starts a new
// conversation, is prefaix's call (DESIGN §4.3.6).

import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { shellHintsFile } from "../core/paths.js";
import { PrefaixError, unsupported, messageOf } from "../core/errors.js";
import { newRecord, summarize, titleFrom } from "./store.js";
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
import { PLAN_EXECUTION_PROMPT } from "../core/protocol.js";
import type {
  CommandsListParams,
  ConvGetParams,
  ConvLastTextParams,
  ConvListParams,
  ConvNewParams,
  ConvRenameParams,
  ConversationSummary,
  ModelSetParams,
  ModelListParams,
  ShellVersionInfo,
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
    (async (bin, args, opts) => {
      const { execFile } = await import("node:child_process");
      return new Promise<string | undefined>((resolve) => {
        execFile(
          bin,
          [...args],
          { cwd: opts.cwd, timeout: GIT_TIMEOUT_MS },
          (error, stdout) => {
            resolve(error ? undefined : stdout.trim());
          },
        );
      });
    });
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
  ) => void | Promise<void>;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

export class Operations {
  readonly #options: OpsOptions;
  /** turn id -> the connection that owns it, so a close knows what to abort. */
  readonly #owned = new Map<string, Connection>();
  readonly #pending = new Set<Promise<unknown>>();
  #closing = false;

  constructor(options: OpsOptions) {
    this.#options = options;
  }

  /** Refuse new turns while shutdown waits for starts and outcome writes. */
  beginShutdown(): void {
    this.#closing = true;
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled([...this.#pending]);
    }
  }

  #track<T>(pending: Promise<T>): Promise<T> {
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      () => this.#pending.delete(pending),
    );
    return pending;
  }

  #checkOpen(): void {
    if (this.#closing) {
      throw new PrefaixError("DAEMON_UNAVAILABLE", "the daemon is stopping");
    }
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

  async convSelect(params: {
    conversationId: string;
    shell: ShellVersionInfo;
    previousConversationId?: string;
  }): Promise<ConversationSummary> {
    const record = await this.#require(params.conversationId);
    const paths = this.#options.store.paths;
    const file = shellHintsFile(paths, params.shell.shellId);
    const previous = await this.#shellHints(params.shell.shellId);
    const oldId = params.previousConversationId || previous.current;
    const hints = {
      pid: params.shell.pid,
      current: record.id,
      previous:
        oldId !== undefined && oldId !== record.id ? oldId : previous.previous,
      roots: { ...previous.roots, [record.root]: record.id },
    };
    await mkdir(paths.shellHintsDir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${String(process.pid)}.tmp`;
    await writeFile(temp, JSON.stringify(hints), { mode: 0o600 });
    await rename(temp, file);
    // Only our validated hint files are considered, and EPERM means alive.
    for (const name of await readdir(paths.shellHintsDir)) {
      if (!name.endsWith(".json") || name === `${params.shell.shellId}.json`)
        continue;
      try {
        const other = JSON.parse(
          await readFile(join(paths.shellHintsDir, name), "utf8"),
        ) as { pid?: number };
        if (typeof other.pid === "number" && other.pid > 0) {
          try {
            process.kill(other.pid, 0);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ESRCH")
              await unlink(join(paths.shellHintsDir, name));
          }
        }
      } catch {
        /* A stale or malformed hint must not block a switch. */
      }
    }
    return summarize(record);
  }

  async #shellHints(shellId: string): Promise<{
    current?: string;
    previous?: string;
    roots?: Record<string, string>;
  }> {
    const file = shellHintsFile(this.#options.store.paths, shellId);
    try {
      const raw: unknown = JSON.parse(await readFile(file, "utf8"));
      if (typeof raw !== "object" || raw === null) return {};
      const hints = raw as Record<string, unknown>;
      return {
        ...(typeof hints["current"] === "string"
          ? { current: hints["current"] }
          : {}),
        ...(typeof hints["previous"] === "string"
          ? { previous: hints["previous"] }
          : {}),
        ...(typeof hints["roots"] === "object" && hints["roots"] !== null
          ? {
              roots: Object.fromEntries(
                Object.entries(hints["roots"]).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === "string",
                ),
              ),
            }
          : {}),
      };
    } catch {
      return {};
    }
  }

  async convPrevious(params: {
    shellId: string;
    fallback?: string;
  }): Promise<ConversationSummary> {
    const hints = await this.#shellHints(params.shellId);
    const id = params.fallback || hints.previous;
    if (id === undefined)
      throw new PrefaixError(
        "USAGE",
        "there is no previous conversation in this shell",
      );
    return summarize(await this.#require(id));
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
    const oldestSeq = turn.ring.oldestSeq;
    const summary = turn.summary;
    for (const entry of turn.ring.since(from)) {
      this.#options.send(connection, {
        t: "evt",
        turnId: turn.id,
        seq: entry.seq,
        e: entry.event,
      });
      const pending = connection.waitWritable?.();
      if (pending !== undefined) await pending;
      if (connection.closed) break;
    }
    if (summary !== undefined && !connection.closed) {
      this.#options.send(connection, {
        t: "turn.end",
        turnId: turn.id,
        summary,
      });
    }
    // The oldest sequence still held, so a client that asked to replay from
    // further back can be told where the gap starts instead of being handed a
    // stream with a hole in it.
    return { turnId: turn.id, fromSeq: oldestSeq };
  }

  async convLastText(
    params: ConvLastTextParams,
  ): Promise<{ text: string | null }> {
    const session = this.#options.pool.session(params.conversationId);
    if (session === undefined) {
      return {
        text:
          (await this.#options.store.get(params.conversationId))
            ?.lastAssistantText ?? null,
      };
    }
    const text = await session.lastAssistantText();
    return {
      text:
        text ??
        (await this.#options.store.get(params.conversationId))
          ?.lastAssistantText ??
        null,
    };
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

  turnStart(
    params: TurnStartParams,
    connection: Connection,
  ): Promise<TurnStartResult> {
    return this.#track(this.#startTurn(params, connection));
  }

  async #startTurn(
    params: TurnStartParams,
    connection: Connection,
  ): Promise<TurnStartResult> {
    this.#checkOpen();
    if (params.text.startsWith("/"))
      this.#options.pool.require("slashCommands");
    // Validate explicit names before creating a conversation as a side effect.
    const requestedPersona = this.#persona(params.persona);
    if (
      params.executePlan === true &&
      (params.conversationId === undefined ||
        params.conversationId === "" ||
        params.newConversation === true ||
        params.persona != null)
    )
      throw new PrefaixError(
        "USAGE",
        ":go requires the active planning conversation",
        {
          hint: "Use :plan <task> first, then :go without arguments.",
        },
      );
    const resolved = await this.#resolveConversation(params);
    if (params.executePlan === true) {
      const root = await workspaceRoot(params.cwd, this.#options.gitRoot ?? {});
      if (root !== resolved.record.root)
        throw new PrefaixError(
          "USAGE",
          ":go cannot execute a plan in a different workspace",
          {
            hint: `Return to ${resolved.record.root}, or make a new plan here.`,
          },
        );
      params = { ...params, text: PLAN_EXECUTION_PROMPT, persona: null };
    }
    let record =
      params.executePlan === true
        ? resolved.record
        : await this.#applyCwdPolicy(resolved.record, params.cwd);
    let persona: PersonaSpec | undefined;
    const startupPatch: Partial<ConversationRecord> = {};
    if (
      params.executePlan !== true &&
      this.#options.config.workspace.cwdPolicy === "follow"
    ) {
      // This is the caller's routed workspace, even if it equaled the stale
      // snapshot. Another shell may move the record before we own the turn.
      startupPatch.root = record.root;
    }
    this.#checkOpen();
    const turn = this.#options.turns.start({
      conversationId: record.id,
      shellId: params.shell.shellId,
      promptText: params.text,
      ...(params.onDisconnect === undefined
        ? {}
        : { onDisconnect: params.onDisconnect }),
    });
    this.#owned.set(turn.id, connection);

    let agent: AgentSession;
    try {
      // Workspace routing can yield while another shell completes a turn.
      // Resolve retained persona/native state only after claiming ownership.
      const current = await this.#require(record.id);
      if (params.executePlan === true) {
        // Another shell could have consumed or replaced this plan while we
        // resolved its workspace; never trust the pre-ownership snapshot.
        if (current.persona !== "plan" || current.planReady !== true)
          throw new PrefaixError("USAGE", "no completed plan to execute", {
            hint: "Use :plan <task> and wait for a successful answer before :go.",
          });
        if (current.root !== record.root)
          throw new PrefaixError("USAGE", "the planning workspace changed", {
            hint: `Return to ${current.root}, or make a new plan here.`,
          });
      }
      record = current;
      persona =
        params.persona === null
          ? undefined
          : (requestedPersona ?? this.#persona(record.persona));
      if (record.title === "new conversation" && record.stats.turns === 0)
        startupPatch.title = titleFrom(params.text);
      // A failed backend acquisition must consume an executable plan before
      // any child can be opened. Already-invalid markers need no disk write.
      if (record.planReady === true) startupPatch.planReady = false;
      if (startupPatch.root === record.root) delete startupPatch.root;
      if (Object.keys(startupPatch).length > 0)
        record = await this.#options.store.update(record.id, startupPatch);
      this.#checkOpen();
      // A replacement resumes the latest native transcript, not the snapshot
      // from before this turn owned the conversation.
      const native =
        this.#options.pool.session(record.id)?.native ?? record.native;
      agent = await this.#options.pool.acquire({
        conversationId: record.id,
        root: record.root,
        env: params.env,
        title: record.title,
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(record.thinking === undefined ? {} : { thinking: record.thinking }),
        persona: persona ?? null,
        native,
      });
      this.#checkOpen();
      // A changed handle/persona must be durable before any prompt side
      // effect. Warm unchanged state is already durable; don't fsync it again.
      const updatedNative = { ...record.native, ...agent.native };
      if (
        updatedNative.sessionId !== record.native.sessionId ||
        updatedNative.sessionFile !== record.native.sessionFile ||
        persona?.name !== record.persona
      )
        record = await this.#options.store.update(record.id, {
          native: updatedNative,
          persona: persona?.name,
        });
      this.#checkOpen();
    } catch (cause) {
      this.#owned.delete(turn.id);
      this.#options.turns.finish(turn, {
        turnId: turn.id,
        status: "error",
        error: messageOf(cause),
      });
      throw cause;
    }

    // The turn is already registered, so a prompt failure is reported through
    // the same event stream and settle path as any other turn outcome rather
    // than as a lost response to `turn.start`.
    void this.#track(this.#pump(record, turn, agent, params, persona)).catch(
      (cause) =>
        this.#options.log?.("could not deliver the turn outcome", {
          turn: turn.id,
          cause: messageOf(cause),
        }),
    );
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
    // Persist only after claiming turn ownership, so a second shell cannot
    // change the root of a conversation whose first turn is still running.
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
        const pending = this.#owned
          .get(turn.id)
          ?.waitWritable?.(turn.controller.signal);
        if (pending !== undefined) await pending;
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

    // The record is written before the client is told the turn ended, so a
    // `:info` or `conversations show` immediately after a turn reads a
    // conversation that already includes it.
    try {
      await this.#recordOutcome(record.id, session, summary);
    } catch (cause) {
      summary = {
        turnId: turn.id,
        status: "error",
        error: `could not persist the turn outcome: ${messageOf(cause)}`,
      };
      this.publish(turn, {
        type: "notice",
        level: "error",
        text: summary.error as string,
        source: this.#options.pool.backend.id,
      });
    }
    // Publish background status before releasing the foreground. Otherwise a
    // late daemon write can overwrite the client's final model/context status.
    try {
      await this.#options.onEnd(turn, summary, {
        root: record.root,
        env: params.env,
      });
    } catch (cause) {
      summary = {
        turnId: turn.id,
        status: "error",
        error: `could not finalize the turn: ${messageOf(cause)}`,
      };
      this.#options.log?.("could not finalize the turn", {
        turn: turn.id,
        cause: messageOf(cause),
      });
    } finally {
      this.#options.turns.finish(turn, summary);
    }
    const owner = this.#owned.get(turn.id);
    this.#owned.delete(turn.id);
    if (owner !== undefined && !owner.closed) {
      this.#options.send(owner, { t: "turn.end", turnId: turn.id, summary });
    }
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
    const lastAssistantText = await session
      .lastAssistantText()
      .catch(() => null);
    const patch: Partial<ConversationRecord> = {
      planReady:
        record.persona === "plan" &&
        summary.status === "stop" &&
        lastAssistantText !== null &&
        lastAssistantText.trim() !== "",
      ...(lastAssistantText === null ? {} : { lastAssistantText }),
      ...(state?.usage === undefined ? {} : { usage: state.usage }),
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
      throw cause;
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

  async modelList(
    params: ModelListParams,
  ): Promise<{ models: unknown[]; thinkingLevels?: string[] }> {
    this.#options.pool.require("models");
    const session = await this.#modelSession(params);
    const thinkingLevels = this.#options.pool.backend.capabilities
      .thinkingLevels
      ? await session.listThinkingLevels?.()
      : undefined;
    return {
      models: await session.listModels(),
      ...(thinkingLevels === undefined ? {} : { thinkingLevels }),
    };
  }

  async modelSet(
    params: ModelSetParams,
  ): Promise<{ model: { provider: string; id: string } }> {
    const record = await this.#resolveForModel(params.conversationId);
    this.#options.pool.require("models");
    this.#assertIdle(record.id);
    await (await this.#modelSession(params)).setModel(params.ref);
    await this.#options.store.update(record.id, { model: params.ref });
    return { model: params.ref };
  }

  async thinkingList(params: ModelListParams): Promise<{ levels: string[] }> {
    this.#options.pool.require("thinkingLevels");
    const session = await this.#modelSession(params);
    if (session.listThinkingLevels === undefined)
      throw unsupported(this.#options.pool.backend.id, ":think");
    return { levels: await session.listThinkingLevels() };
  }

  async thinkingSet(params: ThinkingSetParams): Promise<{ level: string }> {
    const record = await this.#resolveForModel(params.conversationId);
    this.#assertIdle(record.id);
    this.#options.pool.require("thinkingLevels");
    const session = await this.#modelSession(params);
    if (session.setThinking === undefined) {
      throw unsupported(this.#options.pool.backend.id, ":think");
    }
    const levels = await session.listThinkingLevels?.();
    if (levels !== undefined && !levels.includes(params.level))
      throw new PrefaixError(
        "USAGE",
        `unknown thinking level ${JSON.stringify(params.level)}; choose ${levels.join(", ")}`,
      );
    await session.setThinking(params.level);
    await this.#options.store.update(record.id, { thinking: params.level });
    return { level: params.level };
  }

  async commandsList(params: CommandsListParams): Promise<{
    commands: { name: string; kind: string; description?: string }[];
  }> {
    this.#options.pool.require("slashCommands");
    const temporary =
      (params.conversationId === undefined || params.conversationId === "") &&
      params.env !== undefined &&
      params.cwd !== undefined;
    const session = temporary
      ? await this.#options.pool.backend.open({
          root: await workspaceRoot(params.cwd!, this.#options.gitRoot ?? {}),
          env: params.env!,
        })
      : params.env === undefined
        ? this.#requireWarm(params.conversationId)
        : await this.#modelSession(params);
    try {
      if (session.listCommands === undefined)
        throw unsupported(this.#options.pool.backend.id, ":skill");
      return {
        commands: (await session.listCommands()).map((command) => ({
          name: command.name,
          kind: command.kind,
          ...(command.description === undefined
            ? {}
            : { description: command.description }),
        })),
      };
    } finally {
      if (temporary) await session.close();
    }
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
    const usage = state?.usage ?? record?.usage;
    const model = state?.model ?? record?.model;
    const thinking = state?.thinking ?? record?.thinking;
    const contextPct =
      state?.contextPct === undefined
        ? record?.stats.lastContextPct
        : state.contextPct;
    return {
      version: this.#options.version,
      pid: process.pid,
      backend: this.#options.pool.backend.id,
      uptimeMs: (this.#options.now ?? Date.now)() - this.#options.startedAt,
      clients: this.#options.turns.count,
      turns: this.#options.turns.count,
      children: pool.children,
      ...(record === undefined ? {} : { conversation: summarize(record) }),
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(usage === undefined ? {} : { usage }),
      ...(contextPct === undefined ? {} : { contextPct }),
      state: this.#options.turns.count === 0 ? "idle" : "busy",
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  #assertIdle(conversationId: string): void {
    if (this.#options.turns.runningFor(conversationId) !== undefined)
      throw new PrefaixError(
        "CONVERSATION_BUSY",
        "wait for this conversation's turn to finish before changing models",
      );
  }

  async #modelSession(params: ModelListParams): Promise<AgentSession> {
    const record = await this.#resolveForModel(params.conversationId);
    const warm = this.#options.pool.session(record.id);
    if (warm !== undefined) return warm;
    if (params.env === undefined) return this.#requireWarm(record.id);
    const session = await this.#options.pool.acquire({
      conversationId: record.id,
      root: record.root,
      env: params.env,
      title: record.title,
      native: record.native,
      ...(record.model === undefined ? {} : { model: record.model }),
      ...(record.thinking === undefined ? {} : { thinking: record.thinking }),
    });
    await this.#options.store.update(record.id, { native: session.native });
    return session;
  }

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
    if (conversationId !== undefined && conversationId !== "") {
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

  #persona(name: string | null | undefined): PersonaSpec | undefined {
    if (name == null || name === "") {
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
