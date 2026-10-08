import { afterEach, describe, expect, it, vi } from "vitest";
import { PiRpc, type PiChild } from "../../src/agents/pi/rpc.js";
import { PiSession } from "../../src/agents/pi/adapter.js";
import type { PromptInput } from "../../src/core/agent-port.js";

function harness(options: { startupUi?: boolean; exitOnKill?: boolean } = {}) {
  let stdout: (chunk: string) => void = () => {};
  let exited: Parameters<PiChild["onExit"]>[0] = () => {};
  const writes: Record<string, unknown>[] = [];
  const kills: string[] = [];
  const emit = (record: Record<string, unknown>) =>
    stdout(JSON.stringify(record) + "\n");
  const ui = (id: string, method = "select", timeout?: number) =>
    emit({
      type: "extension_ui_request",
      id,
      method,
      title: "Scripted dialog",
      options: ["Yes"],
      ...(timeout === undefined ? {} : { timeout }),
    });
  const ack = (command: string) => {
    const request = writes.filter((w) => w["type"] === command).at(-1)!;
    emit({
      id: request["id"],
      type: "response",
      command,
      success: true,
      data: {},
    });
  };
  const child: PiChild = {
    pid: 1234,
    write: (line) => {
      const request = JSON.parse(line) as Record<string, unknown>;
      writes.push(request);
      if (request["type"] === "get_state") {
        if (options.startupUi) ui("startup");
        ack("get_state");
      }
    },
    endStdin: () => exited({ code: 0, signal: null }),
    kill: (signal) => {
      kills.push(signal);
      if (options.exitOnKill !== false) exited({ code: null, signal });
    },
    onStdout: (fn) => {
      stdout = fn;
    },
    onStderr: () => {},
    onExit: (fn) => {
      exited = fn;
    },
    onError: () => {},
  };
  const rpc = new PiRpc({
    bin: "scripted",
    args: [],
    cwd: "/workspace",
    env: {},
    spawn: () => child,
    requestTimeoutMs: 200,
    killGraceMs: 50,
  });
  return { rpc, writes, kills, emit, ui, ack };
}

