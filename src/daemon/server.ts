// The daemon's socket server and request router (DESIGN §4.3.1, §4.3.2).
//
// The server is a thin line-protocol shell: it accepts connections, reads
// newline-delimited JSON, and hands every message to the router. The router
// owns the semantics. Keeping them apart is what lets the whole turn flow be
// unit-tested against a fake socket with no process and no filesystem.

import { connect, createServer, type Server, type Socket } from "node:net";
import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { PrefaixError, toErrorInfo, messageOf } from "../core/errors.js";
import {
  PROTOCOL_VERSION,
  encodeRecord,
  parseClientRecord,
  splitRecords,
  type ClientMessage,
  type DaemonMessage,
  type OperationName,
} from "../core/protocol.js";
import type { PrefaixPaths } from "../core/paths.js";

export interface Connection {
  readonly id: string;
  /** The client's pid, filled in by the hello handshake. */
  pid: number;
  send(message: DaemonMessage): void;
  /** Release on drain, disconnect, or abort; in-memory connections need no wait. */
  waitWritable?(signal?: AbortSignal): Promise<void> | void;
  close(): void;
  readonly closed: boolean;
}

/** The connection object, with the mutable bits the socket itself sets. */
interface MutableConnection {
  readonly id: string;
  pid: number;
  closed: boolean;
  send(message: DaemonMessage): void;
  waitWritable(signal?: AbortSignal): Promise<void> | void;
  close(): void;
  onMessage(line: string): void;
}

export interface ServerHandlers {
  onMessage(connection: Connection, message: ClientMessage): void;
  onClose(connection: Connection): void;
  onError?(problem: string): void;
}

export interface SocketServerOptions {
  readonly paths: PrefaixPaths;
  readonly handlers: ServerHandlers;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Skips the group/world-writable runtime dir check, for tests. */
  readonly checkOwner?: boolean;
}

const SOCKET_MODE = 0o600;
const DIR_MODE = 0o700;

export class SocketServer {
  readonly #paths: PrefaixPaths;
  readonly #handlers: ServerHandlers;
  readonly #log:
    ((message: string, fields?: Record<string, unknown>) => void) | undefined;
  readonly #server: Server;
  readonly #connections = new Set<Connection>();
  #nextId = 0;
  #closing = false;
  readonly #checkOwner: boolean;

