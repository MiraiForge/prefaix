import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Daemon } from "../../src/daemon/daemon.js";
import {
  defaultConfig,
  type PrefaixConfig,
} from "../../src/core/config/schema.js";
import { resolvePaths } from "../../src/core/paths.js";
import type { TurnStartParams } from "../../src/core/protocol.js";
import type { AgentEvent } from "../../src/core/agent-port.js";
import { FakeSession } from "../../src/agents/fake/adapter.js";
import { TestClient } from "../support/client.js";

let home: string;
let daemon: Daemon;
let client: TestClient;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pfx-suggest-"));
});
afterEach(async () => {
  client?.close();
  await daemon?.stop();
  vi.restoreAllMocks();
  rmSync(home, { force: true, recursive: true });
});
async function start(
  model: string | null = null,
  settings: Partial<PrefaixConfig> = {},
) {
  const config = defaultConfig();
  daemon = new Daemon({
    paths: resolvePaths({
      home,
      env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    }),
    config: {
      ...config,
      agent: { ...config.agent, backend: "fake" },
      pool: { ...config.pool, spare: false },
      commands: { ...config.commands, suggest: { model } },
      ...settings,
    },
    version: "test",
    checkOwner: false,
  });
  await daemon.start();
  client = await TestClient.open(daemon.store.paths.socket);
}
function params(extra: Partial<TurnStartParams> = {}): TurnStartParams {
  return {
    shell: { kind: "fish", version: "4", shellId: "1-1-a", pid: 1 },
    cwd: home,
    env: { HOME: home },
    text: "find a file",
    context: {
      recent: [],
      os: "test",
      term: { cols: 80, rows: 24, colors: 0 },
    },
    ...extra,
  };
}
async function turn(extra: Partial<TurnStartParams> = {}) {
  const response = await client.call("turn.start", params(extra));
  expect(response.ok, response.error?.message).toBe(true);
  const result = response.data as { conversationId: string; turnId: string };
  const end = await client.waitFor(
    (m) => m.t === "turn.end" && m.turnId === result.turnId,
  );
  if (end.t !== "turn.end") throw new Error("missing end");
  const events = client
    .events()
    .flatMap((m) => (m.t === "evt" && m.turnId === result.turnId ? [m.e] : []));
  return { ...result, summary: end.summary, events };
}
function session(id: string) {
  return daemon.pool.session(id) as FakeSession;
}
function scripted(active: FakeSession, events: AgentEvent[]) {
  return vi.spyOn(active, "prompt").mockImplementation(async function* () {
    yield* events;
  });
}
const proposal: AgentEvent = {
  type: "set_buffer",
  text: "printf '%s' 日本語🙂\n\techo done",
};
const stop: AgentEvent = { type: "settled", stopReason: "stop" };

it("returns exactly one literal proposal only after successful settlement", async () => {
  await start();
  const first = await turn({ edit: "suggest" });
  expect(first.summary.status).toBe("stop");
  expect(first.summary.buffer).toBe("printf '%s\\n' 'fake suggestion'");
  expect(first.events.filter((e) => e.type === "settled")).toHaveLength(1);
  expect(session(first.conversationId).lastPrompt).toMatchObject({
    text: "find a file",
    commandProposal: true,
    context: { shell: { kind: "fish" } },
  });
  expect(first.events.at(-2)).toEqual({
    type: "set_buffer",
    text: first.summary.buffer,
  });
  expect(first.events.at(-1)).toEqual(stop);
  const next = await turn({ conversationId: first.conversationId });
  expect(next.summary.buffer).toBeUndefined();
  expect(
    session(first.conversationId).lastPrompt?.commandProposal,
  ).toBeUndefined();
});

it("retains the conversation persona but never arms :go from an edit answer", async () => {
  await start();
  const first = await turn({ persona: "plan" });
  expect((await daemon.store.get(first.conversationId))?.planReady).toBe(true);
  await turn({ conversationId: first.conversationId, edit: "suggest" });
  expect(await daemon.store.get(first.conversationId)).toMatchObject({
    persona: "plan",
    planReady: false,
  });
  expect(session(first.conversationId).persona?.name).toBe("plan");
});

