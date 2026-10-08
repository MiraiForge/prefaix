// The pi JSONL transport and child lifecycle (DESIGN §4.5.1, §4.5.2).
//
// One reader owns stdout: every line is either the reply to a pending request
// or an event, and there is no third possibility. Splitting is on LF only, so a
// U+2028 inside a string is data, and pi's stderr is captured for the log and
// never parsed as protocol.
//
// Lifecycle facts measured in docs/spikes/S1-pi-rpc-lifecycle.md, which this
// file encodes: closing stdin exits 0, SIGTERM exits 143, SIGKILL writes
// nothing at all, and pi intermittently blocks at startup with no output, so
// ready is a wait with a deadline rather than a certainty.

import { PrefaixError } from "../../core/errors.js";
import { createQueue, type AsyncQueue } from "../../core/async-queue.js";
import {
  isPiResponse,
  type PiCommand,
  type PiRecord,
  type PiResponse,
} from "./types.js";

export interface ChildExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/** The seam tests substitute, so a replay can drive the transport exactly. */
export interface PiChild {
  readonly pid: number | undefined;
  write(line: string): void;
  endStdin(): void;
  kill(signal: NodeJS.Signals): void;
  onStdout(listener: (chunk: string) => void): void;
  onStderr(listener: (chunk: string) => void): void;
  onExit(listener: (exit: ChildExit) => void): void;
  /**
   * A spawn failure, which is an `error` event rather than an exit: a missing
   * or non-executable pi never reaches the point of exiting.
   */
  onError(listener: (problem: string) => void): void;
}

export type SpawnChild = (
  bin: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string> },
) => PiChild;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
// DESIGN §4.3.1: stdin EOF, then SIGTERM after 3s, then SIGKILL after 5s.
const TERM_GRACE_MS = 3_000;
const KILL_GRACE_MS = 5_000;

function processSpawn(
  bin: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: Record<string, string> },
): PiChild {
  const { spawn } = process.getBuiltinModule("child_process");
  const child = spawn(bin, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const handlers: {
    stdout?: (chunk: string) => void;
    stderr?: (chunk: string) => void;
    exit?: (exit: ChildExit) => void;
    error?: (problem: string) => void;
  } = {};
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => handlers.stdout?.(chunk));
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => handlers.stderr?.(chunk));
  child.on("exit", (code, signal) =>
    handlers.exit?.({ code, signal: signal as NodeJS.Signals | null }),
  );
  // Without a listener an unspawnable child takes the whole process down, which
  // for the daemon means a crash on `prefaix run` with no pi installed.
  child.on("error", (error: NodeJS.ErrnoException) => {
    handlers.error?.(
      error.code === "ENOENT"
        ? "pi was not found on PATH"
        : `pi could not be started (${error.code ?? error.message})`,
    );
  });
  return {
    get pid() {
      return child.pid;
    },
    write: (line) => {
      child.stdin.write(line);
    },
    endStdin: () => {
      child.stdin.end();
    },
    kill: (signal) => {
      child.kill(signal);
    },
    onStdout: (fn) => {
      handlers.stdout = fn;
    },
    onStderr: (fn) => {
      handlers.stderr = fn;
    },
    onExit: (fn) => {
      handlers.exit = fn;
    },
    onError: (fn) => {
      handlers.error = fn;
    },
  };
}

