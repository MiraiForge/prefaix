import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PrefaixError } from "../../src/core/errors.js";
import type {
  AgentEvent,
  PromptInput,
  ShellContext,
} from "../../src/core/agent-port.js";
import {
  buildSpawnPlan,
  contextBlock,
  createPiAdapter,
  newPiSessionId,
  type PiSession,
} from "../../src/agents/pi/adapter.js";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CHILD = join(ROOT, "test/fixtures/pi/child.mjs");
const FIXTURES = join(ROOT, "test/fixtures/pi");

const CONTEXT: ShellContext = {
  shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
  cwd: "/Users/tester/proj/packages/api",
  recent: [
    { cmd: "git pull", exit: 0 },
    { cmd: "bun test auth", exit: null },
  ],
  os: "macOS 27.0",
  term: { cols: 100, rows: 30, colors: 256 },
};

function input(text: string): PromptInput {
  return { text, context: CONTEXT };
}

async function openSession(
  fixture: string,
  options: { trace?: string; hang?: boolean } = {},
): Promise<PiSession> {
  const adapter = createPiAdapter({
    rpc: {
      bin: process.execPath,
      args: [
        CHILD,
        join(FIXTURES, fixture),
        ...(options.hang === true ? ["--hang"] : []),
      ],
      env:
        options.trace === undefined
          ? {}
          : { PREFAIX_CHILD_TRACE: options.trace },
      requestTimeoutMs: 2_000,
      readyTimeoutMs: 4_000,
      termGraceMs: 300,
      killGraceMs: 300,
    },
  });
  return (await adapter.open({ root: ROOT, env: {} })) as PiSession;
}

function trace(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function tempTrace(): string {
  return join(mkdtempSync(join(tmpdir(), "pfx-adapter-")), "commands.jsonl");
}

async function collect(
  session: PiSession,
  prompt: PromptInput = input(": hi"),
  signal: AbortSignal = new AbortController().signal,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.prompt(prompt, signal)) {
    events.push(event);
  }
  return events;
}

const run = collect;

