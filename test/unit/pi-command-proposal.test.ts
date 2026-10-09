import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createBridge, BRIDGE_DIR_ENV } from "../../src/agents/pi/bridge.js";
import {
  proposalTool,
  type ProposalTool,
} from "../../src/agents/pi/command-proposal.js";
import {
  bridgeReadyFile,
  turnContextFile,
  writeTurnContext,
  BRIDGE_VERSION,
} from "../../src/agents/pi/bridge-context.js";
import {
  createPiAdapter,
  type PiSession,
} from "../../src/agents/pi/adapter.js";
import { TurnMapper } from "../../src/agents/pi/mapping.js";
import type { AgentEvent, ShellContext } from "../../src/core/agent-port.js";

const context: ShellContext = {
  shell: { kind: "bash", version: "5", shellId: "test", pid: 1 },
  cwd: "/tmp",
  recent: [],
  os: "test",
  term: { cols: 80, rows: 24, colors: 0 },
};
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pfx-pi-proposal-"));
  process.env[BRIDGE_DIR_ENV] = dir;
});
afterEach(() => {
  delete process.env[BRIDGE_DIR_ENV];
  rmSync(dir, { recursive: true, force: true });
});
function fake() {
  const handlers = new Map<string, (event: never) => unknown>();
  let tools = ["read", "bash"];
  let proposal: ProposalTool | undefined;
  let failing = false;
  const pi = {
    on(name: string, handler: (event: never) => unknown) {
      handlers.set(name, handler);
    },
    registerTool(tool: ProposalTool) {
      proposal = tool;
      tools.push(tool.name);
    },
    setActiveTools(names: string[]) {
      if (failing) throw new Error("switch failed");
      tools = names;
    },
    getActiveTools() {
      return tools;
    },
  };
  createBridge(pi as never, { pid: 123 });
  const fire = (name: string, event: unknown = {}) =>
    handlers.get(name)?.(event as never);
  fire("session_start");
  return {
    pi,
    fire,
    proposal: () => proposal!,
    failing: () => {
      failing = true;
    },
  };
}
function begin(
  f: ReturnType<typeof fake>,
  edit: boolean,
  persona?: { name: string; tools: string[] },
) {
  writeTurnContext(turnContextFile(dir, 123), {
    version: BRIDGE_VERSION,
    context,
    commandProposal: edit,
    ...(persona === undefined ? {} : { persona }),
  });
  const sections: Record<string, string> = {};
  f.fire("before_agent_start", {
    prompt: "want",
    systemPromptOptions: { sections },
  });
  return sections;
}
it("registers the terminating model-only tool but excludes it from ordinary tools", () => {
  const f = fake();
  expect(f.pi.getActiveTools()).toEqual(["read", "bash"]);
  expect(
    JSON.parse(readFileSync(bridgeReadyFile(dir, 123), "utf8")),
  ).toMatchObject({ commandProposals: true });
  expect(f.proposal().exposure).toBe("model-only");
  expect(() =>
    f.proposal().execute("x", { command: "echo x", explanation: "" }),
  ).toThrow(/active edit/);
});
it("activates only the proposal tool with shell guidance, then restores the selected persona", () => {
  const f = fake();
  begin(f, false, { name: "ask", tools: ["read"] });
  expect(f.pi.getActiveTools()).toEqual(["read"]);
  const sections = begin(f, true);
  expect(f.pi.getActiveTools()).toEqual(["propose_command"]);
  expect(sections.suggest).toContain("bash shell");
  expect(sections.persona).toBeUndefined();
  expect(
    f.proposal().execute("x", { command: "echo x", explanation: "Review." }),
  ).toEqual({
    content: [{ type: "text", text: "Review." }],
    details: { command: "echo x", explanation: "Review." },
    terminate: true,
  });
  f.fire("agent_settled");
  expect(f.pi.getActiveTools()).toEqual(["read"]);
  expect(() =>
    f.proposal().execute("x", { command: "echo x", explanation: "" }),
  ).toThrow();
  expect(
    begin(f, false, { name: "ask", tools: ["read"] }).suggest,
  ).toBeUndefined();
});
it("blocks all other edit tools, nested proposals, and proposals outside edit mode", () => {
  const f = fake();
  expect(
    f.fire("tool_call", { toolName: "propose_command", toolCallId: "x" }),
  ).toMatchObject({ block: true });
  begin(f, true);
  expect(
    f.fire("tool_call", { toolName: "bash", toolCallId: "x" }),
  ).toMatchObject({ block: true });
  expect(
    f.fire("tool_call", { toolName: "propose_command", toolCallId: "x/0" }),
  ).toMatchObject({ block: true });
  expect(
    f.fire("tool_call", { toolName: "propose_command", toolCallId: "x" }),
  ).toBeUndefined();
  expect(f.fire("tool_call", { toolName: "propose_command" })).toBeUndefined();
});
it("keeps the tool-call guard armed if activation or restoration throws", () => {
  const f = fake();
  begin(f, true);
  f.failing();
  expect(() => begin(f, true)).toThrow("switch failed");
  expect(f.fire("tool_call", { toolName: "bash" })).toMatchObject({
    block: true,
  });
});
it("restores tools on the next prompt after a local abort without a native settlement", () => {
  const f = fake();
  begin(f, true);
  begin(f, false);
  expect(f.pi.getActiveTools()).toEqual(["read", "bash"]);
  expect(f.fire("tool_call", { toolName: "bash" })).toBeUndefined();
});
it("rejects invalid and aborted proposal executions", () => {
  const tool = proposalTool(() => true);
  expect(() => tool.execute("x", { command: "", explanation: "" })).toThrow(
    /nonempty/,
  );
  expect(() =>
    tool.execute(
      "x",
      { command: "echo x", explanation: "" },
      AbortSignal.abort(),
    ),
  ).toThrow(/active edit/);
});

