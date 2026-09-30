import { describe, expect, it, vi } from "vitest";
import { AgentPool } from "../../src/daemon/pool.js";
import {
  createFakeAgent,
  type FakeAgentOptions,
} from "../../src/agents/fake/adapter.js";
import {
  defaultConfig,
  type PrefaixConfig,
} from "../../src/core/config/schema.js";
import type {
  AgentBackend,
  AgentSession,
  Capabilities,
  OpenOptions,
} from "../../src/core/agent-port.js";
import type { FakeAgent } from "../../src/agents/fake/adapter.js";

const ROOT = "/Users/tester/proj";
let clock = 1_000;

/** A valid conversation id, since the store and the pool key on the shape. */
function cid(n: number): string {
  return `c_0${String(n).padStart(25, "0")}`;
}

function config(overrides: Partial<PrefaixConfig> = {}): PrefaixConfig {
  const base = defaultConfig();
  return { ...base, ...overrides };
}

function pool(
  options: {
    config?: PrefaixConfig;
    fake?: FakeAgentOptions;
    now?: () => number;
    isBusy?: (conversationId: string) => boolean;
  } = {},
): { pool: AgentPool; agent: FakeAgent } {
  const agent = createFakeAgent({ tickMs: 0, ...options.fake });
  return {
    agent,
    pool: new AgentPool({
      backend: agent,
      config: options.config ?? config(),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.isBusy === undefined ? {} : { isBusy: options.isBusy }),
    }),
  };
}

/** The same backend with one capability changed, for the branches that hinge on it. */
function withCapabilities(
  agent: FakeAgent,
  patch: Partial<Capabilities>,
): AgentBackend {
  return {
    id: agent.id,
    capabilities: { ...agent.capabilities, ...patch },
    probe: () => agent.probe(),
    open: (openOptions) => agent.open(openOptions),
  };
}

const request = (overrides: Record<string, unknown> = {}) => ({
  conversationId: cid(0),
  root: ROOT,
  env: { PATH: "/usr/bin", HOME: "/Users/tester" },
  ...overrides,
});

describe("binding a child to a conversation", () => {
  it("opens one child and reuses it for the next turn", async () => {
    const { pool: p, agent } = pool();
    const first = await p.acquire(request());
    const second = await p.acquire(request());
    expect(second).toBe(first);
    expect(p.stats().children).toBe(1);
    expect(agent.transcript(first.native.sessionId ?? "")?.turns).toEqual([]);
  });

  it("resumes the persisted native handle when reopening a cold conversation", async () => {
    const { pool: p, agent } = pool();
    const first = await p.acquire(request());
    const native = { ...first.native };
    await p.release(cid(0));
    const resumed = await p.acquire(request({ native }));
    expect(resumed.native).toEqual(native);
    expect(agent.transcript(native.sessionId ?? "")).toBeDefined();
    await p.close();
  });

  it("gives each conversation its own child", async () => {
    const { pool: p } = pool();
    const a = await p.acquire(request({ conversationId: cid(0) }));
    const b = await p.acquire(request({ conversationId: cid(1) }));
    expect(b).not.toBe(a);
    expect(p.stats().children).toBe(2);
  });

  it("resumes the native session rather than starting over", async () => {
    const { pool: p } = pool();
    const first = await p.acquire(request());
    const native = { ...first.native };
    const second = await p.acquire(
      request({
        env: { PATH: "/usr/bin", HOME: "/Users/tester", VIRTUAL_ENV: "/v" },
        native,
      }),
    );
    // The respawn is a different object but the same transcript, which is what
    // "respawn on the same session" has to mean.
    expect(second).not.toBe(first);
    expect(second.native.sessionId).toBe(native.sessionId);
  });
});

describe("when the child's environment changes", () => {
  it("respawns on a new VIRTUAL_ENV", async () => {
    const { pool: p } = pool();
    const first = await p.acquire(request());
    const second = await p.acquire(
      request({ env: { PATH: "/bin", HOME: "/h" } }),
    );
    expect(second).not.toBe(first);
  });

  it("keeps the child when only volatile keys changed", async () => {
    const { pool: p } = pool();
    const first = await p.acquire(request());
    const second = await p.acquire(
      request({
        env: {
          PATH: "/usr/bin",
          HOME: "/Users/tester",
          COLUMNS: "200",
          TERM_SESSION_ID: "abc",
          PREFAIX_SHELL_ID: "9-9-z",
        },
      }),
    );
    expect(second).toBe(first);
  });

  it("respawns when the root moves", async () => {
    const { pool: p } = pool();
    const first = await p.acquire(request());
    const second = await p.acquire(request({ root: "/Users/tester/other" }));
    expect(second).not.toBe(first);
  });
});

