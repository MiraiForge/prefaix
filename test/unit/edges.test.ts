import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Daemon } from "../../src/daemon/daemon.js";
import { DaemonClient } from "../../src/client/connection.js";
import { run } from "../../src/client/run.js";
import {
  defaultConfig,
  type PrefaixConfig,
} from "../../src/core/config/schema.js";
import { resolvePaths, type PrefaixPaths } from "../../src/core/paths.js";
import { EXIT } from "../../src/core/errors.js";
import { MarkdownStream, styleOnce } from "../../src/client/render/styler.js";
import { capabilities } from "../../src/client/render/theme.js";
import { Renderer } from "../../src/client/render/renderer.js";
import {
  renderSelect,
  runConfirm,
  runDialog,
  runInput,
  type DialogIo,
  type DialogRequest,
} from "../../src/client/render/dialogs.js";
import { parseLine, suggestions } from "../../src/shells/grammar.js";
import {
  decodeDirectives,
  encodeDirectives,
} from "../../src/shells/directives.js";
import { TestClient } from "../support/client.js";

const VERSION = "0.0.0-test";
const TTY_ENV = { TERM: "xterm-256color" };

let home = "";
let paths: PrefaixPaths;
let daemon: Daemon | undefined;
let out: string[] = [];
let err: string[] = [];

function config(overrides: Partial<PrefaixConfig> = {}): PrefaixConfig {
  const base = defaultConfig();
  return {
    ...base,
    agent: { ...base.agent, backend: "fake" },
    ...overrides,
  };
}

async function startDaemon(
  options: {
    env?: Record<string, string>;
    config?: PrefaixConfig;
    idleMinutes?: number;
    onIdleCheck?: () => Promise<boolean>;
  } = {},
): Promise<Daemon> {
  const instance = new Daemon({
    paths,
    config: options.config ?? config(),
    version: VERSION,
    env: { PATH: "/usr/bin", HOME: home, ...options.env },
    checkOwner: false,
    ...(options.idleMinutes === undefined
      ? {}
      : { idleMinutes: options.idleMinutes }),
    ...(options.onIdleCheck === undefined
      ? {}
      : { onIdleCheck: options.onIdleCheck }),
  });
  daemon = instance;
  await instance.start();
  return instance;
}

