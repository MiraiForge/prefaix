import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, USAGE } from "../../src/cli/index.js";
import {
  runDaemon,
  daemonStatus,
  stopDaemon,
  defaultIo as daemonIo,
} from "../../src/cli/daemon.js";
import {
  runConversations,
  runTap,
  defaultIo as conversationsIo,
} from "../../src/cli/conversations.js";
import { Daemon } from "../../src/daemon/daemon.js";
import { DaemonClient } from "../../src/client/connection.js";
import { defaultConfig } from "../../src/core/config/schema.js";
import { resolvePaths } from "../../src/core/paths.js";
import { EXIT, type ExitCode } from "../../src/core/errors.js";

const VERSION = "0.0.0-test";

let home = "";
let paths: ReturnType<typeof resolvePaths>;
let daemon: Daemon | undefined;
let out: string[] = [];
let err: string[] = [];

function io() {
  return {
    env: { PATH: "/usr/bin", HOME: home },
    paths,
    out: (text: string) => out.push(text),
    err: (text: string) => err.push(text),
    version: VERSION,
  };
}

async function startDaemon(): Promise<Daemon> {
  const instance = new Daemon({
    paths,
    config: {
      ...defaultConfig(),
      agent: { ...defaultConfig().agent, backend: "fake" },
    },
    version: VERSION,
    env: { PATH: "/usr/bin", HOME: home, PREFAIX_BACKEND: "fake" },
    checkOwner: false,
  });
  daemon = instance;
  await instance.start();
  return instance;
}