interface PendingRequest {
  readonly command: string;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly timeoutMs: number;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface DialogWait {
  readonly prompts: Set<string>;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A ready wait can be abandoned by a timeout, so nothing may go unhandled.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export interface PiRpcOptions {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly requestTimeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly spawn?: SpawnChild;
  /** Receives pi's stderr and framing warnings. Never protocol. */
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  /** Receives every non-JSON line pi writes to stdout. */
  readonly onProtocolNoise?: (line: string) => void;
}

export interface CloseResult {
  readonly exit: ChildExit;
  readonly escalatedTo: "stdin" | "SIGTERM" | "SIGKILL" | "already";
}

export class PiRpc {
  /** Every record that was not a reply, in the order pi wrote it. */
  readonly events: AsyncQueue<PiRecord> = createQueue<PiRecord>();
  #child: PiChild | undefined;
  #buffer = "";
  readonly #pending = new Map<string, PendingRequest>();
  readonly #dialogs = new Map<string, DialogWait>();
  #terminatePromise: Promise<CloseResult> | undefined;
  #terminationCause: PrefaixError | undefined;
  #nextId = 0;
  #exit: ChildExit | undefined;
  #closing = false;
  #ready = false;
  // pi can emit extension_ui_request before the first reply, so those are held
  // until the caller is ready to receive them.
  #preReady: PiRecord[] = [];
  #startupTaken = false;
  readonly #exitGate = deferred<ChildExit>();
  readonly #options: PiRpcOptions;
  readonly #spawnChild: SpawnChild;

  constructor(options: PiRpcOptions) {
    this.#options = options;
    this.#spawnChild = options.spawn ?? processSpawn;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  get exited(): boolean {
    return this.#exit !== undefined;
  }

  get closing(): boolean {
    return this.#closing;
  }

  get waitingForUi(): boolean {
    return this.#dialogs.size > 0;
  }

  get exitInfo(): ChildExit | undefined {
    return this.#exit;
  }

  /** True once pi answered a command and the session is usable. */
  get ready(): boolean {
    return this.#ready;
  }

  /**
   * The records pi wrote before its first reply, drained once. They are
   * startup output — a notification, a status, a dialog from a pre-warming
   * extension — and must not be mistaken for leftovers of an abandoned turn.
   */
  takeStartupRecords(): readonly PiRecord[] {
    if (this.#startupTaken) {
      return [];
    }
    this.#startupTaken = true;
    return this.#preReady;
  }

  get requestTimeoutMs(): number {
    return this.#options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  spawn(): void {
    if (this.#child !== undefined) {
      return;
    }
    const child = this.#spawnChild(this.#options.bin, this.#options.args, {
      cwd: this.#options.cwd,
      env: this.#options.env,
    });
    this.#child = child;
    child.onStdout((chunk) => {
      this.#read(chunk);
    });
    child.onStderr((chunk) => {
      for (const line of chunk.split("\n")) {
        if (line.trim() !== "") {
          this.#options.log?.("pi stderr", { line: line.slice(0, 500) });
        }
      }
    });
    child.onExit((exit) => {
      this.#handleExit(exit);
    });
    child.onError((problem) => {
      this.#handleSpawnFailure(problem);
    });
  }