function fakeTty() {
  const listeners: ((chunk: string) => void)[] = [];
  return {
    setRawMode: () => true,
    setEncoding: () => undefined,
    on: (_event: "data", listener: (chunk: string) => void) => {
      listeners.push(listener);
    },
    removeAllListeners: () => {
      listeners.length = 0;
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-edges-"));
  paths = resolvePaths({
    env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    home,
  });
  out = [];
  err = [];
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("the socket, driven by hand", () => {
  it("ignores a line that arrives after the client hangs up", async () => {
    await startDaemon();
    const socket = await new Promise<ReturnType<typeof connect>>(
      (resolve, reject) => {
        const pending = connect(paths.socket);
        pending.once("connect", () => resolve(pending));
        pending.once("error", reject);
      },
    );
    socket.setEncoding("utf8");
    socket.write('{"t":"hello","v":1,"version":"x","pid":1}\n');
    await new Promise((resolve) => setTimeout(resolve, 30));
    socket.destroy();
    // The daemon is still there for the next client, which is the point of the
    // close handler being a cleanup rather than a shutdown.
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    expect(client.hello?.v).toBe(1);
    client.close();
  });

  it("survives a socket error without taking the daemon down", async () => {
    const instance = await startDaemon();
    const socket = await new Promise<ReturnType<typeof connect>>(
      (resolve, reject) => {
        const pending = connect(paths.socket);
        pending.once("connect", () => resolve(pending));
        pending.once("error", reject);
      },
    );
    // Destroying a connection mid-write is what a closed pty does.
    socket.destroy(new Error("the pty went away"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    expect(await client.call("daemon.ping", {})).toMatchObject({ ok: true });
    client.close();
    expect(instance.connections).toBeGreaterThan(0);
  });

  it("refuses a second daemon on the same socket", async () => {
    const instance = await startDaemon();
    const second = new Daemon({
      paths,
      config: config(),
      version: VERSION,
      env: { PATH: "/usr/bin", HOME: home, PREFAIX_BACKEND: "fake" },
      checkOwner: false,
    });
    await expect(second.start()).rejects.toThrow(/another prefaix daemon/);
    await instance.stop();
  });
});

describe("the handshake a client can get wrong", () => {
  it("gives up on a daemon that accepts but never says hello", async () => {
    // A stub server that reads and never answers is the shape of a daemon stuck
    // at startup, which S1 measured happening.
    const { createServer } = await import("node:net");
    // A socket of its own, so this never races a real daemon from another test.
    const socket = join(home, "stub.sock");
    const accepted: { destroy(): void }[] = [];
    const stub = createServer((connection) => {
      accepted.push(connection);
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(socket, resolve);
    });
    const client = new DaemonClient({
      paths: { ...paths, socket },
      version: VERSION,
      autospawn: false,
    });
    await expect(client.connect()).rejects.toThrow(/never said hello/);
    client.close();
    await new Promise<void>((resolve) => {
      // The stub's connection is still open, and `close` waits for it;
      // dropping it is what makes the teardown finish.
      for (const connection of accepted) {
        connection.destroy();
      }
      stub.close(() => resolve());
    });
  });

  it("keeps working when the daemon says something new", async () => {
    await startDaemon();
    const client = new DaemonClient({
      paths,
      version: VERSION,
      autospawn: false,
    });
    await client.connect();
    // A newer daemon may add a message this build has never heard of. Dropping
    // the line is what keeps an M2 client working against an M3 daemon, so the
    // next request has to go through as if nothing happened.
    const socket = connect(paths.socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write('{"t":"hello","v":1,"version":"0.0.0-test","pid":7}\n');
    socket.write('{"t":"gossip","payload":{"anything":true}}\n');
    const status = await client.call<{ backend: string }>("status.get", {});
    expect(status.backend).toBe("fake");
    socket.destroy();
    client.close();
  });

  it("ignores the answer to a request it is no longer waiting for", async () => {
    await startDaemon();
    const client = new DaemonClient({
      paths,
      version: VERSION,
      autospawn: false,
    });
    await client.connect();
    const socket = connect(paths.socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write('{"t":"hello","v":1,"version":"0.0.0-test","pid":7}\n');
    // A response with an id nobody asked about is not this client's to act on.
    socket.write('{"t":"res","id":"r999","ok":true}\n');
    const status = await client.call<{ backend: string }>("status.get", {});
    expect(status.backend).toBe("fake");
    socket.destroy();
    client.close();
  });

  it("does not respawn a daemon that answers with something else", async () => {
    const socket = join(home, "quiet.sock");
    const { createServer } = await import("node:net");
    const stub = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(socket, resolve);
    });
    const spawned: string[] = [];
    const client = new DaemonClient({
      paths: { ...paths, socket },
      version: VERSION,
      spawnDaemon: (entry) => {
        spawned.push(entry);
      },
    });
    // The connection was accepted, so nothing is refused: the wait is for a
    // hello that never comes, and the client must not answer that by spawning.
    await expect(client.connect()).rejects.toThrow(/never said hello/);
    expect(spawned).toEqual([]);
    client.close();
    stub.close();
  });

  it("keeps reading past a line it does not understand", async () => {
    const socket = join(home, "chatty.sock");
    const { createServer } = await import("node:net");
    const stub = createServer((connection) => {
      connection.setEncoding("utf8");
      connection.once("data", () => {
        // A newer daemon can say anything it likes; the one thing it must not
        // do is stop this client from reading the lines it does understand.
        connection.write('{"t":"gossip","payload":1}\n');
        connection.write("not json at all\n");
        connection.write(`{"t":"res","id":"r-nobody-asked","ok":true}\n`);
        connection.write(
          `{"t":"hello","v":1,"version":"${VERSION}","pid":7}\n`,
        );
        setTimeout(() => connection.end(), 20);
      });
    });
    await new Promise<void>((resolve, reject) => {
      stub.once("error", reject);
      stub.listen(socket, resolve);
    });
    const client = new DaemonClient({
      paths: { ...paths, socket },
      version: VERSION,
      autospawn: false,
    });
    await client.connect();
    // Every unusable line was dropped and the hello still arrived.
    await expect(client.call("status.get", {})).rejects.toThrow();
    client.close();
    stub.close();
  });

  it("reports a version mismatch as a protocol error", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket, { v: 99 });
    const refusal = await client.waitFor((message) => message.t === "res");
    expect(refusal).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_MISMATCH" },
    });
    client.close();
  });

  it("fails every pending request when the daemon goes away mid-turn", async () => {
    const instance = await startDaemon();
    const client = new DaemonClient({ paths, version: VERSION });
    await client.connect();
    const pending = client.call("daemon.ping", {});
    await instance.stop();
    await expect(pending).rejects.toThrow(/closed the connection/);
    client.close();
  });
});

describe("commands the client has not implemented yet", () => {
  async function runLine(line: string): Promise<number> {
    return run({
      argv: [
        "--shell",
        "zsh",
        "--shell-id",
        "1-1-a",
        "--nonce",
        "n1",
        "--directives",
        join(home, "run", "d"),
        "--cwd",
        home,
        "--",
        line,
      ],
      version: VERSION,
      paths,
      config: config(),
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      tty: fakeTty(),
    });
  }

  it("explains commands that need an active conversation", async () => {
    await startDaemon();
    for (const command of [":model", ":think high", ":copy"]) {
      err = [];
      expect(await runLine(command), command).toBe(EXIT.usage);
      expect(err.join(""), command).toContain("no active conversation");
    }
  });

  it("reaches the daemon for :model.set, which is not wired to a command", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const started = await client.call("turn.start", {
      shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
      cwd: home,
      env: { PATH: "/usr/bin" },
      text: ": hi",
      context: {
        recent: [],
        os: "macOS",
        term: { cols: 100, rows: 30, colors: 256 },
      },
    });
    const { conversationId } = started.data as { conversationId: string };
    await client.waitForTurnEnd();
    expect(
      await client.call("model.set", {
        conversationId,
        ref: { provider: "fake", id: "fake-slow" },
      }),
    ).toMatchObject({ ok: true });
    client.close();
  });
});

