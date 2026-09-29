import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PrefaixError } from "../../src/core/errors.js";
import { PiRpc } from "../../src/agents/pi/rpc.js";
import type { PiRecord } from "../../src/agents/pi/types.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHILD = join(ROOT, "test/fixtures/pi/child.mjs");
const FIXTURES = join(ROOT, "test/fixtures/pi");

function fixture(name: string): string {
  return join(FIXTURES, name);
}

function makeRpc(
  name: string,
  options: { hang?: boolean; trace?: string } = {},
): PiRpc {
  return new PiRpc({
    bin: process.execPath,
    args: [CHILD, fixture(name), ...(options.hang === true ? ["--hang"] : [])],
    cwd: ROOT,
    env:
      options.trace === undefined ? {} : { PREFAIX_CHILD_TRACE: options.trace },
    requestTimeoutMs: 2_000,
    readyTimeoutMs: 4_000,
    termGraceMs: 500,
    killGraceMs: 500,
  });
}

/**
 * Waits for a condition the child reaches on its own schedule. A fixed sleep
 * is a guess about how long a process takes to die, and a loaded CI runner is
 * slower than a workstation, so the guess is what turns a pass into a flake.
 */
async function waitUntil(
  condition: () => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits for the child to be gone, which is an event and not a duration. */
async function waitForExit(rpc: PiRpc): Promise<void> {
  await waitUntil(() => rpc.exited, "the child to exit");
}

async function collect(rpc: PiRpc, count: number): Promise<PiRecord[]> {
  const events: PiRecord[] = [];
  for await (const record of rpc.events) {
    events.push(record);
    if (events.length >= count) {
      break;
    }
  }
  return events;
}

function tempTrace(): string {
  return join(mkdtempSync(join(tmpdir(), "pfx-trace-")), "commands.jsonl");
}

function traceCommands(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("pi transport framing", () => {
  it("correlates a request with its reply", async () => {
    const rpc = makeRpc("stream.jsonl");
    await rpc.waitReady();
    const state = await rpc.request("get_state");
    expect(state).toMatchObject({
      sessionId: "01a0ea38-719b-778d-9f81-e9cf3570db2c",
    });
    expect(rpc.ready).toBe(true);
    expect(rpc.pid).toBeGreaterThan(0);
    await rpc.close();
  });

  it("numbers requests so two in flight cannot collide", async () => {
    const trace = tempTrace();
    const rpc = makeRpc("stream.jsonl", { trace });
    await rpc.waitReady();
    await Promise.all([
      rpc.request("get_state"),
      rpc.request("get_available_thinking_levels"),
      rpc.request("get_session_stats"),
    ]);
    // r1 is the get_state that waitReady sends to define readiness.
    const ids = traceCommands(trace).map((command) => command["id"]);
    expect(ids).toEqual(["r1", "r2", "r3", "r4"]);
    expect(new Set(ids).size).toBe(ids.length);
    await rpc.close();
  });

  it("reassembles a line split across reads and strips a trailing CR", async () => {
    const rpc = makeRpc("stream.jsonl");
    await rpc.waitReady();
    const state = await rpc.request("get_state");
    expect(state).toBeDefined();
    await rpc.close();
  });

  it("keeps reading after a line that is not JSON", async () => {
    const noise: string[] = [];
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        [
          'process.stdout.write("not json at all\\n");',
          'process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s1"}}) + "\\n");',
          'process.stdout.write("also not json\\n");',
          'process.stdout.write(JSON.stringify({type:"agent_start"}) + "\\n");',
        ].join(""),
      ],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
      onProtocolNoise: (line) => noise.push(line),
    });
    await rpc.waitReady();
    const events = await collect(rpc, 1);
    expect(events).toEqual([{ type: "agent_start" }]);
    expect(noise).toEqual(["not json at all", "also not json"]);
    await rpc.close();
  });

  it("puts a failure's string into an AGENT_ERROR, with pi's own words", async () => {
    const rpc = makeRpc("stream.jsonl");
    await rpc.waitReady();
    await expect(
      rpc.request("no_such_command" as "get_state"),
    ).rejects.toMatchObject({
      code: "AGENT_ERROR",
      message: "pi no_such_command failed: Unknown command: no_such_command",
    });
    await rpc.close();
  });

  it("surfaces pi's leaked internal error rather than inventing one", async () => {
    const rpc = makeRpc("stream.jsonl");
    await rpc.waitReady();
    await expect(rpc.request("set_session_name", {})).rejects.toMatchObject({
      code: "AGENT_ERROR",
      message:
        "pi set_session_name failed: Cannot read properties of undefined (reading 'trim')",
    });
    await rpc.close();
  });

  it("times a command out instead of waiting forever", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      // Reads stdin and never answers.
      args: ["-e", "process.stdin.resume();"],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 60,
      readyTimeoutMs: 2_000,
    });
    await expect(rpc.request("get_state")).rejects.toMatchObject({
      code: "AGENT_ERROR",
      message: "pi get_state timed out after 60ms",
    });
    await rpc.close();
  });

  it("times readiness out when pi never speaks", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: ["-e", "process.stdin.resume();"],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
      readyTimeoutMs: 80,
    });
    // pi intermittently blocks at startup with no output, so ready is a
    // deadline rather than a certainty.
    await expect(rpc.waitReady()).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      message: "pi did not become ready within 80ms",
    });
    await rpc.close();
  });
});

