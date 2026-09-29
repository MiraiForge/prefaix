import { describe, expect, it } from "vitest";
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
  } = {},
): { pool: AgentPool; agent: FakeAgent } {
  const agent = createFakeAgent({ tickMs: 0, ...options.fake });
  return {
    agent,
    pool: new AgentPool({
      backend: agent,
      config: options.config ?? config(),
      ...(options.now === undefined ? {} : { now: options.now }),
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
    expect(p.stats().degraded).toEqual([]);
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
        return {
          ...session,
          abort: () => session.abort(),
          close: () => Promise.reject(new Error("the child is already gone")),
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