describe("the idle exit", () => {
  it("stops once nothing is left to do", async () => {
    const instance = await startDaemon({
      idleMinutes: 0,
      onIdleCheck: async () => false,
    });
    const stopped = instance.waitForStop();
    // The tick runs every 30 s, so the wait is what proves the daemon keeps
    // itself alive; the tick itself is driven by a short idle window.
    expect(instance.idle).toBe(true);
    await instance.stop();
    await stopped;
  });

  it("stays alive while a client is connected", async () => {
    const instance = await startDaemon({ idleMinutes: 0 });
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    expect(instance.idle).toBe(false);
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(instance.idle).toBe(true);
  });
});

describe("the styler's corners", () => {
  const caps = capabilities({ env: TTY_ENV, isTty: true });

  it("opens and closes a tilde fence", () => {
    const stream = new MarkdownStream({ caps });
    expect(plainText(stream, "~~~\nraw\n~~~\n")).toBe("~~~\nraw\n~~~\n");
    expect(stream.inFence).toBe(false);
  });

  it("leaves a different fence character alone inside a block", () => {
    const stream = new MarkdownStream({ caps });
    const text = "```\n~~~\nstill code\n```\n";
    expect(plainText(stream, text)).toBe(text);
  });

  it("holds a line that could still become a quote", () => {
    const stream = new MarkdownStream({ caps });
    expect(stream.push("> ")).toBe("");
    expect(plainText(stream, "quoted")).toBe("> quoted");
  });

  it("leaves a table alone", () => {
    const stream = new MarkdownStream({ caps });
    expect(plainText(stream, "| a | b |\n")).toBe("| a | b |\n");
  });

  it("styles text that is not a stream", () => {
    expect(stripEscapes(styleOnce("hi", caps))).toBe("hi");
    expect(styleOnce("hi", capabilities({ env: TTY_ENV, isTty: false }))).toBe(
      "hi",
    );
  });

  it("holds an unmatched marker rather than styling it", () => {
    const stream = new MarkdownStream({ caps });
    expect(plainText(stream, "a_b_c")).toBe("a_b_c");
  });

  it("pairs a marker with the next one inside the window", () => {
    const stream = new MarkdownStream({ caps });
    expect(stream.push("*ab*")).toContain("*ab*");
  });
});

function plainText(stream: MarkdownStream, text: string): string {
  return stripEscapes(`${stream.push(text)}${stream.flush()}`);
}

