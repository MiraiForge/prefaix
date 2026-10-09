// Daemon lifecycle (DESIGN §4.3.1). Owns the lock, the socket, the pool, the
// turn manager, and the idle exit, and is the only process that stays alive
// between turns.
//
// The headless rule is what makes everything else possible: this process never
// touches a tty, holds no render state, and can be replaced by a new version at
// any moment between turns. Detach and attach in M4 need exactly that.

import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import { PrefaixError, messageOf } from "../core/errors.js";
import { createLogger, type Logger } from "../core/log.js";
import { resolvePaths } from "../core/paths.js";
import type { PrefaixPaths as Paths } from "../core/paths.js";
import { createConfiguredBackend } from "../agents/registry.js";
import { loadConfig } from "../core/config/index.js";
import type { PrefaixConfig } from "../core/config/schema.js";
import { AgentPool } from "./pool.js";
import { ConversationStore } from "./store.js";
import { createStatusFiles } from "./status.js";
import { tryLock, type LockHandle } from "./lock.js";
import { TurnManager, type TurnHandle } from "./turns.js";
import { Operations } from "./operations.js";
import { Router, SocketServer, type Connection } from "./server.js";
import type {
  ClientMessage,
  OperationName,
  TurnSummary,
  TurnStartParams,
} from "../core/protocol.js";

export const DEFAULT_IDLE_MINUTES = 30;
const IDLE_TICK_MS = 30_000;
/** Below this, a size-rotated log is not worth the rename. */
const LOG_ROTATE_BYTES = 4 * 1024 * 1024;

export interface DaemonOptions {
  readonly paths?: Paths;
  readonly config?: PrefaixConfig;
  readonly version: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
  /** Injected so a test can drive the idle exit without waiting 30 minutes. */
  readonly idleMinutes?: number;
  /** How often to look for an idle daemon; a seam so a test need not wait. */
  readonly idleTickMs?: number;
  readonly onIdleCheck?: () => Promise<boolean>;
  readonly checkOwner?: boolean;
}

export class Daemon {
  readonly #paths: Paths;
  readonly #config: PrefaixConfig;
  readonly #version: string;
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #idleMinutes: number;
  readonly #idleTickMs: number;
  readonly #server: SocketServer;
  readonly #router: Router;
  readonly #turns: TurnManager;
  readonly #pool: AgentPool;
  readonly #store: ConversationStore;
  readonly #status: ReturnType<typeof createStatusFiles>;
  readonly #ops: Operations;
  readonly #startedAt: number;
  readonly #onIdleCheck: (() => Promise<boolean>) | undefined;
  readonly #logWrites = new Set<Promise<void>>();
  #lock: LockHandle | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastActivity = 0;
  #stopping = false;
  #stopPromise: Promise<void> | undefined;
  #ticking = false;
  #stopped: (() => void) | undefined;

