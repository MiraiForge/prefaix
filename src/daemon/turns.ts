// The turn manager (DESIGN §4.3.3). One running turn per conversation, an
// event ring with a monotonic per-turn `seq` so a client can tell a gap from a
// duplicate, and a disconnect policy that defaults to aborting.
//
// The ring is what makes `:attach` possible in M4 and what makes a client that
// reconnects mid-turn able to catch up, so it is bounded by bytes rather than
// by count: one turn of a thousand tool updates is not the same cost as one
// turn of a hundred.

import { PrefaixError } from "../core/errors.js";
import { newTurnId } from "../core/ids.js";
import type { AgentEvent } from "../core/agent-port.js";
import type { TurnSummary } from "../core/protocol.js";

export const DEFAULT_RING_BYTES = 4 * 1024 * 1024;

export interface RingEntry {
  readonly seq: number;
  readonly event: AgentEvent;
}

/**
 * A bounded event log for one turn. The oldest entries are dropped first, and
 * `from` reports the lowest sequence still held, so a client asking to replay
 * from a sequence it no longer has can be told where to start instead of being
 * given a stream with a hole in it.
 */
export class EventRing {
  readonly limitBytes: number;
  #entries: RingEntry[] = [];
  #bytes = 0;
  #next = 1;
  /**
   * The settle is what a replay ends on, so it is never evicted: a client
   * attaching to a long turn must be able to see how it finished even after the
   * body of the turn has rolled out of the ring.
   */
  #pinned: RingEntry | undefined;

  constructor(limitBytes: number = DEFAULT_RING_BYTES) {
    this.limitBytes = limitBytes;
  }

  get size(): number {
    return this.#entries.length;
  }

  get nextSeq(): number {
    return this.#next;
  }

  /** The lowest sequence still held, or the next one when the ring is empty. */
  get oldestSeq(): number {
    return this.#entries[0]?.seq ?? this.#next;
  }

  push(event: AgentEvent): RingEntry {
    const entry: RingEntry = { seq: this.#next++, event };
    this.#entries.push(entry);
    this.#bytes += JSON.stringify(event).length;
    if (event.type === "settled") {
      this.#pinned = entry;
    }
    while (this.#bytes > this.limitBytes && this.#entries.length > 1) {
      // The oldest entry that is not the settle, so the tail of the turn is
      // what rolls out first.
      const at = this.#entries.findIndex(
        (candidate) => candidate !== this.#pinned,
      );
      if (at === -1) {
        break;
      }
      const [dropped] = this.#entries.splice(at, 1);
      if (dropped !== undefined) {
        this.#bytes -= JSON.stringify(dropped.event).length;
      }
    }
    return entry;
  }

  /** Everything from `fromSeq` onward, inclusive. */
  since(fromSeq: number): RingEntry[] {
    return this.#entries.filter((entry) => entry.seq >= fromSeq);
  }

  /** The event the turn ended on, which the ring never drops. */
  settled(): RingEntry | undefined {
    return this.#pinned;
  }

  get settledSeq(): number | undefined {
    return this.#pinned?.seq;
  }
}

export type TurnOwner = "attached" | "detached";

export interface TurnHandle {
  readonly id: string;
  readonly conversationId: string;
  readonly shellId: string;
  readonly ring: EventRing;
  readonly controller: AbortController;
  owner: TurnOwner;
  startedAt: number;
  finished: boolean;
  buffer: string;
  summary: TurnSummary | undefined;
  onDisconnect: "abort" | "continue";
  /** Dialog ids the turn has asked about and not yet had answered. */
  readonly dialogs: Set<string>;
  /** Dialog ids the client has answered, so a repeat is not forwarded twice. */
  readonly answered: Set<string>;
  /** The prompt as typed, which `:info` and the record's title are built from. */
  readonly promptText: string;
}

export interface TurnManagerOptions {
  readonly ringBytes?: number;
  readonly now?: () => number;
  readonly onFinish?: (turn: TurnHandle) => void | Promise<void>;
  readonly onBuffer?: (turn: TurnHandle, text: string) => void;
}

export interface StartTurnOptions {
  readonly conversationId: string;
  readonly shellId: string;
  readonly promptText?: string;
  readonly onDisconnect?: "abort" | "continue";
}

export class TurnManager {
  readonly #turns = new Map<string, TurnHandle>();
  /** conversationId -> the turn running on it, which is how busy is decided. */
  readonly #byConversation = new Map<string, TurnHandle>();
  /**
   * The last finished turn per conversation, with its ring. This is what
   * `turn.attach` replays and what `debug tap` reads, and it is why the ring is
   * bounded but not discarded.
   */
  readonly #lastByConversation = new Map<string, TurnHandle>();
  readonly #ringBytes: number;
  readonly #now: () => number;
  readonly #onFinish: ((turn: TurnHandle) => void | Promise<void>) | undefined;
  readonly #onBuffer: ((turn: TurnHandle, text: string) => void) | undefined;

  constructor(options: TurnManagerOptions = {}) {
    this.#ringBytes = options.ringBytes ?? DEFAULT_RING_BYTES;
    this.#now = options.now ?? Date.now;
    this.#onFinish = options.onFinish;
    this.#onBuffer = options.onBuffer;
  }

