import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Daemon } from "../../src/daemon/daemon.js";
import { Operations } from "../../src/daemon/operations.js";
import { FakeSession } from "../../src/agents/fake/adapter.js";
import { DaemonClient } from "../../src/client/connection.js";
import { run, type RunOptions } from "../../src/client/run.js";
import { defaultConfig } from "../../src/core/config/schema.js";
import { resolvePaths, shellRuntimeFiles } from "../../src/core/paths.js";
import { decodeDirectives } from "../../src/shells/directives.js";
import { EventRing } from "../../src/daemon/turns.js";
import type {
  TurnStartParams,
  TurnStartResult,
  TurnAttachResult,
  OperationName,
} from "../../src/core/protocol.js";
import { TestClient } from "../support/client.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
function input() {
  let listener: ((text: string) => void) | undefined;
  const modes: boolean[] = [];
  return {
    modes,
    send: (text: string) => listener?.(text),
    tty: {
      setRawMode(raw: boolean) {
        modes.push(raw);
        return raw;
      },
      on(_name: string, fn: (text: string) => void) {
        listener = fn;
      },
      removeAllListeners() {
        listener = undefined;
      },
    },
  };
}
let home: string;
let daemon: Daemon;
let paths: ReturnType<typeof resolvePaths>;
let clients: TestClient[];
let output: string[];
let pause: ReturnType<typeof gate>;
let config: ReturnType<typeof defaultConfig>;
const shell = { kind: "bash" as const, version: "5", shellId: "1-1-a", pid: 1 };
async function client() {
  const connection = await TestClient.open(paths.socket);
  clients.push(connection);
  return connection;
}
function params(extra: Partial<TurnStartParams> = {}): TurnStartParams {
  return {
    shell,
    cwd: home,
    env: { HOME: home, PATH: process.env.PATH! },
    text: "work",
    context: {
      recent: [],
      os: "test",
      term: { cols: 80, rows: 24, colors: 0 },
    },
    ...extra,
  };
}
function status(shellId = shell.shellId) {
  return readFileSync(shellRuntimeFiles(paths, shellId).status, "utf8").trim();
}
function directives() {
  return decodeDirectives(readFileSync(join(home, "directives")))!;
}
async function start(c: TestClient, extra: Partial<TurnStartParams> = {}) {
  const response = await c.call("turn.start", params(extra));
  expect(response.ok, response.error?.message).toBe(true);
  const result = response.data as TurnStartResult;
  await c.waitFor((m) => m.t === "evt" && m.e.type === "text_delta");
  return result;
}
async function detach(c: TestClient, started: TurnStartResult) {
  const response = await c.call("turn.detach", { turnId: started.turnId });
  expect(response.ok, response.error?.message).toBe(true);
  return response;
}
async function finished(id: string) {
  await vi.waitFor(() => expect(daemon.turns.lastFor(id)?.finished).toBe(true));
}
function invoke(
  line: string,
  conversation = "",
  options: Partial<RunOptions> = {},
) {
  return run({
    argv: [
      "--shell",
      "bash",
      "--shell-id",
      shell.shellId,
      "--shell-pid",
      String(process.pid),
      "--nonce",
      "n",
      "--directives",
      join(home, "directives"),
      "--cwd",
      home,
      "--conversation",
      conversation,
      "--",
      line,
    ],
    version: "test",
    config,
    paths,
    env: { HOME: home, PATH: process.env.PATH! },
    out: (text) => output.push(text),
    err: (text) => output.push(text),
    stdoutIsTty: false,
    tty: input().tty,
    ...options,
  });
}
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "pfx-detach-"));
  paths = resolvePaths({
    home,
    env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
  });
  config = structuredClone(defaultConfig());
  config.agent.backend = "fake";
  config.pool.spare = false;
  clients = [];
  output = [];
  pause = gate();
  vi.spyOn(FakeSession.prototype, "prompt").mockImplementation(
    async function* (_input, signal) {
      yield { type: "turn_start" };
      yield { type: "text_delta", block: 0, text: "before detach\n" };
      let onAbort!: () => void;
      const abort = new Promise<void>((resolve) => {
        onAbort = resolve;
      });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (!signal.aborted) await Promise.race([pause.promise, abort]);
        if (signal.aborted) {
          yield { type: "settled", stopReason: "aborted" };
          return;
        }
        yield { type: "text_delta", block: 0, text: "after detach\n" };
        yield { type: "text_end", block: 0 };
        yield { type: "settled", stopReason: "stop" };
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  );
  daemon = new Daemon({ paths, config, version: "test", checkOwner: false });
  await daemon.start();
});
afterEach(async () => {
  for (const c of clients) c.close();
  pause.open();
  await daemon.stop();
  vi.restoreAllMocks();
  rmSync(home, { force: true, recursive: true });
});
it("acknowledges detach, survives disconnect, replays once and forwards future events to the new owner", async () => {
  const original = await client();
  const started = await start(original);
  expect((await detach(original, started)).data).toEqual(started);
  expect(status()).toBe("⟳ running");
  const turn = daemon.turns.get(started.turnId)!;
  expect(turn.owner).toBe("detached");
  original.close();
  const next = await client();
  const attached = await next.call("turn.attach", {
    conversationId: started.conversationId,
    fromSeq: 1,
    follow: true,
    shell: { ...shell, shellId: "2-2-b" },
  });
  expect(attached.data).toMatchObject({ ...started, following: true });
  expect(turn.controller.signal.aborted).toBe(false);
  pause.open();
  await next.waitFor((m) => m.t === "turn.end");
  const events = next.eventsOfType("evt");
  expect(events.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(
    events
      .filter((m) => m.e.type === "text_delta")
      .map((m) => (m.e.type === "text_delta" ? m.e.text : ""))
      .join(""),
  ).toBe("before detach\nafter detach\n");
  expect(status()).toBe("✓ done");
  expect(status("2-2-b")).toBe("✓ done");
});
it("replays a completed detached turn, and a cursor avoids duplicate output", async () => {
  const original = await client();
  const started = await start(original);
  await detach(original, started);
  original.close();
  pause.open();
  await finished(started.conversationId);
  const next = await client();
  expect(
    (
      await next.call("turn.attach", {
        conversationId: started.conversationId,
        fromSeq: 3,
        follow: true,
      })
    ).ok,
  ).toBe(true);
  expect(next.eventsOfType("evt").map((m) => m.seq)).toEqual([3, 4, 5]);
  expect(next.eventsOfType("turn.end")).toHaveLength(1);
});
it("refuses ownership theft and conversation aborts of attached turns", async () => {
  const original = await client();
  const started = await start(original);
  const other = await client();
  expect(
    (await other.call("turn.detach", { turnId: started.turnId })).error
      ?.message,
  ).toContain("owning foreground");
  expect(
    (
      await other.call("turn.attach", {
        conversationId: started.conversationId,
        fromSeq: 1,
        follow: true,
      })
    ).error?.code,
  ).toBe("CONVERSATION_BUSY");
  expect(
    (await other.call("turn.abort", { conversationId: started.conversationId }))
      .error?.code,
  ).toBe("CONVERSATION_BUSY");
  expect(daemon.turns.get(started.turnId)?.controller.signal.aborted).toBe(
    false,
  );
});
it("aborts a detached turn by conversation, reports no running turn afterwards, and still replays its outcome", async () => {
  const original = await client();
  const started = await start(original);
  await detach(original, started);
  original.close();
  const other = await client();
  expect(
    (await other.call("turn.abort", { conversationId: started.conversationId }))
      .ok,
  ).toBe(true);
  await finished(started.conversationId);
  expect(daemon.turns.lastFor(started.conversationId)?.summary?.status).toBe(
    "aborted",
  );
  expect(
    (await other.call("turn.abort", { conversationId: started.conversationId }))
      .error?.message,
  ).toContain("no detached turn");
  expect(
    (
      await other.call("turn.attach", {
        conversationId: started.conversationId,
        fromSeq: 1,
        follow: true,
      })
    ).ok,
  ).toBe(true);
  expect(other.eventsOfType("turn.end")[0]?.summary.status).toBe("aborted");
});
it("resumes a continue-on-disconnect turn but aborts when a reattached client disconnects without detach", async () => {
  const original = await client();
  const started = await start(original, { onDisconnect: "continue" });
  original.close();
  await vi.waitFor(() =>
    expect(daemon.turns.get(started.turnId)?.owner).toBe("detached"),
  );
  const next = await client();
  await next.call("turn.attach", {
    conversationId: started.conversationId,
    fromSeq: 1,
    follow: true,
  });
  expect(daemon.turns.get(started.turnId)?.owner).toBe("attached");
  // Explicit continuation policy is retained on this turn.
  next.close();
  await vi.waitFor(() =>
    expect(daemon.turns.get(started.turnId)?.owner).toBe("detached"),
  );
  const last = await client();
  await last.call("turn.abort", { conversationId: started.conversationId });
  await finished(started.conversationId);
});
it.each([-1, 1.5, null, "1"])(
  "rejects invalid replay cursor %j",
  async (fromSeq) => {
    const original = await client();
    const started = await start(original);
    expect(
      (
        await original.call("turn.attach", {
          conversationId: started.conversationId,
          fromSeq,
        })
      ).error?.code,
    ).toBe("USAGE");
  },
);
it("refuses edit detachment and unknown turn ids without releasing ownership", async () => {
  const original = await client();
  const started = await start(original, { edit: "suggest" });
  expect(
    (await original.call("turn.detach", { turnId: started.turnId })).error
      ?.code,
  ).toBe("UNSUPPORTED");
  expect(
    (await original.call("turn.detach", { turnId: "unknown" })).error?.code,
  ).toBe("CONVERSATION_NOT_FOUND");
  expect(daemon.turns.get(started.turnId)?.owner).toBe("attached");
});
it("Ctrl+Z restores the tty and typeahead, preserves daemon status, and :attach replays the complete turn", async () => {
  const tty = input();
  const pending = invoke(": work", "", { tty: tty.tty });
  await vi.waitFor(() => expect(output.join("")).toContain("before detach"));
  tty.send("echo held");
  tty.send("\u001a");
  expect(await pending).toBe(0);
  const id = directives().conversation!;
  expect(directives().buffer).toBe("echo held");
  expect(tty.modes).toEqual([true, false]);
  expect(status()).toBe("⟳ running");
  output = [];
  const attachedTty = input();
  const attached = invoke(":attach", id, { tty: attachedTty.tty });
  await vi.waitFor(() => expect(output.join("")).toContain("before detach"));
  pause.open();
  expect(await attached).toBe(0);
  expect(output.join("")).toContain("after detach");
  expect(output.join("").match(/before detach/g)).toHaveLength(1);
  expect(attachedTty.modes).toEqual([true, false]);
  expect(directives().buffer).toBeUndefined();
});
it("honors cancellation while waiting for detach acknowledgment without hanging or returning success", async () => {
  const tty = input();
  const ack = gate();
  const pending = invoke(": work", "", {
    tty: tty.tty,
    connect: (options) => {
      const c = new DaemonClient(options);
      const call = c.call.bind(c);
      c.call = async <T>(op: OperationName, args?: unknown) => {
        const result = await call<T>(op, args);
        if (op === "turn.detach") await ack.promise;
        return result;
      };
      return c;
    },
  });
  try {
    await vi.waitFor(() => expect(output.join("")).toContain("before detach"));
    const id = daemon.turns.active[0]!.conversationId;
    tty.send("\u001a");
    await vi.waitFor(() =>
      expect(daemon.turns.runningFor(id)?.owner).toBe("detached"),
    );
    tty.send("\u0003");
    await finished(id);
    ack.open();
    expect(await pending).toBe(130);
    expect(status()).toBe("✓ done");
    expect(tty.modes).toEqual([true, false]);
  } finally {
    ack.open();
  }
});

it("Ctrl+Z requested during turn-start acknowledgment detaches after the matching turn id arrives", async () => {
  const tty = input();
  expect(
    await invoke(": work", "", {
      tty: tty.tty,
      connect: (options) => {
        const c = new DaemonClient(options);
        const call = c.call.bind(c);
        c.call = async (op, args) => {
          if (op === "turn.start") tty.send("\u001a");
          return call(op, args);
        };
        return c;
      },
    }),
  ).toBe(0);
  expect(daemon.turns.lastFor(directives().conversation!)?.owner).toBe(
    "detached",
  );
});
it.each([":attach extra", ":abort extra"])(
  "rejects unexpected arguments in %s",
  async (line) => {
    expect(await invoke(line)).toBe(2);
    expect(output.join("")).toContain("does not take arguments");
  },
);
it("supports :abort without taking the tty and reports missing conversations clearly", async () => {
  expect(await invoke(":attach")).toBe(2);
  expect(await invoke(":abort")).toBe(2);
  const tty = input();
  const pending = invoke(": work", "", { tty: tty.tty });
  await vi.waitFor(() => expect(output.join("")).toContain("before detach"));
  tty.send("\u001a");
  await pending;
  const id = directives().conversation!;
  const abortTty = input();
  expect(await invoke(":abort", id, { tty: abortTty.tty })).toBe(0);
  expect(abortTty.modes).toEqual([]);
  await finished(id);
  expect(status()).toBe("✓ done");
});
it("refuses Ctrl+Z in edit turns, keeping the proposal guarded until cancellation", async () => {
  const tty = input();
  const pending = invoke(":suggest command", "", { tty: tty.tty });
  await vi.waitFor(() => expect(output.join("")).toContain("before detach"));
  tty.send("\u001a");
  expect(output.join("")).toContain("edit turns cannot detach");
  expect(daemon.turns.active[0]?.owner).toBe("attached");
  tty.send("\u0003");
  expect(await pending).toBe(130);
  expect(directives().buffer).toBeUndefined();
});
it("a daemon without detach support reports it clearly and continues the foreground turn", async () => {
  const tty = input();
  const pending = invoke(": work", "", {
    tty: tty.tty,
    connect: (options) => {
      const c = new DaemonClient(options);
      const call = c.call.bind(c);
      c.call = async (op, args) => {
        if (op === "turn.detach") throw new Error("unsupported detach");
        return call(op, args);
      };
      return c;
    },
  });
  await vi.waitFor(() => expect(output.join("")).toContain("before detach"));
  tty.send("\u001a");
  await vi.waitFor(() =>
    expect(output.join("")).toContain("cannot detach: unsupported detach"),
  );
  expect(daemon.turns.active[0]?.owner).toBe("attached");
  pause.open();
  expect(await pending).toBe(0);
});
it.each([{ turnId: "wrong", conversationId: "wrong" }, undefined])(
  "fails closed on a malformed detach acknowledgment %j without hanging the tty",
  async (ack) => {
    const tty = input();
    const pending = invoke(": work", "", {
      tty: tty.tty,
      connect: (options) => {
        const c = new DaemonClient(options);
        const call = c.call.bind(c);
        c.call = async <T>(op: OperationName, args?: unknown) =>
          op === "turn.detach" ? (ack as T) : call<T>(op, args);
        return c;
      },
    });
    await vi.waitFor(() => expect(output.join("")).toContain("before detach"));
    tty.send("\u001a");
    expect(await pending).toBe(2);
    expect(output.join("")).toContain("did not acknowledge this turn");
    expect(tty.modes).toEqual([true, false]);
  },
);

it("does not accept a legacy snapshot-only daemon as a live attachment", async () => {
  const original = await client();
  const started = await start(original);
  await detach(original, started);
  expect(
    await invoke(":attach", started.conversationId, {
      connect: (options) => {
        const c = new DaemonClient(options);
        const call = c.call.bind(c);
        c.call = async <T>(op: OperationName, args?: unknown) => {
          const response = await call<T>(op, args);
          if (op === "turn.attach")
            delete (response as TurnAttachResult).following;
          return response;
        };
        return c;
      },
    }),
  ).toBe(2);
  expect(output.join("")).toContain("cannot follow an attached turn");
});
it.each([
  ["ctrl-z", "\u001a", 0],
  ["ctrl-c", "\u0003", 130],
  ["esc", "\u001b", 130],
] as const)(
  "stops completed replay with %s before its backpressured attach response",
  async (_name, key, exit) => {
    const original = await client();
    const started = await start(original);
    pause.open();
    await finished(started.conversationId);
    const held = gate();
    const entered = gate();
    const attach = Operations.prototype.turnAttach;
    vi.spyOn(Operations.prototype, "turnAttach").mockImplementation(function (
      this: Operations,
      args,
      connection,
    ) {
      return attach.call(this, args, {
        ...connection,
        get closed() {
          return connection.closed;
        },
        waitWritable: (signal?: AbortSignal) => {
          entered.open();
          if (connection.closed || signal?.aborted) return;
          if (signal === undefined) return held.promise;
          return new Promise<void>((resolve) => {
            const release = () => {
              signal.removeEventListener("abort", release);
              resolve();
            };
            signal.addEventListener("abort", release, { once: true });
            void held.promise.then(release);
          });
        },
      });
    });
    const tty = input();
    const pending = invoke(":attach", started.conversationId, { tty: tty.tty });
    try {
      await entered.promise;
      tty.send(key);
      expect(await pending).toBe(exit);
      expect(tty.modes).toEqual([true, false]);
      expect(directives().buffer).toBeUndefined();
      expect(
        daemon.turns.lastFor(started.conversationId)?.summary?.status,
      ).toBe("stop");
      expect(output.join("")).not.toContain("after detach");
    } finally {
      held.open();
    }
  },
);
it("cancellation of a pending live attach aborts even a continue-on-disconnect turn", async () => {
  const original = await client();
  const started = await start(original, { onDisconnect: "continue" });
  await detach(original, started);
  const held = gate();
  const entered = gate();
  const attach = Operations.prototype.turnAttach;
  vi.spyOn(Operations.prototype, "turnAttach").mockImplementation(function (
    this: Operations,
    args,
    connection,
  ) {
    return attach.call(this, args, {
      ...connection,
      get closed() {
        return connection.closed;
      },
      waitWritable: (signal?: AbortSignal) => {
        entered.open();
        if (connection.closed || signal?.aborted) return;
        if (signal === undefined) return held.promise;
        return new Promise<void>((resolve) => {
          const release = () => {
            signal.removeEventListener("abort", release);
            resolve();
          };
          signal.addEventListener("abort", release, { once: true });
          void held.promise.then(release);
        });
      },
    });
  });
  const tty = input();
  const pending = invoke(":attach", started.conversationId, { tty: tty.tty });
  try {
    await entered.promise;
    tty.send("\u0003");
    expect(await pending).toBe(130);
    await finished(started.conversationId);
    expect(daemon.turns.lastFor(started.conversationId)?.summary?.status).toBe(
      "aborted",
    );
  } finally {
    held.open();
  }
});
it("cancelled completed edit replay cannot restore a finalized command while its reply is blocked", async () => {
  pause.open();
  vi.spyOn(FakeSession.prototype, "prompt").mockImplementation(
    async function* () {
      yield { type: "set_buffer", text: "echo safe" };
      yield { type: "settled", stopReason: "stop" };
    },
  );
  expect(await invoke(":suggest command")).toBe(0);
  const id = directives().conversation!;
  const held = gate();
  const entered = gate();
  const attach = Operations.prototype.turnAttach;
  vi.spyOn(Operations.prototype, "turnAttach").mockImplementation(function (
    this: Operations,
    args,
    connection,
  ) {
    return attach.call(this, args, {
      ...connection,
      get closed() {
        return connection.closed;
      },
      waitWritable: (signal?: AbortSignal) => {
        entered.open();
        if (connection.closed || signal?.aborted) return;
        if (signal === undefined) return held.promise;
        return new Promise<void>((resolve) => {
          const release = () => {
            signal.removeEventListener("abort", release);
            resolve();
          };
          signal.addEventListener("abort", release, { once: true });
          void held.promise.then(release);
        });
      },
    });
  });
  const tty = input();
  const pending = invoke(":attach", id, { tty: tty.tty });
  try {
    await entered.promise;
    tty.send("\u001a");
    expect(await pending).toBe(0);
    expect(directives().buffer).toBeUndefined();
    expect(output.join("")).toContain("replay stopped");
  } finally {
    held.open();
  }
});
it("warns about evicted output rather than pretending replay is complete", async () => {
  const original = await client();
  const started = await start(original);
  await detach(original, started);
  const turn = daemon.turns.get(started.turnId)!;
  const ring = new EventRing(64);
  ring.push({ type: "turn_start" });
  ring.push({ type: "text_delta", block: 0, text: "old".repeat(100) });
  ring.push({ type: "text_delta", block: 0, text: "retained\n" });
  Object.defineProperty(turn, "ring", { value: ring });
  pause.open();
  await finished(started.conversationId);
  expect(await invoke(":attach", started.conversationId)).toBe(0);
  expect(output.join("")).toContain(
    "earlier turn output is no longer available",
  );
});
it("cancels outstanding dialogs on detach and does not ask them again during replay", async () => {
  const answer = vi.spyOn(FakeSession.prototype, "respondUi");
  vi.spyOn(FakeSession.prototype, "prompt").mockImplementation(
    async function* () {
      yield { type: "turn_start" };
      yield { type: "text_delta", block: 0, text: "before detach\n" };
      yield {
        type: "ui_request",
        id: "question",
        kind: "confirm",
        title: "Proceed?",
      };
      await pause.promise;
      yield { type: "settled", stopReason: "stop" };
    },
  );
  const original = await client();
  const started = await start(original);
  await original.waitFor((m) => m.t === "evt" && m.e.type === "ui_request");
  await detach(original, started);
  expect(answer).toHaveBeenCalledWith("question", { cancelled: true });
  expect(daemon.turns.get(started.turnId)?.dialogs.size).toBe(0);
  pause.open();
  await finished(started.conversationId);
  const next = await client();
  await next.call("turn.attach", {
    conversationId: started.conversationId,
    fromSeq: 1,
    follow: true,
  });
  expect(next.eventsOfType("evt").some((m) => m.e.type === "ui_request")).toBe(
    false,
  );
  expect(next.eventsOfType("evt").map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
});
it("answers newly arriving detached dialogs immediately and exposes error status on completion", async () => {
  const answer = vi.spyOn(FakeSession.prototype, "respondUi");
  vi.spyOn(FakeSession.prototype, "prompt").mockImplementation(
    async function* () {
      yield { type: "turn_start" };
      yield { type: "text_delta", block: 0, text: "before detach\n" };
      await pause.promise;
      yield { type: "ui_request", id: "late", kind: "input", title: "Input?" };
      yield { type: "settled", stopReason: "error", error: "scripted failure" };
    },
  );
  const original = await client();
  const started = await start(original);
  await detach(original, started);
  pause.open();
  await finished(started.conversationId);
  expect(answer).toHaveBeenCalledWith("late", { cancelled: true });
  expect(status()).toBe("✗ error");
  expect(await invoke(":attach", started.conversationId)).toBe(1);
  expect(output.join("")).toContain("scripted failure");
});
it("a reattached default-policy turn aborts when its foreground closes without detaching", async () => {
  const original = await client();
  const started = await start(original);
  await detach(original, started);
  original.close();
  const next = await client();
  await next.call("turn.attach", {
    conversationId: started.conversationId,
    fromSeq: 1,
    follow: true,
  });
  next.close();
  await finished(started.conversationId);
  expect(daemon.turns.lastFor(started.conversationId)?.summary?.status).toBe(
    "aborted",
  );
});
it("does not render duplicate sequence deliveries twice", async () => {
  pause.open();
  expect(
    await invoke(": work", "", {
      connect: (options) => {
        const c = new DaemonClient(options);
        const onEvent = c.onEvent.bind(c);
        c.onEvent = (listener) =>
          onEvent((id, event) => {
            listener(id, event);
            listener(id, event);
          });
        return c;
      },
    }),
  ).toBe(0);
  expect(output.join("").match(/before detach/g)).toHaveLength(1);
});
it("a newer detached conversation keeps its running status when an older one completes", async () => {
  const waits = [gate(), gate()];
  let index = 0;
  vi.spyOn(FakeSession.prototype, "prompt").mockImplementation(
    async function* () {
      const wait = waits[index++]!;
      yield { type: "turn_start" };
      yield { type: "text_delta", block: 0, text: "before detach\n" };
      await wait.promise;
      yield { type: "settled", stopReason: "stop" };
    },
  );
  try {
    const original = await client();
    const first = await start(original);
    await detach(original, first);
    original.clearEvents();
    const second = await start(original, { newConversation: true });
    await detach(original, second);
    waits[0]!.open();
    await finished(first.conversationId);
    expect(status()).toBe("⟳ running");
    waits[1]!.open();
    await finished(second.conversationId);
    expect(status()).toBe("✓ done");
  } finally {
    for (const wait of waits) wait.open();
  }
});

it("refuses replaying shell-specific edit proposals in a different shell", async () => {
  pause.open();
  vi.spyOn(FakeSession.prototype, "prompt").mockImplementation(
    async function* () {
      yield { type: "set_buffer", text: "echo safe" };
      yield { type: "settled", stopReason: "stop" };
    },
  );
  expect(await invoke(":suggest command")).toBe(0);
  const next = await client();
  expect(
    (
      await next.call("turn.attach", {
        conversationId: directives().conversation,
        fromSeq: 1,
        follow: true,
        shell: { ...shell, kind: "fish" },
      })
    ).error?.message,
  ).toContain("original shell");
  expect(next.eventsOfType("evt")).toEqual([]);
});
it("completed edit replay uses only its finalized proposal, never auto-runs it", async () => {
  pause.open();
  vi.spyOn(FakeSession.prototype, "prompt").mockImplementation(
    async function* () {
      yield { type: "set_buffer", text: "echo safe" };
      yield { type: "settled", stopReason: "stop" };
    },
  );
  expect(await invoke(":suggest command")).toBe(0);
  const id = directives().conversation!;
  expect(await invoke(":attach", id)).toBe(0);
  expect(directives().buffer).toBe("echo safe");
});