const input: PromptInput = {
  text: "scripted, not native/model evidence",
  context: {
    shell: { kind: "bash", version: "test", shellId: "test", pid: 1 },
    cwd: "/workspace",
    recent: [],
    os: "test",
    term: { cols: 80, rows: 24, colors: 256 },
  },
};

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("scripted human UI deadlines", () => {
  it.each(["select", "confirm", "input", "editor"])(
    "pauses prompt acceptance, but not metadata deadlines, for %s",
    async (method) => {
      vi.useFakeTimers();
      const { rpc, ui, ack, writes, kills } = harness();
      await rpc.waitReady();
      let accepted = false;
      const prompt = rpc.request("prompt", { message: "test" }).then(() => {
        accepted = true;
      });
      ui("human", method);
      ui("human", method); // duplicate notification must not replace a live wait
      await vi.advanceTimersByTimeAsync(30000);
      expect(accepted).toBe(false);
      expect(rpc.waitingForUi).toBe(true);
      const metadata = rpc
        .request("get_commands")
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(201);
      expect(await metadata).toMatchObject({
        message: "pi get_commands timed out after 200ms",
      });
      expect(rpc.closing).toBe(false);
      rpc.respondUi("stale", { value: "Yes" });
      expect(rpc.waitingForUi).toBe(true);
      rpc.respondUi("human", { value: "Yes" });
      rpc.respondUi("human", { value: "No" });
      expect(
        writes.filter((w) => w["type"] === "extension_ui_response"),
      ).toEqual([{ type: "extension_ui_response", id: "human", value: "Yes" }]);
      expect(rpc.waitingForUi).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(accepted).toBe(false);
      ack("prompt");
      await prompt;
      await vi.advanceTimersByTimeAsync(30000);
      expect(kills).toEqual([]);
      await rpc.close();
    },
  );

  it.each(["notify", "setStatus", "future-method"])(
    "does not treat %s as an unanswered dialog",
    async (method) => {
      vi.useFakeTimers();
      const { rpc, ui, kills } = harness();
      await rpc.waitReady();
      const prompt = rpc.request("prompt").catch((error: unknown) => error);
      ui("notice", method);
      await vi.advanceTimersByTimeAsync(201);
      expect(await prompt).toMatchObject({
        message: "pi prompt timed out after 200ms",
      });
      expect(kills).toEqual(["SIGKILL"]);
      expect(rpc.exited).toBe(true);
    },
  );

  it("waits for the last concurrent dialog and re-arms the ordinary acceptance deadline", async () => {
    vi.useFakeTimers();
    const { rpc, ui, kills } = harness();
    await rpc.waitReady();
    const prompt = rpc.request("prompt").catch((error: unknown) => error);
    ui("first");
    ui("second", "confirm");
    rpc.respondUi("first", { value: "Yes" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(rpc.waitingForUi).toBe(true);
    expect(kills).toEqual([]);
    rpc.respondUi("second", { confirmed: true });
    await vi.advanceTimersByTimeAsync(201);
    expect(await prompt).toMatchObject({
      message: "pi prompt timed out after 200ms",
    });
    expect(kills).toEqual(["SIGKILL"]);
  });

  it("honors an extension-owned dialog timeout and ignores expired answers", async () => {
    vi.useFakeTimers();
    const { rpc, ui, ack, writes } = harness();
    await rpc.waitReady();
    const prompt = rpc.request("prompt");
    ui("expires", "input", 60);
    await vi.advanceTimersByTimeAsync(61);
    expect(rpc.waitingForUi).toBe(false);
    expect(rpc.closing).toBe(false);
    rpc.respondUi("expires", { value: "late" });
    expect(writes.filter((w) => w["type"] === "extension_ui_response")).toEqual(
      [],
    );
    ack("prompt");
    await prompt;
    await rpc.close();
  });

  it("retires auto-resolved pre-ack dialogs on acceptance but keeps later tool UI", async () => {
    vi.useFakeTimers();
    const { rpc, ui, ack } = harness();
    await rpc.waitReady();
    const prompt = rpc.request("prompt");
    ui("preflight");
    const metadata = rpc.request("get_commands");
    ack("get_commands");
    await metadata;
    expect(rpc.waitingForUi).toBe(true);
    ack("prompt");
    await prompt;
    expect(rpc.waitingForUi).toBe(false);
    ui("tool");
    expect(rpc.waitingForUi).toBe(true);
    rpc.respondUi("tool", { cancelled: true });
    expect(rpc.waitingForUi).toBe(false);
    await rpc.close();
  });

  it("holds startup UI without pausing the readiness deadline", async () => {
    vi.useFakeTimers();
    const { rpc, ack } = harness({ startupUi: true });
    await rpc.waitReady();
    expect(rpc.takeStartupRecords()).toHaveLength(1);
    const prompt = rpc.request("prompt");
    await vi.advanceTimersByTimeAsync(1000);
    expect(rpc.waitingForUi).toBe(true);
    rpc.respondUi("startup", { value: "Yes" });
    ack("prompt");
    await prompt;
    await rpc.close();
  });

  it.each(["signal", "method"])(
    "hard-stops an unanswered dialog on %s abort without replying cancelled",
    async (kind) => {
      vi.useFakeTimers();
      const { rpc, ui, writes, kills } = harness();
      const session = new PiSession(
        rpc,
        { sessionId: "scripted" },
        {},
        { bin: "scripted", root: "/workspace" },
      );
      await session.ready();
      const controller = new AbortController();
      const turn = session.prompt(input, controller.signal);
      const next = turn.next();
      ui("human");
      expect((await next).value).toEqual({ type: "turn_start" });
      const request = (await turn.next()).value;
      expect(request).toMatchObject({ type: "ui_request" });
      if (kind === "signal") controller.abort();
      else await session.abort();
      expect((await turn.next()).value).toEqual({
        type: "settled",
        stopReason: "aborted",
      });
      expect((await turn.next()).done).toBe(true);
      expect(session.busy).toBe(false);
      expect(session.isAlive).toBe(false);
      expect(kills).toEqual(["SIGKILL"]);
      session.respondUi(
        request!.type === "ui_request" ? request!.id : "stale",
        { cancelled: true },
      );
      expect(
        writes.filter((w) => w["type"] === "extension_ui_response"),
      ).toEqual([]);
      await session.close();
    },
  );

  it("answers startup UI only once before forwarding a fresh preflight dialog", async () => {
    vi.useFakeTimers();
    const { rpc, ui, ack, emit } = harness({ startupUi: true });
    const session = new PiSession(
      rpc,
      {},
      {},
      { bin: "scripted", root: "/workspace" },
    );
    await session.ready();
    const turn = session.prompt(input, new AbortController().signal);
    expect((await turn.next()).value).toEqual({ type: "turn_start" });
    const startup = (await turn.next()).value;
    expect(startup).toMatchObject({ type: "ui_request", kind: "select" });
    if (startup?.type === "ui_request")
      session.respondUi(startup.id, { value: "Yes" });
    const next = turn.next();
    ui("fresh", "confirm");
    const fresh = (await next).value;
    expect(fresh).toMatchObject({ type: "ui_request", kind: "confirm" });
    if (fresh?.type === "ui_request")
      session.respondUi(fresh.id, { confirmed: true });
    ack("prompt");
    emit({ type: "agent_start" });
    emit({ type: "agent_settled" });
    expect((await turn.next()).value).toEqual({
      type: "settled",
      stopReason: "stop",
    });
    expect((await turn.next()).done).toBe(true);
    await session.close();
  });

  it("does not submit a prompt after aborting its startup dialog", async () => {
    vi.useFakeTimers();
    const { rpc, writes, kills } = harness({ startupUi: true });
    const session = new PiSession(
      rpc,
      {},
      {},
      { bin: "scripted", root: "/workspace" },
    );
    await session.ready();
    const controller = new AbortController();
    const turn = session.prompt(input, controller.signal);
    expect((await turn.next()).value).toEqual({ type: "turn_start" });
    expect((await turn.next()).value).toMatchObject({ type: "ui_request" });
    controller.abort();
    expect((await turn.next()).value).toEqual({
      type: "settled",
      stopReason: "aborted",
    });
    expect((await turn.next()).done).toBe(true);
    expect(writes.some((w) => w["type"] === "prompt")).toBe(false);
    expect(kills).toEqual(["SIGKILL"]);
    await session.close();
  });

  it("stops timed-out preflight before returning a single local error settlement", async () => {
    vi.useFakeTimers();
    const { rpc, kills } = harness();
    const session = new PiSession(
      rpc,
      {},
      {},
      { bin: "scripted", root: "/workspace" },
    );
    await session.ready();
    const turn = session.prompt(input, new AbortController().signal);
    const next = turn.next();
    await vi.advanceTimersByTimeAsync(201);
    expect((await next).value).toMatchObject({
      type: "settled",
      stopReason: "error",
      error: "pi prompt timed out after 200ms",
    });
    expect((await turn.next()).done).toBe(true);
    expect(session.isAlive).toBe(false);
    expect(kills).toEqual(["SIGKILL"]);
    await session.close();
  });

  it("does not leave paused requests dangling when forced exit cannot be confirmed", async () => {
    vi.useFakeTimers();
    const { rpc, ui, kills } = harness({ exitOnKill: false });
    await rpc.waitReady();
    const prompt = rpc.request("prompt").catch((error: unknown) => error);
    ui("human");
    const closing = rpc.terminate();
    expect(rpc.terminate()).toBe(closing);
    expect(rpc.closing).toBe(true);
    await vi.advanceTimersByTimeAsync(51);
    expect(await prompt).toMatchObject({
      message: "pi child was forcibly terminated",
    });
    expect(await closing).toMatchObject({ escalatedTo: "SIGKILL" });
    expect(kills).toEqual(["SIGKILL"]);
    await expect(rpc.request("get_state")).rejects.toThrow("closing");
  });

  it("can terminate an unspawned or already-exited child without escalation", async () => {
    const { rpc, kills } = harness();
    expect(await rpc.terminate()).toMatchObject({ escalatedTo: "already" });
    expect(kills).toEqual([]);
    const live = harness();
    await live.rpc.waitReady();
    await live.rpc.close();
    expect(await live.rpc.terminate()).toMatchObject({
      escalatedTo: "already",
    });
    expect(live.kills).toEqual([]);
  });
});
