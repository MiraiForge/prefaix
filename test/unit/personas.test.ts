import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Daemon } from "../../src/daemon/daemon.js";
import { PrefaixError } from "../../src/core/errors.js";
import {
  defaultConfig,
  type PrefaixConfig,
} from "../../src/core/config/schema.js";
import {
  PLAN_EXECUTION_PROMPT,
  type TurnStartParams,
} from "../../src/core/protocol.js";
import { resolvePaths } from "../../src/core/paths.js";
import type { FakeSession } from "../../src/agents/fake/adapter.js";
import { TestClient } from "../support/client.js";

let home: string;
let daemon: Daemon;
let client: TestClient;

async function start(
  overrides: Partial<PrefaixConfig> = {},
  scenario = "hello",
) {
  const defaults = defaultConfig();
  daemon = new Daemon({
    paths: resolvePaths({
      home,
      env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    }),
    config: {
      ...defaults,
      agent: { ...defaults.agent, backend: "fake" },
      pool: { ...defaults.pool, spare: false },
      ...overrides,
    },
    version: "test",
    checkOwner: false,
    env: { PREFAIX_FAKE_SCENARIO: scenario },
  });
  await daemon.start();
  client = await TestClient.open(daemon.store.paths.socket);
}
function params(overrides: Partial<TurnStartParams> = {}): TurnStartParams {
  return {
    shell: { kind: "zsh", version: "test", shellId: "1-1-a", pid: 1 },
    cwd: home,
    env: { HOME: home, PATH: "/usr/bin" },
    text: "explain this code",
    context: {
      recent: [],
      os: "test",
      term: { cols: 100, rows: 30, colors: 256 },
    },
    ...overrides,
  };
}
async function turn(overrides: Partial<TurnStartParams> = {}) {
  const response = await client.call("turn.start", params(overrides));
  expect(response.ok, response.error?.message).toBe(true);
  const result = response.data as { conversationId: string; turnId: string };
  const end = await client.waitFor(
    (m) => m.t === "turn.end" && m.turnId === result.turnId,
  );
  expect(end.t).toBe("turn.end");
  return result;
}
function session(id: string) {
  return daemon.pool.session(id) as FakeSession;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-personas-"));
});
afterEach(async () => {
  client?.close();
  await daemon?.stop();
  rmSync(home, { recursive: true, force: true });
});