describe("capacity", () => {
  it("closes the least recently used child at the limit", async () => {
    let now = 1_000;
    const { pool: p } = pool({
      config: config({
        pool: { maxChildren: 2, idleMinutes: 15, spare: false },
      }),
      now: () => now,
    });
    const a = await p.acquire(request({ conversationId: cid(0) }));
    now += 1_000;
    await p.acquire(request({ conversationId: cid(1) }));
    // Touching the first makes the second the least recent, so it is the one
    // that goes when a third asks for a slot.
    now += 1_000;
    p.touch(cid(0));
    now += 1_000;
    await p.acquire(request({ conversationId: cid(2) }));
    expect(p.session(cid(0))).toBe(a);
    expect(p.session(cid(1))).toBeUndefined();
    expect(p.stats().children).toBe(2);
  });

  it("makes room even when the ceiling is one", async () => {
    const { pool: p } = pool({
      config: config({
        pool: { maxChildren: 1, idleMinutes: 15, spare: false },
      }),
    });
    const first = await p.acquire(request({ conversationId: cid(0) }));
    const second = await p.acquire(request({ conversationId: cid(1) }));
    // A fixed ceiling is a promise that at most one child is ever running, and
    // the oldest one is what gives way.
    expect(p.session(cid(0))).toBeUndefined();
    expect(p.session(cid(1))).toBe(second);
    expect(second).not.toBe(first);
  });
});

describe("the idle sweep", () => {
  it("closes a child idle past pool.idle_minutes", async () => {
    let now = 1_000;
    const { pool: p } = pool({
      config: config({
        pool: { maxChildren: 6, idleMinutes: 1, spare: false },
      }),
      now: () => now,
    });
    await p.acquire(request());
    expect(await p.sweepIdle()).toEqual([]);
    now += 61_000;
    expect(await p.sweepIdle()).toEqual([cid(0)]);
    expect(p.stats().children).toBe(0);
  });
});

describe("crashes", () => {
  it("marks a conversation degraded after three crashes in a minute", async () => {
    let now = 1_000;
    const { pool: p } = pool({ now: () => now });
    await p.acquire(request());
    expect(p.noteCrash(cid(0)).degraded).toBe(false);
    now += 100;
    expect(p.noteCrash(cid(0)).degraded).toBe(false);
    now += 100;
    const third = p.noteCrash(cid(0));
    expect(third.degraded).toBe(true);
    expect(p.stats().degraded).toEqual([cid(0)]);
  });

  it("forgets crashes once the window has passed", async () => {
    let now = 1_000;
    const { pool: p } = pool({ now: () => now });
    await p.acquire(request());
    p.noteCrash(cid(0));
    p.noteCrash(cid(0));
    now += 61_000;
    expect(p.noteCrash(cid(0)).recent).toBe(1);
  });

  it("says nothing about a conversation it has never seen", () => {
    const { pool: p } = pool();
    expect(p.noteCrash(cid(9))).toEqual({
      degraded: false,
      recent: 0,
    });
  });

  it("respawns a degraded conversation on its next turn", async () => {
    const { pool: p } = pool();
    const first = await p.acquire(request());
    for (let at = 0; at < 3; at++) {
      p.noteCrash(cid(0));
    }
    const second = await p.acquire(request());
    expect(second).not.toBe(first);
    // A respawn does not erase the recent failure history.
    expect(p.stats().degraded).toEqual([cid(0)]);
  });
});

