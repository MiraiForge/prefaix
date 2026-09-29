import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Daemon, daemonUnavailable } from "../../src/daemon/daemon.js";
import { resolvePaths } from "../../src/core/paths.js";
import { defaultConfig } from "../../src/core/config/schema.js";
import { lockIsStale, tryLock, LockHeldError } from "../../src/daemon/lock.js";
import { EventRing, TurnManager } from "../../src/daemon/turns.js";
import { isErrorInfo } from "../../src/core/protocol.js";
import { TestClient } from "../support/client.js";
import type { PrefaixConfig } from "../../src/core/config/schema.js";
import type { TurnStartParams } from "../../src/core/protocol.js";

let home = "";
let paths: ReturnType<typeof resolvePaths>;

function config(overrides: Partial<PrefaixConfig> = {}): PrefaixConfig {
  const base = defaultConfig();
  return { ...base, ...overrides };
}

function turnParams(overrides: Partial<TurnStartParams> = {}): TurnStartParams {
  return {
    shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
    cwd: home,
    env: { PATH: "/usr/bin", HOME: home },
    text: ": hello",
    context: {
      recent: [{ cmd: "ls", exit: 0 }],
      os: "macOS 27.0",
      term: { cols: 100, rows: 30, colors: 256 },
    },
    ...overrides,
  };
}

const daemons: Daemon[] = [];
const clients: TestClient[] = [];

async function startDaemon(
  overrides: Partial<PrefaixConfig> = {},
  options: {
    idleMinutes?: number;
    onIdleCheck?: () => Promise<boolean>;
    /** The daemon's own environment; the fake backend reads its scenario here. */
    env?: Record<string, string>;
  } = {},
): Promise<Daemon> {
  const daemon = new Daemon({
    paths,
    config: config({
      agent: { ...defaultConfig().agent, backend: "fake" },
      ...overrides,
    }),
    version: "0.0.0-test",
    env: { PATH: "/usr/bin", HOME: home, ...options.env },
    checkOwner: false,
  });
  daemons.push(daemon);
  await daemon.start();
  return daemon;
}

function scenario(name: string): Record<string, string> {
  return { PREFAIX_BACKEND: "fake", PREFAIX_FAKE_SCENARIO: name };
}

async function connect(): Promise<TestClient> {
  const client = await TestClient.open(paths.socket);
  clients.push(client);
  await client.waitFor((message) => message.t === "hello");
  return client;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-daemon-"));
  paths = resolvePaths({
    env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    home,
  });
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  for (const daemon of daemons.splice(0)) {
    await daemon.stop();
  }
  rmSync(home, { recursive: true, force: true });
});

describe("the daemon lifecycle", () => {
  it("listens on a 0600 socket in a 0700 runtime dir", async () => {
    await startDaemon();
    expect(statSync(paths.runtimeDir).mode & 0o777).toBe(0o700);
    expect(statSync(paths.socket).mode & 0o777).toBe(0o600);
  });

  it("answers hello with its version and pid", async () => {
    const daemon = await startDaemon();
    const client = await connect();
    expect(client.hello).toMatchObject({
      t: "hello",
      v: 1,
      version: "0.0.0-test",
      pid: process.pid,
    });
    const ping = await client.call("daemon.ping", {});
    expect(ping.ok).toBe(true);
    expect(ping.data).toMatchObject({ version: "0.0.0-test" });
    expect(daemon.paths.socket).toBe(paths.socket);
  });

  it("refuses a client that speaks another protocol version", async () => {
    await startDaemon();
    const bad = await TestClient.open(paths.socket, { v: 99 });
    clients.push(bad);
    // The daemon answers with an error and hangs up, so there is no request to
    // correlate against: the client has to be able to read a bare refusal.
    const refusal = await bad.waitFor((message) => message.t === "res");
    expect(refusal).toMatchObject({
      ok: false,
      error: { code: "PROTOCOL_MISMATCH" },
    });
    await waitFor(() => bad.closed, 2_000);
  });

  it("refuses a request that arrives before hello", async () => {
    await startDaemon();
    const client = await TestClient.open(paths.socket, { sendHello: false });
    clients.push(client);
    const result = await client.call("daemon.ping", {});
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain("hello");
  });

  it("ignores a line that is not a message this protocol defines", async () => {
    await startDaemon();
    const client = await connect();
    client.writeRaw('{"t":"req","id":"r9","op":"no.such.op","params":{}}\n');
    client.writeRaw("not json at all\n");
    client.writeRaw('"a bare string"\n');
    // Silence is the answer: a line this build does not understand must not be
    // answered, because any reply would be a guess at what was meant.
    const ping = await client.call("daemon.ping", {});
    expect(ping.ok).toBe(true);
    expect(
      client.events().filter((message) => message.t === "res"),
    ).toHaveLength(1);
  });

  it("leaves the socket and the lock behind on stop", async () => {
    const daemon = await startDaemon();
    await daemon.stop();
    expect(() => statSync(paths.socket)).toThrow();
  });
});