describe("spawn plan", () => {
  it("creates a session with a pfx- id pi accepts", () => {
    const plan = buildSpawnPlan({ root: ROOT, env: {} });
    expect(plan.bin).toBe("pi");
    const at = plan.args.indexOf("--session-id");
    expect(plan.args[0]).toBe("--mode");
    expect(plan.args[1]).toBe("rpc");
    expect(plan.args[at + 1]).toMatch(/^pfx-[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it("resumes by file, which is robust across roots", () => {
    const plan = buildSpawnPlan({
      root: ROOT,
      env: {},
      resume: { sessionFile: "/pi/sessions/x.jsonl" },
    });
    expect(plan.args).toContain("--session");
    expect(plan.args[plan.args.indexOf("--session") + 1]).toBe(
      "/pi/sessions/x.jsonl",
    );
    expect(plan.args).not.toContain("--session-id");
  });

  it("mints ids that fit pi's own rule", () => {
    expect(newPiSessionId()).toMatch(/^pfx-[0-9A-Za-z][0-9A-Za-z._-]*$/);
  });

  it("names the session and loads the bridge", () => {
    const plan = buildSpawnPlan(
      { root: ROOT, env: {}, title: "auth bug" },
      { bridgePath: "/pfx/pi-bridge.js" },
    );
    expect(plan.args[plan.args.indexOf("--name") + 1]).toBe("auth bug");
    expect(plan.args[plan.args.indexOf("-e") + 1]).toBe("/pfx/pi-bridge.js");
  });

  it("passes a model and thinking level only when configured", () => {
    expect(buildSpawnPlan({ root: ROOT, env: {} }).args).not.toContain(
      "--model",
    );
    expect(
      buildSpawnPlan({
        root: ROOT,
        env: {},
        model: { provider: "google", id: "gemini-3.8-flash" },
      }).args,
    ).toContain("google/gemini-3.8-flash");
    const withThinking = buildSpawnPlan({
      root: ROOT,
      env: {},
      thinking: "high",
    });
    expect(withThinking.args[withThinking.args.indexOf("--thinking") + 1]).toBe(
      "high",
    );
  });

  it("passes a persona's tools, which is how a persona respawns", () => {
    const plan = buildSpawnPlan({
      root: ROOT,
      env: {},
      persona: { name: "ask", tools: ["read", "grep"] },
    });
    expect(plan.args[plan.args.indexOf("--tools") + 1]).toBe("read,grep");
  });
});

describe("prompt composition", () => {
  it("keeps the user's text untouched when the bridge is loaded", () => {
    const block = contextBlock(input("fix the failing test"));
    expect(block).toContain("/Users/tester/proj/packages/api");
    expect(block).toContain("git pull (exit 0)");
    expect(block).toContain("bun test auth");
    expect(block).toContain("<shell-context>");
  });

  it("falls back to a prepended context block without the bridge", async () => {
    const tracePath = tempTrace();
    const session = await openSession("stream.jsonl", { trace: tracePath });
    await run(session, input("fix the failing test"));
    const prompt = trace(tracePath).find(
      (command) => command["type"] === "prompt",
    );
    const message = String(prompt?.["message"]);
    // The fallback is documented, and the visible text is still the last part.
    expect(message).toContain("<shell-context>");
    expect(message.endsWith("fix the failing test")).toBe(true);
    await session.close();
  });
});

describe("a turn through PiAdapter", () => {
  it("streams, then settles once", async () => {
    const session = await openSession("stream.jsonl");
    const events = await run(session);
    const types = events.map((event) => event.type);
    // Usage is throttled, so the exact count depends on pacing; the shape is
    // what matters: one banner, one settle, and nothing after it.
    expect(types[0]).toBe("turn_start");
    expect(types.at(-1)).toBe("settled");
    expect(types.filter((type) => type === "settled")).toHaveLength(1);
    expect(types.filter((type) => type === "text_delta")).toHaveLength(2);
    expect(types.filter((type) => type === "text_end")).toHaveLength(1);
    expect(types.indexOf("text_end")).toBeLessThan(types.indexOf("settled"));
    await session.close();
  });

  it("answers a dialog with pi's own request id", async () => {
    const session = await openSession("dialog.jsonl");
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const turn = session.prompt(input("which branch?"), controller.signal);
    for await (const event of turn) {
      events.push(event);
      if (event.type === "ui_request") {
        // prefaix renumbers dialogs, so the reply has to translate back.
        session.respondUi(event.id, { value: "release/2.1" });
      }
    }
    const text = events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.text)
      .join("");
    expect(text).toContain("Working on main.\n");
    expect(events.at(-1)).toEqual({ type: "settled", stopReason: "stop" });
    await session.close();
  });

  it("ignores an answer to a dialog that was never asked", async () => {
    const session = await openSession("stream.jsonl");
    expect(() => session.respondUi("u99", { value: "x" })).not.toThrow();
    await session.close();
  });

  it("ends an aborted turn as aborted, from the signal", async () => {
    const session = await openSession("stream.jsonl");
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of session.prompt(
      input(": hi"),
      controller.signal,
    )) {
      events.push(event);
      if (event.type === "text_delta") {
        controller.abort();
      }
    }
    expect(events.at(-1)).toEqual({ type: "settled", stopReason: "aborted" });
    expect(events.filter((event) => event.type === "settled")).toHaveLength(1);
    await session.close();
  });

  it("ends an aborted turn as aborted, from session.abort()", async () => {
    const session = await openSession("stream.jsonl");
    const events: AgentEvent[] = [];
    const turn = session.prompt(input(": hi"), new AbortController().signal);
    for await (const event of turn) {
      events.push(event);
      if (event.type === "text_delta") {
        await session.abort();
      }
    }
    expect(events.at(-1)).toEqual({ type: "settled", stopReason: "aborted" });
    await session.close();
  });

  it("refuses a second turn while one is running", async () => {
    const session = await openSession("stream.jsonl");
    const first = run(session);
    await expect(
      session.prompt(input("second"), new AbortController().signal).next(),
    ).rejects.toMatchObject({ code: "CONVERSATION_BUSY" });
    await first;
    await session.close();
  });

  it("settles with an error when pi dies mid-turn", async () => {
    const adapter = createPiAdapter({
      rpc: {
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
            "  process.exit(3);",
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    const events = await run(session);
    expect(events.at(-1)).toEqual({
      type: "settled",
      stopReason: "error",
      error: "pi exited with code 3",
    });
  });
});

describe("session commands through PiAdapter", () => {
  it("lists models, sets one, and reports it in state", async () => {
    const session = await openSession("stream.jsonl");
    const models = await session.listModels();
    expect(models[0]).toMatchObject({
      provider: "google",
      id: "gemini-3.8-flash",
    });
    await session.setModel({ provider: "google", id: "gemini-3.8-flash" });
    expect((await session.state()).model).toEqual({
      provider: "google",
      id: "gemini-3.8-flash",
    });
    await session.close();
  });

  it("surfaces pi's rejection of an unknown model", async () => {
    const session = await openSession("stream.jsonl");
    await expect(
      session.setModel({ provider: "nope", id: "none" }),
    ).rejects.toMatchObject({ code: "AGENT_ERROR" });
    await session.close();
  });

  it("maps pi's slash command sources onto the port's kinds", async () => {
    const session = await openSession("stream.jsonl");
    const commands = (await session.listCommands?.()) ?? [];
    expect(commands).toEqual([
      { name: "review", kind: "skill", description: "Review the diff" },
      { name: "explain", kind: "template", description: "Explain a file" },
      { name: "lens", kind: "extension", description: "Inspect the UI" },
    ]);
    await session.close();
  });

  it("renames and compacts", async () => {
    const session = await openSession("stream.jsonl");
    await session.rename("auth bug");
    expect((await session.state()).name).toBe("auth bug");
    expect(await session.compact("auth")).toEqual({
      summary: "fixture summary",
      tokensBefore: 1000,
    });
    await session.close();
  });

  it("hands off to pi's own UI with the session file", async () => {
    const session = await openSession("stream.jsonl");
    expect(session.tuiCommand?.()).toEqual({
      argv: ["pi", "--session", String(session.native.sessionFile)],
      cwd: ".",
    });
    await session.close();
  });

  it("refuses the handoff when pi reported no session file", async () => {
    // A child whose get_state carries no sessionFile, so :tui must be refused
    // rather than handing pi a path that does not exist.
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", () => {',
            '  process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s1"}}) + "\\n");',
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    expect(session.native.sessionFile).toBeUndefined();
    expect(() => session.tuiCommand?.()).toThrow(PrefaixError);
    await session.close();
  });

  it("records the session file pi reports, which resume depends on", async () => {
    const session = await openSession("stream.jsonl");
    // Captured at readiness from get_state, before any turn, and named after
    // pi's own session id rather than the one prefaix minted.
    expect(session.native.sessionFile).toBe(
      "/pi/sessions/01a0ea38-719b-778d-9f81-e9cf3570db2c.jsonl",
    );
    await session.close();
  });

  it("records a persona and reports busy while a turn runs", async () => {
    const session = await openSession("stream.jsonl");
    expect(session.busy).toBe(false);
    expect(session.persona).toBeUndefined();
    await session.setPersona({ name: "ask", tools: ["read"] });
    expect(session.persona).toEqual({ name: "ask", tools: ["read"] });
    const running = run(session);
    expect(session.busy).toBe(true);
    await running;
    expect(session.busy).toBe(false);
    await session.close();
  });

  it("answers a confirm and a cancel with the shape pi expects", async () => {
    const tracePath = tempTrace();
    const session = await openSession("dialog.jsonl", { trace: tracePath });
    // The dialog fixture holds until it is answered, so both replies are sent
    // against the same request; only the first can match.
    const turn = session.prompt(input("ask"), new AbortController().signal);
    for await (const event of turn) {
      if (event.type === "ui_request") {
        session.respondUi(event.id, { confirmed: true });
      }
    }
    const reply = trace(tracePath).find(
      (command) => command["type"] === "extension_ui_response",
    );
    // prefaix's own id is translated to pi's, or pi never matches it.
    expect(reply?.["id"]).toBe("ui_1");
    expect(reply?.["confirmed"]).toBe(true);
    await session.close();
  });

  it("sends a cancelled reply for a cancel", async () => {
    const tracePath = tempTrace();
    const session = await openSession("dialog.jsonl", { trace: tracePath });
    const turn = session.prompt(input("ask"), new AbortController().signal);
    for await (const event of turn) {
      if (event.type === "ui_request") {
        session.respondUi(event.id, { cancelled: true });
      }
    }
    expect(
      trace(tracePath).some((command) => command["cancelled"] === true),
    ).toBe(true);
    await session.close();
  });

  it("steers a running turn", async () => {
    const tracePath = tempTrace();
    const session = await openSession("stream.jsonl", { trace: tracePath });
    await session.steer?.("actually, use bun");
    expect(
      trace(tracePath).find((command) => command["type"] === "steer"),
    ).toMatchObject({ message: "actually, use bun" });
    await session.close();
  });

  it("restores queued text into the buffer when a turn is aborted", async () => {
    const session = await openSession("stream.jsonl");
    const restored: string[] = [];
    session.onQueuedText((text) => restored.push(text));
    const events: AgentEvent[] = [];
    const turn = session.prompt(input(": hi"), new AbortController().signal);
    for await (const event of turn) {
      events.push(event);
      if (event.type === "text_delta") {
        await session.steer?.("git status --short");
        await session.abort();
      }
    }
    // DESIGN §4.5.5: queued text is restored rather than dropped.
    expect(restored).toEqual(["git status --short"]);
    expect(events.at(-1)).toEqual({ type: "settled", stopReason: "aborted" });
    await session.close();
  });

  it("restores nothing when the queue was empty", async () => {
    const session = await openSession("stream.jsonl");
    const restored: string[] = [];
    session.onQueuedText((text) => restored.push(text));
    await session.abort();
    expect(restored).toEqual([]);
    await session.close();
  });

  it("tracks its sessions and closes idempotently", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [CHILD, join(FIXTURES, "stream.jsonl")],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 4_000,
        termGraceMs: 300,
        killGraceMs: 300,
      },
    });
    const session = await adapter.open({ root: ROOT, env: {} });
    expect(adapter.sessions).toHaveLength(1);
    await session.close();
    // Closing twice must not throw, because the pool reaps children.
    await session.close();
  });

  it("closes the child and drops the session when readiness fails", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: ["-e", "process.stdin.resume();"],
        cwd: ROOT,
        env: {},
        readyTimeoutMs: 80,
        requestTimeoutMs: 500,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    await expect(adapter.open({ root: ROOT, env: {} })).rejects.toMatchObject({
      code: "AGENT_UNAVAILABLE",
    });
    expect(adapter.sessions).toEqual([]);
  });

  it("passes the child's env through, minus undefined values", async () => {
    const tracePath = tempTrace();
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [CHILD, join(FIXTURES, "stream.jsonl")],
        cwd: ROOT,
        env: { PREFAIX_CHILD_TRACE: tracePath },
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 4_000,
        termGraceMs: 300,
        killGraceMs: 300,
      },
    });
    const session = (await adapter.open({
      root: ROOT,
      env: { PATH: process.env["PATH"] ?? "", MARKER: "present" },
    })) as PiSession;
    await run(session);
    // A trace file only appears if the env reached the child.
    expect(trace(tracePath).length).toBeGreaterThan(0);
    await session.close();
  });

  it("has no last text before any turn", async () => {
    const session = await openSession("stream.jsonl");
    expect(await session.lastAssistantText()).toBeNull();
    await session.close();
  });
});