describe("the spare", () => {
  it("is not started when pool.spare is off", async () => {
    const { pool: p } = pool({
      config: config({
        pool: { maxChildren: 6, idleMinutes: 15, spare: false },
      }),
    });
    p.warmSpare(ROOT, { PATH: "/usr/bin" });
    expect(p.stats().spare).toBe(0);
  });

  it("is nothing to take when none was warmed", async () => {
    const { pool: p } = pool();
    // Asking for a spare that was never asked for is not an error; there is
    // simply nothing to adopt, so the turn opens its own child.
    await expect(
      p.takeSpare(cid(0), ROOT, { PATH: "/usr/bin" }),
    ).resolves.toBeUndefined();
    expect(p.session(cid(0))).toBeUndefined();
  });

  it("is adopted by the next conversation that wants the same root and env", async () => {
    const { pool: p } = pool();
    p.warmSpare(ROOT, { PATH: "/usr/bin" });
    // The spare opens on its own schedule, so the adoption waits for it.
    await p.takeSpare(cid(0), ROOT, { PATH: "/usr/bin" });
    const session = p.session(cid(0));
    expect(session).toBeDefined();
    expect(p.stats().spare).toBe(0);
  });

  it("is left alone when the next turn wants a different root", async () => {
    const { pool: p } = pool();
    p.warmSpare(ROOT, { PATH: "/usr/bin" });
    await p.takeSpare(cid(0), "/other", {
      PATH: "/usr/bin",
    });
    expect(p.session(cid(0))).toBeUndefined();
    expect(p.stats().spare).toBe(1);
  });

  it("is closed by the idle sweep rather than left running", async () => {
    let now = 1_000;
    const { pool: p } = pool({
      config: config({ pool: { maxChildren: 6, idleMinutes: 1, spare: true } }),
      now: () => now,
    });
    p.warmSpare(ROOT, { PATH: "/usr/bin" });
    now += 61_000;
    await p.sweepIdle();
    expect(p.stats().spare).toBe(0);
  });

  it("does not fail the turn that triggered it when it cannot start", async () => {
    const backend: AgentBackend = {
      id: "broken",
      capabilities: createFakeAgent().capabilities,
      probe: () => Promise.resolve({ installed: true, usable: true }),
      open: () => Promise.reject(new Error("no child for you")),
    };
    const p = new AgentPool({ backend, config: config() });
    expect(() => p.warmSpare(ROOT, { PATH: "/usr/bin" })).not.toThrow();
    // The rejection is absorbed; the next turn spawns its own child.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(p.stats().children).toBe(0);
  });
});

describe("closing down", () => {
  it("closes every child and any spare that was warming up", async () => {
    const { pool: p, agent } = pool({
      config: config({
        pool: { maxChildren: 6, idleMinutes: 15, spare: true },
      }),
    });
    await p.acquire(request());
    await p.acquire(request({ conversationId: cid(1) }));
    p.warmSpare(ROOT, { PATH: "/usr/bin" });
    expect(p.stats().spare).toBe(1);
    await p.close();
    expect(p.stats().children).toBe(0);
    expect(p.stats().spare).toBe(0);
    // Nothing is left bound, so a later turn starts from scratch.
    expect(p.session(cid(0))).toBeUndefined();
    expect(agent).toBeDefined();
  });

  it("closes a child the conversation is done with", async () => {
    const { pool: p } = pool();
    await p.acquire(request());
    await p.release(cid(0));
    expect(p.session(cid(0))).toBeUndefined();
    // Releasing a conversation the pool has never heard of is a no-op, not a
    // crash: the client asked, and the answer is that there was nothing.
    await expect(p.release(cid(9))).resolves.toBeUndefined();
  });

  it("records a turn so the sweep has a reason to keep the child", async () => {
    let now = 1_000;
    const { pool: p } = pool({
      config: config({
        pool: { maxChildren: 6, idleMinutes: 1, spare: false },
      }),
      now: () => now,
    });
    await p.acquire(request());
    now += 30_000;
    p.touch(cid(0));
    // Without the touch the child would already be over the idle limit.
    expect(await p.sweepIdle()).toEqual([]);
  });

  it("has nothing to keep when the conversation was never bound", () => {
    const { pool: p } = pool();
    // A turn that arrives for a conversation the pool has lost is not an
    // error; there is simply no child to record it against.
    expect(() => p.touch(cid(9))).not.toThrow();
  });
});

