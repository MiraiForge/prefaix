// A minimal client for the daemon's socket, used by the daemon's own tests.
// It speaks the wire protocol from DESIGN §4.3.2 and nothing else, so a bug in
// the daemon's framing cannot be masked by a shared helper.

import { connect, type Socket } from "node:net";
import {
  PROTOCOL_VERSION,
  parseDaemonRecord,
  splitRecords,
  type DaemonMessage,
  type OperationName,
  type TurnSummary,
} from "../../src/core/protocol.js";
import type { AgentEvent } from "../../src/core/agent-port.js";

/** One event as the wire carries it, with the sequence that orders it. */
export interface TurnEvent {
  readonly seq: number;
  readonly event: AgentEvent;
}

export interface CallResult {
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; hint?: string } | undefined;
}

export class TestClient {
  #socket: Socket | undefined;
  #buffer = "";
  #next = 0;
  readonly #pending = new Map<string, (result: CallResult) => void>();
  readonly #events: DaemonMessage[] = [];
  readonly #waiters: ((message: DaemonMessage) => void)[] = [];
  hello: { v: number; version: string; pid: number } | undefined;
  closed = false;
  #onEvent: ((turnId: string, event: TurnEvent) => void) | undefined;
  #onEnd: ((turnId: string, summary: TurnSummary) => void) | undefined;

  static async open(
    socketPath: string,
    options: {
      version?: string;
      pid?: number;
      v?: number;
      /** Skips the handshake, so a test can check what happens without it. */
      sendHello?: boolean;
    } = {},
  ): Promise<TestClient> {
    const client = new TestClient();
    await client.#connect(socketPath, options);
    return client;
  }

  async #connect(
    socketPath: string,
    options: {
      version?: string;
      pid?: number;
      v?: number;
      /** Skips the handshake, so a test can check what happens without it. */
      sendHello?: boolean;
    },
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = connect(socketPath);
      socket.setEncoding("utf8");
      socket.once("error", reject);
      socket.once("connect", () => {
        socket.removeListener("error", reject);
        resolve();
      });
      this.#socket = socket;
      socket.on("data", (chunk: string) => this.#onData(chunk));
      socket.on("close", () => {
        this.closed = true;
      });
    });
    if (options.sendHello !== false) {
      this.write({
        t: "hello",
        v: options.v ?? PROTOCOL_VERSION,
        version: options.version ?? "0.0.0-test",
        pid: options.pid ?? process.pid,
      });
    }
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    const { lines, rest } = splitRecords(this.#buffer);
    this.#buffer = rest;
    for (const line of lines) {
      const message = parseDaemonRecord(line);
      if (message === undefined) {
        continue;
      }
      if (message.t === "hello") {
        this.hello = message;
      }
      if (message.t === "res") {
        this.#pending.get(message.id)?.({
          ok: message.ok,
          data: message.ok ? message.data : undefined,
          error: message.ok ? undefined : message.error,
        });
        this.#pending.delete(message.id);
      }
      // Every message is recorded, including the handshake and responses, so a
      // test can assert on the order of the whole conversation.
      this.#events.push(message);
      if (message.t === "evt") {
        this.#onEvent?.(message.turnId, { seq: message.seq, event: message.e });
      } else if (message.t === "turn.end") {
        this.#onEnd?.(message.turnId, message.summary);
      }
      for (const waiter of [...this.#waiters]) {
        waiter(message);
      }
    }
  }

  write(
    message:
      | DaemonMessage
      | { t: "hello"; v: number; version: string; pid: number }
      | { t: "req"; id: string; op: OperationName; params: unknown },
  ): void {
    this.#socket?.write(`${JSON.stringify(message)}\n`);
  }

  /** Writes a line with no framing guarantees, for the parser's own tests. */
  writeRaw(line: string): void {
    this.#socket?.write(line);
  }

  /** Called for every event as it arrives, alongside the recorded list. */
  onEvent(listener: (turnId: string, event: TurnEvent) => void): void {
    this.#onEvent = listener;
  }

  onTurnEnd(listener: (turnId: string, summary: TurnSummary) => void): void {
    this.#onEnd = listener;
  }

  call(op: OperationName, params: unknown): Promise<CallResult> {
    const id = `r${String(++this.#next)}`;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.write({ t: "req", id, op, params });
    });
  }

  /** Events received so far, in order. */
  events(): readonly DaemonMessage[] {
    return this.#events;
  }

  eventsOfType<T extends DaemonMessage["t"]>(
    type: T,
  ): Extract<DaemonMessage, { t: T }>[] {
    return this.#events.filter(
      (message): message is Extract<DaemonMessage, { t: T }> =>
        message.t === type,
    );
  }

  clearEvents(): void {
    this.#events.length = 0;
  }

  /** Resolves on the first message matching `predicate`, past or future. */
  waitFor(
    predicate: (message: DaemonMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<DaemonMessage> {
    const existing = this.#events.find(predicate);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        reject(
          new Error(
            `timed out waiting for a message. saw: ${this.#events
              .map((message) => message.t)
              .join(", ")}`,
          ),
        );
      }, timeoutMs);
      const waiter = (message: DaemonMessage): void => {
        if (!predicate(message)) {
          return;
        }
        clearTimeout(timer);
        this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
        resolve(message);
      };
      this.#waiters.push(waiter);
    });
  }

  waitForTurnEnd(
    timeoutMs = 5_000,
  ): Promise<Extract<DaemonMessage, { t: "turn.end" }>> {
    return this.waitFor(
      (message): message is Extract<DaemonMessage, { t: "turn.end" }> =>
        message.t === "turn.end",
      timeoutMs,
    ) as Promise<Extract<DaemonMessage, { t: "turn.end" }>>;
  }

  close(): void {
    this.#socket?.destroy();
    this.closed = true;
  }
}