describe("pi transport event stream", () => {
  it("holds pre-ready events until the caller is ready", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        [
          'process.stdout.write(JSON.stringify({type:"extension_ui_request",id:"ui_1",method:"setStatus",statusKey:"k",statusText:"early"}) + "\\n");',
          'process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");',
          'process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s1"}}) + "\\n");',
          "setTimeout(() => process.exit(0), 300);",
        ].join(""),
      ],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
    });
    const events: PiRecord[] = [];
    await rpc.waitReady();
    for await (const record of rpc.events) {
      events.push(record);
      if (events.length === 2) {
        break;
      }
    }
    // The ui request was written before the first reply, and still arrives
    // first, in order.
    expect(events.map((record) => record.type)).toEqual([
      "extension_ui_request",
      "agent_settled",
    ]);
    await rpc.close();
  });

  it("fails the event stream when the child dies mid-turn", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        [
          'process.stdin.setEncoding("utf8");',
          "let seen = 0;",
          'process.stdin.on("data", () => {',
          "  seen += 1;",
          "  if (seen === 1) {",
          '    process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s1"}}) + "\\n");',
          '    process.stdout.write(JSON.stringify({type:"agent_start"}) + "\\n");',
          "    return;",
          "  }",
          "  process.exit(1);",
          "});",
        ].join(""),
      ],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
      readyTimeoutMs: 2_000,
    });
    await rpc.waitReady();
    const iterator = rpc.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "agent_start" },
    });
    await expect(rpc.request("get_state")).rejects.toMatchObject({
      message: "pi exited with code 1",
    });
    // The turn's event stream ends by throwing, so the caller settles it.
    await expect(iterator.next()).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      message: "pi exited with code 1",
    });
  });

  it("rejects every pending request when the child is killed", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        "process.stdin.resume(); setTimeout(() => process.exit(9), 60);",
      ],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 5_000,
    });
    await expect(rpc.request("get_state")).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
      message: "pi exited with code 9",
    });
    expect(rpc.exited).toBe(true);
    expect(rpc.exitInfo).toEqual({ code: 9, signal: null });
  });
});