describe("conversation personas", () => {
  it("persists a built-in persona across plain turns, eviction, and environment respawn", async () => {
    await start();
    const first = await turn({ persona: "ask" });
    const original = session(first.conversationId);
    const expected = {
      name: "ask",
      tools: ["read", "grep", "find", "ls"],
      guideline: "Answer the question. Do not modify files.",
    };
    expect(original.persona).toEqual(expected);
    await turn({ conversationId: first.conversationId, text: "and this?" });
    expect(session(first.conversationId)).toBe(original);
    expect(original.lastPrompt?.persona).toEqual(expected);
    await daemon.pool.release(first.conversationId);
    await turn({ conversationId: first.conversationId });
    expect(session(first.conversationId)).not.toBe(original);
    expect(session(first.conversationId).persona).toEqual(expected);
    const second = session(first.conversationId);
    await turn({
      conversationId: first.conversationId,
      env: { PATH: "/bin", HOME: home },
    });
    expect(session(first.conversationId)).not.toBe(second);
    expect(session(first.conversationId).persona).toEqual(expected);
    expect((await daemon.store.get(first.conversationId))?.persona).toBe("ask");
  });

  it.each(["split", "follow", "stay"] as const)(
    "does not rewrite already durable warm state under %s policy",
    async (cwdPolicy) => {
      await start({ workspace: { ...defaultConfig().workspace, cwdPolicy } });
      const first = await turn({ persona: "ask" });
      const updates = vi.spyOn(daemon.store, "update");
      try {
        await turn({ conversationId: first.conversationId });
        // Only the new outcome needs a durable write. Startup has no title,
        // root, executable-plan, native-handle, or persona change to commit.
        expect(updates.mock.calls).toHaveLength(1);
        expect(updates.mock.calls[0]?.[1]).toMatchObject({
          planReady: false,
          stats: { turns: 2 },
        });
        expect(session(first.conversationId).persona?.name).toBe("ask");
      } finally {
        updates.mockRestore();
      }
    },
  );

  it.each(["sessionId", "sessionFile"] as const)(
    "persists a changed native %s before prompting",
    async (field) => {
      await start();
      const first = await turn();
      const active = session(first.conversationId);
      const expected = { ...active.native, [field]: "new-native-handle" };
      Object.assign(active.native, expected);
      const observed: unknown[] = [];
      const prompt = active.prompt.bind(active);
      const watching = vi
        .spyOn(active, "prompt")
        .mockImplementation(async function* (input, signal) {
          observed.push((await daemon.store.get(first.conversationId))?.native);
          yield* prompt(input, signal);
        });
      try {
        await turn({ conversationId: first.conversationId });
        expect(observed).toEqual([expected]);
      } finally {
        watching.mockRestore();
      }
    },
  );

  it("switches custom and built-in personas in the same native conversation, and clears explicitly", async () => {
    await start({
      personas: {
        ...defaultConfig().personas,
        audit: { tools: ["read"], guideline: "Audit dependencies." },
        free: { tools: null, guideline: "Ask before editing." },
      },
    });
    const first = await turn({ persona: "audit" });
    const original = session(first.conversationId);
    expect(original.persona).toEqual({
      name: "audit",
      tools: ["read"],
      guideline: "Audit dependencies.",
    });
    await turn({ conversationId: first.conversationId, persona: "plan" });
    expect(session(first.conversationId)).toBe(original);
    expect(original.persona?.name).toBe("plan");
    await turn({ conversationId: first.conversationId, persona: "free" });
    expect(original.persona).toEqual({
      name: "free",
      guideline: "Ask before editing.",
    });
    await turn({ conversationId: first.conversationId, persona: null });
    expect(original.persona).toBeUndefined();
    expect(
      (await daemon.store.get(first.conversationId))?.persona,
    ).toBeUndefined();
  });

  it("executes a completed plan with normal tools without changing native identity", async () => {
    await start();
    const first = await turn({ persona: "plan", text: "plan the refactor" });
    const original = session(first.conversationId);
    expect((await daemon.store.get(first.conversationId))?.planReady).toBe(
      true,
    );
    const result = await turn({
      conversationId: first.conversationId,
      executePlan: true,
      text: "ignored wire text",
    });
    expect(result.conversationId).toBe(first.conversationId);
    expect(session(first.conversationId)).toBe(original);
    expect(original.persona).toBeUndefined();
    expect(original.lastPrompt?.text).toBe(PLAN_EXECUTION_PROMPT);
    const record = await daemon.store.get(first.conversationId);
    expect(record?.persona).toBeUndefined();
    expect(record?.planReady).toBe(false);
    expect(record?.stats.turns).toBe(2);
    const retry = await client.call(
      "turn.start",
      params({ conversationId: first.conversationId, executePlan: true }),
    );
    expect(retry.error?.message).toContain("no completed plan");
  });

  it.each(["consumed", "workspace"])(
    "rechecks a %s plan after claiming turn ownership",
    async (change) => {
      await start();
      const first = await turn({ persona: "plan" });
      const read = daemon.store.get.bind(daemon.store);
      let announce!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = vi
        .spyOn(daemon.store, "get")
        .mockImplementationOnce(async (id) => {
          const stale = await read(id);
          announce();
          await gate;
          return stale;
        });
      try {
        const pending = client.call(
          "turn.start",
          params({ conversationId: first.conversationId, executePlan: true }),
        );
        await entered;
        await daemon.store.update(
          first.conversationId,
          change === "consumed"
            ? { persona: undefined, planReady: false }
            : { root: join(home, "other") },
        );
        release();
        const result = await pending;
        expect(result.error?.message).toContain(
          change === "consumed" ? "no completed plan" : "workspace changed",
        );
        expect(session(first.conversationId).turnsRun).toBe(1);
      } finally {
        release();
        spy.mockRestore();
      }
    },
  );

  it("restores the default persona when :go resumes an evicted planning child", async () => {
    await start();
    const first = await turn({ persona: "plan" });
    const native = { ...session(first.conversationId).native };
    await daemon.pool.release(first.conversationId);
    await turn({ conversationId: first.conversationId, executePlan: true });
    expect(session(first.conversationId).native).toEqual(native);
    expect(session(first.conversationId).persona).toBeUndefined();
  });

  it("does not inherit an old workspace's persona into a new split conversation", async () => {
    await start();
    const first = await turn({ persona: "ask" });
    const other = join(home, "other");
    mkdirSync(other);
    const next = await turn({
      conversationId: first.conversationId,
      cwd: other,
    });
    expect(next.conversationId).not.toBe(first.conversationId);
    expect(session(next.conversationId).persona).toBeUndefined();
    expect((await daemon.store.get(first.conversationId))?.persona).toBe("ask");
  });

  it("refuses a cross-workspace :go before splitting or spawning a child", async () => {
    await start();
    const first = await turn({ persona: "plan" });
    const other = join(home, "other");
    mkdirSync(other);
    const response = await client.call(
      "turn.start",
      params({
        conversationId: first.conversationId,
        cwd: other,
        executePlan: true,
      }),
    );
    expect(response.error?.message).toContain("different workspace");
    expect(response.error?.hint).toContain(home);
    expect(await daemon.store.list()).toHaveLength(1);
    expect((await daemon.store.get(first.conversationId))?.planReady).toBe(
      true,
    );
    expect(session(first.conversationId).turnsRun).toBe(1);
  });

  it.each([
    {},
    { conversationId: "" },
    { newConversation: true },
    { persona: "ask" },
  ])(
    "refuses an invalid :go request %j without creating a conversation",
    async (overrides) => {
      await start();
      const response = await client.call(
        "turn.start",
        params({ executePlan: true, ...overrides }),
      );
      expect(response.error?.code).toBe("USAGE");
      expect(response.error?.hint).toContain(":plan");
      expect(await daemon.store.list()).toHaveLength(0);
    },
  );

  it("refuses :go on an ordinary answer or a failed planning turn", async () => {
    await start({}, "error");
    const first = await turn({ persona: "plan" });
    expect((await daemon.store.get(first.conversationId))?.planReady).toBe(
      false,
    );
    const response = await client.call(
      "turn.start",
      params({ conversationId: first.conversationId, executePlan: true }),
    );
    expect(response.error?.message).toContain("no completed plan");
  });

  it.each(["plan", "plain", "go"])(
    "invalidates the previous plan before backend startup for a %s turn can fail",
    async (kind) => {
      await start();
      const first = await turn({ persona: "plan" });
      const saved = await daemon.store.get(first.conversationId);
      expect(saved?.planReady).toBe(true);
      await daemon.pool.release(first.conversationId);
      const acquiring = vi
        .spyOn(daemon.pool, "acquire")
        .mockRejectedValueOnce(
          new PrefaixError(
            "AGENT_UNAVAILABLE",
            "replacement child failed to start",
          ),
        );
      try {
        const result = await client.call(
          "turn.start",
          params({
            conversationId: first.conversationId,
            ...(kind === "plan" ? { persona: "plan" } : {}),
            ...(kind === "go" ? { executePlan: true } : {}),
          }),
        );
        expect(result.error?.message).toContain("replacement child failed");
        expect((await daemon.store.get(first.conversationId))?.planReady).toBe(
          false,
        );
        const retry = await client.call(
          "turn.start",
          params({
            conversationId: first.conversationId,
            executePlan: true,
          }),
        );
        expect(retry.error?.message).toContain("no completed plan");
        expect(acquiring).toHaveBeenCalledTimes(1);
        expect(daemon.pool.session(first.conversationId)).toBeUndefined();
        expect(
          (await daemon.store.get(first.conversationId))?.lastAssistantText,
        ).toBe(saved?.lastAssistantText);
      } finally {
        acquiring.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "preserves the requested follow workspace while refreshing persona state (established=%s)",
    async (established) => {
      await start({
        workspace: { ...defaultConfig().workspace, cwdPolicy: "follow" },
      });
      const created = established
        ? await turn({ persona: "plan" })
        : await client
            .call("conv.new", {
              shell: params().shell,
              cwd: home,
              env: params().env,
            })
            .then((response) => {
              expect(response.ok).toBe(true);
              return { conversationId: (response.data as { id: string }).id };
            });
      const read = daemon.store.get.bind(daemon.store);
      let announce!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = vi
        .spyOn(daemon.store, "get")
        .mockImplementationOnce(async (id) => {
          const stale = await read(id);
          announce();
          await gate;
          return stale;
        });
      try {
        const pending = client.call(
          "turn.start",
          params({
            conversationId: created.conversationId,
            text: "A delayed prompt in workspace A.",
          }),
        );
        await entered;
        const other = join(home, "other");
        mkdirSync(other);
        await turn({
          conversationId: created.conversationId,
          cwd: other,
          persona: "ask",
        });
        const native = { ...session(created.conversationId).native };
        expect((await daemon.store.get(created.conversationId))?.root).toBe(
          other,
        );
        release();
        const response = await pending;
        expect(response.ok, response.error?.message).toBe(true);
        const result = response.data as {
          turnId: string;
          conversationId: string;
        };
        await client.waitFor(
          (m) => m.t === "turn.end" && m.turnId === result.turnId,
        );
        expect(result.conversationId).toBe(created.conversationId);
        expect(session(created.conversationId).lastRoot).toBe(home);
        expect(session(created.conversationId).lastPrompt?.context.cwd).toBe(
          home,
        );
        expect(session(created.conversationId).persona?.name).toBe("ask");
        expect(session(created.conversationId).native).toEqual(native);
        const record = await daemon.store.get(created.conversationId);
        expect(record?.root).toBe(home);
        expect(record?.persona).toBe("ask");
        expect(record?.planReady).toBe(false);
        expect(record?.stats.turns).toBe(established ? 3 : 2);
      } finally {
        release();
        reading.mockRestore();
      }
    },
  );

  it.each([undefined, "ask", null])(
    "resolves a delayed prompt's persona %s from current state under turn ownership",
    async (requested) => {
      await start();
      const first = await turn({ persona: "plan" });
      const read = daemon.store.get.bind(daemon.store);
      let announce!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reading = vi
        .spyOn(daemon.store, "get")
        .mockImplementationOnce(async (id) => {
          const stale = await read(id);
          announce();
          await gate;
          return stale;
        });
      try {
        const pending = client.call(
          "turn.start",
          params({
            conversationId: first.conversationId,
            text: "A delayed follow-up.",
            ...(requested === undefined ? {} : { persona: requested }),
          }),
        );
        await entered;
        await turn({ conversationId: first.conversationId, executePlan: true });
        expect(session(first.conversationId).persona).toBeUndefined();
        release();
        const response = await pending;
        expect(response.ok, response.error?.message).toBe(true);
        const result = response.data as { turnId: string };
        await client.waitFor(
          (m) => m.t === "turn.end" && m.turnId === result.turnId,
        );
        const expected = requested === "ask" ? "ask" : undefined;
        expect(session(first.conversationId).persona?.name).toBe(expected);
        expect(session(first.conversationId).lastPrompt?.persona?.name).toBe(
          expected,
        );
        const record = await daemon.store.get(first.conversationId);
        expect(record?.persona).toBe(expected);
        expect(record?.planReady).toBe(false);
        expect(record?.stats.turns).toBe(3);
        const retry = await client.call(
          "turn.start",
          params({
            conversationId: first.conversationId,
            executePlan: true,
          }),
        );
        expect(retry.error?.message).toContain("no completed plan");
      } finally {
        release();
        reading.mockRestore();
      }
    },
  );

  it("invalidates a previously completed plan when a new planning answer is empty", async () => {
    await start();
    const first = await turn({ persona: "plan" });
    // An empty answer is not an executable plan, even if the turn stops.
    session(first.conversationId).lastAssistantText = async () => "";
    await turn({ conversationId: first.conversationId, persona: "plan" });
    expect((await daemon.store.get(first.conversationId))?.planReady).toBe(
      false,
    );
    const response = await client.call(
      "turn.start",
      params({ conversationId: first.conversationId, executePlan: true }),
    );
    expect(response.error?.message).toContain("no completed plan");
  });

  it.each(["missing", "toString", "constructor"])(
    "gives a helpful error for unknown persona %s before making any turn",
    async (name) => {
      await start();
      const response = await client.call(
        "turn.start",
        params({ persona: name }),
      );
      expect(response.error).toMatchObject({
        code: "USAGE",
        message: `unknown persona "${name}"`,
        hint: "Known personas: ask, plan",
      });
      expect(await daemon.store.list()).toHaveLength(0);
    },
  );
});