describe("turns", () => {
  it("creates a conversation and streams a turn to a stop", async () => {
    const daemon = await startDaemon();
    const client = await connect();
    const started = await client.call("turn.start", turnParams());
    expect(started.ok).toBe(true);
    const { turnId, conversationId } = started.data as {
      turnId: string;
      conversationId: string;
    };
    expect(conversationId).toMatch(/^c_/);

    const end = await client.waitForTurnEnd();
    expect(end.summary.status).toBe("stop");
    const events = client.eventsOfType("evt");
    expect(events.length).toBeGreaterThan(3);
    // seq is monotonic per turn, which is what makes a gap detectable.
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(events.at(-1)?.e.type).toBe("settled");
    expect(turnId).toMatch(/^t_/);
    expect(daemon.turns.count).toBe(0);
  });

  it("continues the same conversation on a second turn", async () => {
    await startDaemon();
    const client = await connect();
    const first = await client.call(
      "turn.start",
      turnParams({ text: ": first" }),
    );
    await client.waitForTurnEnd();
    const { conversationId } = first.data as { conversationId: string };
    client.clearEvents();
    const second = await client.call(
      "turn.start",
      turnParams({ text: ": second", conversationId }),
    );
    const end = await client.waitForTurnEnd();
    expect((second.data as { conversationId: string }).conversationId).toBe(
      conversationId,
    );
    expect(end.summary.status).toBe("stop");
    const record = await client.call("conv.get", { conversationId });
    expect((record.data as { turns: number }).turns).toBe(2);
  });

  it("gives a new conversation its own id and title", async () => {
    await startDaemon();
    const client = await connect();
    const first = await client.call(
      "turn.start",
      turnParams({ text: ": fix the failing auth test" }),
    );
    await client.waitForTurnEnd();
    const { conversationId } = first.data as { conversationId: string };
    const second = await client.call(
      "turn.start",
      turnParams({ text: ": something else", newConversation: true }),
    );
    const { conversationId: other } = second.data as { conversationId: string };
    await client.waitForTurnEnd();
    expect(other).not.toBe(conversationId);
    const record = await client.call("conv.get", { conversationId: other });
    expect((record.data as { title: string }).title).toBe("something else");
  });

  it("refuses a second turn while one is running", async () => {
    await startDaemon({ pool: { ...defaultConfig().pool, spare: false } });
    const client = await connect();
    const other = await connect();
    const first = await client.call("turn.start", turnParams());
    const { conversationId } = first.data as { conversationId: string };
    // The same conversation from a second shell is the busy case.
    const busy = await other.call(
      "turn.start",
      turnParams({
        conversationId,
        shell: { kind: "zsh", version: "5.9", shellId: "2-2-b", pid: 2 },
      }),
    );
    expect(busy.ok).toBe(false);
    expect(busy.error?.code).toBe("CONVERSATION_BUSY");
    await client.waitForTurnEnd();
  });

  it("runs two conversations at once", async () => {
    await startDaemon();
    const one = await connect();
    const two = await connect();
    const a = await one.call("turn.start", turnParams({ text: ": one" }));
    const b = await two.call("turn.start", turnParams({ text: ": two" }));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const [endA, endB] = await Promise.all([
      one.waitForTurnEnd(),
      two.waitForTurnEnd(),
    ]);
    expect(endA.summary.turnId).not.toBe(endB.summary.turnId);
  });

  it("aborts on turn.abort and settles as aborted", async () => {
    await startDaemon({}, { env: scenario("long") });
    const client = await connect();
    const started = await client.call("turn.start", turnParams());
    const { turnId } = started.data as { turnId: string };
    const aborted = await client.call("turn.abort", { turnId });
    expect(aborted.ok).toBe(true);
    const end = await client.waitForTurnEnd();
    expect(end.summary.status).toBe("aborted");
  });

  it("aborts when the client socket closes mid-turn", async () => {
    const daemon = await startDaemon({}, { env: scenario("long") });
    const client = await TestClient.open(paths.socket);
    await client.waitFor((message) => message.t === "hello");
    await client.call("turn.start", turnParams());
    // The turn is registered before the scenario starts pacing, so the close
    // lands while it is still running.
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.close();
    await waitFor(() => daemon.turns.count === 0, 3_000);
    expect(daemon.turns.count).toBe(0);
  });

  it("leaves an aborted turn out of the conversation's counters", async () => {
    await startDaemon({}, { env: scenario("long") });
    const client = await connect();
    const started = await client.call(
      "turn.start",
      turnParams({ text: ": long one" }),
    );
    const { conversationId, turnId } = started.data as {
      conversationId: string;
      turnId: string;
    };
    await client.call("turn.abort", { turnId });
    await client.waitForTurnEnd();
    const record = await client.call("conv.get", { conversationId });
    expect((record.data as { turns: number }).turns).toBe(0);
  });
});