  /**
   * Waits for pi's first reply. pi intermittently blocks at startup with no
   * output, so this rejects on a deadline rather than hanging.
   */
  async waitReady(inspect: (state: unknown) => void = () => {}): Promise<void> {
    if (this.#ready) {
      return;
    }
    this.spawn();
    const readyTimeoutMs =
      this.#options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new PrefaixError(
            "AGENT_UNAVAILABLE",
            `pi did not become ready within ${readyTimeoutMs}ms`,
            { hint: "prefaix doctor" },
          ),
        );
      }, readyTimeoutMs);
    });
    try {
      const state = await Promise.race([
        this.request("get_state", {}, { timeoutMs: readyTimeoutMs }),
        deadline,
      ]);
      inspect(state);
      this.#ready = true;
      for (const record of this.#preReady) {
        this.events.push(record);
      }
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  #read(chunk: string): void {
    this.#buffer += chunk;
    for (
      let at = this.#buffer.indexOf("\n");
      at !== -1;
      at = this.#buffer.indexOf("\n")
    ) {
      const line = this.#buffer.slice(0, at);
      this.#buffer = this.#buffer.slice(at + 1);
      this.#handleLine(line);
    }
  }

  #handleLine(raw: string): void {
    // pi is LF-only, but strip a trailing CR rather than handing a parser one.
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      return;
    }
    let record: PiRecord;
    try {
      record = JSON.parse(line) as PiRecord;
    } catch {
      // A malformed line must never end a turn: report it and keep reading.
      this.#options.onProtocolNoise?.(line.slice(0, 300));
      this.#options.log?.("pi stdout is not JSON", {
        line: line.slice(0, 300),
      });
      return;
    }
    // A line that is valid JSON but not an object is not a record at all, and
    // must not travel downstream as if it were.
    if (typeof record !== "object" || record === null) {
      this.#options.onProtocolNoise?.(line.slice(0, 300));
      this.#options.log?.("pi wrote a JSON value that is not a record", {
        line: line.slice(0, 300),
      });
      return;
    }
    if (isPiResponse(record)) {
      this.#settle(record);
      return;
    }
    if (
      record.type === "extension_ui_request" &&
      typeof record["id"] === "string" &&
      ["select", "confirm", "input", "editor"].includes(
        String(record["method"]),
      )
    ) {
      this.#waitForDialog(record["id"], record["timeout"]);
    } else if (record.type === "agent_settled") {
      this.#clearDialogs();
    }
    if (!this.#ready) {
      this.#preReady.push(record);
      return;
    }
    this.events.push(record);
  }

  #settle(response: PiResponse): void {
    const id = response.id;
    if (id === undefined) {
      return;
    }
    const pending = this.#pending.get(id);
    if (pending === undefined) {
      this.#options.log?.("pi replied to an unknown request", {
        id,
        command: response.command,
      });
      return;
    }
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    // An extension can auto-resolve its own dialog without a client reply.
    // Only retire dialogs belonging to this acceptance, not later tool UI.
    for (const [dialogId, dialog] of this.#dialogs) {
      if (dialog.prompts.has(id)) this.#finishDialog(dialogId);
    }
    if (response.success) {
      pending.resolve(response.data);
      return;
    }
    const error = new PrefaixError(
      "AGENT_ERROR",
      `pi ${pending.command} failed: ${response.error}`,
    );
    pending.reject(error);
  }

  // A child that never started has no exit code, so the failure is carried the
  // same way: every pending request rejects and the turn ends.
  #handleSpawnFailure(problem: string): void {
    if (this.#exit !== undefined) {
      return;
    }
    this.#exit = { code: null, signal: null };
    this.#fail(
      new PrefaixError("AGENT_UNAVAILABLE", problem, {
        hint: "Install pi, then run prefaix doctor.",
      }),
    );
  }

  #fail(error: PrefaixError): void {
    this.#clearDialogs();
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.events.fail(error);
  }

  #handleExit(exit: ChildExit): void {
    if (this.#exit !== undefined) {
      return;
    }
    this.#exit = exit;
    this.#clearDialogs();
    const how =
      exit.signal === null
        ? `exited with code ${String(exit.code)}`
        : `was killed by ${exit.signal}`;
    // A killed child writes nothing, so this failure is synthesized here.
    const error =
      this.#terminationCause ??
      new PrefaixError("AGENT_UNAVAILABLE", `pi ${how}`);
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.events.fail(error);
    this.#exitGate.resolve(exit);
  }

  /**
   * Sends a command and resolves with its `data`. `prompt` resolves on pi's
   * accept, not on completion: a turn ends at `agent_settled`.
   */
  request(
    command: PiCommand["type"],
    params: Record<string, unknown> = {},
    options: { readonly timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (this.#closing) {
      return Promise.reject(
        new PrefaixError("AGENT_UNAVAILABLE", "pi child is closing"),
      );
    }
    // Idempotent: a caller that skips waitReady still gets a child rather than
    // a promise that never settles.
    this.spawn();
    if (this.#exit !== undefined) {
      return Promise.reject(
        new PrefaixError("AGENT_UNAVAILABLE", "pi child has exited"),
      );
    }
    const id = `r${++this.#nextId}`;
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const settled = deferred<unknown>();
    const pending: PendingRequest = {
      command,
      timer: undefined,
      timeoutMs,
      resolve: settled.resolve,
      reject: settled.reject,
    };
    this.#pending.set(id, pending);
    for (const dialog of this.#dialogs.values()) {
      if (command === "prompt") dialog.prompts.add(id);
    }
    this.#armTimeout(id, pending);
    try {
      this.#child?.write(
        `${JSON.stringify({ id, type: command, ...params })}\n`,
      );
    } catch (cause) {
      clearTimeout(pending.timer);
      this.#pending.delete(id);
      settled.reject(
        new PrefaixError("AGENT_UNAVAILABLE", "pi stdin is closed", { cause }),
      );
    }
    return settled.promise;
  }

  #armTimeout(id: string, pending: PendingRequest): void {
    if (pending.command === "prompt" && this.waitingForUi) return;
    pending.timer = setTimeout(() => {
      this.#pending.delete(id);
      // A late preflight must not launch a model after local error settlement.
      // Ordinary metadata deadlines still leave a responsive child usable.
      const error = new PrefaixError(
        "AGENT_ERROR",
        `pi ${pending.command} timed out after ${pending.timeoutMs}ms`,
        {
          hint: "prefaix doctor",
        },
      );
      pending.reject(error);
      if (pending.command === "prompt") void this.terminate(error);
    }, pending.timeoutMs);
  }

  #waitForDialog(id: string, timeout: unknown): void {
    if (this.#dialogs.has(id)) return;
    const prompts = new Set<string>();
    for (const [requestId, pending] of this.#pending) {
      if (pending.command !== "prompt") continue;
      prompts.add(requestId);
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    const timer =
      typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 0
        ? setTimeout(() => this.#finishDialog(id), timeout)
        : undefined;
    this.#dialogs.set(id, { prompts, timer });
  }

  #finishDialog(id: string): void {
    const dialog = this.#dialogs.get(id);
    if (dialog === undefined) return;
    clearTimeout(dialog.timer);
    this.#dialogs.delete(id);
    if (this.waitingForUi) return;
    // Human thinking time is not a transport failure. A fresh ordinary deadline
    // starts only after the last dialog is answered/expired, not for metadata.
    for (const [requestId, pending] of this.#pending) {
      if (pending.command === "prompt" && pending.timer === undefined) {
        this.#armTimeout(requestId, pending);
      }
    }
  }

  #clearDialogs(): void {
    for (const dialog of this.#dialogs.values()) clearTimeout(dialog.timer);
    this.#dialogs.clear();
  }

  /** Writes a UI answer once. Unknown/expired answers cannot refresh a deadline. */
  respondUi(id: string, response: Record<string, unknown>): void {
    if (!this.#dialogs.has(id) || this.#closing || this.exited) return;
    this.writeRaw(
      JSON.stringify({ type: "extension_ui_response", id, ...response }),
    );
    this.#finishDialog(id);
  }

  /**
   * Held native dialogs need a hard stop: RPC abort does not clear pi's dialog
   * promises, and merely answering 'cancelled' may continue preflight/model work.
   * The pool replaces this unusable child on its saved native conversation.
   */
  terminate(cause?: PrefaixError): Promise<CloseResult> {
    if (this.#terminatePromise !== undefined) return this.#terminatePromise;
    this.#terminationCause = cause;
    this.#closing = true;
    this.#terminatePromise = (async () => {
      this.#clearDialogs();
      if (this.#child === undefined || this.#exit !== undefined) {
        this.events.close();
        return {
          exit: this.#exit ?? { code: 0, signal: null },
          escalatedTo: "already",
        };
      }
      this.#child.kill("SIGKILL");
      await this.#waitForExit(this.#options.killGraceMs ?? KILL_GRACE_MS);
      // Do not leave paused requests pending if the OS cannot confirm exit.
      this.#fail(
        this.#terminationCause ??
          new PrefaixError(
            "AGENT_UNAVAILABLE",
            "pi child was forcibly terminated",
          ),
      );
      return {
        exit: this.#exit ?? { code: null, signal: "SIGKILL" },
        escalatedTo: "SIGKILL",
      };
    })();
    return this.#terminatePromise;
  }

  /** Writes a raw command line, for a shape this file does not model yet. */
  writeRaw(line: string): void {
    this.#child?.write(line.endsWith("\n") ? line : `${line}\n`);
  }

  /**
   * stdin EOF, then SIGTERM, then SIGKILL. pi exits 0 on EOF and 143 on
   * SIGTERM, so a non-zero code here is expected rather than a failure.
   */
  async close(): Promise<CloseResult> {
    if (this.#closing) {
      return {
        exit: this.#exit ?? { code: 0, signal: null },
        escalatedTo: "already",
      };
    }
    this.#closing = true;
    this.#clearDialogs();
    if (this.#child === undefined) {
      this.events.close();
      return { exit: { code: 0, signal: null }, escalatedTo: "already" };
    }
    if (this.#exit === undefined) {
      this.#child.endStdin();
    }
    if (await this.#waitForExit(this.#options.termGraceMs ?? TERM_GRACE_MS)) {
      this.events.close();
      return { exit: this.#exit as ChildExit, escalatedTo: "stdin" };
    }
    this.#child.kill("SIGTERM");
    if (await this.#waitForExit(this.#options.killGraceMs ?? KILL_GRACE_MS)) {
      this.events.close();
      return { exit: this.#exit as ChildExit, escalatedTo: "SIGTERM" };
    }
    this.#child.kill("SIGKILL");
    await this.#waitForExit(this.#options.killGraceMs ?? KILL_GRACE_MS);
    this.events.close();
    return {
      exit: this.#exit ?? { code: null, signal: "SIGKILL" },
      escalatedTo: "SIGKILL",
    };
  }

  async #waitForExit(ms: number): Promise<boolean> {
    if (this.#exit !== undefined) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.#exitGate.promise.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