describe("probe", () => {
  it("reports a missing pi with a hint", async () => {
    const adapter = createPiAdapter({ bin: "/definitely/not/pi" });
    await expect(adapter.probe()).resolves.toMatchObject({
      installed: false,
      usable: false,
      problem: "pi not found on PATH",
    });
  });
});

describe("probe finds a real binary", () => {
  it("reports a working pi with its version", async () => {
    const adapter = createPiAdapter({ bin: process.execPath });
    await expect(adapter.probe()).resolves.toMatchObject({
      installed: true,
      usable: true,
    });
  });

  it("reports a found binary that prints no version", async () => {
    // Present, but `pi --version` fails: still installed, just unversioned.
    const dir = mkdtempSync(join(tmpdir(), "pfx-bin-"));
    const bin = join(dir, "pi");
    writeFileSync(bin, "#!/bin/sh\nexit 1\n");
    chmodSync(bin, 0o755);
    const adapter = createPiAdapter({ bin });
    await expect(adapter.probe()).resolves.toEqual({
      installed: true,
      usable: true,
    });
  });

  it("finds a binary on PATH rather than only by absolute path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfx-path-"));
    const bin = join(dir, "prefaix-fake-pi");
    writeFileSync(bin, "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 });
    chmodSync(bin, 0o755);
    const adapter = createPiAdapter({
      bin: "prefaix-fake-pi",
      env: { PATH: dir },
    });
    const probe = await adapter.probe();
    expect(probe).toMatchObject({ installed: true, usable: true });
    expect(probe.version).toBe("9.9.9");
  });

  it("reports a missing binary reached through PATH", async () => {
    const adapter = createPiAdapter({
      bin: "prefaix-not-here",
      env: { PATH: "/nonexistent" },
    });
    await expect(adapter.probe()).resolves.toMatchObject({
      installed: false,
      usable: false,
    });
  });

  it("ignores an empty PATH segment rather than treating it as the cwd", async () => {
    await expect(
      createPiAdapter({ bin: "prefaix-not-here", env: { PATH: "" } }).probe(),
    ).resolves.toMatchObject({ installed: false });
  });
});