describe("the agent pool", () => {
  it("respawns the child when the environment fingerprint changes", async () => {
    const daemon = await startDaemon();
    const client = await connect();
    const first = await client.call(
      "turn.start",
      turnParams({ env: { PATH: "/usr/bin", HOME: home, VIRTUAL_ENV: "/a" } }),
    );
    await client.waitForTurnEnd();
    const { conversationId } = first.data as { conversationId: string };
    const before = daemon.pool.session(conversationId);

    client.clearEvents();
    await client.call(
      "turn.start",
      turnParams({
        conversationId,
        env: { PATH: "/usr/bin", HOME: home, VIRTUAL_ENV: "/b" },
      }),
    );
    await client.waitForTurnEnd();
    // A new VIRTUAL_ENV means a new venv on PATH, so the child is respawned on
    // the same session rather than reused with the old one (DESIGN §4.3.4).
    expect(daemon.pool.session(conversationId)).not.toBe(before);
  });

  it("keeps the child when only volatile keys changed", async () => {
    const daemon = await startDaemon();
    const client = await connect();
    const first = await client.call(
      "turn.start",
      turnParams({ env: { PATH: "/usr/bin", HOME: home, COLUMNS: "80" } }),
    );
    await client.waitForTurnEnd();
    const { conversationId } = first.data as { conversationId: string };
    const before = daemon.pool.session(conversationId);
    client.clearEvents();
    await client.call(
      "turn.start",
      turnParams({
        conversationId,
        env: { PATH: "/usr/bin", HOME: home, COLUMNS: "120" },
      }),
    );
    await client.waitForTurnEnd();
    expect(daemon.pool.session(conversationId)).toBe(before);
  });
});

