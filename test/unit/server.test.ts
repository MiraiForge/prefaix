// The socket layer on its own (DESIGN §4.3.2). The daemon tests exercise it
// through a live daemon; this file is about what the socket does when a client
// is rude, when the file on disk is a corpse, and when it is asked to stop
// twice.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SocketServer, type Connection } from "../../src/daemon/server.js";
import { resolvePaths, type PrefaixPaths } from "../../src/core/paths.js";
import type { ClientMessage } from "../../src/core/protocol.js";

let home = "";
let paths: PrefaixPaths;
let server: SocketServer | undefined;
let closed: string[] = [];
let messages: { connection: Connection; message: ClientMessage }[] = [];
let problems: string[] = [];
let logs: string[] = [];

function noopHandlers(): ConstructorParameters<
  typeof SocketServer
>[0]["handlers"] {
  return {
    onMessage: (connection, message) => messages.push({ connection, message }),
    onClose: (connection) => closed.push(connection.id),
    ...(problems.length === 0
      ? {}
      : { onError: (text) => problems.push(text) }),
  };
}

async function start(
  options: { withErrorHandler?: boolean } = {},
): Promise<SocketServer> {
  const problems: string[] = [];
  const instance = new SocketServer({
    paths,
    checkOwner: false,
    handlers: {
      onMessage: (connection, message) =>
        messages.push({ connection, message }),
      onClose: (connection) => closed.push(connection.id),
      ...(options.withErrorHandler === true
        ? { onError: (text) => problems.push(text) }
        : {}),
    },
    log: (message) => logs.push(message),
  });
  server = instance;
  await instance.listen();
  return instance;
}

async function client(chunk: string): Promise<Socket> {
  const socket = connect(paths.socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.setEncoding("utf8");
  if (chunk !== "") {
    socket.write(chunk);
  }
  return socket;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let at = 0; at < 200; at += 1) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the condition");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-srv-"));
  paths = resolvePaths({
    env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    home,
  });
  closed = [];
  messages = [];
  problems = [];
  logs = [];
});

afterEach(async () => {
  await server?.close();
  server = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("the socket file", () => {
  it("is the address the daemon publishes", async () => {
    const instance = await start();
    expect(instance.address).toBe(paths.socket);
    expect(instance.connections).toBe(0);
  });

  it("is removed when a daemon was killed and left one behind", async () => {
    // A socket with no listener is a corpse: every autospawn would fail on it
    // forever, so the new daemon clears it before binding. The only way to get
    // one is a process that bound it and then died without cleaning up.
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("node:net").createServer().listen(${JSON.stringify(paths.socket)}, () => process.stdout.write("ready\\n"))`,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect(statSync(paths.socket).isSocket()).toBe(true);

    const instance = await start();
    expect(instance.connections).toBe(0);
  });

  it("refuses to start while a live daemon is listening", async () => {
    await start();
    const second = new SocketServer({
      paths,
      checkOwner: false,
      handlers: noopHandlers(),
    });
    await expect(second.listen()).rejects.toThrow(
      /another prefaix daemon is already listening/,
    );
  });

  it("reports a bind failure as well as rejecting it", async () => {
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    // A directory the daemon cannot write to is a bind it cannot win, and the
    // reason belongs in the log even though the caller gets it as a throw.
    chmodSync(paths.runtimeDir, 0o500);
    try {
      const instance = new SocketServer({
        paths,
        checkOwner: false,
        handlers: {
          onMessage: (connection, message) =>
            messages.push({ connection, message }),
          onClose: (connection) => closed.push(connection.id),
          onError: (text) => problems.push(text),
        },
      });
      await expect(instance.listen()).rejects.toThrow();
      expect(problems.join("")).toContain("daemon socket error");
    } finally {
      chmodSync(paths.runtimeDir, 0o700);
    }
  });
});

describe("a client that misbehaves", () => {
  it("ignores a line that is not a protocol message", async () => {
    await start();
    const socket = await client("this is not json\n");
    await client('{"t":"hello","v":1,"version":"0.0.0-test","pid":7}\n');
    await waitFor(() => messages.length > 0);
    expect(logs.join("")).toContain("not a protocol message");
    socket.destroy();
  });

  it("counts a connection once and forgets it when the socket ends", async () => {
    const instance = await start();
    const socket = await client(
      '{"t":"hello","v":1,"version":"0.0.0-test","pid":7}\n',
    );
    await waitFor(() => instance.connections === 1);
    socket.end();
    await waitFor(() => instance.connections === 0);
    expect(closed).toHaveLength(1);
  });
});

describe("stopping", () => {
  it("hangs up on every client and is safe to ask twice", async () => {
    const instance = await start();
    const socket = await client(
      '{"t":"hello","v":1,"version":"0.0.0-test","pid":7}\n',
    );
    await waitFor(() => instance.connections === 1);
    await instance.close();
    await expect(instance.close()).resolves.toBeUndefined();
    await waitFor(() => instance.connections === 0);
    socket.destroy();
  });
});
