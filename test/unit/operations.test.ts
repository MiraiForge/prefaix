import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliVersion, isEntry, runCli } from "../../src/cli/bin.js";
import { main } from "../../src/cli/index.js";
import { Daemon } from "../../src/daemon/daemon.js";
import { TestClient } from "../support/client.js";
import {
  defaultConfig,
  type PrefaixConfig,
} from "../../src/core/config/schema.js";
import { resolvePaths, type PrefaixPaths } from "../../src/core/paths.js";
import { runConversations } from "../../src/cli/conversations.js";
import { EXIT } from "../../src/core/errors.js";
import { workspaceRoot } from "../../src/daemon/operations.js";

const VERSION = "0.0.0-test";

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
  options: { env?: Record<string, string>; config?: PrefaixConfig } = {},
): Promise<Daemon> {
  const instance = new Daemon({
    paths,
    config: options.config ?? config(),
    version: VERSION,
    env: { PATH: "/usr/bin", HOME: home, ...options.env },
    // No git in the test environment, so the root is the cwd itself.
    checkOwner: false,
  });
  daemon = instance;
  await instance.start();
  return instance;
}

function io() {
  return {
    env: { PATH: "/usr/bin", HOME: home },
    paths,
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    version: VERSION,
  };
}

async function turn(
  client: TestClient,
  text: string,
  overrides: Record<string, unknown> = {},
): Promise<{ turnId: string; conversationId: string }> {
  const started = client.call("turn.start", {
    shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
    cwd: home,
    env: { PATH: "/usr/bin" },
    text,
    context: {
      recent: [],
      os: "macOS",
      term: { cols: 100, rows: 30, colors: 256 },
    },
    ...overrides,
  });
  const result = await started;
  if (!result.ok) {
    throw new Error(result.error?.message ?? "turn.start failed");
  }
  await new Promise<void>((resolve) => {
    client.onTurnEnd(() => resolve());
    setTimeout(resolve, 2_000);
  });
  return result.data as { turnId: string; conversationId: string };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-ops-"));
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

describe("the bin", () => {
  it("reads the version from the package it ships with", () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("falls back to 0.0.0 when the package cannot be read", () => {
    expect(
      cliVersion(() => {
        throw new Error("no package.json here");
      }),
    ).toBe("0.0.0");
    expect(cliVersion(() => "{}")).toBe("0.0.0");
  });

  it("knows when it is the entry and when it was imported", () => {
    const entry = join(home, "bin.js");
    const linked = join(home, "prefaix");
    writeFileSync(entry, "");
    symlinkSync(entry, linked);
    const url = pathToFileURL(realpathSync(entry)).href;
    expect(isEntry(url, entry)).toBe(true);
    expect(isEntry(url, linked)).toBe(true);
    expect(isEntry(url, join(home, "missing.js"))).toBe(false);
    expect(isEntry("file:///a/other.js", entry)).toBe(false);
    expect(isEntry("file:///a/b.js", undefined)).toBe(false);
    // A Windows-style or relative argv[1] must not throw.
    expect(isEntry("file:///a/b.js", "b.js")).toBe(false);
  });

  it("dispatches through the same entry the process uses", async () => {
    expect(await runCli(["--version"], VERSION)).toBe(EXIT.ok);
  });

  it("runs a local help turn through the client entry and writes its directives", async () => {
    const directives = join(home, "directives");
    expect(
      await runCli(
        [
          "run",
          "--shell",
          "zsh",
          "--shell-id",
          "1-1-bin",
          "--nonce",
          "bin",
          "--directives",
          directives,
          "--",
          ":help",
        ],
        VERSION,
      ),
    ).toBe(EXIT.ok);
    expect(readFileSync(directives, "utf8")).toBe("nonce\0bin\0");
  });
});

describe("the workspace root", () => {
  it("uses the git toplevel when there is one", async () => {
    const root = await workspaceRoot("/somewhere", {
      run: () => Promise.resolve("/repo\n"),
    });
    expect(root).toBe("/repo");
  });

  it("uses the directory itself when git says nothing", async () => {
    expect(
      await workspaceRoot("/somewhere", { run: () => Promise.resolve("") }),
    ).toBe("/somewhere");
    expect(
      await workspaceRoot("/somewhere", {
        run: () => Promise.resolve(undefined),
      }),
    ).toBe("/somewhere");
  });
});

describe("model, thinking, and commands", () => {
  it("sets a thinking level and records it on the conversation", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const { conversationId } = await turn(client, ": hi");
    expect(
      await client.call("thinking.set", { conversationId, level: "high" }),
    ).toMatchObject({
      ok: true,
    });
    const record = await client.call("conv.get", { conversationId });
    expect((record.data as { thinking: string }).thinking).toBe("high");
    client.close();
  });

  it("refuses a thinking level on a conversation with no warm child", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const result = await client.call("thinking.set", { level: "high" });
    expect(result.ok).toBe(false);
    expect(result.error?.hint).toContain("Run a `:`");
    client.close();
  });

  it("compacts a warm conversation", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const { conversationId } = await turn(client, ": hi");
    const result = await client.call("conv.compact", {
      conversationId,
      focus: "the loader",
    });
    expect(result.ok).toBe(true);
    expect(
      (result.data as { tokensBefore: number }).tokensBefore,
    ).toBeGreaterThan(0);
    client.close();
  });

  it("refuses to compact with no warm conversation", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const result = await client.call("conv.compact", {
      conversationId: "c_0" + "0".repeat(25),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONVERSATION_NOT_FOUND");
    client.close();
  });

  it("lists the agent's own commands", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const { conversationId } = await turn(client, ": hi");
    const result = await client.call("commands.list", { conversationId });
    expect(
      (result.data as { commands: { name: string }[] }).commands.map(
        (each) => each.name,
      ),
    ).toContain("review");
    client.close();
  });
});