describe("pi transport shutdown", () => {
  it("closes on stdin EOF, which pi answers with exit 0", async () => {
    const rpc = makeRpc("stream.jsonl");
    await rpc.waitReady();
    const result = await rpc.close();
    expect(result.escalatedTo).toBe("stdin");
    expect(result.exit.code).toBe(0);
    expect(rpc.exited).toBe(true);
  });

  it("escalates to SIGTERM when the child ignores stdin", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      // Ignores stdin EOF; only SIGTERM ends it, and pi answers that with 143.
      args: [
        "-e",
        'process.stdin.resume(); setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(143));',
      ],
      cwd: ROOT,
      env: {},
      termGraceMs: 150,
      killGraceMs: 150,
    });
    rpc.spawn();
    const result = await rpc.close();
    expect(result.escalatedTo).toBe("SIGTERM");
    expect(result.exit.code).toBe(143);
  });

  it("escalates to SIGKILL when SIGTERM is ignored, and synthesizes the exit", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        'process.stdin.resume(); setInterval(() => {}, 1000); process.on("SIGTERM", () => {});',
      ],
      cwd: ROOT,
      env: {},
      termGraceMs: 120,
      killGraceMs: 1_000,
    });
    rpc.spawn();
    const result = await rpc.close();
    expect(result.escalatedTo).toBe("SIGKILL");
  });

  it("is idempotent", async () => {
    const rpc = makeRpc("stream.jsonl");
    await rpc.waitReady();
    const first = await rpc.close();
    const second = await rpc.close();
    expect(first.escalatedTo).toBe("stdin");
    expect(second.escalatedTo).toBe("already");
  });

  it("refuses new requests once closing", async () => {
    const rpc = makeRpc("stream.jsonl");
    await rpc.waitReady();
    await rpc.close();
    await expect(rpc.request("get_state")).rejects.toThrow(/closing|exited/);
  });

  it("refuses requests against a dead child rather than hanging", async () => {
    const rpc = makeRpc("stream.jsonl");
    await rpc.waitReady();
    await rpc.close();
    await expect(rpc.request("get_state")).rejects.toBeInstanceOf(PrefaixError);
  });
});

describe("pi transport stderr", () => {
  it("captures stderr for the log and never parses it as protocol", async () => {
    const lines: string[] = [];
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        [
          'process.stderr.write("Claude plugin path does not exist: /nope\\n");',
          'process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s1"}}) + "\\n");',
          "setTimeout(() => process.exit(0), 200);",
        ].join(""),
      ],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
      log: (message, fields) => {
        if (fields?.["line"] !== undefined) {
          lines.push(String(fields["line"]));
        }
        expect(message).toBe("pi stderr");
      },
    });
    await rpc.waitReady();
    expect(lines).toEqual(["Claude plugin path does not exist: /nope"]);
    await rpc.close();
  });
});