/** What a person sees, with the styling taken back out. */
function stripEscapes(text: string): string {
  return text.replace(
    // eslint-disable-next-line no-control-regex -- stripping escapes is the point
    /\u001b\[[0-9;]*m/g,
    "",
  );
}

describe("the renderer's remaining corners", () => {
  it("labels the spinner with thinking text", () => {
    const err: string[] = [];
    const renderer = new Renderer({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
      out: () => undefined,
      err: (text) => err.push(text),
      footer: ["time"],
    });
    renderer.begin();
    renderer.handle({ type: "thinking_delta", text: "hmm" });
    renderer.handle({ type: "settled", stopReason: "stop" });
    expect(err.join("")).toContain("── ");
  });

  it("paints a dimmed and a grey line for a command's own output", () => {
    const out: string[] = [];
    const renderer = new Renderer({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
      out: (text) => out.push(text),
      err: () => undefined,
      footer: [],
    });
    expect(renderer.dimmed("a")).toContain("\u001b[2m");
    expect(renderer.grey("a")).toContain("\u001b[90m");
    expect(renderer.dimmed("a")).not.toBe("a");
  });

  it("shows the model the backend reported", () => {
    const err: string[] = [];
    const renderer = new Renderer({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
      out: () => undefined,
      err: (text) => err.push(text),
      footer: ["model"],
    });
    renderer.setModel("flash");
    renderer.handle({ type: "settled", stopReason: "stop" });
    expect(stripEscapes(err.join(""))).toContain("flash");
  });

  it("prints a notice that is not part of the turn", () => {
    const err: string[] = [];
    const renderer = new Renderer({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
      out: () => undefined,
      err: (text) => err.push(text),
      footer: [],
    });
    renderer.notice("a thing happened", "warn");
    expect(stripEscapes(err.join(""))).toContain("a thing happened");
  });
});

describe("dialogs with less to show", () => {
  function io(
    keys: { name: string; text: string }[] = [],
    lines: string[] = [],
  ): DialogIo {
    const queue = [...keys];
    return {
      caps: capabilities({ env: TTY_ENV, isTty: true }),
      write: () => undefined,
      erase: () => undefined,
      readKey: () =>
        Promise.resolve(queue.shift() ?? { name: "enter", text: "" }),
      readLine: () => Promise.resolve(lines.shift() ?? ""),
    };
  }

  it("shows only the options when there is no title or message", () => {
    const rendered = stripEscapes(
      renderSelect(
        { id: "u", kind: "select", title: "", options: ["a"] },
        0,
        capabilities({ env: TTY_ENV, isTty: true }),
      ),
    );
    expect(rendered).toContain("❯ a");
    expect(rendered).not.toContain("undefined");
  });

  it("takes the only option of a one-item list", async () => {
    expect(
      await runDialog(
        { id: "u", kind: "select", title: "Pick", options: ["only"] },
        io(),
      ),
    ).toEqual({ value: "only" });
  });

  it("joins the title and the message in a confirmation", async () => {
    const request: DialogRequest = {
      id: "u",
      kind: "confirm",
      title: "Apply?",
      message: "it changes files",
    };
    expect(await runConfirm(request, io([], ["y"]))).toEqual({
      confirmed: true,
    });
  });

  it("returns an empty answer when there is no prefill to fall back on", async () => {
    expect(
      await runInput({ id: "u", kind: "input", title: "Name?" }, io([], [""])),
    ).toEqual({ value: "" });
  });
});

describe("the grammar's fallbacks", () => {
  it("falls back to the documented passthrough when the config's does not compile", () => {
    expect(parseLine(": > f", { passthrough: "([bad" }).kind).toBe("pass");
  });

  it("offers suggestions from a caller-supplied list", () => {
    expect(suggestions("modek", ["model", "modek"])[0]).toBe("modek");
  });

  it("treats a lone backslash-colon as passthrough", () => {
    expect(parseLine("\\: ls").kind).toBe("pass");
  });
});

describe("directives a plugin will never see", () => {
  it("decodes an empty buffer as no buffer", () => {
    const decoded = decodeDirectives(
      encodeDirectives({ nonce: "n", buffer: "" }),
    );
    expect(decoded?.buffer).toBe("");
  });

  it("refuses a cursor that is not a number", () => {
    const bytes = Buffer.from("nonce\0n\0cursor\0abc\0", "utf8");
    expect(decodeDirectives(bytes)?.cursor).toBeUndefined();
  });
});