  constructor(options: SocketServerOptions) {
    this.#paths = options.paths;
    this.#handlers = options.handlers;
    this.#log = options.log;
    this.#server = createServer((socket) => {
      this.#accept(socket);
    });
    this.#checkOwner = options.checkOwner ?? true;
  }

  #report(error: unknown): void {
    this.#handlers.onError?.(`daemon socket error: ${messageOf(error)}`);
  }

  get connections(): number {
    return this.#connections.size;
  }

  get address(): string {
    return this.#paths.socket;
  }

  async listen(): Promise<void> {
    await mkdir(this.#paths.runtimeDir, { recursive: true, mode: DIR_MODE });
    await this.#assertRuntimeDir();
    // A socket left behind by a daemon that was killed is not a live daemon;
    // leaving it in place would make every autospawn fail with ECONNREFUSED
    // forever (DESIGN §8).
    await this.#removeStaleSocket();
    await new Promise<void>((resolve, reject) => {
      // A bind that fails is reported as well as rejected: the daemon is going
      // to exit, and the reason belongs in its log as well as in the message
      // the client gets back.
      const onError = (error: Error): void => {
        this.#report(error);
        reject(error);
      };
      this.#server.once("error", onError);
      this.#server.listen(this.#paths.socket, () => {
        this.#server.removeListener("error", onError);
        // Past this point an error is not about the bind, so it goes to the
        // handler rather than to a promise that has already settled.
        this.#server.on("error", (error) => {
          this.#report(error);
        });
        resolve();
      });
    });
    await chmod(this.#paths.socket, SOCKET_MODE);
  }

  /**
   * The runtime dir may be the shared `/tmp/prefaix-$UID` fallback, where a
   * world-writable directory would let another user swap the socket out from
   * under us. Refusing to start is the only safe answer (DESIGN §10).
   */
  async #assertRuntimeDir(): Promise<void> {
    if (!this.#checkOwner) {
      return;
    }
    let info;
    try {
      info = await stat(this.#paths.runtimeDir);
    } catch {
      return;
    }
    if ((info.mode & 0o022) !== 0) {
      throw new PrefaixError(
        "DAEMON_UNAVAILABLE",
        `the prefaix runtime directory is group- or world-writable: ${this.#paths.runtimeDir}`,
        {
          hint: `chmod 700 ${this.#paths.runtimeDir}`,
        },
      );
    }
  }

  async #removeStaleSocket(): Promise<void> {
    try {
      await stat(this.#paths.socket);
    } catch {
      return;
    }
    // A live daemon is the one that would answer a connect attempt. Binding
    // over the path cannot tell the two cases apart, because a dead daemon's
    // socket file is still on disk and refuses the bind exactly like a live
    // one, so the probe is a connect.
    const alive = await new Promise<boolean>((resolve) => {
      const probe = connect(this.#paths.socket);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => {
        resolve(false);
      });
    });
    if (alive) {
      throw new PrefaixError(
        "DAEMON_UNAVAILABLE",
        "another prefaix daemon is already listening on this socket",
        { hint: "Run `prefaix daemon status`, or stop it first." },
      );
    }
    await unlink(this.#paths.socket).catch(() => undefined);
  }

  #accept(socket: Socket): void {
    socket.setEncoding("utf8");
    let buffer = "";
    const blockedWriters = new Set<() => void>();
    const releaseWriters = (): void => {
      for (const release of blockedWriters) release();
    };
    const connection: MutableConnection = {
      id: `c${String(++this.#nextId)}`,
      pid: 0,
      closed: false,
      send: (message) => {
        if (!connection.closed && !socket.writableEnded && !socket.destroyed) {
          socket.write(encodeRecord(message));
        }
      },
      waitWritable: (signal) => {
        if (connection.closed || !socket.writableNeedDrain || signal?.aborted)
          return;
        return new Promise<void>((resolve) => {
          const done = () => {
            blockedWriters.delete(done);
            socket.removeListener("drain", done);
            socket.removeListener("close", done);
            socket.removeListener("error", done);
            signal?.removeEventListener("abort", done);
            resolve();
          };
          blockedWriters.add(done);
          socket.once("drain", done);
          socket.once("close", done);
          socket.once("error", done);
          signal?.addEventListener("abort", done, { once: true });
        });
      },
      close: () => {
        connection.closed = true;
        releaseWriters();
        socket.end();
      },
      onMessage: (line) => {
        const message = parseClientRecord(line);
        if (message === undefined) {
          this.#log?.("ignoring a line that is not a protocol message", {
            line: line.slice(0, 200),
          });
          return;
        }
        this.#handlers.onMessage(connection, message);
      },
    };
    this.#connections.add(connection);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const { lines, rest } = splitRecords(buffer);
      buffer = rest;
      for (const line of lines) {
        connection.onMessage(line);
      }
    });
    const finish = (): void => {
      if (!this.#connections.delete(connection)) {
        return;
      }
      connection.closed = true;
      releaseWriters();
      this.#handlers.onClose(connection);
    };
    socket.on("close", finish);
    socket.on("end", finish);
    socket.on("error", () => {
      finish();
    });
  }

  async close(): Promise<void> {
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    for (const connection of [...this.#connections]) {
      connection.close();
    }
    this.#connections.clear();
    await new Promise<void>((resolve) => {
      this.#server.close(() => resolve());
    });
    await unlink(this.#paths.socket).catch(() => undefined);
  }
}

export interface RouterOptions {
  readonly version: string;
  readonly handle: (
    op: OperationName,
    params: unknown,
    connection: Connection,
  ) => Promise<unknown>;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The handshake and the request/response envelope. A protocol version this
 * build does not speak is fatal, because a mismatch means the two sides
 * disagree about the shape of every message, not just one.
 */
export class Router {
  readonly #options: RouterOptions;
  readonly #hello = new WeakMap<Connection, boolean>();

  constructor(options: RouterOptions) {
    this.#options = options;
  }

  onMessage(connection: Connection, message: ClientMessage): void {
    if (message.t === "hello") {
      this.#handshake(connection, message);
      return;
    }
    if (!this.#hello.get(connection)) {
      connection.send({
        t: "res",
        id: message.t === "req" ? message.id : "r0",
        ok: false,
        error: toErrorInfo(
          new PrefaixError(
            "PROTOCOL_MISMATCH",
            "send hello before any request",
          ),
        ),
      });
      return;
    }
    if (message.t !== "req") {
      return;
    }
    void this.#run(connection, message.id, message.op, message.params);
  }

  #handshake(
    connection: Connection,
    message: Extract<ClientMessage, { t: "hello" }>,
  ): void {
    if (message.v !== PROTOCOL_VERSION) {
      connection.send({
        t: "res",
        id: "r0",
        ok: false,
        error: toErrorInfo(
          new PrefaixError(
            "PROTOCOL_MISMATCH",
            `this daemon speaks protocol v${String(PROTOCOL_VERSION)}, the client asked for v${String(message.v)}`,
            {
              hint: "The client and daemon are from different versions. Run `prefaix daemon stop`, then retry.",
            },
          ),
        ),
      });
      connection.close();
      return;
    }
    connection.pid = message.pid;
    this.#hello.set(connection, true);
    connection.send({
      t: "hello",
      v: PROTOCOL_VERSION,
      version: this.#options.version,
      pid: process.pid,
    });
  }

  async #run(
    connection: Connection,
    id: string,
    op: OperationName,
    params: unknown,
  ): Promise<void> {
    try {
      const data = await this.#options.handle(op, params, connection);
      connection.send({ t: "res", id, ok: true, data });
    } catch (cause) {
      this.#options.log?.("operation failed", {
        op,
        problem: messageOf(cause),
      });
      connection.send({ t: "res", id, ok: false, error: toErrorInfo(cause) });
    }
  }

  onClose(connection: Connection): void {
    this.#hello.delete(connection);
  }
}