describe("removing a conversation", () => {
  it("takes it out of the index and releases the warm child", async () => {
    const instance = await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const { conversationId } = await turn(client, ": hi");
    expect(instance.pool.session(conversationId)).toBeDefined();
    const result = await client.call("conv.rm", { conversationId });
    expect(result.ok).toBe(true);
    expect(await client.call("conv.get", { conversationId })).toMatchObject({
      ok: false,
    });
    expect(instance.pool.session(conversationId)).toBeUndefined();
    client.close();
  });

  it("refuses while a turn is running on it", async () => {
    await startDaemon({
      env: { PREFAIX_BACKEND: "fake", PREFAIX_FAKE_SCENARIO: "long" },
    });
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    // Started but not awaited: the turn is still running when the removal asks.
    const started = client.call("turn.start", {
      shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
      cwd: home,
      env: { PATH: "/usr/bin" },
      text: ": a long one",
      context: {
        recent: [],
        os: "macOS",
        term: { cols: 100, rows: 30, colors: 256 },
      },
    });
    const { conversationId } = (await started).data as {
      conversationId: string;
    };
    const result = await client.call("conv.rm", { conversationId });
    expect(result.ok).toBe(false);
    expect(result.error?.hint).toContain("Abort it first");
    client.close();
  });

  it("reports a conversation that does not exist", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const result = await client.call("conv.rm", {
      conversationId: "c_0" + "0".repeat(25),
    });
    expect(result.ok).toBe(false);
    client.close();
  });

  it("is reachable from the CLI", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const { conversationId } = await turn(client, ": hi");
    client.close();
    expect(await runConversations(["rm", conversationId], io())).toBe(EXIT.ok);
    expect(out.join("")).toContain(`removed ${conversationId}`);
  });

  it("insists on an id from the CLI", async () => {
    expect(await runConversations(["rm"], io())).toBe(EXIT.usage);
    expect(err.join("")).toContain("an id is required");
  });
});

describe("attaching to a turn", () => {
  it("replays the ring of a finished turn and reports where it starts", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const { conversationId } = await turn(client, ": hi");
    client.onEvent((_turnId, { seq, event }) => {
      out.push(`${String(seq)}:${event.type}`);
    });
    client.onTurnEnd((_turnId, summary) => {
      out.push(`end:${summary.status}`);
    });
    const result = await client.call("turn.attach", {
      conversationId,
      fromSeq: 1,
    });
    expect(result.ok).toBe(true);
    expect(out.join("")).toContain("1:turn_start");
    expect(out.join("")).toContain("end:stop");
    client.close();
  });

  it("replays from a sequence, not from the start", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const { conversationId } = await turn(client, ": hi");
    client.onEvent((_turnId, { seq, event }) => {
      out.push(`${String(seq)}:${event.type}`);
    });
    await client.call("turn.attach", { conversationId, fromSeq: 99 });
    expect(out.join("")).toBe("");
    client.close();
  });

  it("insists on a conversation id", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const result = await client.call("turn.attach", { fromSeq: 1 });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("a conversation id is required");
    client.close();
  });

  it("reports a conversation with no turn on record", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const result = await client.call("turn.attach", {
      conversationId: "c_0" + "0".repeat(25),
      fromSeq: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.hint).toContain("Run a `:`");
    client.close();
  });
});