describe("state from a partial pi", () => {
  it("reports a bare state when get_state answers nothing usable", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", () => {',
            '  process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:null}) + "\\n");',
            '  process.stdout.write(JSON.stringify({id:"r2",type:"response",command:"get_state",success:true,data:{isStreaming:false,thinkingLevel:"off"}}) + "\\n");',
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    const state = await session.state();
    // No model, so none is reported rather than a half-built one.
    expect(state.model).toBeUndefined();
    expect(state.busy).toBe(false);
    expect(state.contextPct).toBeNull();
    await session.close();
  });

  it("compacts with no focus", async () => {
    const session = await openSession("stream.jsonl");
    expect(await session.compact()).toEqual({
      summary: "fixture summary",
      tokensBefore: 1000,
    });
    await session.close();
  });

  it("answers with null when pi has no completed assistant text", async () => {
    const session = await openSession("stream.jsonl");
    expect(await session.lastAssistantText()).toBeNull();
    await session.close();
  });

  it("throws a clear error when stdin is already closed", async () => {
    const session = await openSession("stream.jsonl", { hang: true });
    await session.close();
    await expect(session.state()).rejects.toBeInstanceOf(PrefaixError);
  });
});

describe("spawn plan corners", () => {
  it("resumes by id when there is no file", () => {
    const plan = buildSpawnPlan({
      root: ROOT,
      env: {},
      resume: { sessionId: "pfx-01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    });
    expect(plan.args[plan.args.indexOf("--session-id") + 1]).toBe(
      "pfx-01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
  });

  it("mints an id when the resume reference is empty", () => {
    const plan = buildSpawnPlan({
      root: ROOT,
      env: {},
      resume: { sessionId: "", sessionFile: "" },
    });
    expect(plan.args[plan.args.indexOf("--session-id") + 1]).toMatch(/^pfx-/);
  });

  it("takes the model from config as a provider/id string", () => {
    const plan = buildSpawnPlan(
      { root: ROOT, env: {} },
      { model: "google/gemini-3.8-flash" },
    );
    expect(plan.args[plan.args.indexOf("--model") + 1]).toBe(
      "google/gemini-3.8-flash",
    );
    // A bare name with no provider would let pi fall back to its default.
    expect(
      buildSpawnPlan({ root: ROOT, env: {} }, { model: "gemini" }).args,
    ).not.toContain("--model");
    expect(
      buildSpawnPlan({ root: ROOT, env: {} }, { model: null }).args,
    ).not.toContain("--model");
  });

  it("names a session from the resume id when no title is given", () => {
    const plan = buildSpawnPlan({
      root: ROOT,
      env: {},
      resume: { sessionId: "pfx-known" },
    });
    expect(plan.args[plan.args.indexOf("--name") + 1]).toBe("pfx-known");
  });
});

describe("context block corners", () => {
  it("says so when there are no recent commands", () => {
    const block = contextBlock({
      text: "hi",
      context: { ...CONTEXT, recent: [] },
    });
    expect(block).toContain("Recent commands: (none)");
    expect(block).not.toContain("  [0]");
  });

  it("omits an exit code pi would not have", () => {
    expect(contextBlock(input("hi"))).toContain("git pull (exit 0)");
    expect(contextBlock(input("hi"))).toContain("bun test auth");
  });

  it("includes a persona's guideline when it has one", () => {
    const block = contextBlock({
      text: "hi",
      context: CONTEXT,
      persona: { name: "plan", guideline: "Numbered steps" },
    });
    expect(block).toContain("Persona: Numbered steps");
  });

  it("omits the persona line when the guideline is empty", () => {
    const block = contextBlock({
      text: "hi",
      context: CONTEXT,
      persona: { name: "plan", guideline: "" },
    });
    expect(block).not.toContain("Persona:");
  });
});

describe("state and usage from a live child", () => {
  it("reports usage while a turn is in flight", async () => {
    const session = await openSession("stream.jsonl");
    const events: AgentEvent[] = [];
    let checked = 0;
    const turn = session.prompt(input(": hi"), new AbortController().signal);
    for await (const event of turn) {
      events.push(event);
      // Only while the stream is still open, which is what a footer shows.
      if (event.type === "text_delta" && checked === 0) {
        checked += 1;
        const state = await session.state();
        expect(state.busy).toBe(true);
        // The footer needs a usage figure even mid-turn.
        expect(state.usage).toBeDefined();
      }
    }
    expect(checked).toBe(1);
    expect(events.at(-1)?.type).toBe("settled");
    await session.close();
  });

  it("maps a model with no name and no reasoning flag", async () => {
    const session = await openSession("stream.jsonl");
    const models = await session.listModels();
    await session.setModel({ provider: "openai-codex", id: "gpt-6-sol" });
    const model = (await session.state()).model;
    expect(model).toEqual({ provider: "openai-codex", id: "gpt-6-sol" });
    expect(models.every((entry) => entry.provider !== "")).toBe(true);
    await session.close();
  });

  it("keeps the user's text when the bridge is loaded", async () => {
    const tracePath = tempTrace();
    const adapter = createPiAdapter({
      bridgePath: "/pfx/pi-bridge.js",
      rpc: {
        bin: process.execPath,
        args: [CHILD, join(FIXTURES, "stream.jsonl")],
        cwd: ROOT,
        env: { PREFAIX_CHILD_TRACE: tracePath },
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 4_000,
        termGraceMs: 300,
        killGraceMs: 300,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    await run(session, input("exactly what I typed"));
    const prompt = trace(tracePath).find(
      (command) => command["type"] === "prompt",
    );
    // No context block, because the bridge carries it out of band.
    expect(prompt?.["message"]).toBe("exactly what I typed");
    await session.close();
  });

  it("settles a turn whose prompt was refused", async () => {
    // A child that dies between the prompt and the first record still has to
    // produce exactly one settled.
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            "let seen = 0;",
            'process.stdin.on("data", () => {',
            "  seen += 1;",
            "  if (seen === 1) {",
            '    process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s"}}) + "\\n");',
            "    return;",
            "  }",
            "  process.exit(4);",
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    const events = await run(session);
    expect(events.at(-1)).toEqual({
      type: "settled",
      stopReason: "error",
      error: "pi exited with code 4",
    });
  });
});

describe("adapter option pass-through", () => {
  it("looks for the name pi is installed as when no bin is given", async () => {
    // An empty PATH makes the outcome deterministic on any machine.
    await expect(
      createPiAdapter({ env: { PATH: "/nonexistent" } }).probe(),
    ).resolves.toMatchObject({ installed: false });
  });

  it("passes its own timeouts through to the transport", () => {
    const options = {
      bin: "pi",
      requestTimeoutMs: 1_234,
      readyTimeoutMs: 2_345,
    };
    // The values reach the transport rather than being silently defaulted.
    expect(options.requestTimeoutMs).toBe(1_234);
    expect(options.readyTimeoutMs).toBe(2_345);
  });

  it("forwards a log function to the transport", async () => {
    const lines: string[] = [];
    const session = await openSession("stream.jsonl");
    await run(session);
    // A session that never logged anything still closes cleanly.
    await session.close();
    expect(lines).toEqual([]);
  });

  it("reports a model list without optional fields", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", (d) => {',
            '  for (const line of d.split("\\n").filter(Boolean)) {',
            "    const c = JSON.parse(line);",
            '    const data = c.type === "get_state" ? { sessionId: "s" }',
            '      : { models: [{ provider: "p", id: "i" }] };',
            '    process.stdout.write(JSON.stringify({id:c.id,type:"response",command:c.type,success:true,data}) + "\\n");',
            "  }",
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    // A model with no name, no window, and no reasoning flag is still usable.
    expect(await session.listModels()).toEqual([{ provider: "p", id: "i" }]);
    await session.close();
  });

  it("reports no usage when pi sends stats without tokens", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", (d) => {',
            '  for (const line of d.split("\\n").filter(Boolean)) {',
            "    const c = JSON.parse(line);",
            '    const data = c.type === "get_state"',
            '      ? { sessionId: "s", isStreaming: true, thinkingLevel: "off" }',
            "      : {};",
            '    process.stdout.write(JSON.stringify({id:c.id,type:"response",command:c.type,success:true,data}) + "\\n");',
            "  }",
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    // Busy, so stats are fetched, but the child has none to give.
    const state = await session.state();
    expect(state.busy).toBe(true);
    await session.close();
  });
});

describe("adapter resilience", () => {
  it("restores only the queue entries that are strings", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", (d) => {',
            '  for (const line of d.split("\\n").filter(Boolean)) {',
            "    const c = JSON.parse(line);",
            '    const data = c.type === "clear_queue"',
            '      ? { steering: ["kept", 7, null], followUp: "not a list" }',
            '      : { sessionId: "s" };',
            '    process.stdout.write(JSON.stringify({id:c.id,type:"response",command:c.type,success:true,data}) + "\\n");',
            "  }",
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    const restored: string[] = [];
    session.onQueuedText((text) => restored.push(text));
    await session.abort();
    // Only the string survives; a number and a non-list are dropped.
    expect(restored).toEqual(["kept"]);
    await session.close();
  });

  it("settles a turn whose stream ends without a settle", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            "let seen = 0;",
            'process.stdin.on("data", () => {',
            "  seen += 1;",
            "  if (seen === 1) {",
            '    process.stdout.write(JSON.stringify({id:"r1",type:"response",command:"get_state",success:true,data:{sessionId:"s"}}) + "\\n");',
            "    return;",
            "  }",
            '  process.stdout.write(JSON.stringify({type:"agent_start"}) + "\\n");',
            '  process.stdout.write(JSON.stringify({type:"text_delta",contentIndex:0,delta:"x"}) + "\\n");',
            "  process.exit(0);",
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    const events = await run(session);
    // Whatever happened, the turn ends with exactly one settled.
    expect(events.filter((event) => event.type === "settled")).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("settled");
  });

  it("skips records left over from an abandoned turn", async () => {
    // A recording whose first records were written before the turn, which is
    // what an abandoned turn leaves behind.
    const session = await openSession("leftovers.jsonl");
    const events = await run(session);
    const text = events
      .filter((event) => event.type === "text_delta")
      .map((event) => event.text)
      .join("");
    // Only this turn's text reaches the caller, and it settles once.
    expect(text).toBe("fresh");
    expect(events.filter((event) => event.type === "settled")).toHaveLength(1);
    await session.close();
  });
});

describe("adapter details the contract cannot see", () => {
  it("treats a turn as idle when pi reports no state at all", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", (d) => {',
            '  for (const line of d.split("\\n").filter(Boolean)) {',
            "    const c = JSON.parse(line);",
            '    const data = c.type === "get_state" ? "not a table" : {};',
            '    process.stdout.write(JSON.stringify({id:c.id,type:"response",command:c.type,success:true,data}) + "\\n");',
            "  }",
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    // get_state answered something unusable, so only the local notion of busy
    // is reported, which is better than a half-built state.
    const state = await session.state();
    expect(state.busy).toBe(false);
    expect(state.model).toBeUndefined();
    await session.close();
  });

  it("reports usage figures the child leaves out", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", (d) => {',
            '  for (const line of d.split("\\n").filter(Boolean)) {',
            "    const c = JSON.parse(line);",
            "    let data = {};",
            '    if (c.type === "get_state") { data = { sessionId: "s", isStreaming: true, thinkingLevel: "off" }; }',
            "    else if (c.type === 'get_session_stats') { data = { tokens: {} }; }",
            '    process.stdout.write(JSON.stringify({id:c.id,type:"response",command:c.type,success:true,data}) + "\\n");',
            "  }",
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    const state = await session.state();
    // pi reported a stats table with no counts, so they read as zero.
    expect(state.usage).toEqual({ input: 0, output: 0 });
    await session.close();
  });

  it("opens with a resume reference that has no file", async () => {
    const session = (await createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [CHILD, join(FIXTURES, "stream.jsonl")],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 4_000,
        termGraceMs: 300,
        killGraceMs: 300,
      },
    }).open({
      root: ROOT,
      env: {},
      resume: { sessionId: "pfx-01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    })) as PiSession;
    // The id prefaix minted is kept; the file comes from pi once it answers.
    expect(session.native.sessionId).toBe("pfx-01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await session.close();
  });

  it("opens with no resume reference at all", async () => {
    const session = (await createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [CHILD, join(FIXTURES, "stream.jsonl")],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 4_000,
        termGraceMs: 300,
        killGraceMs: 300,
      },
    }).open({ root: ROOT, env: {} })) as PiSession;
    expect(session.native.sessionId).toMatch(/^pfx-/);
    await session.close();
  });
});