describe("what a running daemon is made of", () => {
  it("hands out the parts a client and a test need to look at", async () => {
    const daemon = await startDaemon();
    expect(daemon.store.paths.conversationsDir).toBe(paths.conversationsDir);
    expect(daemon.turns.count).toBe(0);
    expect(daemon.pool.backend.id).toBe("fake");
  });

  it("can be built from the process environment alone", () => {
    // `prefaix daemon` with no arguments does exactly this: the paths, the
    // config, and the environment all come from where the process is.
    const daemon = new Daemon({ version: "0.0.0-test" });
    expect(daemon.paths.socket.endsWith(".sock")).toBe(true);
    expect(daemon.store.paths.conversationsDir).toContain("prefaix");
  });

  it("names the command that shows its log when it cannot be reached", () => {
    const error = daemonUnavailable("no socket");
    expect(error.code).toBe("DAEMON_UNAVAILABLE");
    expect(error.hint).toContain("prefaix daemon --foreground");
  });
});

describe("the idle tick", () => {
  it("does nothing at all once the daemon is stopping", async () => {
    const daemon = new Daemon({
      paths,
      config: config({ agent: { ...defaultConfig().agent, backend: "fake" } }),
      version: "0.0.0-test",
      env: { PATH: "/usr/bin", HOME: home },
      checkOwner: false,
      idleMinutes: 0,
      idleTickMs: 5,
    });
    daemons.push(daemon);
    await daemon.start();
    // The stop and the tick race; the daemon must not try to stop itself twice.
    const stopping = daemon.stop();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stopping;
    expect(daemon.connections).toBe(0);
  });

  it("waits out a daemon that was never idle for long", async () => {
    const daemon = new Daemon({
      paths,
      config: config({ agent: { ...defaultConfig().agent, backend: "fake" } }),
      version: "0.0.0-test",
      env: { PATH: "/usr/bin", HOME: home },
      checkOwner: false,
      idleMinutes: 60,
      idleTickMs: 5,
    });
    daemons.push(daemon);
    await daemon.start();
    const stopped = { value: false };
    void daemon.waitForStop().then(() => {
      stopped.value = true;
    });
    // Ticks keep coming and none of them is far enough past the last activity.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(stopped.value).toBe(false);
  });

  it("stays up while a turn is running, and stops once it is not", async () => {
    const daemon = new Daemon({
      paths,
      config: config({ agent: { ...defaultConfig().agent, backend: "fake" } }),
      version: "0.0.0-test",
      env: {
        PATH: "/usr/bin",
        HOME: home,
        PREFAIX_BACKEND: "fake",
        PREFAIX_FAKE_SCENARIO: "long",
      },
      checkOwner: false,
      idleMinutes: 0,
      idleTickMs: 5,
    });
    daemons.push(daemon);
    await daemon.start();
    const client = await connect();
    const stopped = { value: false };
    void daemon.waitForStop().then(() => {
      stopped.value = true;
    });
    const finished = client.call("turn.start", turnParams({ text: "hello" }));
    const started = await finished;
    expect(started.ok).toBe(true);
    // The turn and the connection are both reasons to stay up, so the daemon
    // is still there once the tick has run several times.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped.value).toBe(false);
    client.close();
    clients.push(client);
  });

  it("keeps running while the backend still has work it counts", async () => {
    const stopped = { value: false };
    let busy = true;
    const daemon = new Daemon({
      paths,
      config: config({ agent: { ...defaultConfig().agent, backend: "fake" } }),
      version: "0.0.0-test",
      env: { PATH: "/usr/bin", HOME: home },
      checkOwner: false,
      idleMinutes: 0,
      onIdleCheck: async () => busy,
    });
    daemons.push(daemon);
    await daemon.start();
    void daemon.waitForStop().then(() => {
      stopped.value = true;
    });
    // The backend answering "busy" is enough to hold the daemon open, with no
    // client and no turn in sight.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stopped.value).toBe(false);
    busy = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stopped.value).toBe(false);
    await daemon.stop();
  });
});