describe("a child that will not close", () => {
  /** A backend whose sessions hang up badly, which is what a crash looks like. */
  function stubborn(): AgentBackend {
    const agent = createFakeAgent({ tickMs: 0 });
    return {
      id: agent.id,
      capabilities: agent.capabilities,
      probe: () => agent.probe(),
      open: async (openOptions) => {
        const session = await agent.open(openOptions);
        let alive = true;
        return {
          ...session,
          get isAlive() {
            return alive;
          },
          abort: () => session.abort(),
          close: () => {
            alive = false;
            return Promise.reject(new Error("the child is already gone"));
          },
        } as unknown as AgentSession;
      },
    };
  }

  it("still respawns, and forgets the child it could not close", async () => {
    const p = new AgentPool({
      backend: stubborn(),
      config: config(),
    });
    const first = await p.acquire(request());
    // A new root is a respawn, which closes the old child first. That close
    // fails, and the respawn has to go ahead anyway.
    const second = await p.acquire({
      ...request(),
      root: "/Users/tester/other",
    });
    expect(second).not.toBe(first);
    expect(p.stats().children).toBe(1);
  });

  it("still evicts, and still sweeps, a child it cannot close", async () => {
    const p = new AgentPool({
      backend: stubborn(),
      config: config({
        pool: { maxChildren: 1, idleMinutes: 1, spare: false },
      }),
      now: () => clock,
    });
    await p.acquire(request());
    // Over the ceiling, so the first child is evicted to make room.
    await p.acquire(request({ conversationId: cid(1) }));
    expect(p.stats().children).toBe(1);
    clock += 61_000;
    expect(await p.sweepIdle()).toEqual([cid(1)]);
    expect(p.stats().children).toBe(0);
  });

  it("still releases, and still shuts down, a child it cannot close", async () => {
    const p = new AgentPool({ backend: stubborn(), config: config() });
    await p.acquire(request());
    await expect(p.release(cid(0))).resolves.toBeUndefined();
    expect(p.session(cid(0))).toBeUndefined();
    await p.acquire(request());
    await expect(p.close()).resolves.toBeUndefined();
    expect(p.stats().children).toBe(0);
  });

  it("still shuts down a spare it cannot close", async () => {
    const p = new AgentPool({
      backend: stubborn(),
      config: config({
        pool: { maxChildren: 6, idleMinutes: 15, spare: true },
      }),
    });
    p.warmSpare(ROOT, { PATH: "/usr/bin" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await p.close();
    expect(p.stats().spare).toBe(0);
  });
});

describe("personas", () => {
  it("respawns when the backend cannot switch a persona in place", async () => {
    const { agent } = pool();
    // The fake can switch live; the pi adapter without the bridge cannot.
    const withoutBridge = new AgentPool({
      backend: withCapabilities(agent, { personasWithoutRespawn: false }),
      config: config(),
    });
    const first = await withoutBridge.acquire(
      request({ persona: { name: "ask" } }),
    );
    const second = await withoutBridge.acquire(
      request({ persona: { name: "plan" } }),
    );
    expect(second).not.toBe(first);
  });

  it("keeps the child and switches in place when the backend can", async () => {
    const agent = createFakeAgent({ tickMs: 0 });
    const p = new AgentPool({ backend: agent, config: config() });
    const first = await p.acquire(request({ persona: { name: "ask" } }));
    const second = await p.acquire(request({ persona: { name: "plan" } }));
    expect(second).toBe(first);
    expect((second as { persona?: { name: string } }).persona?.name).toBe(
      "plan",
    );
  });
});

describe("capabilities and warm lookups", () => {
  it("reports a missing capability as an unsupported-feature error", () => {
    const { agent } = pool();
    const p = new AgentPool({
      backend: withCapabilities(agent, { compact: false }),
      config: config(),
    });
    expect(() => p.require("compact")).toThrow(/isn't supported by fake/);
    expect(() => p.require("abort")).not.toThrow();
  });

  it("refuses models for a conversation with no warm child", async () => {
    const { pool: p } = pool();
    await expect(p.models(cid(0))).rejects.toThrow(/no warm agent/);
  });

  it("lists models for a warm conversation", async () => {
    const { pool: p } = pool();
    await p.acquire(request());
    const models = await p.models(cid(0));
    expect(models.map((model) => model.id)).toContain("fake-fast");
  });
});

describe("closing", () => {
  it("closes every child and the spare, and is safe to repeat", async () => {
    const { pool: p } = pool();
    await p.acquire(request());
    p.warmSpare(ROOT, { PATH: "/usr/bin" });
    await p.close();
    expect(p.stats().children).toBe(0);
    expect(p.stats().spare).toBe(0);
    await p.close();
    expect(p.stats().children).toBe(0);
  });
});

describe("session typing", () => {
  it("returns undefined for a conversation it does not hold", () => {
    const { pool: p } = pool();
    const session: AgentSession | undefined = p.session(cid(0));
    expect(session).toBeUndefined();
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function trackedBackend() {
  const agent = createFakeAgent({ tickMs: 0 });
  const sessions: AgentSession[] = [];
  let live = 0;
  let peak = 0;
  const open = vi.fn(async (options: OpenOptions) => {
    const session = await agent.open(options);
    sessions.push(session);
    live += 1;
    peak = Math.max(peak, live);
    const close = session.close.bind(session);
    let closed = false;
    session.close = vi.fn(async () => {
      await close();
      if (!closed) {
        closed = true;
        live -= 1;
      }
    });
    return session;
  });
  return {
    agent,
    sessions,
    open,
    backend: { ...withCapabilities(agent, {}), open },
    get peak() {
      return peak;
    },
    get live() {
      return live;
    },
  };
}

const singleChild = config({
  pool: { maxChildren: 1, idleMinutes: 1, spare: true },
});

describe("pool lifecycle regressions", () => {
  it("acquire adopts a fresh matching spare and applies the requested settings", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: config() });
    const fresh = request();
    p.warmSpare(fresh.root, fresh.env);
    const session = await p.acquire(
      request({
        title: "new title",
        model: { provider: "fake", id: "fake-slow" },
        thinking: "high",
      }),
    );
    expect(tracked.open).toHaveBeenCalledTimes(1);
    expect(session).toBe(tracked.sessions[0]);
    expect(await session.state()).toMatchObject({
      name: "new title",
      model: { provider: "fake", id: "fake-slow" },
      thinking: "high",
    });
    await p.close();
    expect(tracked.live).toBe(0);
  });

  it("closes a spare before resuming another native transcript", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: singleChild });
    const fresh = request();
    p.warmSpare(fresh.root, fresh.env);
    const native = { sessionId: "persisted-native" };
    const resumed = await p.acquire(request({ native }));
    expect(resumed.native).toEqual(native);
    expect(tracked.sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(tracked.peak).toBe(1);
    await p.close();
    expect(tracked.live).toBe(0);
  });

  it("closes a configuration-unsuitable spare before opening with spawn persona", async () => {
    const tracked = trackedBackend();
    const backend = {
      ...tracked.backend,
      capabilities: {
        ...tracked.backend.capabilities,
        personasWithoutRespawn: false,
      },
    };
    const p = new AgentPool({ backend, config: singleChild });
    const fresh = request();
    p.warmSpare(fresh.root, fresh.env);
    await p.acquire(request({ persona: { name: "ask", tools: ["read"] } }));
    expect(tracked.sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(tracked.open.mock.calls[1]?.[0].persona).toEqual({
      name: "ask",
      tools: ["read"],
    });
    expect(tracked.peak).toBe(1);
    await p.close();
  });

  it("does not warm a spare when all child slots are occupied", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: singleChild });
    await p.acquire(request());
    p.warmSpare(ROOT, {});
    await p.sweepIdle();
    expect(tracked.open).toHaveBeenCalledTimes(1);
    expect(p.stats().spare).toBe(0);
    expect(tracked.peak).toBe(1);
    await p.close();
  });

  it("rejects capacity requests while every child is active", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({
      backend: tracked.backend,
      config: singleChild,
      isBusy: (id) => id === cid(0),
    });
    const first = await p.acquire(request());
    await expect(
      p.acquire(request({ conversationId: cid(1) })),
    ).rejects.toMatchObject({ code: "CONVERSATION_BUSY" });
    expect(p.session(cid(0))).toBe(first);
    expect(first.close).not.toHaveBeenCalled();
    await p.close();
  });

  it("evicts an idle child while protecting the older active child", async () => {
    const { pool: p } = pool({
      config: config({
        pool: { maxChildren: 2, idleMinutes: 1, spare: false },
      }),
      isBusy: (id) => id === cid(0),
    });
    const active = await p.acquire(request());
    await p.acquire(request({ conversationId: cid(1) }));
    await p.acquire(request({ conversationId: cid(2) }));
    expect(p.session(cid(0))).toBe(active);
    expect(p.session(cid(1))).toBeUndefined();
    await p.close();
  });

  it("sweeps only expired idle children and expired spares", async () => {
    let now = 1_000;
    const { pool: p } = pool({
      now: () => now,
      config: config({ pool: { maxChildren: 3, idleMinutes: 1, spare: true } }),
      isBusy: (id) => id === cid(0),
    });
    await p.acquire(request());
    await p.acquire(request({ conversationId: cid(1) }));
    p.warmSpare(ROOT, {});
    await p.sweepIdle();
    expect(p.stats().spare).toBe(1);
    now += 61_000;
    expect(await p.sweepIdle()).toEqual([cid(1)]);
    expect(p.session(cid(0))).toBeDefined();
    expect(p.stats().spare).toBe(0);
    await p.close();
  });

  it("reopens an exited child on the same native session", async () => {
    const { pool: p } = pool();
    const first = await p.acquire(request());
    await first.close();
    const resumed = await p.acquire(request());
    expect(resumed).not.toBe(first);
    expect(resumed.native).toEqual(first.native);
    await p.close();
  });

  it("preserves recent crash counts across transport respawns", async () => {
    const { pool: p } = pool();
    for (let i = 0; i < 3; i += 1) {
      const session = await p.acquire(request());
      await session.close();
    }
    await p.acquire(request());
    expect(p.stats().degraded).toEqual([cid(0)]);
    await p.close();
  });

  it("serializes concurrent opens so they never exceed the child limit", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: singleChild });
    await Promise.all([
      p.acquire(request()),
      p.acquire(request({ conversationId: cid(1) })),
      p.acquire(request({ conversationId: cid(2) })),
    ]);
    expect(tracked.peak).toBe(1);
    expect(p.stats().children).toBe(1);
    await p.close();
    expect(tracked.live).toBe(0);
  });

  it("opens once when concurrent callers acquire the same conversation", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: config() });
    const [first, second] = await Promise.all([
      p.acquire(request()),
      p.acquire(request()),
    ]);
    expect(first).toBe(second);
    expect(tracked.open).toHaveBeenCalledTimes(1);
    await p.close();
    expect(tracked.live).toBe(0);
  });

  it("closes before respawning rather than briefly exceeding capacity", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: singleChild });
    await p.acquire(request());
    await p.acquire(request({ root: "/other" }));
    expect(tracked.peak).toBe(1);
    await p.close();
  });

  it("retains a closing child's slot until closure completes", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: singleChild });
    const session = await p.acquire(request());
    const gate = deferred<void>();
    const entered = deferred<void>();
    const close = session.close.bind(session);
    session.close = vi.fn(async () => {
      entered.resolve();
      await gate.promise;
      await close();
    });
    const released = p.release(cid(0));
    await entered.promise;
    expect(p.stats().children).toBe(1);
    const acquired = p.acquire(request({ conversationId: cid(1) }));
    expect(tracked.open).toHaveBeenCalledTimes(1);
    gate.resolve();
    await released;
    await acquired;
    expect(tracked.peak).toBe(1);
    await p.close();
  });

  it("shutdown closes a child whose open completes after shutdown began", async () => {
    const tracked = trackedBackend();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const backend = {
      ...tracked.backend,
      open: async (options: OpenOptions) => {
        entered.resolve();
        await gate.promise;
        return tracked.open(options);
      },
    };
    const p = new AgentPool({ backend, config: singleChild });
    const acquiring = p.acquire(request());
    const failed = expect(acquiring).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
    await entered.promise;
    const closing = p.close();
    gate.resolve();
    await failed;
    await closing;
    expect(tracked.live).toBe(0);
    expect(p.stats()).toMatchObject({ children: 0, spare: 0 });
    await p.close();
    expect(tracked.sessions[0]?.close).toHaveBeenCalledTimes(1);
  });
});