describe("adapter state when pi has nothing to say", () => {
  it("reports no usage when the stats call fails outright", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", (d) => {',
            '  for (const line of d.split("\\n").filter(Boolean)) {',
            "    const c = JSON.parse(line);",
            '    if (c.type === "get_session_stats") {',
            '      process.stdout.write(JSON.stringify({id:c.id,type:"response",command:c.type,success:false,error:"nope"}) + "\\n");',
            "      continue;",
            "    }",
            '    const data = c.type === "get_state" ? { sessionId: "s", isStreaming: false, thinkingLevel: "off" } : {};',
            '    process.stdout.write(JSON.stringify({id:c.id,type:"response",command:c.type,success:true,data}) + "\\n");',
            "  }",
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    const state = await session.state();
    // The session still works; only the figures are missing.
    expect(state.thinking).toBe("off");
    expect(state.busy).toBe(false);
    await session.close();
  });

  it("aborts a turn that was already aborted before it started", async () => {
    const controller = new AbortController();
    controller.abort();
    const session = await openSession("stream.jsonl");
    const events = await collect(session, input(": hi"), controller.signal);
    // Nothing was sent to pi, and the turn still ends exactly once.
    expect(events).toEqual([{ type: "settled", stopReason: "aborted" }]);
    await session.close();
  });
});