describe("the cwd policy", () => {
  it("keeps the conversation's root under `stay`", async () => {
    const stay = config({
      workspace: { ...defaultConfig().workspace, cwdPolicy: "stay" },
    });
    const instance = await startDaemon({ config: stay });
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const { conversationId } = await turn(client, ": hi");
    await client.call("turn.start", {
      shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
      cwd: join(home, "elsewhere"),
      conversationId,
      env: { PATH: "/usr/bin" },
      text: ": still here",
      context: {
        recent: [],
        os: "macOS",
        term: { cols: 100, rows: 30, colors: 256 },
      },
    });
    const record = await client.call("conv.get", { conversationId });
    expect((record.data as { root: string }).root).not.toContain("elsewhere");
    expect(instance.pool.session(conversationId)).toBeDefined();
    client.close();
  });

  it("moves the conversation's root under `follow`", async () => {
    const follow = config({
      workspace: { ...defaultConfig().workspace, cwdPolicy: "follow" },
    });
    await startDaemon({ config: follow });
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const { conversationId } = await turn(client, ": hi");
    const other = join(home, "elsewhere");
    await client.call("turn.start", {
      shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
      cwd: other,
      conversationId,
      env: { PATH: "/usr/bin" },
      text: ": moved",
      context: {
        recent: [],
        os: "macOS",
        term: { cols: 100, rows: 30, colors: 256 },
      },
    });
    await new Promise<void>((resolve) => {
      client.onTurnEnd(() => resolve());
      setTimeout(resolve, 2_000);
    });
    const record = await client.call("conv.get", { conversationId });
    expect((record.data as { root: string }).root).toContain("elsewhere");
    client.close();
  });
});

describe("the daemon's own lifecycle", () => {
  it("stops when the client asks it to", async () => {
    const instance = await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    const result = await client.call("daemon.stop", {});
    expect(result.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(instance.connections).toBe(0);
    client.close();
  });

  it("writes a log line for every turn", async () => {
    const instance = await startDaemon();
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    await turn(client, ": hi");
    const { readFileSync } = await import("node:fs");
    // The log is written asynchronously behind the turn, so a read has to let
    // the appends land first.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const log = readFileSync(paths.daemonLog, "utf8");
    expect(log).toContain("daemon listening");
    expect(log).toContain("turn finished");
    expect(log).toContain("conversation=c_");
    void instance;
  });

  it("rotates a log that has grown past its limit", async () => {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(paths.logsDir, { recursive: true });
    await writeFile(paths.daemonLog, "x".repeat(5 * 1024 * 1024));
    await startDaemon();
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(paths.logsDir)).toContain("daemon.log.1");
  });

  it("leaves no temp file in the log directory", async () => {
    await startDaemon();
    const { readdirSync } = await import("node:fs");
    expect(
      readdirSync(paths.logsDir).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});

describe("the dispatcher's plumbing", () => {
  it("passes the terminal's shape through to the client", async () => {
    await startDaemon();
    const directives = join(home, "run", "d");
    const code = await main({
      argv: [
        "run",
        "--shell",
        "zsh",
        "--shell-id",
        "1-1-a",
        "--nonce",
        "n1",
        "--directives",
        directives,
        "--cwd",
        home,
        "--",
        ": hello",
      ],
      version: VERSION,
      paths,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      isTty: false,
      cols: 60,
      rows: 20,
      sleep: () => Promise.resolve(),
    });
    expect(code).toBe(EXIT.ok);
  });

  it("reports a config it cannot load", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(home, ".config", "prefaix"), { recursive: true });
    writeFileSync(join(home, ".config", "prefaix", "config.toml"), "[pool\n");
    const code = await main({
      argv: [
        "run",
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
        ": hello",
      ],
      version: VERSION,
      paths: resolvePaths({
        env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
        home,
      }),
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    expect(code).toBe(EXIT.usage);
    expect(err.join("")).toContain("Invalid TOML document");
  });
});
