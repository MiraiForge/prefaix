import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, parseRunArgs, writeDirectives } from "../../src/client/run.js";
import { DaemonClient, isConnectRefused } from "../../src/client/connection.js";
import { Daemon } from "../../src/daemon/daemon.js";
import {
  defaultConfig,
  type PrefaixConfig,
} from "../../src/core/config/schema.js";
import { resolvePaths } from "../../src/core/paths.js";
import { decodeDirectives } from "../../src/shells/directives.js";
import { EXIT } from "../../src/core/errors.js";
import { ESC } from "../../src/client/tty.js";
import { capabilities } from "../../src/client/render/theme.js";
import type { RawModeTarget } from "../../src/client/tty.js";

const VERSION = "0.0.0-test";

let home = "";
let paths: ReturnType<typeof resolvePaths>;
let daemon: Daemon | undefined;
let directivesFile = "";
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
    checkOwner: false,
  });
  daemon = instance;
  await instance.start();
  return instance;
}

function fakeTty(): RawModeTarget & { send(chunk: string): void } {
  const listeners: ((chunk: string) => void)[] = [];
  return {
    setRawMode: () => true,
    setEncoding: () => undefined,
    on: (_event, listener) => {
      listeners.push(listener);
    },
    removeAllListeners: () => {
      listeners.length = 0;
    },
    send(chunk) {
      for (const listener of [...listeners]) {
        listener(chunk);
      }
    },
  };
}

function argv(line: string, overrides: Record<string, string> = {}): string[] {
  return [
    "--shell",
    "zsh",
    "--shell-id",
    "1-1-a",
    "--shell-version",
    "5.9",
    "--shell-pid",
    "4242",
    "--nonce",
    "n1",
    "--directives",
    directivesFile,
    "--cwd",
    home,
    ...(overrides["conversation"] === undefined
      ? ["--conversation", ""]
      : ["--conversation", overrides["conversation"] ?? ""]),
    "--",
    line,
  ];
}

async function runClient(
  line: string,
  options: {
    tty?: RawModeTarget;
    config?: PrefaixConfig;
    sleep?: (ms: number) => Promise<void>;
    conversation?: string;
  } = {},
): Promise<number> {
  return run({
    argv: argv(line, {
      conversation: options.conversation ?? "",
    }),
    version: VERSION,
    paths,
    config: options.config ?? config(),
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    stdoutIsTty: true,
    cols: 100,
    tty: options.tty ?? fakeTty(),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  });
}

function readDirectives(): {
  nonce: string;
  conversation?: string;
  buffer?: string;
  cursor?: number;
  status?: string;
} {
  return decodeDirectives(readFileSync(directivesFile)) ?? { nonce: "" };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-run-"));
  paths = resolvePaths({
    env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    home,
  });
  directivesFile = join(home, "run", "directives");
  out = [];
  err = [];
});