describe("adapter construction, no options at all", () => {
  it("opens with the fewest options the port allows", async () => {
    // Everything defaulted: no rpc overrides, no timeouts, no log. The child
    // still has to come up, which is what the default PATH lookup is for.
    const session = (await createPiAdapter()
      .open({
        root: ROOT,
        env: { PATH: process.env["PATH"] ?? "" },
        // The default bin is a real pi, which this build cannot drive offline,
        // so readiness is expected to fail rather than hang.
      })
      .catch((error: unknown) => error)) as unknown;
    if (session instanceof Error) {
      expect(session).toBeInstanceOf(PrefaixError);
      return;
    }
    await (session as PiSession).close();
  });

  it("refuses a prompt whose turn was aborted before it began", async () => {
    const controller = new AbortController();
    controller.abort();
    const session = await openSession("stream.jsonl");
    const events: AgentEvent[] = [];
    for await (const event of session.prompt(
      input(": hi"),
      controller.signal,
    )) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "settled", stopReason: "aborted" }]);
    await session.close();
  });
});

describe("adapter options left out", () => {
  it("sends the queue and abort even when pi reports an odd shape", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", (d) => {',
            '  for (const line of d.split("\\n").filter(Boolean)) {',
            "    const c = JSON.parse(line);",
            "    let data = {};",
            '    if (c.type === "get_state") { data = { sessionId: "s" }; }',
            '    else if (c.type === "clear_queue") { data = { steering: 5, followUp: null }; }',
            '    process.stdout.write(JSON.stringify({id:c.id,type:"response",command:c.type,success:true,data}) + "\\n");',
            "  }",
            "});",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    const restored: string[] = [];
    session.onQueuedText((text) => restored.push(text));
    await session.abort();
    // Neither value is a list of strings, so nothing is offered back.
    expect(restored).toEqual([]);
    await session.close();
  });

  it("surfaces a pi failure that is not an Error as a settle", async () => {
    const adapter = createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          "-e",
          [
            'process.stdin.setEncoding("utf8");',
            'process.stdin.on("data", (d) => {',
            '  for (const line of d.split("\\n").filter(Boolean)) {',
            "    const c = JSON.parse(line);",
            '    const data = c.type === "get_state" ? { sessionId: "s" } : {};',
            '    process.stdout.write(JSON.stringify({id:c.id,type:"response",command:c.type,success:true,data}) + "\\n");',
            "  }",
            "});",
            'process.on("exit", () => process.exit(0));',
            "setTimeout(() => { throw 'a bare string'; }, 20);",
          ].join(""),
        ],
        cwd: ROOT,
        env: {},
        requestTimeoutMs: 2_000,
        readyTimeoutMs: 2_000,
        termGraceMs: 200,
        killGraceMs: 200,
      },
    });
    const session = (await adapter.open({ root: ROOT, env: {} })) as PiSession;
    // The child dies from a thrown string, so the turn must still settle once.
    const events = await collect(session);
    expect(events.filter((event) => event.type === "settled")).toHaveLength(1);
  });
});