  constructor(options: DaemonOptions) {
    this.#paths = options.paths ?? resolvePaths();
    this.#config = options.config ?? loadConfig();
    this.#version = options.version;
    this.#now = options.now ?? Date.now;
    this.#idleMinutes = options.idleMinutes ?? DEFAULT_IDLE_MINUTES;
    this.#idleTickMs = options.idleTickMs ?? IDLE_TICK_MS;
    this.#startedAt = this.#now();
    this.#lastActivity = this.#startedAt;
    this.#onIdleCheck = options.onIdleCheck;
    this.#log = createLogger({
      scope: "daemon",
      level: "info",
      write: (line) => {
        const writing = appendFile(this.#paths.daemonLog, `${line}\n`, {
          mode: 0o600,
        }).catch(() => undefined);
        this.#logWrites.add(writing);
        void writing.then(() => this.#logWrites.delete(writing));
      },
    });

    const backend = createConfiguredBackend({
      config: this.#config,
      turnsDir: this.#paths.turnsDir,
      env: options.env ?? process.env,
      log: (message, fields) => this.#log.info(message, fields),
    });

    this.#store = new ConversationStore({
      paths: this.#paths,
      log: this.#log.warn,
    });
    this.#turns = new TurnManager({
      now: this.#now,
      retainedTurns: this.#config.pool.maxChildren,
    });
    this.#pool = new AgentPool({
      backend,
      config: this.#config,
      log: this.#log.info,
      now: this.#now,
      isBusy: (id) => this.#turns.runningFor(id) !== undefined,
    });
    this.#status = createStatusFiles(this.#paths);

    this.#ops = new Operations({
      store: this.#store,
      pool: this.#pool,
      turns: this.#turns,
      config: this.#config,
      version: this.#version,
      startedAt: this.#startedAt,
      now: this.#now,
      send: (connection, message) => connection.send(message),
      onEnd: (turn, summary, info) => this.#onTurnEnd(turn, summary, info),
      log: this.#log.info,
    });

    this.#server = new SocketServer({
      paths: this.#paths,
      log: this.#log.warn,
      ...(options.checkOwner === undefined
        ? {}
        : { checkOwner: options.checkOwner }),
      handlers: {
        onMessage: (connection, message) =>
          this.#onMessage(connection, message),
        onClose: (connection) => this.#onClose(connection),
        onError: (problem) => this.#log.error(problem),
      },
    });
    // The router carries the handshake and the request envelope; Operations
    // sends turn events, because it is the only place that knows which client
    // owns which turn.
    this.#router = new Router({
      version: this.#version,
      handle: (op, params, connection) =>
        this.#dispatch(op, params, connection),
      log: this.#log.warn,
    });
  }

  get paths(): Paths {
    return this.#paths;
  }

  get pool(): AgentPool {
    return this.#pool;
  }

  get turns(): TurnManager {
    return this.#turns;
  }

  get store(): ConversationStore {
    return this.#store;
  }

  get connections(): number {
    return this.#server.connections;
  }

  /** Starts listening. Rejects when another daemon already holds the lock. */
  async start(): Promise<void> {
    await mkdir(this.#paths.logsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.#paths.turnsDir, { recursive: true, mode: 0o700 });
    await this.#rotateLogIfLarge();
    this.#lock = await tryLock({ path: this.#paths.lock, pid: process.pid });
    try {
      await this.#server.listen();
    } catch (cause) {
      await this.#lock.release();
      this.#lock = undefined;
      throw cause;
    }
    this.#log.info("daemon listening", {
      socket: this.#paths.socket,
      pid: process.pid,
      backend: this.#config.agent.backend,
    });
    this.#timer = setInterval(() => {
      void this.#tick().catch((cause) => {
        this.#log.warn("idle cleanup failed", { cause: messageOf(cause) });
      });
    }, this.#idleTickMs);
    this.#timer.unref();
  }

  /** Stops and waits for the socket to be gone, which is what autospawn waits on. */
  stop(): Promise<void> {
    if (this.#stopPromise !== undefined) return this.#stopPromise;
    this.#stopPromise = this.#stop().catch((cause) => {
      this.#stopPromise = undefined;
      throw cause;
    });
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#stopping = true;
    this.#ops.beginShutdown();
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    this.#log.info("daemon stopping");
    for (const turn of this.#turns.active) {
      this.#turns.abort(turn);
    }
    await this.#pool.close();
    // Closing transports unblocks aborted streams. Wait for their metadata
    // before releasing the lock to a replacement daemon.
    await this.#ops.drain();
    await this.#server.close();
    while (this.#logWrites.size > 0) {
      await Promise.all([...this.#logWrites]);
    }
    await this.#lock?.release();
    this.#stopped?.();
  }

  /** Resolves when the daemon has fully stopped, for `prefaix daemon --foreground`. */
  waitForStop(): Promise<void> {
    return new Promise((resolve) => {
      this.#stopped = resolve;
    });
  }

  #onMessage(connection: Connection, message: ClientMessage): void {
    this.#lastActivity = this.#now();
    this.#router.onMessage(connection, message);
  }

  #onClose(connection: Connection): void {
    this.#router.onClose(connection);
    this.#ops.releaseConnection(connection);
  }

  async #dispatch(
    op: OperationName,
    params: unknown,
    connection: Connection,
  ): Promise<unknown> {
    if (this.#stopping) {
      throw new PrefaixError("DAEMON_UNAVAILABLE", "the daemon is stopping");
    }
    switch (op) {
      case "turn.start":
        return this.#ops.turnStart(params as never, connection);
      case "turn.suggest":
        return this.#ops.turnStart(
          {
            ...(params as TurnStartParams),
            edit: "suggest",
          },
          connection,
        );
      case "turn.abort":
        return this.#ops.turnAbort(params as never);
      case "turn.attach":
        return this.#ops.turnAttach(params as never, connection);
      case "conv.rm":
        return this.#ops.convRemove(params as never);
      case "ui.respond":
        return this.#ops.uiRespond(params as never);
      case "conv.select":
        return this.#ops.convSelect(params as never);
      case "conv.previous":
        return this.#ops.convPrevious(params as never);
      case "conv.new":
        return this.#ops.convNew(params as never);
      case "conv.list":
        return this.#ops.convList(params as never);
      case "conv.get":
        return this.#ops.convGet(params as never);
      case "conv.rename":
        return this.#ops.convRename(params as never);
      case "conv.lastText":
        return this.#ops.convLastText(params as never);
      case "conv.compact":
        return this.#ops.convCompact(params as never);
      case "model.list":
        return this.#ops.modelList(params as never);
      case "model.set":
        return this.#ops.modelSet(params as never);
      case "thinking.list":
        return this.#ops.thinkingList(params as never);
      case "thinking.set":
        return this.#ops.thinkingSet(params as never);
      case "commands.list":
        return this.#ops.commandsList(params as never);
      case "status.get":
        return this.#ops.statusGet(params as never);
      case "daemon.ping":
        return { version: this.#version, pid: process.pid, v: 1 };
      case "daemon.stop":
        // Answer first, then exit: a client waiting on this response must not
        // see a closed socket instead of an acknowledgement.
        setTimeout(() => {
          void this.stop();
        }, 10).unref();
        return { stopping: true };
    }
  }

  /**
   * Everything a finished turn leaves behind: the right prompt's status, the
   * pool's bookkeeping, and a pre-warmed spare for the next `:new` in the same
   * root with the same environment.
   */
  async #onTurnEnd(
    turn: TurnHandle,
    summary: TurnSummary,
    info: { root: string; env: Record<string, string> },
  ): Promise<void> {
    this.#lastActivity = this.#now();
    // An abort is not a failure the user needs to see on their next prompt; a
    // crash is.
    const status = summary.status === "error" ? "error" : "done";
    await this.#status.writeStatus(turn.shellId, status).catch(() => undefined);
    this.#pool.touch(turn.conversationId);
    if (!this.#stopping) this.#pool.warmSpare(info.root, info.env);
    this.#log.info("turn finished", {
      turn: turn.id,
      conversation: turn.conversationId,
      status: summary.status,
      events: turn.ring.size,
    });
  }

  /**
   * Idle exit: no clients and no running turns for `idle_minutes`. The check
   * exists as a seam so a test can decide when the daemon is idle without
   * waiting half an hour.
   */
  async #tick(): Promise<void> {
    if (this.#stopping || this.#ticking) {
      return;
    }
    this.#ticking = true;
    try {
      await this.#pool.sweepIdle();
      if (this.#stopping) return;
      const busy =
        this.#turns.count > 0 ||
        this.#server.connections > 0 ||
        (this.#onIdleCheck !== undefined && (await this.#onIdleCheck()));
      if (busy) {
        this.#lastActivity = this.#now();
        return;
      }
      const idleMs = this.#now() - this.#lastActivity;
      if (idleMs < this.#idleMinutes * 60_000) return;
      this.#log.info("exiting after idle", { idleMs });
      await this.stop();
    } finally {
      this.#ticking = false;
    }
  }

  /** True when nothing is in flight, for a status line or a test. */
  get idle(): boolean {
    return this.#turns.count === 0 && this.#server.connections === 0;
  }

  async #rotateLogIfLarge(): Promise<void> {
    try {
      const info = await stat(this.#paths.daemonLog);
      if (info.size < LOG_ROTATE_BYTES) {
        return;
      }
      await rename(this.#paths.daemonLog, `${this.#paths.daemonLog}.1`);
    } catch {
      // No log yet, or it is not ours to rotate. Neither is an error worth
      // refusing to start over.
    }
  }
}

export function daemonUnavailable(reason: string): PrefaixError {
  return new PrefaixError("DAEMON_UNAVAILABLE", reason, {
    hint: "prefaix daemon --foreground shows the log",
  });
}
