// The tty controller (DESIGN §4.2, D5, §3.3).
//
// During a turn the client owns the terminal: raw mode so Esc and Ctrl+C arrive
// as bytes instead of signals, captured typeahead that goes back into the next
// prompt instead of garbling the stream, and a restore on *every* exit path.
// A terminal left in raw mode is the single worst failure this program has, so
// the restore is not a `finally` in one place — it is a signal handler, an
// exit hook, and an idempotent method all pointing at the same function.

import { messageOf } from "../core/errors.js";
import { StringDecoder } from "node:string_decoder";

export interface Key {
  /** `esc`, `ctrl-c`, `enter`, `up`, or a single printable character. */
  readonly name: string;
  readonly text: string;
}

export const ESC_TIMEOUT_MS = 25;

/** The escape byte, named so the source stays readable. */
export const ESC = "\u001b";

const ESCAPES: Readonly<Record<string, string>> = {
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[H": "home",
  "[F": "end",
  "[1~": "home",
  "[4~": "end",
  "[3~": "delete",
  "O.A": "up",
  "O.B": "down",
  "O.C": "right",
  "O.D": "left",
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
};

const CONTROL_NAMES: Readonly<Record<string, string>> = {
  "\r": "enter",
  "\n": "enter",
  "\u0003": "ctrl-c",
  "\u0004": "ctrl-d",
  "\u0007": "ctrl-g",
  "\u0008": "backspace",
  "\u001a": "ctrl-z",
  "\u0015": "ctrl-u",
  "\u0017": "ctrl-w",
  "\u0018": "ctrl-x",
  "\u001c": "ctrl-\\",
  "\u001e": "ctrl-^",
  "\u001f": "ctrl-_",
  "\u0000": "ctrl-space",
  "\u007f": "backspace",
};

/** The keys a turn acts on; everything else is captured as typeahead (M4). */
export function keyName(bytes: string): string {
  if (bytes === ESC) {
    return "esc";
  }
  const control = CONTROL_NAMES[bytes];
  if (control !== undefined) {
    return control;
  }
  if (bytes === "\t") {
    return "tab";
  }
  const code = bytes.charCodeAt(0);
  if (code < 32) {
    // Every remaining C0 control is a Ctrl combination.
    return `ctrl-${String.fromCharCode(code + 96)}`;
  }
  // Anything left is a character: the decoder hands over one code unit, or the
  // two of a surrogate pair, and nothing else.
  return "char";
}

/**
 * Turns a byte stream into key events. An Esc is only reported as Esc once the
 * disambiguation window closes without a sequence following it, so an arrow key
 * is never mistaken for a cancel.
 */
export class KeyDecoder {
  #pending = "";
  readonly #onKey: (key: Key) => void;
  readonly #onEsc: () => void;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #escMs: number;

  constructor(options: {
    onKey: (key: Key) => void;
    onEsc: () => void;
    escTimeoutMs?: number;
  }) {
    this.#onKey = options.onKey;
    this.#onEsc = options.onEsc;
    this.#escMs = options.escTimeoutMs ?? ESC_TIMEOUT_MS;
  }

  push(chunk: string): void {
    this.#pending += chunk;
    for (;;) {
      const bytes = this.#pending;
      if (bytes === "") {
        return;
      }
      if (bytes.startsWith(ESC)) {
        const body = this.#escapeBody(bytes);
        if (body === "wait") {
          this.#armEsc();
          return;
        }
        this.#clearEsc();
        // A lone Esc is reported through the Esc callback, not as a key, so the
        // caller has one path for "the user pressed Esc".
        if (body === "") {
          this.#pending = bytes.slice(ESC.length);
          this.#onEsc();
          continue;
        }
        const sequence = `${ESC}${body}`;
        this.#pending = bytes.slice(sequence.length);
        // A body that matched neither the table nor the final-character shape
        // is still a sequence the terminal sent, so it is reported as unknown
        // rather than dropped.
        this.#onKey({ name: ESCAPES[body] ?? "unknown", text: sequence });
        continue;
      }
      // A character that has only half arrived is held rather than emitted:
      // splitting it would corrupt the typeahead the user is restoring into
      // their prompt.
      const width = charWidth(bytes);
      if (width === "wait") {
        return;
      }
      this.#pending = bytes.slice(width);
      this.#onKey({
        name: keyName(bytes.slice(0, width)),
        text: bytes.slice(0, width),
      });
    }
  }

  /**
   * Reports whatever is still buffered when the caller stops waiting. A lone
   * Esc is an Esc, but a half-typed sequence is not a sequence: holding those
   * bytes forever would leave them to be misread as the start of the next one,
   * so they go back out as the literal characters the user typed.
   */
  flush(): void {
    if (this.#pending === "") {
      return;
    }
    this.#clearEsc();
    const bytes = this.#pending;
    this.#pending = "";
    if (bytes === ESC) {
      this.#onEsc();
      return;
    }
    for (const character of bytes) {
      this.#onKey({ name: keyName(character), text: character });
    }
  }

  /**
   * The body of an escape sequence, without the Esc, or `"wait"` when more
   * bytes could still make it into something longer, or `""` for a lone Esc that
   * has already timed out.
   */
  #escapeBody(bytes: string): string | "wait" {
    const rest = bytes.slice(ESC.length);
    if (rest === "") {
      return "wait";
    }
    // `rest` is not empty, so it has a first character.
    const first = rest.slice(0, 1);
    if (first !== "[" && first !== "O") {
      // Alt+key arrives as Esc followed by the key. The Esc has disambiguated,
      // so it is reported on its own and the key is left in the buffer to be
      // read as a normal character.
      return "";
    }
    for (let length = 2; length <= rest.length + 1; length++) {
      const candidate = rest.slice(0, length);
      if (
        ESCAPES[candidate] !== undefined ||
        /^[A-Za-z~]$/u.test(candidate.slice(-1))
      ) {
        return candidate;
      }
    }
    return "wait";
  }

  #armEsc(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, this.#escMs);
    this.#timer.unref?.();
  }

  #clearEsc(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  get pending(): string {
    return this.#pending;
  }
}

