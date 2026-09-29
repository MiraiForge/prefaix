// The client's side of the daemon socket: connect, autospawn, and the request /
// event plumbing (DESIGN §4.3.1).
//
// The client is short-lived, so this file is the hot path. It imports only
// `core/`, which is why the daemon and the adapters stay out of a `prefaix run`
// cold start (DESIGN §4.2, §9).

import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { PrefaixError } from "../core/errors.js";
import {
  PROTOCOL_VERSION,
  parseDaemonRecord,
  splitRecords,
  type DaemonMessage,
  type OperationName,
  type TurnSummary,
} from "../core/protocol.js";
import type { AgentEvent, UiResponse } from "../core/agent-port.js";
import type { PrefaixPaths } from "../core/paths.js";

/** How long autospawn waits for the new daemon to answer, in total. */
export const AUTOSPAWN_BUDGET_MS = 3_000;
const FIRST_RETRY_MS = 25;
const HELLO_TIMEOUT_MS = 2_000;
const MAX_RETRY_MS = 200;

export interface TurnEvent {
  readonly seq: number;
  readonly event: AgentEvent;
}

export interface ClientOptions {
  readonly paths: PrefaixPaths;
  readonly version: string;
  readonly pid?: number;
  /** The bundle to run when autospawning. */
  readonly entry?: string;
  /**
   * Whether to start a daemon when nothing is listening. A command that is
   * *about* the daemon — `stop`, `status` — must say "nothing is running"
   * rather than start one so it can stop it.
   */
  readonly autospawn?: boolean;
  /** Injected so a test can decide whether a spawn works. */
  readonly spawnDaemon?: (entry: string, paths: PrefaixPaths) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function errnoOf(cause: unknown): string | undefined {
  return (cause as NodeJS.ErrnoException | undefined)?.code;
}

/** True for the two errors that mean "no daemon is listening right now". */
export function isConnectRefused(cause: unknown): boolean {
  const code = errnoOf(cause);
  return code === "ENOENT" || code === "ECONNREFUSED";
}

export function defaultSpawnDaemon(entry: string, paths: PrefaixPaths): void {
  // Detached with its own session, stdio to the log, and unref'd, so the client
  // can exit while the daemon keeps running (DESIGN §4.3.1).
  const log = spawn(entry, ["daemon"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: { ...process.env, PREFAIX_SOCKET: paths.socket },
  });
  log.on("error", () => undefined);
  log.unref();
}

/**
 * A connection to the daemon. Requests are correlated by id; events for a turn
 * are pushed to a listener the caller installs with `onEvent`.
 */
export class DaemonClient {
  readonly #options: ClientOptions;
  #socket: Socket | undefined;
  #buffer = "";
  #next = 0;
  #closed = false;
  readonly #pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (error: unknown) => void }
  >();
  readonly #eventListeners = new Set<
    (turnId: string, message: TurnEvent) => void
  >();
  readonly #endListeners = new Set<
    (turnId: string, summary: TurnSummary) => void
  >();
  #onEvent: ((turnId: string, event: TurnEvent) => void) | undefined;
  #onEnd: ((turnId: string, summary: TurnSummary) => void) | undefined;
  #awaitingHello:
    | {
        resolve: (hello: { version: string; pid: number }) => void;
        reject: (error: unknown) => void;
      }
    | undefined;

  constructor(options: ClientOptions) {
    this.#options = options;
  }

  onEvent(listener: (turnId: string, event: TurnEvent) => void): void {
    this.#onEvent = listener;
  }

  onTurnEnd(listener: (turnId: string, summary: TurnSummary) => void): void {
    this.#onEnd = listener;
  }

  /**
   * Connects, autospawning the daemon when nothing is listening. The backoff is
   * short and bounded: the daemon is already running by the time the second
   * attempt lands, and a user staring at an unchanged prompt needs the failure
   * fast.
   */
  async connect(): Promise<{ version: string; pid: number }> {
    try {
      return await this.#open();
    } catch (cause) {
      if (!isConnectRefused(cause) || this.#options.autospawn === false) {
        throw cause;
      }
      this.#options.log?.("no daemon listening; spawning one");
    }
    const entry = this.#options.entry ?? process.argv[1] ?? "";
    (this.#options.spawnDaemon ?? defaultSpawnDaemon)(
      entry,
      this.#options.paths,
    );
    const hello = await this.#poll();
    return hello;
  }

  async #poll(): Promise<{ version: string; pid: number }> {
    const sleep = this.#options.sleep ?? delay;
    const now = this.#options.now ?? Date.now;
    const deadline = now() + AUTOSPAWN_BUDGET_MS;
    let wait = FIRST_RETRY_MS;
    let last: unknown;
    while (now() < deadline) {
      await sleep(wait);
      wait = Math.min(wait * 2, MAX_RETRY_MS);
      try {
        return await this.#open();
      } catch (cause) {
        if (!isConnectRefused(cause)) {
          throw cause;
        }
        last = cause;
      }
    }
    throw new PrefaixError(
      "DAEMON_UNAVAILABLE",
      `the prefaix daemon did not come up within ${String(AUTOSPAWN_BUDGET_MS)}ms`,
      { hint: "prefaix daemon --foreground shows its log", cause: last },
    );
  }