describe("the event ring", () => {
  it("rolls the body out but never the settle", () => {
    const ring = new EventRing(200);
    ring.push({ type: "text_delta", block: 0, text: "x".repeat(40) });
    for (let index = 0; index < 40; index += 1) {
      ring.push({ type: "text_delta", block: 0, text: "x".repeat(40) });
    }
    // The turn outgrew the ring, so the oldest entries are gone.
    expect(ring.oldestSeq).toBeGreaterThan(1);
    const settled = ring.push({ type: "settled", stopReason: "stop" });
    // The settle survives, and a later burst cannot roll it out either.
    for (let index = 0; index < 40; index += 1) {
      ring.push({ type: "text_delta", block: 0, text: "y".repeat(40) });
    }
    expect(ring.settled()?.seq).toBe(settled.seq);
    expect(ring.settledSeq).toBe(settled.seq);
  });

  it("never drops its only entry, however small the ring is", () => {
    const ring = new EventRing(1);
    ring.push({ type: "text_delta", block: 0, text: "a".repeat(500) });
    expect(ring.size).toBe(1);
  });

  it("an empty ring starts at the sequence it is about to hand out", () => {
    const ring = new EventRing();
    expect(ring.oldestSeq).toBe(ring.nextSeq);
  });
});

describe("the last-turn history", () => {
  it("keeps the newest and drops the oldest", () => {
    const turns = new TurnManager();
    for (let index = 0; index < 3; index += 1) {
      const turn = turns.start({
        conversationId: `c_${index}`,
        shellId: "1-1-a",
        promptText: "hi",
      });
      turns.finish(turn, { turnId: turn.id, status: "stop" });
    }
    turns.gcLast(1);
    expect(turns.lastFor("c_0")).toBeUndefined();
    expect(turns.lastFor("c_2")?.conversationId).toBe("c_2");
    // Asking for more than is held is not an error; it is a no-op.
    turns.gcLast(10);
    expect(turns.lastFor("c_2")?.conversationId).toBe("c_2");
  });
});

describe("an error the daemon sends", () => {
  it("is recognisable only when it has the shape of one", () => {
    expect(isErrorInfo({ code: "X", message: "y" })).toBe(true);
    expect(isErrorInfo({ code: "X" })).toBe(false);
    expect(isErrorInfo(null)).toBe(false);
    expect(isErrorInfo("X")).toBe(false);
  });
});

describe("the idle exit", () => {
  it("stops when no client and no turn are left", async () => {
    const stopped = { value: false };
    const daemon = new Daemon({
      paths,
      config: config({ agent: { ...defaultConfig().agent, backend: "fake" } }),
      version: "0.0.0-test",
      env: { PATH: "/usr/bin", HOME: home, PREFAIX_BACKEND: "fake" },
      checkOwner: false,
      idleMinutes: 0,
    });
    daemons.push(daemon);
    await daemon.start();
    void daemon.waitForStop().then(() => {
      stopped.value = true;
    });
    await connect();
    // One tick with a client connected is not idle, so the daemon is only
    // stopped once the client is gone and the tick runs again.
    await daemon.stop();
    expect(stopped.value).toBe(true);
  });
});

describe("the lock", () => {
  it("is released when the daemon stops, so the next one can take it", async () => {
    await startDaemon();
    await daemons[0]?.stop();
    const second = await startDaemon();
    expect(second.paths.socket).toBe(paths.socket);
  });

  it("is refused while a live process holds it", async () => {
    const daemon = await startDaemon();
    await expect(
      tryLock({ path: paths.lock, pid: process.pid, isAlive: () => true }),
    ).rejects.toBeInstanceOf(LockHeldError);
    await daemon.stop();
  });

  it("takes over a lock whose pid is dead", async () => {
    mkdirSync(join(home, "run", "prefaix"), { recursive: true });
    writeFileSync(paths.lock, "999999\n");
    await startDaemon();
    const pid = await (
      await import("../../src/daemon/lock.js")
    ).readLockPid(paths.lock);
    expect(pid).toBe(process.pid);
  });

  it("removes only its own lock on release", async () => {
    const handle = await tryLock({ path: join(home, "lock"), pid: 4242 });
    writeFileSync(handle.path, "9999\n", "utf8");
    await handle.release();
    // A lock that now belongs to someone else must survive the old owner's exit.
    const pid = await (
      await import("../../src/daemon/lock.js")
    ).readLockPid(handle.path);
    expect(pid).toBe(9999);
  });

  it("takes the lock under its own pid when none was given", async () => {
    // The daemon passes its pid; anything that does not gets this process's,
    // which is the only one that can be right for a lock it will release.
    const handle = await tryLock({ path: join(home, "own.lock") });
    expect(handle.pid).toBe(process.pid);
    await handle.release();
    // Releasing a lock that is already gone is not an error.
    await expect(handle.release()).resolves.toBeUndefined();
  });

  it("says what went wrong when the lock cannot be created at all", async () => {
    await expect(
      tryLock({ path: join(home, "no-such-dir", "lock"), pid: 1 }),
    ).rejects.toThrow();
  });

  it("reports a lock with a dead or unreadable pid as stale", async () => {
    const file = join(home, "stale.lock");
    writeFileSync(file, "not a pid\n");
    expect(await lockIsStale(file, () => true)).toBe(true);
    writeFileSync(file, "4242\n");
    expect(await lockIsStale(file, () => false)).toBe(true);
    expect(await lockIsStale(file, () => true)).toBe(false);
    expect(await lockIsStale(join(home, "absent.lock"))).toBe(true);
  });
});