/** stdin when it is a terminal, and nothing at all when it is not. */
function defaultInput(): RawModeTarget | undefined {
  const stdin = process.stdin;
  return stdin.isTTY === true ? (stdin as unknown as RawModeTarget) : undefined;
}

/**
 * How many UTF-16 code units the next character occupies, or `"wait"` when only
 * its high surrogate has arrived. stdin is decoded, so the buffer holds code
 * units rather than bytes, and an emoji is two of them.
 */
function charWidth(text: string): number | "wait" {
  const first = text.charCodeAt(0);
  if (first >= 0xd800 && first <= 0xdbff) {
    const second = text.charCodeAt(1);
    return second >= 0xdc00 && second <= 0xdfff ? 2 : "wait";
  }
  return 1;
}

/**
 * The slice of a TTY read stream this file uses. Declared structurally so a test
 * can pass a plain object, and so nothing here depends on the stream being
 * stdin.
 */
export interface RawModeTarget {
  isRaw?: boolean;
  setRawMode(mode: boolean): boolean;
  setEncoding?(encoding: BufferEncoding): void;
  on(event: "data", listener: (chunk: string) => void): unknown;
  removeAllListeners?(event: "data"): unknown;
  /**
   * Stops reading. A real `process.stdin` holds the event loop open once it has
   * been read from, so without this the client finishes its turn and then
   * hangs, and the shell never gets its prompt back.
   */
  pause?(): unknown;
}