const start = {
  type: "tool_execution_start",
  toolCallId: "one",
  toolName: "propose_command",
  args: { command: "echo x", explanation: "Review." },
};
const end = {
  type: "tool_execution_end",
  toolCallId: "one",
  toolName: "propose_command",
  isError: false,
  result: {
    content: [{ type: "text", text: "Review." }],
    details: { command: "echo x", explanation: "Review." },
  },
};
it("maps only paired successful top-level proposal details, never arguments or editor UI", () => {
  const mapper = new TurnMapper({ commandProposals: true });
  expect(mapper.map(start).filter((e) => e.type === "set_buffer")).toEqual([]);
  expect(
    mapper
      .map({
        type: "extension_ui_request",
        method: "set_editor_text",
        text: "evil",
        id: "ui",
      })
      .filter((e) => e.type === "set_buffer"),
  ).toEqual([]);
  expect(mapper.map(end)).toContainEqual({
    type: "set_buffer",
    text: "echo x",
  });
  expect(mapper.map(end).filter((e) => e.type === "set_buffer")).toEqual([]);
});
it.each([
  {
    enabled: false,
    id: "one",
    failed: false,
    paired: true,
    details: { command: "echo x", explanation: "" },
  },
  {
    enabled: true,
    id: "one/0",
    failed: false,
    paired: true,
    details: { command: "echo x", explanation: "" },
  },
  {
    enabled: true,
    id: "one",
    failed: true,
    paired: true,
    details: { command: "echo x", explanation: "" },
  },
  {
    enabled: true,
    id: "one",
    failed: false,
    paired: false,
    details: { command: "echo x", explanation: "" },
  },
  {
    enabled: true,
    id: "one",
    failed: false,
    paired: true,
    details: { command: "", explanation: "" },
  },
])(
  "does not map untrusted proposal completion %#",
  ({ enabled, id, failed, paired, details }) => {
    const mapper = new TurnMapper({ commandProposals: enabled });
    if (paired) mapper.map({ ...start, toolCallId: id });
    expect(
      mapper
        .map({ ...end, toolCallId: id, isError: failed, result: { details } })
        .filter((e) => e.type === "set_buffer"),
    ).toEqual([]);
  },
);
it("does not produce an explanation notice for an empty explanation", () => {
  const mapper = new TurnMapper({ commandProposals: true });
  mapper.map(start);
  expect(
    mapper
      .map({
        ...end,
        result: { details: { command: "echo x", explanation: "" } },
      })
      .filter((e) => e.type === "notice"),
  ).toEqual([]);
});

async function adapter(ready: "supported" | "legacy" | "malformed" | "absent") {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const fixture = join(dir, "proposal.jsonl");
  writeFileSync(
    fixture,
    [
      { type: "agent_start" },
      start,
      end,
      { type: "agent_end" },
      { type: "agent_settled" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
  );
  const trace = join(dir, "trace.jsonl");
  let contextFile = "";
  const agent = createPiAdapter({
    bridgePath: "/scripted/bridge",
    turnsDir: dir,
    bridgeReady: (file) => {
      contextFile = file.replace(/\.ready$/u, ".json");
      if (ready === "absent") return false;
      writeFileSync(
        file,
        ready === "malformed"
          ? "broken"
          : JSON.stringify({ commandProposals: ready === "supported" }),
      );
      return true;
    },
    rpc: {
      bin: process.execPath,
      args: [join(root, "test/fixtures/pi/child.mjs"), fixture],
      env: { PREFAIX_CHILD_TRACE: trace },
      requestTimeoutMs: 500,
      readyTimeoutMs: 2000,
      termGraceMs: 100,
      killGraceMs: 100,
    },
  });
  const session = (await agent.open({ root, env: {} })) as PiSession;
  return { session, trace, contextFile };
}
it.each(["supported", "legacy", "malformed", "absent"] as const)(
  "scripted adapter negotiates %s proposal support without silently prompting",
  async (ready) => {
    const { session, trace, contextFile } = await adapter(ready);
    try {
      const events: AgentEvent[] = [];
      for await (const e of session.prompt(
        { text: "/do-not-run-extension", context, commandProposal: true },
        new AbortController().signal,
      )) {
        events.push(e);
        if (ready === "supported" && e.type === "turn_start")
          expect(JSON.parse(readFileSync(contextFile, "utf8"))).toMatchObject({
            commandProposal: true,
            context,
          });
      }
      const commands = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string; message?: string });
      if (ready === "supported") {
        expect(events).toContainEqual({ type: "set_buffer", text: "echo x" });
        expect(commands.find((c) => c.type === "prompt")?.message).toBe(
          "Request for a suggested shell command:\n/do-not-run-extension",
        );
      } else {
        expect(events.at(-1)).toMatchObject({
          type: "settled",
          stopReason: "error",
          error: expect.stringContaining("bridge tool"),
        });
        expect(commands.some((c) => c.type === "prompt")).toBe(false);
      }
    } finally {
      await session.close();
    }
  },
);