it.each(["fake/fake-slow", "fake-slow"])(
  "temporarily scopes %s and restores model/thinking before recording",
  async (model) => {
    await start(model);
    const first = await turn();
    const active = session(first.conversationId);
    await active.setThinking("high");
    const observed: unknown[] = [];
    const original = active.prompt.bind(active);
    vi.spyOn(active, "prompt").mockImplementation(
      async function* (input, signal) {
        observed.push(await active.state());
        yield* original(input, signal);
      },
    );
    const realSetModel = active.setModel.bind(active);
    const setter = vi
      .spyOn(active, "setModel")
      .mockImplementation(async (ref) => {
        await realSetModel(ref);
        if (ref.id === "fake-slow") await active.setThinking("off");
      });
    const result = await turn({
      conversationId: first.conversationId,
      edit: "suggest",
    });
    expect(result.summary.status).toBe("stop");
    expect(observed[0]).toMatchObject({
      model: { provider: "fake", id: "fake-slow" },
    });
    expect(setter.mock.calls.map(([ref]) => ref.id)).toEqual([
      "fake-slow",
      "fake-fast",
    ]);
    expect(await active.state()).toMatchObject({
      model: { provider: "fake", id: "fake-fast" },
      thinking: "high",
    });
    expect(await daemon.store.get(first.conversationId)).toMatchObject({
      model: { provider: "fake", id: "fake-fast" },
      thinking: "high",
    });
  },
);

