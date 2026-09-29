import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DIRECTIVE_KEYS,
  bufferAction,
  decodeDirectives,
  encodeDirectives,
  isDirectiveKey,
  nonceMatches,
} from "../../src/shells/directives.js";
import {
  KeyDecoder,
  TtyController,
  ESC,
  keyName,
  installExitGuards,
} from "../../src/client/tty.js";

// DESIGN §12.1: the directives round-trip carries arbitrary bytes, because a
// `buffer` value can be anything a model produced.

describe("the whitelist a plugin applies", () => {
  it("is exactly the keys DESIGN §4.1.0 names", () => {
    expect([...DIRECTIVE_KEYS]).toEqual([
      "nonce",
      "conversation",
      "status",
      "buffer",
      "cursor",
    ]);
  });

  it("refuses anything outside it", () => {
    expect(isDirectiveKey("conversation")).toBe(true);
    expect(isDirectiveKey("rm")).toBe(false);
    expect(isDirectiveKey("BASH_ENV")).toBe(false);
  });
});

describe("round-tripping directives", () => {
  it("carries every key", () => {
    const directives = {
      nonce: "n7",
      conversation: "c_01J",
      status: "✓ done",
      buffer: "git status",
      cursor: 4,
    };
    expect(decodeDirectives(encodeDirectives(directives))).toEqual(directives);
  });

  it("carries a value with quotes, newlines, and a backslash", () => {
    const buffer = `echo "it's \\ fine"\nsecond line\tthird`;
    const decoded = decodeDirectives(encodeDirectives({ nonce: "n", buffer }));
    expect(decoded?.buffer).toBe(buffer);
  });

  it("carries a value that looks like a directive", () => {
    // The NUL separator is what stops a model-written buffer from smuggling a
    // second directive past the whitelist.
    const buffer = "rm -rf /\0conversation\0c_forged";
    expect(() => encodeDirectives({ nonce: "n", buffer })).toThrow(/NUL/);
  });

  it("refuses a file that is not a whole number of fields", () => {
    // A truncated write leaves an odd field count, and a half-directive is
    // worse than none: the shell would apply half of it.
    expect(decodeDirectives("nonce\0n7\0conversation\0")).toBeUndefined();
    // A file with no fields at all is the same mistake with nothing in it.
    expect(decodeDirectives("")).toBeUndefined();
  });

  it("ignores a key the whitelist does not carry", () => {
    // A newer client may write a key this build has never heard of; the ones it
    // does know still have to arrive intact.
    const decoded = decodeDirectives("nonce\0n7\0rm\0-whatever\0buffer\0ls\0");
    expect(decoded).toEqual({ nonce: "n7", buffer: "ls" });
  });

  it("reads the same file whether it arrives as bytes or as text", () => {
    // A shell plugin reads the file as bytes, because the buffer can hold
    // anything a model produced; the tests hold the same file as text.
    const encoded = encodeDirectives({ nonce: "n7", buffer: "héllo" });
    const dir = mkdtempSync(join(tmpdir(), "pfx-directives-"));
    const file = join(dir, "directives");
    writeFileSync(file, encoded);
    expect(decodeDirectives(readFileSync(file))).toEqual(
      decodeDirectives(encoded),
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports no cursor when the file carries none", () => {
    expect(decodeDirectives("nonce\0n7\0")?.cursor).toBeUndefined();
    // A cursor that is not a number is left out rather than written as NaN,
    // which a shell would take literally.
    expect(decodeDirectives("nonce\0n7\0cursor\0not a number\0")).toEqual({
      nonce: "n7",
    });
    expect(decodeDirectives("nonce\0n7\0cursor\0" + "7" + "\0")?.cursor).toBe(
      7,
    );
  });

  it("omits keys that were not set, rather than writing empty ones", () => {
    const encoded = encodeDirectives({ nonce: "n" });
    expect(decodeDirectives(encoded)).toEqual({ nonce: "n" });
  });

  it("writes cursor as text and reads it back as a number", () => {
    const decoded = decodeDirectives(
      encodeDirectives({ nonce: "n", cursor: 0 }),
    );
    expect(decoded?.cursor).toBe(0);
  });

  it("keeps unicode intact", () => {
    const decoded = decodeDirectives(
      encodeDirectives({ nonce: "n", buffer: "日本語 🎉" }),
    );
    expect(decoded?.buffer).toBe("日本語 🎉");
  });

  it("reads an empty file as nothing", () => {
    expect(decodeDirectives(Buffer.alloc(0))).toBeUndefined();
  });

  it("refuses a truncated file rather than half-applying it", () => {
    expect(
      decodeDirectives(Buffer.from("nonce\0n1\0buffer\0hal", "utf8")),
    ).toBeUndefined();
  });

  it("refuses a file with no nonce, which the plugin could not match", () => {
    expect(
      decodeDirectives(Buffer.from("buffer\0x\0", "utf8")),
    ).toBeUndefined();
  });

  it("ignores a key it does not know, which a newer client may write", () => {
    const bytes = Buffer.from("nonce\0n1\0future\0value\0", "utf8");
    expect(decodeDirectives(bytes)).toEqual({ nonce: "n1" });
  });

  it("writes the pairs in a fixed order, so a reader can rely on it", () => {
    const bytes = encodeDirectives({
      nonce: "n",
      cursor: 2,
      buffer: "b",
      conversation: "c",
    });
    expect(
      bytes
        .toString("utf8")
        .split("\0")
        .filter((part) => part !== ""),
    ).toEqual([
      "nonce",
      "n",
      "conversation",
      "c",
      "buffer",
      "b",
      "cursor",
      "2",
    ]);
  });
});

describe("what the plugin does with the file", () => {
  it("ignores a file whose nonce does not match the one it passed", () => {
    const decoded = decodeDirectives(encodeDirectives({ nonce: "n1" }));
    expect(nonceMatches(decoded, "n2")).toBe(false);
    expect(nonceMatches(decoded, "n1")).toBe(true);
    expect(nonceMatches(undefined, "n1")).toBe(false);
  });

  it("runs the shell again when there is no buffer, so precmd re-runs", () => {
    expect(bufferAction(undefined)).toBe("run");
    expect(bufferAction({ nonce: "n" })).toBe("run");
    expect(bufferAction({ nonce: "n", buffer: "" })).toBe("run");
  });

  it("waits for the user when there is a buffer", () => {
    expect(bufferAction({ nonce: "n", buffer: "git commit -m 'x'" })).toBe(
      "edit",
    );
  });
});

describe("key names", () => {
  it("names the keys a turn acts on", () => {
    expect(keyName(ESC)).toBe("esc");
    expect(keyName("\u0003")).toBe("ctrl-c");
    expect(keyName("\u0004")).toBe("ctrl-d");
    expect(keyName("\u001a")).toBe("ctrl-z");
    expect(keyName("\r")).toBe("enter");
    expect(keyName("\n")).toBe("enter");
    expect(keyName("\t")).toBe("tab");
    expect(keyName("\u007f")).toBe("backspace");
  });

  it("names any other control as its Ctrl combination", () => {
    expect(keyName("\u0001")).toBe("ctrl-a");
    expect(keyName("\u0000")).toBe("ctrl-space");
    expect(keyName("\u000b")).toBe("ctrl-k");
  });

  it("names an ordinary character as a character", () => {
    expect(keyName("a")).toBe("char");
    expect(keyName("é")).toBe("char");
  });

  it("treats the escape byte itself as a control, which the decoder routes first", () => {
    // Escape sequences never reach here: the decoder matches them against its
    // table before asking for a key name. This is what a bare Esc looks like to
    // the fallback.
    expect(keyName(ESC)).toBe("esc");
  });
});

describe("the key decoder", () => {
  function collect(escTimeoutMs = 5) {
    const keys: string[] = [];
    let escapes = 0;
    const decoder = new KeyDecoder({
      onKey: (key) => keys.push(key.name),
      onEsc: () => {
        escapes += 1;
      },
      escTimeoutMs,
    });
    return {
      decoder,
      keys,
      escapes: () => escapes,
    };
  }

  it("reports a plain character", () => {
    const { decoder, keys } = collect();
    decoder.push("ab");
    expect(keys).toEqual(["char", "char"]);
  });

  it("does not report a lone Esc until the window closes", async () => {
    const { decoder, keys, escapes } = collect(5);
    decoder.push(ESC);
    expect(keys).toEqual([]);
    expect(escapes()).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(escapes()).toBe(1);
  });

  it("reads an arrow key as an arrow key, not as an Esc", () => {
    const { decoder, keys, escapes } = collect();
    decoder.push(`${ESC}[A`);
    expect(keys).toEqual(["up"]);
    expect(escapes()).toBe(0);
  });

  it("reads a CSI sequence that arrives in two chunks", () => {
    const { decoder, keys } = collect();
    decoder.push(ESC);
    decoder.push("[");
    decoder.push("D");
    expect(keys).toEqual(["left"]);
  });

  it("reads an application-mode arrow as well", () => {
    const { decoder, keys } = collect();
    decoder.push(`${ESC}OB`);
    expect(keys).toEqual(["down"]);
  });

  it("reads a tilde sequence", () => {
    const { decoder, keys } = collect();
    decoder.push(`${ESC}[3~`);
    expect(keys).toEqual(["delete"]);
  });

  it("treats Alt+key as an Esc and then the key", () => {
    const { decoder, keys, escapes } = collect();
    decoder.push(`${ESC}x`);
    expect(escapes()).toBe(1);
    expect(keys).toEqual(["char"]);
  });

  it("reads a multi-byte character as one key", () => {
    const { decoder, keys } = collect();
    // stdin is set to utf8, so Node hands the decoder whole characters; the
    // check is that a four-byte emoji is not split into four typeahead bytes.
    decoder.push("🎉");
    expect(keys).toEqual(["char"]);
  });

  it("waits for the rest of a character split across two writes", () => {
    const { decoder, keys } = collect();
    // A half-arrived character is held rather than emitted, so the typeahead
    // restored into the prompt is the character and not a replacement mark.
    decoder.push(String.fromCodePoint(0xd83c));
    expect(keys).toEqual([]);
    decoder.push(String.fromCodePoint(0xdf89));
    expect(keys).toEqual(["char"]);
  });

  it("reports what it is still holding back while a sequence is incomplete", () => {
    const keys: string[] = [];
    const decoder = new KeyDecoder({
      onKey: (key) => keys.push(key.name),
      onEsc: () => keys.push("esc"),
      escTimeoutMs: 5,
    });
    expect(decoder.pending).toBe("");
    decoder.push(ESC);
    // An Esc on its own could still become a longer sequence, so nothing is
    // reported until either the rest arrives or the window closes.
    expect(decoder.pending).toBe(ESC);
    expect(keys).toEqual([]);
    decoder.flush();
    expect(decoder.pending).toBe("");
    expect(keys).toEqual(["esc"]);
  });

  it("reports Alt and a key as two separate things", () => {
    const keys: string[] = [];
    const decoder = new KeyDecoder({
      onKey: (key) => keys.push(key.name),
      onEsc: () => keys.push("esc"),
      escTimeoutMs: 5,
    });
    decoder.push(`${ESC}x`);
    expect(keys).toEqual(["esc", "char"]);
  });

  it("waits out a sequence that never finishes", () => {
    const keys: string[] = [];
    const decoder = new KeyDecoder({
      onKey: (key) => keys.push(key.name),
      onEsc: () => keys.push("esc"),
      escTimeoutMs: 5,
    });
    decoder.push(`${ESC}[1;`);
    // Nothing here is a key yet, and nothing ever will be, so the bytes go back
    // out as what the user actually typed rather than being held for good.
    expect(decoder.pending).toBe(`${ESC}[1;`);
    decoder.flush();
    expect(decoder.pending).toBe("");
    expect(keys).toEqual(["esc", "char", "char", "char"]);
  });

  it("reports a sequence it has no name for as unknown", () => {
    const keys: string[] = [];
    const decoder = new KeyDecoder({
      onKey: (key) => keys.push(key.name),
      onEsc: () => keys.push("esc"),
      escTimeoutMs: 5,
    });
    // A final character that matches the shape but is not in the table is a key
    // the terminal can send and this build has never heard of.
    decoder.push(`${ESC}[Z`);
    expect(keys).toEqual(["unknown"]);
  });

  it("flushes a pending Esc when the window closes with nothing after it", () => {
    const { decoder, escapes } = collect(1_000);
    decoder.push(ESC);
    decoder.flush();
    expect(escapes()).toBe(1);
  });

  it("does not flush an Esc that is already part of a sequence", () => {
    const { decoder, escapes } = collect(1_000);
    decoder.push(`${ESC}[`);
    decoder.flush();
    expect(escapes()).toBe(0);
  });
});

describe("the tty controller", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pfx-tty-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in for a tty read stream, with the calls a test can assert on. */
  function fakeTty() {
    const listeners: ((chunk: string) => void)[] = [];
    const calls: boolean[] = [];
    let paused = false;
    return {
      calls,
      listeners,
      isRaw: false,
      get paused() {
        return paused;
      },
      setRawMode(mode: boolean) {
        calls.push(mode);
        this.isRaw = mode;
        return mode;
      },
      setEncoding() {},
      on(_event: "data", listener: (chunk: string) => void) {
        listeners.push(listener);
      },
      removeAllListeners() {
        listeners.length = 0;
      },
      pause() {
        paused = true;
      },
      send(chunk: string) {
        for (const listener of [...listeners]) {
          listener(chunk);
        }
      },
    };
  }

  it("puts the terminal in raw mode and takes it back exactly once", () => {
    const input = fakeTty();
    const tty = new TtyController({
      input: input as never,
      onKey: () => undefined,
      onEsc: () => undefined,
    });
    tty.enter();
    expect(tty.raw).toBe(true);
    tty.restore();
    tty.restore();
    expect(tty.raw).toBe(false);
    expect(input.calls).toEqual([true, false]);
    expect(tty.closed).toBe(true);
    // Reading stopped as well as the mode changing: a `process.stdin` that is
    // still open holds the event loop, and the client would hang after a
    // perfectly good turn instead of handing the terminal back to the shell.
    expect(input.paused).toBe(true);
  });

  it("survives a terminal that is already gone", () => {
    const input = fakeTty();
    input.setRawMode = () => {
      throw new Error("ENOTTY");
    };
    const tty = new TtyController({
      input: input as never,
      onKey: () => undefined,
      onEsc: () => undefined,
    });
    tty.enter();
    expect(tty.raw).toBe(false);
    expect(() => tty.restore()).not.toThrow();
  });

  it("does nothing when there is no terminal to own", () => {
    const tty = new TtyController({
      onKey: () => undefined,
      onEsc: () => undefined,
    });
    tty.enter();
    expect(tty.raw).toBe(false);
    expect(() => tty.restore()).not.toThrow();
  });

  it("captures typeahead and hands it back once", () => {
    const tty = new TtyController({
      input: fakeTty() as never,
      onKey: () => undefined,
      onEsc: () => undefined,
    });
    tty.capture("git status");
    tty.capture(" --short");
    expect(tty.captured).toBe("git status --short");
    expect(tty.takeCaptured()).toBe("git status --short");
    expect(tty.takeCaptured()).toBe("");
  });

  it("reports a new terminal size when the window changes", () => {
    const sizes: [number, number][] = [];
    const isTTY = process.stdout.isTTY;
    const columns = process.stdout.columns;
    const rows = process.stdout.rows;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: 132,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "rows", {
      value: 43,
      configurable: true,
    });
    try {
      const tty = new TtyController({
        input: fakeTty() as never,
        onKey: () => undefined,
        onEsc: () => undefined,
        onResize: (cols, lineCount) => sizes.push([cols, lineCount]),
      });
      tty.enter();
      process.emit("SIGWINCH");
      tty.restore();
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: isTTY,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "columns", {
        value: columns,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "rows", {
        value: rows,
        configurable: true,
      });
    }
    expect(sizes).toEqual([[132, 43]]);
  });

  it("falls back to a standard size when the terminal cannot report one", () => {
    const sizes: [number, number][] = [];
    const isTTY = process.stdout.isTTY;
    const columns = process.stdout.columns;
    const rows = process.stdout.rows;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "rows", {
      value: undefined,
      configurable: true,
    });
    try {
      const tty = new TtyController({
        input: fakeTty() as never,
        onKey: () => undefined,
        onEsc: () => undefined,
        onResize: (cols, lineCount) => sizes.push([cols, lineCount]),
      });
      tty.enter();
      process.emit("SIGWINCH");
      tty.restore();
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: isTTY,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "columns", {
        value: columns,
        configurable: true,
      });
      Object.defineProperty(process.stdout, "rows", {
        value: rows,
        configurable: true,
      });
    }
    expect(sizes).toEqual([[80, 24]]);
  });

  it("routes bytes from the terminal to the key handler", () => {
    const input = fakeTty();
    const keys: string[] = [];
    const tty = new TtyController({
      input: input as never,
      onKey: (key) => keys.push(key.name),
      onEsc: () => keys.push("esc"),
      escTimeoutMs: 5,
    });
    tty.enter();
    input.send("hi");
    tty.restore();
    expect(keys).toEqual(["char", "char"]);
  });
});