export interface TtyOptions {
  readonly input?: RawModeTarget;
  /** The decoder, or a fresh one. */
  readonly onKey: (key: Key) => void;
  readonly onEsc: () => void;
  readonly onResize?: (cols: number, rows: number) => void;
  readonly escTimeoutMs?: number;
  /** Injected so a test does not need a real terminal. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * Owns the terminal for the duration of a turn.
 *
 * `restore` is idempotent and safe to call from anywhere, which is what makes it
 * reasonable to call it from a signal handler, from `process.on("exit")`, and
 * from the normal exit path. It is also the reason the class holds no other
 * state worth flushing.
 */
export class TtyController {
  readonly #input: RawModeTarget | undefined;
  readonly #decoder: KeyDecoder;
  readonly #onResize: ((cols: number, rows: number) => void) | undefined;
  readonly #winch: (() => void) | undefined;
  #raw = false;
  #closed = false;
  /** Everything the user typed that the turn did not act on. */
  #captured = "";

  constructor(options: TtyOptions) {
    this.#input = options.input ?? defaultInput();
    this.#decoder = new KeyDecoder({
      onKey: options.onKey,
      onEsc: options.onEsc,
      ...(options.escTimeoutMs === undefined
        ? {}
        : { escTimeoutMs: options.escTimeoutMs }),
    });
    this.#onResize = options.onResize;
    if (this.#onResize !== undefined && process.stdout.isTTY) {
      this.#winch = (): void => {
        this.#onResize?.(
          process.stdout.columns ?? 80,
          process.stdout.rows ?? 24,
        );
      };
      process.on("SIGWINCH", this.#winch);
    }
  }

  get raw(): boolean {
    return this.#raw;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** The typeahead to hand back to the prompt when the turn ends. */
  takeCaptured(): string {
    const text = this.#captured;
    this.#captured = "";
    return text;
  }

  get captured(): string {
    return this.#captured;
  }

  /** Appends to the typeahead without echoing it into the stream. */
  capture(text: string): void {
    this.#captured += text;
  }

  enter(): void {
    if (this.#input === undefined || this.#raw) {
      return;
    }
    try {
      this.#raw = this.#input.setRawMode(true);
    } catch {
      // A terminal that refuses raw mode is one this turn cannot own. The
      // caller still runs; Esc simply is not available.
      this.#raw = false;
      return;
    }
    const decoder = new StringDecoder("utf8");
    this.#input.setEncoding?.("utf8");
    this.#input.on("data", (chunk: string) => {
      this.#decoder.push(
        typeof chunk === "string" ? chunk : decoder.write(chunk),
      );
    });
  }

  /**
   * Puts the terminal back and releases the listener. Idempotent, because the
   * normal path, the error path, the signal path, and the exit hook all call it
   * and only the first one should do anything.
   */
  restore(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#decoder.flush();
    if (this.#raw) {
      try {
        this.#input?.setRawMode(false);
      } catch {
        // The terminal is already gone, which is the state being restored to.
      }
      this.#raw = false;
    }
    this.#input?.removeAllListeners?.("data");
    this.#input?.pause?.();
    if (this.#winch !== undefined) {
      process.removeListener("SIGWINCH", this.#winch);
    }
  }
}

/**
 * Wires `restore` into every way this process can end, and returns a function
 * that removes the wiring. A turn that is interrupted by a signal must still
 * leave the user's terminal sane.
 */
export function installExitGuards(
  restore: () => void,
  options: { readonly process?: NodeJS.Process } = {},
): () => void {
  const target = options.process ?? process;
  const onSignal = (): void => {
    restore();
    target.exit(130);
  };
  const onExit = (): void => {
    restore();
  };
  const onUncaught = (error: unknown): void => {
    restore();
    // Reported through the default handler so the user still sees the error.
    target.stderr?.write(
      `prefaix: ${error instanceof Error && error.stack !== undefined ? error.stack : messageOf(error)}\n`,
    );
    target.exit(1);
  };
  target.on("SIGINT", onSignal);
  target.on("SIGTERM", onSignal);
  target.on("SIGHUP", onSignal);
  target.on("exit", onExit);
  target.on("uncaughtException", onUncaught);
  return () => {
    target.removeListener("SIGINT", onSignal);
    target.removeListener("SIGTERM", onSignal);
    target.removeListener("SIGHUP", onSignal);
    target.removeListener("exit", onExit);
    target.removeListener("uncaughtException", onUncaught);
  };
}