it.each(["missing/model", "fake-fast"])(
  "rejects unavailable or ambiguous model %s before prompting",
  async (model) => {
    await start(model);
    const first = await turn();
    const active = session(first.conversationId);
    if (model === "fake-fast")
      vi.spyOn(active, "listModels").mockResolvedValue([
        { provider: "one", id: model },
        { provider: "two", id: model },
      ]);
    const prompt = vi.spyOn(active, "prompt");
    const result = await turn({
      conversationId: first.conversationId,
      edit: "suggest",
    });
    expect(result.summary).toMatchObject({
      status: "error",
      error: expect.stringContaining("unavailable or ambiguous"),
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(result.summary.buffer).toBeUndefined();
  },
);

it("fails closed if the previous model cannot be restored", async () => {
  await start("fake/fake-slow");
  const first = await turn();
  const active = session(first.conversationId);
  const real = active.setModel.bind(active);
  vi.spyOn(active, "setModel").mockImplementation(async (ref) => {
    if (ref.id === "fake-fast") throw new Error("restore failed");
    await real(ref);
  });
  const result = await turn({
    conversationId: first.conversationId,
    edit: "suggest",
  });
  expect(result.summary).toMatchObject({
    status: "error",
    error: expect.stringContaining("restore failed"),
  });
  expect(result.summary.buffer).toBeUndefined();
  expect(result.events.filter((e) => e.type === "set_buffer")).toEqual([]);
  expect(result.events.filter((e) => e.type === "settled")).toHaveLength(1);
  expect(daemon.pool.session(first.conversationId)).toBeUndefined();
  expect(await daemon.store.get(first.conversationId)).toMatchObject({
    model: { provider: "fake", id: "fake-fast" },
  });
  await turn({ conversationId: first.conversationId });
  expect(session(first.conversationId)).not.toBe(active);
  expect((await session(first.conversationId).state()).model?.id).toBe(
    "fake-fast",
  );
});

it("restores after a partially applied model switch rejects", async () => {
  await start("fake/fake-slow");
  const first = await turn();
  const active = session(first.conversationId);
  const real = active.setModel.bind(active);
  vi.spyOn(active, "setModel").mockImplementation(async (ref) => {
    await real(ref);
    if (ref.id === "fake-slow") throw new Error("partly switched");
  });
  const prompt = vi.spyOn(active, "prompt");
  const result = await turn({
    conversationId: first.conversationId,
    edit: "suggest",
  });
  expect(result.summary.status).toBe("error");
  expect(prompt).not.toHaveBeenCalled();
  expect((await active.state()).model?.id).toBe("fake-fast");
});

it("refuses a dedicated model if state cannot identify the baseline", async () => {
  await start("fake/fake-slow");
  const first = await turn();
  const active = session(first.conversationId);
  vi.spyOn(active, "state").mockResolvedValue({ busy: false });
  const prompt = vi.spyOn(active, "prompt");
  const result = await turn({
    conversationId: first.conversationId,
    edit: "suggest",
  });
  expect(result.summary.error).toContain("cannot restore");
  expect(prompt).not.toHaveBeenCalled();
});

it.each(
  (
    [
      [proposal, { type: "settled", stopReason: "error", error: "failed" }],
      [proposal, { type: "settled", stopReason: "aborted" }],
      [proposal, { type: "settled", stopReason: "length" }],
      [proposal, proposal, stop],
      [{ type: "set_buffer", text: "echo\0unsafe" }, stop],
      [stop],
      [proposal],
    ] as AgentEvent[][]
  ).map((events, index) => ({
    events,
    status: ["error", "aborted", "length", "error", "error", "error", "error"][
      index
    ],
  })),
)(
  "does not deliver an incomplete, failed, or ambiguous edit %#",
  async ({ events, status }) => {
    await start();
    const first = await turn();
    scripted(session(first.conversationId), events);
    const result = await turn({
      conversationId: first.conversationId,
      edit: "suggest",
    });
    expect(result.summary.status).toBe(status);
    expect(result.summary.buffer).toBeUndefined();
    expect(result.events.filter((e) => e.type === "set_buffer")).toEqual([]);
    expect(result.events.filter((e) => e.type === "settled")).toHaveLength(1);
  },
);

it("does not release a proposal if durable outcome writing fails", async () => {
  await start();
  const first = await turn();
  scripted(session(first.conversationId), [proposal, stop]);
  vi.spyOn(daemon.store, "update").mockRejectedValue(new Error("disk failure"));
  const result = await turn({
    conversationId: first.conversationId,
    edit: "suggest",
  });
  expect(result.summary.error).toContain("disk failure");
  expect(result.summary.buffer).toBeUndefined();
  expect(result.events.filter((e) => e.type === "set_buffer")).toEqual([]);
});

it.each([
  { edit: "other" },
  { edit: "suggest", text: "" },
  { edit: "suggest", executePlan: true },
  { edit: "suggest", persona: "ask" },
])(
  "rejects invalid edit intent before creating a conversation %#",
  async (extra) => {
    await start();
    const response = await client.call("turn.start", { ...params(), ...extra });
    expect(response).toMatchObject({ ok: false, error: { code: "USAGE" } });
    expect(await daemon.store.list()).toEqual([]);
  },
);

it("rejects unsupported proposal backends before opening a child", async () => {
  await start();
  Object.assign(daemon.pool.backend.capabilities, { commandProposals: false });
  expect(
    await client.call("turn.start", params({ edit: "suggest" })),
  ).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
  expect(daemon.pool.stats().children).toBe(0);
  expect(await daemon.store.list()).toEqual([]);
});

it("withdraws a proposal when Esc arrives during durable finalization", async () => {
  await start();
  const first = await turn();
  scripted(session(first.conversationId), [proposal, stop]);
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const update = daemon.store.update.bind(daemon.store);
  vi.spyOn(daemon.store, "update").mockImplementation(async (...args) => {
    entered();
    await gate;
    return update(...args);
  });
  const response = await client.call(
    "turn.suggest",
    params({ conversationId: first.conversationId }),
  );
  expect(response.ok).toBe(true);
  const { turnId } = response.data as { turnId: string };
  try {
    await waiting;
    expect((await client.call("turn.abort", { turnId })).ok).toBe(true);
  } finally {
    release();
  }
  const end = await client.waitFor(
    (m) => m.t === "turn.end" && m.turnId === turnId,
  );
  expect(end).toMatchObject({ t: "turn.end", summary: { status: "aborted" } });
  if (end.t === "turn.end") expect(end.summary.buffer).toBeUndefined();
  expect(
    client
      .events()
      .filter(
        (m) =>
          m.t === "evt" && m.turnId === turnId && m.e.type === "set_buffer",
      ),
  ).toEqual([]);
});

it("refuses dedicated model scoping without thinking restoration", async () => {
  await start("fake/fake-slow");
  const first = await turn();
  const active = session(first.conversationId);
  Object.defineProperty(active, "setThinking", { value: undefined });
  const result = await turn({
    conversationId: first.conversationId,
    edit: "suggest",
  });
  expect(result.summary.error).toContain("cannot restore the current thinking");
  expect(result.summary.buffer).toBeUndefined();
});

it("refuses dedicated models on a backend without models", async () => {
  await start("fake/fake-slow");
  const first = await turn();
  Object.assign(daemon.pool.backend.capabilities, { models: false });
  const result = await turn({
    conversationId: first.conversationId,
    edit: "suggest",
  });
  expect(result.summary).toMatchObject({
    status: "error",
    error: expect.stringContaining("models"),
  });
});