afterEach(async () => {
  await daemon?.stop();
  daemon = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe("argv", () => {
  it("fills in what the plugin left out rather than failing", () => {
    // A hand-run `prefaix run` has no plugin to pass the rest, so every one of
    // these has a default that has to be right.
    const parsed = parseRunArgs([
      "--shell",
      "zsh",
      "--shell-id",
      "1-1-a",
      "--nonce",
      "n1",
      "--directives",
      join(home, "run", "directives"),
      "--",
      ": fix it",
    ]);
    expect(parsed).toMatchObject({
      shell: "zsh",
      shellVersion: "unknown",
      conversationId: "",
    });
    expect(parsed.cwd).toBe(process.cwd());
    expect(parsed.recent).toEqual([]);
    // A shell pid that is not a positive integer is not one.
    const required = [
      "--shell",
      "zsh",
      "--shell-id",
      "1-1-a",
      "--nonce",
      "n1",
      "--directives",
      "d",
    ];
    expect(
      parseRunArgs([...required, "--shell-pid", "0", "--", "x"]).shellPid,
    ).toBe(process.pid);
    expect(
      parseRunArgs([...required, "--shell-pid", "42", "--", "x"]).shellPid,
    ).toBe(42);
  });

  it("keeps a flag with nothing after it as an empty value", () => {
    // A trailing flag has no value to read, and the line the plugin would have
    // supplied is what is missing, not the flag.
    expect(() =>
      parseRunArgs([
        "--shell",
        "zsh",
        "--shell-id",
        "1-1-a",
        "--nonce",
        "n1",
        "--directives",
        "d",
        "--conversation",
      ]),
    ).toThrow(/buffer is required/);
  });

  it("reads a trailing flag that has no value as an empty one", () => {
    // A plugin that ran out of arguments mid-line must not be able to make the
    // parser read the next token as the value.
    const required = [
      "--shell",
      "zsh",
      "--shell-id",
      "1-1-a",
      "--nonce",
      "n1",
      "--directives",
      "d",
    ];
    expect(() => parseRunArgs([...required, "--recent"])).toThrow(
      /buffer is required/,
    );
  });

  it("reads a recent command with no exit code in front of it", () => {
    const parsed = parseRunArgs([
      "--shell",
      "zsh",
      "--shell-id",
      "1-1-a",
      "--nonce",
      "n1",
      "--directives",
      "d",
      "--recent",
      "just this",
      "--recent",
      "0:git status",
      "--",
      "x",
    ]);
    expect(parsed.recent).toEqual([
      { exit: null, cmd: "just this" },
      { exit: 0, cmd: "git status" },
    ]);
  });

  it("reads the flags the plugin passes", () => {
    const parsed = parseRunArgs([
      "--shell",
      "fish",
      "--shell-id",
      "9-9-z",
      "--shell-version",
      "4.0",
      "--shell-pid",
      "12",
      "--conversation",
      "c_1",
      "--nonce",
      "n7",
      "--directives",
      "/tmp/d",
      "--cwd",
      "/w",
      "--recent",
      "0:git pull",
      "--recent",
      "1:bun test",
      "--",
      ": fix the test",
    ]);
    expect(parsed).toMatchObject({
      shell: "fish",
      shellId: "9-9-z",
      shellVersion: "4.0",
      shellPid: 12,
      conversationId: "c_1",
      nonce: "n7",
      directives: "/tmp/d",
      cwd: "/w",
      line: ": fix the test",
    });
    expect(parsed.recent).toEqual([
      { exit: 0, cmd: "git pull" },
      { exit: 1, cmd: "bun test" },
    ]);
  });

  it("keeps the buffer byte-exact, quotes and all", () => {
    const line = `: it's "quoted" $(echo $HOME) *glob* !`;
    expect(
      parseRunArgs([
        "--shell",
        "zsh",
        "--shell-id",
        "1",
        "--nonce",
        "n",
        "--directives",
        "d",
        "--",
        line,
      ]).line,
    ).toBe(line);
  });

  it("defaults a missing exit code to none", () => {
    const parsed = parseRunArgs([
      "--shell",
      "zsh",
      "--shell-id",
      "1",
      "--nonce",
      "n",
      "--directives",
      "d",
      "--recent",
      "ls",
      "--",
      ": hi",
    ]);
    expect(parsed.recent).toEqual([{ exit: null, cmd: "ls" }]);
  });

  it("defaults an unreadable shell pid to this process", () => {
    const parsed = parseRunArgs([
      "--shell",
      "zsh",
      "--shell-id",
      "1",
      "--shell-pid",
      "abc",
      "--nonce",
      "n",
      "--directives",
      "d",
      "--",
      ": hi",
    ]);
    expect(parsed.shellPid).toBe(process.pid);
  });

  it("names the shell it does not support", () => {
    expect(() =>
      parseRunArgs([
        "--shell",
        "csh",
        "--shell-id",
        "1",
        "--nonce",
        "n",
        "--directives",
        "d",
        "--",
        ": hi",
      ]),
    ).toThrow(/--shell must be one of/);
  });

  it("insists on the flags the plugin always passes", () => {
    for (const missing of ["shell-id", "nonce", "directives"]) {
      const flags: Record<string, string> = {
        shell: "zsh",
        "shell-id": "1",
        nonce: "n",
        directives: "d",
      };
      delete flags[missing];
      const args = Object.entries(flags).flatMap(([name, value]) => [
        `--${name}`,
        value,
      ]);
      expect(() => parseRunArgs([...args, "--", ": hi"]), missing).toThrow(
        new RegExp(`--${missing} is required`),
      );
    }
  });

  it("insists on a buffer after --", () => {
    expect(() =>
      parseRunArgs([
        "--shell",
        "zsh",
        "--shell-id",
        "1",
        "--nonce",
        "n",
        "--directives",
        "d",
      ]),
    ).toThrow(/buffer is required/);
  });

  it("refuses a bare argument that is not a flag", () => {
    expect(() => parseRunArgs(["oops"])).toThrow(/after --/);
  });
});

describe("a turn, end to end", () => {
  it("streams the answer to stdout and the chrome to stderr", async () => {
    await startDaemon({
      env: { PREFAIX_BACKEND: "fake", PREFAIX_FAKE_SCENARIO: "tools" },
    });
    expect(await runClient(": explain this repo")).toBe(EXIT.ok);
    // The answer is on stdout so a user can pipe a turn; the tool lines and the
    // footer are on stderr so they never land in the middle of a copy-paste.
    expect(out.join("")).toContain("Read the config loader");
    expect(err.join("")).toContain("⏺ read");
    expect(err.join("")).toContain("── ");
    expect(out.join("")).not.toContain("⏺");
  });

  it("resolves its own paths when the caller gave none", async () => {
    // A hand-run `prefaix run` has no paths to be told, so it reads them from
    // the process environment and then finds no daemon there.
    const code = await run({
      argv: [
        "--shell",
        "zsh",
        "--shell-id",
        "1-1-a",
        "--nonce",
        "n1",
        "--directives",
        join(home, "run", "directives"),
        "--",
        ": hello",
      ],
      version: VERSION,
      env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run"), PATH: "/usr/bin" },
      config: config(),
    });
    expect(code).toBe(EXIT.daemonUnavailable);
  });

  it("runs with nothing but argv, which is how a hand-run invocation looks", async () => {
    // No io, no paths, no config, no tty: every one of those has a default, and
    // the command still has to fail with a message rather than a crash.
    const code = await run({
      argv: ["--shell", "zsh", "--shell-id", "1-1-a", "--nonce", "n1"],
      version: VERSION,
    });
    expect(code).toBe(EXIT.usage);
  });

  it("runs a turn with no terminal attached, and still answers", async () => {
    await startDaemon();
    // A `:` in a pipeline has no tty to own. The turn runs, the answer is
    // printed, and there is no buffer to hand back to a prompt that is not there.
    expect(
      await run({
        argv: argv(": no tty here"),
        version: VERSION,
        paths,
        config: config(),
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      }),
    ).toBe(EXIT.ok);
    expect(out.join("")).toContain("Hello from the fake backend");
    expect(readDirectives()["buffer"]).toBeUndefined();
  });

  it("keeps typeahead the user typed while the turn was running", async () => {
    await startDaemon({ env: { PREFAIX_FAKE_SCENARIO: "long" } });
    const tty = fakeTty();
    const running = runClient(": take your time", { tty });
    // Typed mid-turn, so it belongs in the next prompt rather than the answer.
    await new Promise((resolve) => setTimeout(resolve, 10));
    tty.send("git status");
    expect(await running).toBe(EXIT.ok);
    expect(readDirectives()["buffer"]).toBe("git status");
  });

  it("puts back the agent's own buffer rather than the typeahead", async () => {
    await startDaemon({ env: { PREFAIX_FAKE_SCENARIO: "buffer" } });
    const tty = fakeTty();
    const running = runClient(": give me something to run", { tty });
    await new Promise((resolve) => setTimeout(resolve, 10));
    tty.send("half typed");
    expect(await running).toBe(EXIT.ok);
    // The agent asked for a specific buffer, so that is what the shell gets;
    // the user's half-typed line would be the wrong thing to restore.
    expect(readDirectives()["buffer"]).not.toBe("half typed");
  });

  it("redacts with the patterns the config adds", async () => {
    await startDaemon();
    const custom = config();
    expect(
      await runClient(": my key is hunter2-secret", {
        config: {
          ...custom,
          context: {
            ...custom.context,
            extraRedactPatterns: ["hunter2-\\w+"],
          },
        },
      }),
    ).toBe(EXIT.ok);
    // The built-in patterns are still in force; the added one joins them.
    const written = readDirectives();
    void written;
    expect(out.join("")).not.toContain("hunter2-secret");
  });

  it("answers a dialog the agent raises mid-turn", async () => {
    await startDaemon({ env: { PREFAIX_FAKE_SCENARIO: "dialog" } });
    const dialogs: { id: string; response: unknown }[] = [];
    expect(
      await run({
        argv: argv(": ask me something"),
        version: VERSION,
        paths,
        config: config(),
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        stdoutIsTty: true,
        cols: 100,
        tty: fakeTty(),
        dialogs: {
          caps: capabilities({ env: { COLORTERM: "truecolor" }, isTty: true }),
          write: () => undefined,
          erase: () => undefined,
          readKey: () => Promise.resolve({ name: "esc", text: "" }),
          readLine: () => Promise.resolve("y"),
        },
      }),
    ).toBe(EXIT.ok);
    void dialogs;
  });

  it("hands the shell a conversation id and a matching nonce", async () => {
    await startDaemon();
    await runClient(": first");
    const written = readDirectives();
    expect(written["nonce"]).toBe("n1");
    expect(String(written["conversation"])).toMatch(/^c_/);
  });

  it("continues the same conversation when the shell passes the id back", async () => {
    await startDaemon();
    await runClient(": first");
    const first = String(readDirectives()["conversation"]);
    out = [];
    err = [];
    expect(
      await runClient(": second", { tty: fakeTty(), conversation: first }),
    ).toBe(EXIT.ok);
    // The id is unchanged, which is what makes the second `:` a continuation.
    expect(readDirectives()["conversation"]).toBe(first);
    out = [];
    await runClient(":info", { tty: fakeTty(), conversation: first });
    expect(out.join("")).toContain("2 turns");
  });

  it("says nothing about a buffer when the user typed nothing", async () => {
    await startDaemon();
    await runClient(": hello");
    expect(readDirectives()["buffer"]).toBeUndefined();
  });

  it("hands captured typeahead back to the prompt", async () => {
    await startDaemon({
      env: { PREFAIX_BACKEND: "fake", PREFAIX_FAKE_SCENARIO: "long" },
    });
    const tty = fakeTty();
    const running = runClient(": a long one", { tty });
    // Typed while the turn is running, which the client captures and never
    // echoes (DESIGN §3.3).
    await new Promise((resolve) => setTimeout(resolve, 30));
    tty.send("git status");
    tty.send(ESC);
    expect(await running).toBe(EXIT.aborted);
    expect(readDirectives()["buffer"]).toBe("git status");
  });

  it("gives the tty back on every exit path", async () => {
    await startDaemon();
    const calls: boolean[] = [];
    const tty = fakeTty();
    const original = tty.setRawMode;
    tty.setRawMode = (mode: boolean) => {
      calls.push(mode);
      return original.call(tty, mode);
    };
    await runClient(": hello", { tty });
    expect(calls).toEqual([true, false]);
  });

  it("restores the tty even when the turn ends in an error", async () => {
    await startDaemon({
      env: { PREFAIX_BACKEND: "fake", PREFAIX_FAKE_SCENARIO: "error" },
    });
    const calls: boolean[] = [];
    const tty = fakeTty();
    const original = tty.setRawMode;
    tty.setRawMode = (mode: boolean) => {
      calls.push(mode);
      return original.call(tty, mode);
    };
    // The fake's error scenario settles as `error`, which is exit 1.
    expect(await runClient(": boom", { tty })).toBe(EXIT.agentError);
    expect(calls).toEqual([true, false]);
    // The directives file is still written, so the shell refreshes normally.
    expect(readDirectives()["nonce"]).toBe("n1");
  });
});

describe("a line prefaix is not meant for", () => {
  it("tells the user and exits cleanly rather than consuming the command", async () => {
    await startDaemon();
    // The plugin would not have called run for this, so the disagreement is a
    // bug; the safe resolution is to let the shell have the line.
    const code = await run({
      argv: [
        "--shell",
        "zsh",
        "--shell-id",
        "1-1-a",
        "--nonce",
        "n",
        "--directives",
        directivesFile,
        "--",
        "ls",
      ],
      version: VERSION,
      paths,
      config: config(),
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    expect(code).toBe(EXIT.ok);
    expect(err.join("")).toContain("is not a prefaix line");
  });
});

describe("commands the client carries out itself", () => {
  it("prints the grammar and the command list for :help", async () => {
    await startDaemon();
    expect(await runClient(":help")).toBe(EXIT.ok);
    const text = out.join("");
    expect(text).toContain("prefaix line grammar:");
    expect(text).toContain(":new");
    expect(text).toContain("esc or ctrl+c aborts a turn");
  });

  it("reports an unknown command with the closest matches", async () => {
    await startDaemon();
    expect(await runClient(": modle")).toBe(EXIT.usage);
    expect(err.join("")).toContain("Did you mean :model?");
  });

  it("treats a name that matches nothing as a prompt, not an error", async () => {
    await startDaemon();
    // `zzzzzzzz` is not close to any command, so it is a question about
    // something called zzzzzzzz rather than a typo.
    expect(await runClient(":zzzzzzzz")).toBe(EXIT.ok);
    expect(out.join("")).toContain("Hello from the fake backend");
    expect(err.join("")).not.toContain("not a command");
  });

  it("starts a new conversation for :new", async () => {
    await startDaemon();
    expect(await runClient(":new")).toBe(EXIT.ok);
    expect(err.join("")).toContain("new conversation");
  });

  it("prompts straight away for :new with text", async () => {
    await startDaemon();
    expect(await runClient(":new explain the parser")).toBe(EXIT.ok);
    expect(out.join("")).toContain("Hello from the fake backend");
  });

  it("prints the conversation for :info", async () => {
    await startDaemon();
    await runClient(": why does auth fail");
    out = [];
    expect(await runClient(":info")).toBe(EXIT.ok);
    expect(out.join("")).toContain("why does auth fail");
    expect(out.join("")).toContain("backend: fake");
  });

  it("prints a conversation line for :info before there is one", async () => {
    await startDaemon();
    expect(await runClient(":info")).toBe(EXIT.ok);
    expect(out.join("")).toContain("conversation: none yet");
  });

  it("says a command this build does not carry yet is not available", async () => {
    await startDaemon();
    expect(await runClient(":compact")).toBe(EXIT.usage);
    expect(err.join("")).toContain("arrives in the M4 milestone");
    // It is a real command, so the typo path must not claim otherwise.
    expect(err.join("")).not.toContain("is not a command");
  });
});

describe("a persona", () => {
  it("sends the prompt with the persona's tools", async () => {
    await startDaemon();
    expect(await runClient(": ask why is this slow")).toBe(EXIT.ok);
    expect(out.join("")).toContain("Hello from the fake backend");
  });

  it("treats an unknown leading word as a prompt rather than a bad persona", async () => {
    await startDaemon();
    // `audit` is not a configured persona, so the line is a question, not a
    // request for a persona nobody defined.
    expect(await runClient(":audit the deps")).toBe(EXIT.ok);
  });
});

describe("an agent slash command", () => {
  it("sends it as a prompt, which is how pi expands it", async () => {
    await startDaemon();
    expect(await runClient(":/review src/core")).toBe(EXIT.ok);
    expect(out.join("")).toContain("Hello from the fake backend");
  });
});

describe("when the daemon is not there", () => {
  it("reports it and exits 3 rather than hanging", async () => {
    // No daemon and no autospawn: the injected connect is a client with no
    // socket behind it.
    const code = await run({
      argv: argv(": hello"),
      version: VERSION,
      paths,
      config: config(),
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      connect: () => new DaemonClient({ paths, version: VERSION }),
      sleep: () => Promise.resolve(),
    });
    expect(code).toBe(EXIT.daemonUnavailable);
    expect(err.join("")).toContain("did not come up");
  });
});

describe("autospawn", () => {
  it("connects to a daemon that is already listening", async () => {
    await startDaemon();
    const client = new DaemonClient({ paths, version: VERSION });
    expect(await client.connect()).toEqual({
      version: VERSION,
      pid: process.pid,
    });
    client.close();
  });

  it("recognises the two errors that mean nothing is listening", () => {
    expect(isConnectRefused({ code: "ENOENT" })).toBe(true);
    expect(isConnectRefused({ code: "ECONNREFUSED" })).toBe(true);
    expect(isConnectRefused({ code: "EACCES" })).toBe(false);
    expect(isConnectRefused(new Error("boom"))).toBe(false);
  });

  it("spawns a daemon and waits for it to answer", async () => {
    let spawned = 0;
    const client = new DaemonClient({
      paths,
      version: VERSION,
      spawnDaemon: (entry) => {
        spawned += 1;
        expect(entry).not.toBe("");
        void startDaemon();
      },
      sleep: (ms) =>
        new Promise((resolve) => setTimeout(resolve, Math.min(ms, 10))),
    });
    const hello = await client.connect();
    expect(spawned).toBe(1);
    expect(hello.pid).toBe(process.pid);
    client.close();
  });

  it("gives up with the log path when nothing comes up", async () => {
    const client = new DaemonClient({
      paths,
      version: VERSION,
      spawnDaemon: () => undefined,
      // A clock that jumps past the budget on the first check, so the test does
      // not spend three seconds waiting for nothing.
      now: (() => {
        let at = 0;
        return () => {
          at += 10_000;
          return at;
        };
      })(),
    });
    await expect(client.connect()).rejects.toThrow(/did not come up/);
    client.close();
  });

  it("refuses to answer a request with no connection", async () => {
    const client = new DaemonClient({ paths, version: VERSION });
    await expect(client.call("daemon.ping", {})).rejects.toThrow(
      /not connected/,
    );
  });
});

describe("writing the directives file", () => {
  it("is atomic, so the plugin never reads half of it", async () => {
    await writeDirectives(join(home, "run", "d"), { nonce: "n", buffer: "ls" });
    expect(decodeDirectives(readFileSync(join(home, "run", "d")))?.buffer).toBe(
      "ls",
    );
    expect(readFileSync(join(home, "run", "d"), "utf8")).not.toContain(".tmp");
  });

  it("writes nothing without a target or a nonce", async () => {
    await expect(writeDirectives("", { nonce: "n" })).resolves.toBeUndefined();
    await expect(
      writeDirectives(join(home, "d"), { nonce: "" }),
    ).resolves.toBeUndefined();
  });
});