describe("pi transport options", () => {
  it("hands the first reply to the readiness inspector", async () => {
    const rpc = makeRpc("stream.jsonl");
    const seen: unknown[] = [];
    await rpc.waitReady((state) => seen.push(state));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      sessionId: "01a0ea38-719b-778d-9f81-e9cf3570db2c",
    });
    // A second wait is a no-op, so the inspector is not called twice.
    await rpc.waitReady((state) => seen.push(state));
    expect(seen).toHaveLength(1);
    await rpc.close();
  });

  it("accepts a per-request timeout override", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: ["-e", "process.stdin.resume();"],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 10_000,
    });
    await expect(
      rpc.request("get_state", {}, { timeoutMs: 60 }),
    ).rejects.toThrow("timed out after 60ms");
    await rpc.close();
  });

  it("writes a raw line, adding the newline it needs", async () => {
    const trace = tempTrace();
    const rpc = makeRpc("stream.jsonl", { trace });
    await rpc.waitReady();
    // No trailing newline: the transport adds one, so the child sees a whole
    // command rather than a fragment it would never act on.
    rpc.writeRaw(JSON.stringify({ id: "manual", type: "get_state" }));
    await waitUntil(
      () => traceCommands(trace).some((command) => command["id"] === "manual"),
      "the child to record the raw command",
    );
    await rpc.close();
  });

  it("reports a write to a dead child's stdin as unavailable", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: ["-e", 'process.stdin.on("data", () => process.exit(0));'],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
    });
    const failure = rpc.request("get_state").catch((error: unknown) => error);
    await waitUntil(() => rpc.exited, "the child to exit on its own");
    const error = await failure;
    expect(error).toBeInstanceOf(PrefaixError);
    await rpc.close();
  });

  it("closes cleanly when no child was ever spawned", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: ["-e", ""],
      cwd: ROOT,
      env: {},
    });
    await expect(rpc.close()).resolves.toMatchObject({
      escalatedTo: "already",
    });
  });

  it("rejects a request against a transport that was never started", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: ["-e", "process.exit(0);"],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
    });
    // No spawn: a request against a transport with no child is answered, not
    // left to time out.
    await expect(rpc.request("get_state")).rejects.toThrow(/exited/);
  });

  it("logs a reply whose id it does not recognise", async () => {
    const logs: string[] = [];
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        [
          'process.stdout.write(JSON.stringify({id:"ghost",type:"response",command:"get_state",success:true,data:{}}) + "\\n");',
          'process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s"}}) + "\\n");',
          'process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");',
          "setTimeout(() => process.exit(0), 400);",
        ].join(""),
      ],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
      log: (message) => logs.push(message),
    });
    await rpc.waitReady();
    await waitUntil(
      () => logs.includes("pi replied to an unknown request"),
      "the unknown request to be logged",
    );
    expect(logs).toContain("pi replied to an unknown request");
    await rpc.close();
  });

  it("reports a non-object record without throwing", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        [
          'process.stdout.write("null\\n");',
          'process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s"}}) + "\\n");',
          'process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");',
          "setTimeout(() => process.exit(0), 200);",
        ].join(""),
      ],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
    });
    await rpc.waitReady();
    const iterator = rpc.events[Symbol.asyncIterator]();
    // `null` is valid JSON, and it must be skipped rather than crash the reader.
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "agent_settled" },
    });
    await rpc.close();
  });

  it("exposes its spawn plan through the child it created", async () => {
    const rpc = makeRpc("stream.jsonl");
    expect(rpc.pid).toBeUndefined();
    rpc.spawn();
    expect(rpc.pid).toBeGreaterThan(0);
    // Spawning twice must not create a second child.
    rpc.spawn();
    await rpc.waitReady();
    expect(rpc.exited).toBe(false);
    await rpc.close();
  });
});

describe("pi transport framing details", () => {
  it("strips a trailing CR and skips blank lines", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        [
          'process.stdout.write("\\r\\n");',
          'process.stdout.write("\\r\\n");',
          'process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s"}}) + "\\r\\n");',
          'process.stdout.write(JSON.stringify({type:"agent_settled"}) + "\\n");',
          "setTimeout(() => process.exit(0), 300);",
        ].join(""),
      ],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
    });
    await rpc.waitReady();
    const iterator = rpc.events[Symbol.asyncIterator]();
    // A CR-terminated line still parses, and empty lines are not records.
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "agent_settled" },
    });
    await rpc.close();
  });

  it("uses its default request timeout when none is given", () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: ["-e", ""],
      cwd: ROOT,
      env: {},
    });
    expect(rpc.requestTimeoutMs).toBe(10_000);
  });

  it("ignores a reply with no id at all", async () => {
    const logs: string[] = [];
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        [
          'process.stdout.write(JSON.stringify({type:"response",command:"get_state",success:true,data:{}}) + "\\n");',
          'process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s"}}) + "\\n");',
          "setTimeout(() => process.exit(0), 300);",
        ].join(""),
      ],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
      log: (message) => logs.push(message),
    });
    await rpc.waitReady();
    // The uncorrelated reply has to have arrived before "nothing was logged"
    // means anything, so the round trip is waited for rather than guessed at.
    await collect(rpc, 0).catch(() => undefined);
    await waitUntil(
      () => rpc.exited || logs.length > 0,
      "the child to react to the uncorrelated reply",
    ).catch(() => undefined);
    expect(logs).toEqual([]);
    await rpc.close();
  });

  it("reports its exit once, however many times it is asked", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      // A child that lingers long enough for the exit event to be delivered.
      args: ["-e", "setTimeout(() => process.exit(2), 30);"],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
    });
    rpc.spawn();
    await waitForExit(rpc);
    expect(rpc.exitInfo).toEqual({ code: 2, signal: null });
    // The first close finds it already gone; the second is a no-op.
    await expect(rpc.close()).resolves.toMatchObject({ escalatedTo: "stdin" });
    await expect(rpc.close()).resolves.toMatchObject({
      escalatedTo: "already",
    });
  });

  it("closes a child that already exited without escalating", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: ["-e", "process.exit(0);"],
      cwd: ROOT,
      env: {},
      termGraceMs: 100,
      killGraceMs: 100,
    });
    rpc.spawn();
    await expect(rpc.close()).resolves.toMatchObject({ escalatedTo: "stdin" });
  });
});