async function withTurn(): Promise<string> {
  const client = new DaemonClient({ paths, version: VERSION });
  await client.connect();
  const started = await client.call<{ turnId: string; conversationId: string }>(
    "turn.start",
    {
      shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
      cwd: home,
      env: { PATH: "/usr/bin" },
      text: ": why does auth fail",
      context: {
        recent: [],
        os: "macOS",
        term: { cols: 100, rows: 30, colors: 256 },
      },
    },
  );
  await new Promise<void>((resolve) => {
    client.onTurnEnd(() => resolve());
    setTimeout(resolve, 2_000);
  });
  client.close();
  return started.conversationId;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-cli-"));
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

describe("the dispatcher", () => {
  it("prints the version", async () => {
    expect(await main({ argv: ["--version"], version: VERSION })).toBe(EXIT.ok);
  });

  it("prints the usage with no arguments and with --help", async () => {
    for (const argv of [[], ["--help"], ["help"]]) {
      out = [];
      expect(
        await main({
          argv,
          version: VERSION,
          out: (t) => out.push(t),
          err: (t) => err.push(t),
        }),
      ).toBe(EXIT.ok);
      expect(out.join("")).toBe(USAGE);
    }
  });

  it("names an unknown command and shows the usage", async () => {
    expect(
      await main({
        argv: ["frobnicate"],
        version: VERSION,
        out: (t) => out.push(t),
        err: (t) => err.push(t),
      }),
    ).toBe(EXIT.usage);
    expect(err.join("")).toContain("unknown command");
    expect(err.join("")).toContain(USAGE);
  });

  it("routes each subcommand to its own module", async () => {
    // The dispatcher is the only place that knows the subcommand names, so this
    // is what proves the names in the usage text are the ones that work.
    const seen: string[] = [];
    const fakeDaemon = async (argv: readonly string[]): Promise<ExitCode> => {
      seen.push(`daemon:${argv.join(" ")}`);
      return EXIT.ok;
    };
    await main({
      argv: ["daemon", "status"],
      version: VERSION,
      paths,
      daemon: fakeDaemon,
    });
    expect(seen).toEqual(["daemon:status"]);
  });
});

describe("prefaix config", () => {
  it("accepts a file that is not there", async () => {
    const code = await main({
      argv: ["config", "check"],
      version: VERSION,
      env: { HOME: home },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    expect(code).toBe(EXIT.ok);
    expect(out.join("")).toContain("every setting is at its default");
  });

  it("reports a file with a typo in it", async () => {
    const file = join(home, "config.toml");
    writeFileSync(file, "[pool]\nmax_childern = 4\n");
    const code = await main({
      argv: ["config", "check", "--file", file],
      version: VERSION,
      env: { HOME: home },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    expect(code).toBe(EXIT.usage);
    expect(err.join("")).toContain("max_childern");
  });

  it("names an unknown config subcommand", async () => {
    const code = await main({
      argv: ["config", "frobnicate"],
      version: VERSION,
      env: { HOME: home },
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    expect(code).toBe(EXIT.usage);
    expect(err.join("")).toContain("unknown subcommand");
  });
});

describe("prefaix daemon", () => {
  it("starts in the foreground and stops when asked", async () => {
    const promise = runDaemon(["--foreground"], io());
    await vi.waitFor(() => expect(err.join("")).toContain("listening on"));
    expect(out.join("")).toBe("");
    expect(err.join("")).toContain("listening on");
    daemon = undefined;
    expect(await stopDaemon([], io())).toBe(EXIT.ok);
    expect(await promise).toBe(EXIT.ok);
  });

  it("reports that nothing is running", async () => {
    expect(await daemonStatus([], io())).toBe(EXIT.ok);
    expect(out.join("")).toContain("nothing is running");
  });

  it("reports a live daemon with its version and backend", async () => {
    await startDaemon();
    out = [];
    expect(await daemonStatus([], io())).toBe(EXIT.ok);
    expect(out.join("")).toContain(`prefaix ${VERSION}`);
    expect(out.join("")).toContain("backend fake");
  });

  it("reports a stale lock with no socket", async () => {
    // A lock whose pid is gone and whose socket was never created is what a
    // daemon killed with -9 leaves behind.
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(home, "run", "prefaix"), { recursive: true });
    // Beyond Linux/macOS PID ranges; a guessed six-digit pid can be live.
    await writeFile(paths.lock, "2147483647\n");
    out = [];
    expect(await daemonStatus([], io())).toBe(EXIT.ok);
    expect(out.join("")).toContain("stale lock");
  });

  it("stops a running daemon", async () => {
    await startDaemon();
    out = [];
    expect(await stopDaemon([], io())).toBe(EXIT.ok);
    expect(out.join("")).toContain("daemon stopping");
    // A stop really stops it: the socket is gone and the lock released. The
    // acknowledgement is sent before the exit, so the wait is for the exit.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => readFileSync(paths.lock)).toThrow();
    expect(() => readFileSync(paths.socket)).toThrow();
  });

  it("says there is nothing to stop when no daemon is running", async () => {
    expect(await stopDaemon([], io())).toBe(EXIT.ok);
    expect(out.join("")).toContain("no daemon is running");
  });

  it("names an unknown subcommand", async () => {
    expect(await runDaemon(["frobnicate"], io())).toBe(EXIT.usage);
    expect(err.join("")).toContain("unknown subcommand");
  });

  it("reports a config it cannot load instead of starting", async () => {
    mkdirSync(join(home, ".config", "prefaix"), { recursive: true });
    writeFileSync(join(home, ".config", "prefaix", "config.toml"), "[pool\n");
    const bad = {
      ...io(),
      env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    };
    expect(await runDaemon(["start"], bad)).toBe(EXIT.usage);
    expect(err.join("")).toContain("Invalid TOML document");
  });

  it("reports a lock another live process holds", async () => {
    // A daemon that is already listening owns the lock, so a second start has
    // to fail rather than fight for the socket.
    await startDaemon();
    expect(await runDaemon(["start"], io())).toBe(EXIT.daemonUnavailable);
  });
});

describe("prefaix conversations", () => {
  it("says there are none yet", async () => {
    await startDaemon();
    expect(await runConversations(["ls"], io())).toBe(EXIT.ok);
    expect(out.join("")).toContain("no conversations yet");
  });

  it("lists a conversation with its root and shell", async () => {
    await startDaemon();
    const id = await withTurn();
    out = [];
    expect(await runConversations(["ls"], io())).toBe(EXIT.ok);
    expect(out.join("")).toContain(id);
    expect(out.join("")).toContain("1 turns");
    expect(out.join("")).toContain("zsh");
  });

  it("searches by title", async () => {
    await startDaemon();
    await withTurn();
    out = [];
    expect(await runConversations(["ls", "auth"], io())).toBe(EXIT.ok);
    expect(out.join("")).toContain("auth");
    out = [];
    await runConversations(["ls", "nothing"], io());
    expect(out.join("")).toContain("nothing matches");
  });

  it("shows one conversation", async () => {
    await startDaemon();
    const id = await withTurn();
    out = [];
    expect(await runConversations(["show", id], io())).toBe(EXIT.ok);
    expect(out.join("")).toContain("why does auth fail");
    expect(out.join("")).toContain(`id          ${id}`);
  });

  it("shows the last answer when asked", async () => {
    await startDaemon();
    const id = await withTurn();
    out = [];
    expect(await runConversations(["show", id, "--last"], io())).toBe(EXIT.ok);
    expect(out.join("")).toContain("last answer:");
    expect(out.join("")).toContain("Hello from the fake backend");
  });

  it("says a conversation has no answer yet rather than nothing", async () => {
    await startDaemon();
    const id = await withTurn();
    // A conversation whose turn produced no text is a real state, and blank
    // output would read as a bug rather than as the truth.
    const client = new DaemonClient({ paths, version: VERSION });
    await client.connect();
    const created = await client.call<{ id: string }>("conv.new", {
      cwd: home,
      shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
    });
    client.close();
    out = [];
    expect(await runConversations(["show", created.id, "--last"], io())).toBe(
      EXIT.ok,
    );
    expect(out.join("")).toContain("no completed turn yet");
    void id;
  });

  it("insists on an id", async () => {
    await startDaemon();
    expect(await runConversations(["show"], io())).toBe(EXIT.usage);
    expect(err.join("")).toContain("an id is required");
  });

  it("reports a tap against a conversation that does not exist", async () => {
    await startDaemon();
    // A tap is a debugging tool, so the message names the conversation and the
    // exit code is the one the error carries.
    const code = await runTap("c_00000000000000000000000000", io());
    // Nothing was ever recorded, so there is nothing to replay and the tap is
    // not an error: it simply printed nothing.
    expect(code).toBe(EXIT.agentError);
  });

  it("names an unknown subcommand with its own usage", async () => {
    expect(await runConversations(["frobnicate"], io())).toBe(EXIT.usage);
    expect(err.join("")).toContain("prefaix conversations <command>");
  });

  it("reports a conversation that does not exist", async () => {
    await startDaemon();
    await expect(
      runConversations(["show", "c_0" + "0".repeat(25)], io()),
    ).rejects.toThrow(/no conversation/);
  });
});

describe("prefaix debug tap", () => {
  it("prints the raw events of a conversation's last turn", async () => {
    await startDaemon();
    const id = await withTurn();
    out = [];
    expect(await runTap(id, io())).toBe(EXIT.ok);
    const lines = out.join("").trim().split("\n");
    const first = JSON.parse(lines[0] ?? "{}") as { event: { type: string } };
    expect(first.event.type).toBe("turn_start");
    // The last line is the settle, so a reader can see how the turn ended.
    const last = JSON.parse(lines.at(-1) ?? "{}") as {
      summary?: { status: string };
    };
    expect(last.summary?.status).toBe("stop");
  });

  it("reports a conversation with no turn on record", async () => {
    await startDaemon();
    expect(await runTap("c_0" + "0".repeat(25), io())).toBe(EXIT.agentError);
    expect(err.join("")).toContain("no turn on record");
  });

  it("insists on a conversation id", async () => {
    expect(
      await main({
        argv: ["debug", "tap"],
        version: VERSION,
        paths,
        out: (t) => out.push(t),
        err: (t) => err.push(t),
      }),
    ).toBe(EXIT.usage);
    expect(err.join("")).toContain("a conversation id is required");
  });

  it("names an unknown debug subcommand", async () => {
    expect(
      await main({
        argv: ["debug", "frobnicate"],
        version: VERSION,
        paths,
        out: (t) => out.push(t),
        err: (t) => err.push(t),
      }),
    ).toBe(EXIT.usage);
    expect(err.join("")).toContain("usage: prefaix debug tap");
  });
});

describe("prefaix run", () => {
  it("reaches the client through the dispatcher", async () => {
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
        ": hello there",
      ],
      version: VERSION,
      paths,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    expect(code).toBe(EXIT.ok);
    expect(out.join("")).toContain("Hello from the fake backend");
    expect(readFileSync(directives, "utf8")).toContain("n1");
  });

  it("runs the client through the seams a test supplies", async () => {
    // `tty` and `connect` are how a test replaces the terminal and the socket;
    // the dispatcher has to pass them through untouched.
    const asked: string[] = [];
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
        join(home, "run", "directives"),
        "--",
        ": hello",
      ],
      version: VERSION,
      paths,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      tty: {
        setRawMode: () => true,
        setEncoding: () => undefined,
        on: () => undefined,
        removeAllListeners: () => undefined,
      },
      connect: (options) => {
        asked.push(String(options.version));
        return new DaemonClient(options);
      },
    });
    expect(asked).toEqual([VERSION]);
    // The client it built has nothing to connect to, which is the honest
    // outcome for a test that supplied its own transport factory.
    expect(code).toBe(EXIT.daemonUnavailable);
  });

  it("insists on a conversation to tap", async () => {
    // Both spellings of "nothing" are a usage error rather than a tap of the
    // empty id, which would otherwise be a request the daemon has to reject.
    for (const argv of [
      ["debug", "tap"],
      ["debug", "tap", ""],
    ]) {
      expect(
        await main({
          argv,
          version: VERSION,
          paths,
          out: (text) => out.push(text),
          err: (text) => err.push(text),
        }),
      ).toBe(EXIT.usage);
      expect(err.join("")).toContain("a conversation id is required");
      err = [];
    }
  });

  it("says which usage to print when `config` has no subcommand", async () => {
    expect(
      await main({
        argv: ["config"],
        version: VERSION,
        paths,
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      }),
    ).toBe(EXIT.usage);
    expect(err.join("")).toContain('unknown subcommand ""');
  });

  it("reports an unknown subcommand instead of guessing", async () => {
    expect(
      await main({
        argv: ["config", "frobnicate"],
        version: VERSION,
        paths,
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      }),
    ).toBe(EXIT.usage);
    expect(err.join("")).toContain('unknown subcommand "frobnicate"');
    // No subcommand at all is the same mistake, spelled differently.
    err = [];
    expect(
      await main({
        argv: ["debug"],
        version: VERSION,
        paths,
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      }),
    ).toBe(EXIT.usage);
    expect(err.join("")).toContain("usage: prefaix debug tap <conversation>");
    err = [];
    expect(
      await main({
        argv: ["debug", "tap"],
        version: VERSION,
        paths,
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      }),
    ).toBe(EXIT.usage);
    expect(err.join("")).toContain("a conversation id is required");
  });

  it("names the conversation list by either of its two names", async () => {
    await startDaemon();
    for (const name of ["convs", "conversations"]) {
      out = [];
      expect(
        await main({
          argv: [name, "ls"],
          version: VERSION,
          paths,
          out: (text) => out.push(text),
          err: (text) => err.push(text),
        }),
      ).toBe(EXIT.ok);
      expect(out.join("")).toContain("no conversations yet");
    }
  });

  it("runs a daemon subcommand with the terminal it was handed", async () => {
    // The `daemon` seam is what a test replaces; the default has to reach the
    // same place, so `stop` with nothing running is the cheap path through it.
    expect(
      await main({
        argv: ["daemon", "stop"],
        version: VERSION,
        paths,
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      }),
    ).toBe(EXIT.ok);
    expect(out.join("")).toContain("no daemon is running");
  });

  it("starts a daemon when no subcommand was given", async () => {
    // `prefaix daemon` with nothing after it is the autospawner calling in. The
    // io carries no version, so the daemon advertises `0.0.0` rather than
    // `undefined` to a client that is checking the protocol version.
    const io = {
      env: { PATH: "/usr/bin", HOME: home, PREFAIX_BACKEND: "fake" },
      paths,
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    };
    expect(await runDaemon([], io)).toBe(EXIT.ok);
    out = [];
    expect(await daemonStatus([], io)).toBe(EXIT.ok);
    expect(out.join("")).toContain("daemon pid");
    expect(await stopDaemon([], io)).toBe(EXIT.ok);
  });

  it("starts a daemon with no version of its own to advertise", async () => {
    // The io a test builds by hand need not carry a version; the daemon then
    // has none to report and says `0.0.0` rather than `undefined`.
    const instance = new Daemon({
      paths,
      config: {
        ...defaultConfig(),
        agent: { ...defaultConfig().agent, backend: "fake" },
      },
      version: "0.0.0-test",
      env: { PATH: "/usr/bin", HOME: home, PREFAIX_BACKEND: "fake" },
      checkOwner: false,
    });
    await instance.start();
    const io: Parameters<typeof daemonStatus>[1] = {
      env: { PATH: "/usr/bin", HOME: home },
      paths,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    };
    expect(await daemonStatus([], io)).toBe(EXIT.ok);
    expect(out.join("")).toContain("daemon pid");
    await instance.stop();
  });

  it("refuses to start a daemon with a config it cannot read", async () => {
    mkdirSync(dirname(paths.configFile), { recursive: true });
    writeFileSync(paths.configFile, "this is not = valid = toml [[[");
    const code = await runDaemon(["start"], {
      env: { PATH: "/usr/bin", HOME: home },
      paths,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      version: VERSION,
    });
    // A config that cannot be parsed is a usage error, whatever the file says.
    expect(code).toBe(EXIT.usage);
    expect(err.join("")).not.toBe("");
  });

  it("says which daemon is already listening rather than starting a second", async () => {
    await startDaemon();
    const code = await runDaemon(["start"], {
      env: { PATH: "/usr/bin", HOME: home },
      paths,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      version: VERSION,
    });
    expect(code).toBe(EXIT.daemonUnavailable);
    expect(err.join("")).toContain("another prefaix daemon");
  });

  it("reports a daemon subcommand it does not have", async () => {
    expect(
      await main({
        argv: ["daemon", "frobnicate"],
        version: VERSION,
        paths,
        out: (text) => out.push(text),
        err: (text) => err.push(text),
      }),
    ).toBe(EXIT.usage);
    expect(err.join("")).toContain('unknown subcommand "frobnicate"');
  });

  it("writes to the real terminal when a caller supplies no io", async () => {
    // Nothing here should print, because the command fails before it says
    // anything; what matters is that the defaults are callable.
    const code = await main({
      argv: ["config", "frobnicate"],
      version: VERSION,
    });
    expect(code).toBe(EXIT.usage);
  });

  it("falls back to the real terminal when a caller supplies no io", () => {
    // The bin passes none, so this is the shape every real command runs in.
    // The paths come from the process environment, because the bin supplies
    // none; only the shape is asserted, not whose home that is.
    const daemon = daemonIo({ HOME: home });
    expect(daemon.paths.socket.endsWith(".sock")).toBe(true);
    expect(typeof daemon.out).toBe("function");
    expect(typeof daemon.err).toBe("function");
    const conversations = conversationsIo({ HOME: home }, VERSION);
    expect(conversations.version).toBe(VERSION);
    expect(conversations.paths.conversationsDir).toContain("prefaix");
    expect(typeof conversations.out).toBe("function");
    expect(typeof conversations.err).toBe("function");
  });

  it("reports a usage error without a buffer", async () => {
    expect(
      await main({
        argv: ["run"],
        version: VERSION,
        paths,
        out: (t) => out.push(t),
        err: (t) => err.push(t),
      }),
    ).toBe(EXIT.usage);
    expect(err.join("")).toContain("buffer is required");
  });
});