  get active(): readonly TurnHandle[] {
    return [...this.#turns.values()];
  }

  get count(): number {
    return this.#turns.size;
  }

  runningFor(conversationId: string): TurnHandle | undefined {
    return this.#byConversation.get(conversationId);
  }

  get(turnId: string): TurnHandle | undefined {
    return this.#turns.get(turnId);
  }

  /**
   * Starts a turn, or refuses when the conversation is already busy. The refusal
   * is explicit because the other way to reach the same state is two shells
   * silently interleaving their output into one stream.
   */
  start(options: StartTurnOptions): TurnHandle {
    const busy = this.#byConversation.get(options.conversationId);
    if (busy !== undefined && !busy.finished) {
      throw new PrefaixError(
        "CONVERSATION_BUSY",
        "this conversation already has a turn running",
        {
          hint:
            busy.owner === "detached"
              ? ":attach to watch it, or :abort to stop it"
              : "another shell is using this conversation",
        },
      );
    }
    const turn: TurnHandle = {
      id: newTurnId(),
      conversationId: options.conversationId,
      shellId: options.shellId,
      ring: new EventRing(this.#ringBytes),
      controller: new AbortController(),
      owner: "attached",
      startedAt: this.#now(),
      finished: false,
      buffer: "",
      summary: undefined,
      onDisconnect: options.onDisconnect ?? "abort",
      dialogs: new Set(),
      answered: new Set(),
      promptText: options.promptText ?? "",
    };
    this.#turns.set(turn.id, turn);
    this.#byConversation.set(turn.conversationId, turn);
    return turn;
  }

  /** Publishes an event onto the turn's ring and returns its sequence. */
  publish(turn: TurnHandle, event: AgentEvent): number {
    return turn.ring.push(event).seq;
  }

  /** Text the client should put back in the prompt buffer, if any. */
  addBuffer(turn: TurnHandle, text: string): void {
    if (text === "") {
      return;
    }
    turn.buffer = turn.buffer === "" ? text : `${turn.buffer} ${text}`;
    this.#onBuffer?.(turn, text);
  }

  /**
   * Ends a turn. The handle and its ring stay reachable through the caller's own
   * reference, but the turn leaves the active set, so `count` and the busy check
   * mean "running now" and nothing else.
   */
  finish(turn: TurnHandle, summary: TurnSummary): void {
    if (turn.finished) {
      return;
    }
    turn.finished = true;
    turn.summary = summary;
    this.#turns.delete(turn.id);
    if (this.#byConversation.get(turn.conversationId) === turn) {
      this.#byConversation.delete(turn.conversationId);
    }
    this.#lastByConversation.set(turn.conversationId, turn);
    void this.#onFinish?.(turn);
  }

  /** The most recent turn of a conversation, running or finished. */
  lastFor(conversationId: string): TurnHandle | undefined {
    return (
      this.#byConversation.get(conversationId) ??
      this.#lastByConversation.get(conversationId)
    );
  }

  /** Keeps the last finished turn's ring from growing without bound. */
  gcLast(keep: number): void {
    if (this.#lastByConversation.size <= keep) {
      return;
    }
    const ordered = [...this.#lastByConversation.entries()].sort(
      (a, b) => a[1].startedAt - b[1].startedAt,
    );
    for (const [id] of ordered.slice(0, this.#lastByConversation.size - keep)) {
      this.#lastByConversation.delete(id);
    }
  }

  /**
   * A client socket closed. `detach` leaves the turn running for `:attach`;
   * anything else applies the turn's disconnect policy, which is abort because
   * that is what closing a pi TUI does and the least surprising thing to do
   * with a half-streamed answer.
   */
  release(turn: TurnHandle, how: "detach" | "close"): boolean {
    if (turn.finished) {
      this.#turns.delete(turn.id);
      return false;
    }
    if (how === "detach") {
      turn.owner = "detached";
      return false;
    }
    this.#turns.delete(turn.id);
    if (turn.onDisconnect === "continue") {
      turn.owner = "detached";
      return false;
    }
    turn.controller.abort();
    return true;
  }

  abort(turn: TurnHandle): void {
    turn.controller.abort();
  }

  /**
   * Checks that a dialog answer belongs to a live turn. The answer itself goes
   * straight to the adapter, so an answer that arrives after the turn ended is
   * refused rather than sent into a child that has moved on.
   */
  checkUiRespond(turnId: string, requestId: string): TurnHandle {
    const turn = this.#turns.get(turnId);
    if (turn === undefined) {
      // A finished turn leaves the active set, so this is the answer a late
      // dialog reply gets, and it says so in the terms the user will recognize.
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        `turn ${JSON.stringify(turnId)} is no longer running`,
        { hint: "Its dialog has already closed; ask the agent again." },
      );
    }
    if (!turn.dialogs.has(requestId)) {
      throw new PrefaixError(
        "USAGE",
        `this turn never asked for dialog ${JSON.stringify(requestId)}`,
      );
    }
    turn.answered.add(requestId);
    return turn;
  }

  /** Records that a dialog is open, so a stray answer is refused. */
  openDialog(turn: TurnHandle, requestId: string): void {
    turn.dialogs.add(requestId);
  }

  closeDialog(turn: TurnHandle, requestId: string): void {
    turn.dialogs.delete(requestId);
  }

  /** Drops a turn from the active map; the record itself lives in the ring. */
  forget(turnId: string): boolean {
    const turn = this.#turns.get(turnId);
    if (turn === undefined) {
      return false;
    }
    this.#turns.delete(turnId);
    if (this.#byConversation.get(turn.conversationId) === turn) {
      this.#byConversation.delete(turn.conversationId);
    }
    return true;
  }
}