describe("the exit guards", () => {
  it("prints what an uncaught value was, even without a stack", () => {
    const written: string[] = [];
    const listeners = new Map<string, (value: unknown) => void>();
    const fake = {
      on: (name: string, handler: (value: unknown) => void) => {
        listeners.set(name, handler);
      },
      removeListener: (name: string) => {
        listeners.delete(name);
      },
      exit: () => {
        throw new Error("exited");
      },
      stderr: { write: (text: string) => written.push(text) },
    };
    const release = installExitGuards(() => undefined, {
      process: fake as unknown as NodeJS.Process,
    });
    // A rejection that is not an Error still has to reach the user's terminal
    // as text, not as `[object Object]`.
    expect(() =>
      listeners.get("uncaughtException")?.("the child vanished"),
    ).toThrow("exited");
    expect(written.join("")).toContain("the child vanished");
    release();
  });

  it("restores on a signal and reports the abort status", () => {
    const listeners = new Map<string, (() => void)[]>();
    const fake = {
      on: (event: string, fn: () => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      },
      removeListener: (event: string, fn: () => void) => {
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter((each) => each !== fn),
        );
      },
      exit: () => undefined,
      stderr: { write: () => true },
    } as unknown as NodeJS.Process;
    let restored = 0;
    const release = installExitGuards(
      () => {
        restored += 1;
      },
      { process: fake },
    );
    for (const event of [
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      "exit",
      "uncaughtException",
    ]) {
      for (const fn of listeners.get(event) ?? []) {
        fn();
      }
    }
    expect(restored).toBe(5);
    release();
    for (const event of [
      "SIGINT",
      "SIGTERM",
      "SIGHUP",
      "exit",
      "uncaughtException",
    ]) {
      expect(listeners.get(event)).toEqual([]);
    }
  });
});