describe("pool closure and recovery ownership", () => {
  it("retains a live child after rejected closure and retries shutdown after confirmed exit", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: singleChild });
    const session = await p.acquire(request());
    const actuallyClose = session.close.bind(session);
    session.close = vi.fn(() => Promise.reject(new Error("close failed")));
    await expect(p.release(cid(0))).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
    expect(p.session(cid(0))).toBe(session);
    expect(p.stats().children).toBe(1);
    await expect(
      p.acquire(request({ conversationId: cid(1) })),
    ).rejects.toMatchObject({ code: "AGENT_UNAVAILABLE" });
    expect(tracked.open).toHaveBeenCalledTimes(1);
    await expect(p.close()).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
    await actuallyClose();
    await p.close();
    expect(p.stats().children).toBe(0);
  });

  it("retains a child when close resolves but the backend still reports it alive", async () => {
    const { pool: p } = pool();
    const session = await p.acquire(request());
    const actuallyClose = session.close.bind(session);
    session.close = vi.fn(async () => {});
    await expect(p.release(cid(0))).rejects.toThrow(
      "still alive after closing",
    );
    expect(p.stats().children).toBe(1);
    await actuallyClose();
    await p.close();
    expect(p.stats().children).toBe(0);
  });

  it("retains a live failed-close spare without opening a replacement", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: singleChild });
    const fresh = request();
    p.warmSpare(fresh.root, fresh.env);
    await p.sweepIdle();
    const session = tracked.sessions[0]!;
    const actuallyClose = session.close.bind(session);
    session.close = vi.fn(() => Promise.reject(new Error("spare stays alive")));
    await expect(p.acquire(request({ root: "/other" }))).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
    expect(p.stats().spare).toBe(1);
    expect(tracked.open).toHaveBeenCalledTimes(1);
    await expect(p.close()).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
    await actuallyClose();
    await p.close();
    expect(p.stats().spare).toBe(0);
  });

  it("closes a spare whose requested settings fail without reusing its partial configuration", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: singleChild });
    const fresh = request();
    p.warmSpare(fresh.root, fresh.env);
    await expect(
      p.acquire(
        request({
          title: "partial",
          model: { provider: "fake", id: "not-a-model" },
        }),
      ),
    ).rejects.toThrow("no model");
    expect(p.stats().spare).toBe(0);
    expect(tracked.live).toBe(0);
    const session = await p.acquire(request());
    expect((await session.state()).name).not.toBe("partial");
    await p.close();
  });

  it("closes a spare that cannot apply the requested title before opening with that title", async () => {
    const tracked = trackedBackend();
    const backend = {
      ...tracked.backend,
      open: async (options: OpenOptions) => {
        const session = await tracked.open(options);
        Object.defineProperty(session, "rename", { value: undefined });
        return session;
      },
    };
    const p = new AgentPool({ backend, config: singleChild });
    const fresh = request();
    p.warmSpare(fresh.root, fresh.env);
    const session = await p.acquire(request({ title: "fresh title" }));
    expect((await session.state()).name).toBe("fresh title");
    expect(tracked.sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(tracked.peak).toBe(1);
    await p.close();
  });

  it("retains the native handle across failed replacement startup", async () => {
    const tracked = trackedBackend();
    let fail = false;
    const backend = {
      ...tracked.backend,
      open: async (options: OpenOptions) => {
        if (fail) throw new Error("startup failed");
        return tracked.open(options);
      },
    };
    const p = new AgentPool({ backend, config: singleChild });
    const first = await p.acquire(request());
    fail = true;
    await expect(p.acquire(request({ root: "/other" }))).rejects.toThrow(
      "startup failed",
    );
    expect(p.stats().children).toBe(0);
    expect(p.session(cid(0))).toBeUndefined();
    fail = false;
    const resumed = await p.acquire(request({ root: "/other" }));
    expect(resumed.native).toEqual(first.native);
    await p.close();
  });

  it("closes a late-ready spare during concurrent shutdown and closes it only once", async () => {
    const tracked = trackedBackend();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const backend = {
      ...tracked.backend,
      open: async (options: OpenOptions) => {
        entered.resolve();
        await gate.promise;
        return tracked.open(options);
      },
    };
    const p = new AgentPool({ backend, config: singleChild });
    p.warmSpare(ROOT, {});
    await entered.promise;
    expect(p.stats().spare).toBe(1);
    const first = p.close();
    const second = p.close();
    expect(second).toBe(first);
    gate.resolve();
    await Promise.all([first, second]);
    expect(tracked.sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(tracked.live).toBe(0);
    await expect(p.acquire(request())).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
    p.warmSpare(ROOT, {});
    expect(p.stats().spare).toBe(0);
  });

  it("does not overwrite an existing binding when explicitly taking a spare", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: config() });
    const first = await p.acquire(request());
    const fresh = request();
    p.warmSpare(fresh.root, fresh.env);
    await p.takeSpare(cid(0), fresh.root, fresh.env);
    expect(p.session(cid(0))).toBe(first);
    expect(p.stats().spare).toBe(1);
    await p.close();
    expect(tracked.live).toBe(0);
  });

  it("does not double-count a crash already reported by the turn manager", async () => {
    const { pool: p } = pool();
    const first = await p.acquire(request());
    await first.close();
    expect(p.noteCrash(cid(0)).recent).toBe(1);
    await p.acquire(request());
    expect(p.noteCrash(cid(0)).recent).toBe(2);
    await p.close();
  });

  it("updates a persona whose tools changed while its name stayed the same", async () => {
    const { pool: p } = pool();
    const first = await p.acquire(
      request({ persona: { name: "custom", tools: ["read"] } }),
    );
    const second = await p.acquire(
      request({ persona: { name: "custom", tools: ["read", "write"] } }),
    );
    expect(second).toBe(first);
    expect(
      (second as { persona?: { tools: string[] } }).persona?.tools,
    ).toEqual(["read", "write"]);
    await p.close();
  });

  it("rejects an advertised live persona switch without the matching method", async () => {
    const { pool: p } = pool();
    const session = await p.acquire(request());
    Object.defineProperty(session, "setPersona", { value: undefined });
    await expect(
      p.acquire(request({ persona: { name: "ask" } })),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await p.close();
  });

  it("treats zero expiry as immediate for idle children while preserving busy work", async () => {
    const { pool: p } = pool({
      config: config({
        pool: { maxChildren: 2, idleMinutes: 0, spare: false },
      }),
      isBusy: (id) => id === cid(0),
    });
    await p.acquire(request());
    await p.acquire(request({ conversationId: cid(1) }));
    expect(await p.sweepIdle()).toEqual([cid(1)]);
    expect(p.session(cid(0))).toBeDefined();
    await p.close();
  });
});