describe("failures", () => {
  it("reports a corrupt conversation file and starts a new one", async () => {
    await startDaemon();
    const client = await connect();
    const first = await client.call("turn.start", turnParams());
    await client.waitForTurnEnd();
    const { conversationId } = first.data as { conversationId: string };
    const file = join(paths.conversationsDir, `${conversationId}.json`);
    writeFileSync(file, "{ truncated", "utf8");
    const result = await client.call(
      "turn.start",
      turnParams({ conversationId }),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("CONVERSATION_NOT_FOUND");
    const quarantined = join(
      paths.conversationsDir,
      ".corrupt",
      `${conversationId}.json`,
    );
    expect(statSync(quarantined).isFile()).toBe(true);
  });

  it("refuses a runtime directory another user could write to", async () => {
    const daemon = new Daemon({
      paths,
      config: config({ agent: { ...defaultConfig().agent, backend: "fake" } }),
      version: "0.0.0-test",
      env: { PATH: "/usr/bin", HOME: home, PREFAIX_BACKEND: "fake" },
      checkOwner: true,
    });
    daemons.push(daemon);
    await daemon.start();
    await daemon.stop();
    chmodSync(paths.runtimeDir, 0o777);
    const second = new Daemon({
      paths,
      config: config({ agent: { ...defaultConfig().agent, backend: "fake" } }),
      version: "0.0.0-test",
      env: { PATH: "/usr/bin", HOME: home, PREFAIX_BACKEND: "fake" },
      checkOwner: true,
    });
    await expect(second.start()).rejects.toThrow(/world-writable/);
  });
});

describe("conversations and model commands", () => {
  it("lists, renames, and reads the last assistant text", async () => {
    await startDaemon();
    const client = await connect();
    const started = await client.call("turn.start", turnParams());
    await client.waitForTurnEnd();
    const { conversationId } = started.data as { conversationId: string };

    const listed = await client.call("conv.list", {});
    expect(
      (listed.data as { conversations: { id: string }[] }).conversations,
    ).toHaveLength(1);
    const searched = await client.call("conv.list", {
      query: "nothing matches",
    });
    expect(
      (searched.data as { conversations: unknown[] }).conversations,
    ).toHaveLength(0);

    const renamed = await client.call("conv.rename", {
      conversationId,
      title: "auth work",
    });
    expect((renamed.data as { title: string }).title).toBe("auth work");

    const last = await client.call("conv.lastText", { conversationId });
    expect(String((last.data as { text: string | null }).text)).toContain(
      "Hello from the fake backend",
    );
  });

  it("returns no last text for a conversation with no warm child", async () => {
    await startDaemon();
    const client = await connect();
    const created = await client.call("conv.new", {
      shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
      cwd: home,
      env: {},
    });
    const { id } = created.data as { id: string };
    const last = await client.call("conv.lastText", { conversationId: id });
    expect(last.data).toEqual({ text: null });
  });

  it("lists models, sets one, and lists commands", async () => {
    await startDaemon();
    const client = await connect();
    const started = await client.call("turn.start", turnParams());
    await client.waitForTurnEnd();
    const { conversationId } = started.data as { conversationId: string };

    const models = await client.call("model.list", { conversationId });
    expect(
      (models.data as { models: { id: string }[] }).models.map((m) => m.id),
    ).toContain("fake-fast");
    const set = await client.call("model.set", {
      conversationId,
      ref: { provider: "fake", id: "fake-slow" },
    });
    expect(set.ok).toBe(true);
    const status = await client.call("status.get", { conversationId });
    expect((status.data as { model: { id: string } }).model.id).toBe(
      "fake-slow",
    );

    const commands = await client.call("commands.list", { conversationId });
    expect(
      (commands.data as { commands: { name: string }[] }).commands.map(
        (command) => command.name,
      ),
    ).toContain("review");
  });

  it("reports a model the backend does not know as an agent error", async () => {
    await startDaemon();
    const client = await connect();
    const started = await client.call("turn.start", turnParams());
    await client.waitForTurnEnd();
    const { conversationId } = started.data as { conversationId: string };
    const set = await client.call("model.set", {
      conversationId,
      ref: { provider: "fake", id: "nope" },
    });
    expect(set.ok).toBe(false);
    expect(set.error?.code).toBe("AGENT_ERROR");
  });

  it("refuses model commands with no conversation in play", async () => {
    await startDaemon();
    const client = await connect();
    const models = await client.call("model.list", {});
    expect(models.ok).toBe(false);
    expect(models.error?.code).toBe("CONVERSATION_NOT_FOUND");
    const status = await client.call("status.get", {});
    expect((status.data as { state: string }).state).toBe("idle");
  });

  it("reports a persona it does not know", async () => {
    await startDaemon();
    const client = await connect();
    const started = await client.call(
      "turn.start",
      turnParams({ persona: "nope" }),
    );
    expect(started.ok).toBe(false);
    expect(started.error?.hint).toContain("ask");
  });

  it("accepts a configured persona", async () => {
    await startDaemon();
    const client = await connect();
    const started = await client.call(
      "turn.start",
      turnParams({ persona: "ask" }),
    );
    expect(started.ok).toBe(true);
    const end = await client.waitForTurnEnd();
    expect(end.summary.status).toBe("stop");
  });

  it("answers a dialog the agent asked for", async () => {
    await startDaemon({}, { env: scenario("dialog") });
    const client = await connect();
    void client.call("turn.start", turnParams());
    const request = await client.waitFor(
      (message) => message.t === "evt" && message.e.type === "ui_request",
    );
    const turnId = request.t === "evt" ? request.turnId : "";
    const requestId =
      request.t === "evt" && request.e.type === "ui_request"
        ? request.e.id
        : "";
    const answered = await client.call("ui.respond", {
      turnId,
      requestId,
      response: { value: "first option" },
    });
    expect(answered.ok).toBe(true);
    const end = await client.waitForTurnEnd();
    expect(end.summary.status).toBe("stop");
  });

  it("refuses an answer to a dialog it never asked about", async () => {
    await startDaemon({}, { env: scenario("dialog") });
    const client = await connect();
    void client.call("turn.start", turnParams());
    const request = await client.waitFor(
      (message) => message.t === "evt" && message.e.type === "ui_request",
    );
    const turnId = request.t === "evt" ? request.turnId : "";
    // The turn is parked on a real dialog, so only the id is wrong.
    const answered = await client.call("ui.respond", {
      turnId,
      requestId: "u-does-not-exist",
      response: { value: "x" },
    });
    expect(answered.ok).toBe(false);
    expect(answered.error?.code).toBe("USAGE");
    await client.call("turn.abort", { turnId });
    await client.waitForTurnEnd();
  });
});

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for a condition");
}