  async #open(): Promise<{ version: string; pid: number }> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const pending = connect(this.#options.paths.socket);
      pending.once("connect", () => resolve(pending));
      pending.once("error", reject);
    });
    socket.setEncoding("utf8");
    this.#socket = socket;
    this.#closed = false;

    // The handshake is awaited as a message rather than as a request response,
    // because the daemon answers a version mismatch with a bare refusal and
    // then hangs up: there is no id to correlate against.
    let settle: (hello: { version: string; pid: number }) => void = () =>
      undefined;
    let fail: (error: unknown) => void = () => undefined;
    const hello = new Promise<{ version: string; pid: number }>(
      (resolve, reject) => {
        settle = resolve;
        fail = reject;
      },
    );
    this.#awaitingHello = {
      resolve: settle,
      reject: fail,
    };
    // Deliberately not unref'd: a client waiting for the handshake is doing
    // real work, and giving up early because the event loop was idle is exactly
    // the silent hang this timeout exists to prevent.
    const timer = setTimeout(() => {
      fail(
        new PrefaixError(
          "DAEMON_UNAVAILABLE",
          "the prefaix daemon accepted the connection but never said hello",
        ),
      );
    }, HELLO_TIMEOUT_MS);

    socket.on("data", (chunk: string) => this.#read(chunk));
    socket.on("close", () => this.#handleClose());
    socket.on("error", () => this.#handleClose());
    socket.write(
      `${JSON.stringify({
        t: "hello",
        v: PROTOCOL_VERSION,
        version: this.#options.version,
        pid: this.#options.pid ?? process.pid,
      })}\n`,
    );
    try {
      return await hello;
    } finally {
      clearTimeout(timer);
      this.#awaitingHello = undefined;
    }
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    const { lines, rest } = splitRecords(this.#buffer);
    this.#buffer = rest;
    for (const line of lines) {
      const message = parseDaemonRecord(line);
      if (message === undefined) {
        // A line this build does not understand is skipped, not fatal: a newer
        // daemon may send something extra, and dropping it keeps the turn
        // running.
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message: DaemonMessage): void {
    if (message.t === "hello") {
      this.#awaitingHello?.resolve({
        version: message.version,
        pid: message.pid,
      });
      return;
    }
    if (message.t === "res") {
      if (!message.ok && this.#awaitingHello !== undefined) {
        // A refusal during the handshake is fatal, and it is answered before
        // the socket closes, so it is read here rather than lost.
        this.#awaitingHello.reject(PrefaixError.fromInfo(message.error));
        return;
      }
      const pending = this.#pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.#pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.data);
      } else {
        pending.reject(PrefaixError.fromInfo(message.error));
      }
      return;
    }
    if (message.t === "evt") {
      const event: TurnEvent = { seq: message.seq, event: message.e };
      this.#onEvent?.(message.turnId, event);
      for (const listener of this.#eventListeners) {
        listener(message.turnId, event);
      }
      return;
    }
    if (message.t === "turn.end") {
      this.#onEnd?.(message.turnId, message.summary);
      for (const listener of this.#endListeners) {
        listener(message.turnId, message.summary);
      }
    }
  }

  #handleClose(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    const error = new PrefaixError(
      "DAEMON_UNAVAILABLE",
      "the prefaix daemon closed the connection",
      { hint: "The next `:` starts a new daemon." },
    );
    this.#awaitingHello?.reject(error);
    for (const [, pending] of this.#pending) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
  call<T = unknown>(op: OperationName, params: unknown = {}): Promise<T> {
    if (this.#socket === undefined || this.#closed) {
      return Promise.reject(
        new PrefaixError("DAEMON_UNAVAILABLE", "not connected to a daemon"),
      );
    }
    const id = `r${String(++this.#next)}`;
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
      });
      this.#socket?.write(`${JSON.stringify({ t: "req", id, op, params })}\n`);
    });
    // A request can be rejected by a socket close before the caller has had a
    // chance to attach a handler, and an unhandled rejection takes the process
    // down. Attaching a no-op handler here makes the rejection late-binding
    // again, without changing what the caller's own handler sees.
    promise.catch(() => undefined);
    return promise;
  }

  respondUi(
    turnId: string,
    requestId: string,
    response: UiResponse,
  ): Promise<unknown> {
    return this.call("ui.respond", { turnId, requestId, response });
  }

  close(): void {
    this.#socket?.end();
    this.#socket?.destroy();
    this.#socket = undefined;
    this.#handleClose();
  }
}