describe("spare lifecycle boundaries", () => {
  it("keeps one matching spare and replaces it safely for a different environment", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: singleChild });
    expect(p.backend).toBe(tracked.backend);
    p.warmSpare(ROOT, {});
    p.warmSpare(ROOT, {});
    await p.sweepIdle();
    expect(tracked.open).toHaveBeenCalledTimes(1);
    p.warmSpare(ROOT, { PATH: "/different" });
    await p.sweepIdle();
    expect(tracked.open).toHaveBeenCalledTimes(2);
    expect(tracked.sessions[0]?.close).toHaveBeenCalledTimes(1);
    p.warmSpare("/other", { PATH: "/different" });
    await p.sweepIdle();
    expect(tracked.open).toHaveBeenCalledTimes(3);
    expect(tracked.peak).toBe(1);
    await p.close();
    expect(tracked.live).toBe(0);
  });

  it("does not adopt a spare whose transport has exited", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: singleChild });
    const fresh = request();
    p.warmSpare(fresh.root, fresh.env);
    await p.sweepIdle();
    await tracked.sessions[0]!.close();
    const session = await p.acquire(request({ native: {} }));
    expect(session).not.toBe(tracked.sessions[0]);
    expect(tracked.peak).toBe(1);
    await p.close();
    expect(tracked.live).toBe(0);
  });

  it.each(["setThinking", "setPersona"] as const)(
    "reopens a spare missing %s with the full requested settings",
    async (method) => {
      const tracked = trackedBackend();
      const backend = {
        ...tracked.backend,
        open: async (options: OpenOptions) => {
          const session = await tracked.open(options);
          Object.defineProperty(session, method, { value: undefined });
          return session;
        },
      };
      const p = new AgentPool({ backend, config: singleChild });
      const fresh = request();
      p.warmSpare(fresh.root, fresh.env);
      const settings =
        method === "setThinking"
          ? { thinking: "high" }
          : { persona: { name: "ask" } };
      await p.acquire(request(settings));
      expect(tracked.open.mock.calls[1]?.[0]).toMatchObject(settings);
      expect(tracked.sessions[0]?.close).toHaveBeenCalledTimes(1);
      expect(tracked.peak).toBe(1);
      await p.close();
    },
  );

  it("retains a failed-close spare and logs prewarming failure", async () => {
    const tracked = trackedBackend();
    const log = vi.fn();
    const p = new AgentPool({
      backend: tracked.backend,
      config: singleChild,
      log,
    });
    p.warmSpare(ROOT, {});
    await p.sweepIdle();
    const spare = tracked.sessions[0]!;
    const actuallyClose = spare.close.bind(spare);
    spare.close = vi.fn(() => Promise.reject(new Error("still alive")));
    p.warmSpare("/other", {});
    await p.sweepIdle();
    expect(log).toHaveBeenCalledWith("could not pre-warm a spare agent child", {
      cause: "agent child could not be closed",
    });
    expect(p.stats().spare).toBe(1);
    expect(tracked.open).toHaveBeenCalledTimes(1);
    await actuallyClose();
    await p.close();
  });

  it("does not start queued prewarming once shutdown begins", async () => {
    const tracked = trackedBackend();
    const gate = deferred<void>();
    const entered = deferred<void>();
    const backend = {
      ...tracked.backend,
      open: async (options: OpenOptions) => {
        entered.resolve();
        await gate.promise;
        return tracked.open(options);
      },
    };
    const p = new AgentPool({ backend, config: config() });
    const acquiring = p.acquire(request());
    const failed = expect(acquiring).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
    await entered.promise;
    expect(p.stats().children).toBe(1);
    p.warmSpare(ROOT, {});
    const closing = p.close();
    gate.resolve();
    await failed;
    await closing;
    expect(tracked.open).toHaveBeenCalledTimes(1);
    expect(tracked.live).toBe(0);
  });

  it("honors the spare option override without changing the supplied configuration", async () => {
    const tracked = trackedBackend();
    const options = config();
    const p = new AgentPool({
      backend: tracked.backend,
      config: options,
      spare: false,
    });
    p.warmSpare(ROOT, {});
    await p.close();
    expect(tracked.open).not.toHaveBeenCalled();
    expect(options.pool.spare).toBe(true);
  });

  it("preserves ownership if a nonfinite idle interval reaches the pool", async () => {
    const { pool: p } = pool({
      config: config({
        pool: { maxChildren: 2, idleMinutes: Number.NaN, spare: false },
      }),
    });
    const session = await p.acquire(request());
    expect(await p.sweepIdle()).toEqual([]);
    expect(p.session(cid(0))).toBe(session);
    await p.close();
  });
});

describe("persona spare restrictions", () => {
  it("cold-opens persona-bearing requests even when the backend advertises live switching", async () => {
    const tracked = trackedBackend();
    const p = new AgentPool({ backend: tracked.backend, config: singleChild });
    const fresh = request();
    p.warmSpare(fresh.root, fresh.env);
    const persona = { name: "ask", tools: ["read"] };
    const session = await p.acquire(request({ persona }));
    expect(tracked.open).toHaveBeenCalledTimes(2);
    expect(tracked.open.mock.calls[1]?.[0].persona).toEqual(persona);
    expect(tracked.sessions[0]?.close).toHaveBeenCalledTimes(1);
    expect(session).not.toBe(tracked.sessions[0]);
    expect(tracked.peak).toBe(1);
    await p.close();
  });
});