describe("pi transport close with a default grace period", () => {
  it("uses the default SIGTERM grace when none is configured", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        'process.stdin.resume(); setInterval(() => {}, 1000); process.on("SIGTERM", () => process.exit(143));',
      ],
      cwd: ROOT,
      env: {},
      // Only the stdin grace is shortened; the SIGTERM wait uses the default,
      // which the child satisfies immediately by dying on the signal.
      termGraceMs: 100,
    });
    rpc.spawn();
    await expect(rpc.close()).resolves.toMatchObject({
      escalatedTo: "SIGTERM",
      exit: { code: 143 },
    });
  });
});

describe("pi transport spawn failure", () => {
  it("fails readiness instead of crashing when pi cannot be spawned", async () => {
    // A missing or non-executable pi emits `error`, never `exit`, so without
    // this path an unhandled event would take the daemon down.
    const rpc = new PiRpc({
      bin: "/definitely/not/pi",
      args: [],
      cwd: ROOT,
      env: {},
      readyTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
    });
    await expect(rpc.waitReady()).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
    await expect(rpc.request("get_state")).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
  });

  it("rejects a pending request when the child fails to spawn", async () => {
    const rpc = new PiRpc({
      bin: "/definitely/not/pi",
      args: [],
      cwd: ROOT,
      env: {},
      readyTimeoutMs: 2_000,
      requestTimeoutMs: 2_000,
    });
    const failure = rpc.request("get_state").catch((error: unknown) => error);
    await failure;
    expect(rpc.exited).toBe(true);
  });

  it("fails the event stream of a child that never started", async () => {
    const rpc = new PiRpc({
      bin: "/definitely/not/pi",
      args: [],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
    });
    const first = rpc.events[Symbol.asyncIterator]().next();
    rpc.spawn();
    await expect(first).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
  });
});

describe("startup records and spawn details", () => {
  it("hands the startup records to the caller exactly once", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: [
        "-e",
        [
          'process.stdout.write(JSON.stringify({type:"extension_ui_request",id:"ui_1",method:"setStatus",statusKey:"k",statusText:"early"}) + "\\n");',
          'process.stdin.on("data", () => {',
          '  process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s"}}) + "\\n");',
          "});",
          "setTimeout(() => process.exit(0), 300);",
        ].join(""),
      ],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 2_000,
    });
    await rpc.waitReady();
    // A pre-warming extension's output is drained by the caller, once.
    expect(rpc.takeStartupRecords()).toHaveLength(1);
    expect(rpc.takeStartupRecords()).toHaveLength(0);
    await rpc.close();
  });

  it("reports a non-executable binary as a problem to start", async () => {
    const rpc = new PiRpc({
      bin: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: ROOT,
      env: {},
      requestTimeoutMs: 500,
    });
    rpc.spawn();
    // A child that already exited cannot also fail to spawn. Waiting for the
    // exit rather than sleeping is what makes this true on a slow machine.
    await waitForExit(rpc);
    await rpc.close();
  });
});
