import {
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ShellContext } from "../../src/core/agent-port.js";
import prefaixBridge, { createBridge } from "../../src/agents/pi/bridge.js";
import { BRIDGE_DIR_ENV } from "../../src/agents/pi/bridge.js";
import {
  BRIDGE_VERSION,
  bridgeAppliedLog,
  bridgeReadyFile,
  prependBlock,
  readTurnContext,
  removeTurnContext,
  renderPersonaSection,
  renderShellContext,
  turnContextFile,
  writeTurnContext,
  type AppliedRecord,
  type TurnContextFile,
} from "../../src/agents/pi/bridge-context.js";

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

const PID = 4321;

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pfx-bridge-unit-"));
  process.env[BRIDGE_DIR_ENV] = dir;
});

afterEach(() => {
  delete process.env[BRIDGE_DIR_ENV];
});

interface FakePi {
  readonly applied: string[][];
  readonly pi: {
    on(event: string, handler: (event: unknown) => void): void;
    setActiveTools(names: string[]): void;
    getActiveTools(): string[];
  };
  failToolSwitch(problem: string): void;
  fire(event: { type: string } & Record<string, unknown>): void;
}

/** The slice of pi's extension API the bridge uses, with recorded calls. */
function fakePi(
  startTools: string[] = ["read", "bash", "edit", "write"],
): FakePi {
  const handlers = new Map<string, (event: unknown) => void>();
  const applied: string[][] = [];
  let active = [...startTools];
  let toolProblem: string | undefined;
  return {
    applied,
    pi: {
      on(event, handler) {
        handlers.set(event, handler);
      },
      setActiveTools(names) {
        if (toolProblem !== undefined) {
          throw new Error(toolProblem);
        }
        applied.push(names);
        active = names;
      },
      getActiveTools: () => active,
    },
    failToolSwitch(problem) {
      toolProblem = problem;
    },
    fire(event) {
      handlers.get(event.type)?.(event);
    },
  };
}

function bridge(fake: FakePi) {
  return createBridge(fake.pi as never, { pid: PID });
}

function startTurn(
  fake: FakePi,
  payload: TurnContextFile | undefined,
  prompt = "fix the failing test",
): { sections: Record<string, string> } {
  if (payload !== undefined) {
    writeTurnContext(turnContextFile(dir, PID), payload);
  }
  const sections: Record<string, string> = {};
  fake.fire({
    type: "before_agent_start",
    prompt,
    systemPromptOptions: { sections },
  });
  return { sections };
}

function applied(): AppliedRecord[] {
  const file = bridgeAppliedLog(dir, PID);
  if (!existsSync(file)) {
    return [];
  }
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as AppliedRecord);
}

describe("the bridge announces itself", () => {
  it("writes a ready file the adapter can probe for", () => {
    const fake = fakePi();
    bridge(fake);
    const file = bridgeReadyFile(dir, PID);
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: BRIDGE_VERSION,
      pid: PID,
    });
  });

  it("installs itself through the default entry pi loads", () => {
    const fake = fakePi();
    // pi requires the bundle and calls its default export, so that is the path
    // that has to work, not just the named one the tests use.
    prefaixBridge(fake.pi as never);
    // The default entry has no pid to be told, so it uses the process it runs
    // in, which is the child pi loaded it into.
    expect(existsSync(bridgeReadyFile(dir, process.pid))).toBe(true);
  });

  it("stays silent, rather than throwing, when the directory is gone", () => {
    process.env[BRIDGE_DIR_ENV] = join(dir, "not-there");
    const pi = fakePi();
    expect(() => bridge(pi)).not.toThrow();
  });

  it("does nothing at all without the directory env var", () => {
    delete process.env[BRIDGE_DIR_ENV];
    const fake = fakePi();
    bridge(fake);
    expect(existsSync(bridgeReadyFile(dir, PID))).toBe(false);
    const { sections } = startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
    });
    expect(Object.keys(sections)).toEqual([]);
  });

  it("survives a pi that cannot report its own tools", () => {
    const fake = fakePi();
    fake.pi.getActiveTools = () => {
      throw new Error("not bound yet");
    };
    expect(() => bridge(fake)).not.toThrow();
  });
});

describe("per-turn context out of band", () => {
  it("patches a prefaix section and leaves the user text alone", () => {
    const fake = fakePi();
    bridge(fake);
    const { sections } = startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
    });
    expect(sections["prefaix"]).toContain(
      "You are being used from the user's interactive shell via prefaix.",
    );
    expect(sections["prefaix"]).toContain("/Users/tester/proj/packages/api");
    expect(sections["prefaix"]).toContain("git pull (exit 0)");
    // The visible message is what the user typed, and the log proves it.
    expect(applied()).toEqual([
      { prompt: "fix the failing test", section: true },
    ]);
  });

  it("removes the context file as soon as it has read it", () => {
    const fake = fakePi();
    bridge(fake);
    startTurn(fake, { version: BRIDGE_VERSION, context: CONTEXT });
    expect(existsSync(turnContextFile(dir, PID))).toBe(false);
  });

  it("reports a turn with no context file instead of inventing one", () => {
    const fake = fakePi();
    bridge(fake);
    const { sections } = startTurn(fake, undefined);
    expect(sections["prefaix"]).toBeUndefined();
    expect(applied()).toEqual([
      { prompt: "fix the failing test", section: false },
    ]);
  });

  it("does nothing when pi hands over no mutable prompt", () => {
    const fake = fakePi();
    bridge(fake);
    writeTurnContext(turnContextFile(dir, PID), {
      version: BRIDGE_VERSION,
      context: CONTEXT,
    });
    fake.fire({ type: "before_agent_start", prompt: "hi" });
    expect(existsSync(turnContextFile(dir, PID))).toBe(false);
  });

  it("replaces the section on the next turn rather than appending", () => {
    const fake = fakePi();
    bridge(fake);
    const first = startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
    });
    const second = startTurn(
      fake,
      {
        version: BRIDGE_VERSION,
        context: { ...CONTEXT, cwd: "/Users/tester/other" },
      },
      "now this",
    );
    expect(first.sections["prefaix"]).toContain("packages/api");
    expect(second.sections["prefaix"]).toContain("/Users/tester/other");
    expect(applied().at(-1)?.prompt).toBe("now this");
  });
});

describe("personas switch tools without a respawn", () => {
  it("captures the runtime tool baseline after an unbound empty load-time API", () => {
    const fake = fakePi([]);
    bridge(fake);
    fake.pi.getActiveTools = () => ["read", "bash"];
    fake.fire({ type: "session_start" });
    startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
      persona: { name: "ask", tools: ["read"] },
    });
    startTurn(fake, { version: BRIDGE_VERSION, context: CONTEXT });
    expect(fake.applied).toEqual([["read"], ["read", "bash"]]);
  });

  it("keeps the load-time baseline if the runtime API throws or is absent", () => {
    for (const unavailable of [false, true]) {
      const fake = fakePi(["read", "bash"]);
      bridge(fake);
      fake.pi.getActiveTools = unavailable
        ? (undefined as never)
        : () => {
            throw new Error("unavailable");
          };
      fake.fire({ type: "session_start" });
      startTurn(fake, {
        version: BRIDGE_VERSION,
        context: CONTEXT,
        persona: { name: "ask", tools: ["read"] },
      });
      startTurn(fake, { version: BRIDGE_VERSION, context: CONTEXT });
      expect(fake.applied.at(-1)).toEqual(["read", "bash"]);
    }
  });

  it("narrows the tool set and records the persona section", () => {
    const fake = fakePi();
    bridge(fake);
    const { sections } = startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
      persona: {
        name: "ask",
        tools: ["read", "grep", "find", "ls"],
        guideline: "Answer the question. Do not modify files.",
      },
    });
    expect(fake.applied).toEqual([["read", "grep", "find", "ls"]]);
    expect(sections["persona"]).toContain('You are answering as the "ask"');
    expect(applied().at(-1)?.persona).toBe("ask");
  });

  it("does not re-apply the same persona on every turn", () => {
    const fake = fakePi();
    bridge(fake);
    const persona = { name: "ask", tools: ["read"] };
    startTurn(fake, { version: BRIDGE_VERSION, context: CONTEXT, persona });
    startTurn(fake, { version: BRIDGE_VERSION, context: CONTEXT, persona });
    expect(fake.applied).toHaveLength(1);
  });

  it("re-applies when the tool set changes under the same name", () => {
    const fake = fakePi();
    bridge(fake);
    startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
      persona: { name: "ask", tools: ["read"] },
    });
    startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
      persona: { name: "ask", tools: ["read", "grep"] },
    });
    expect(fake.applied).toEqual([["read"], ["read", "grep"]]);
  });

  it("restores the child's own tool set when the persona is dropped", () => {
    const fake = fakePi();
    bridge(fake);
    startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
      persona: { name: "ask", tools: ["read"] },
    });
    const { sections } = startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
    });
    expect(fake.applied.at(-1)).toEqual(["read", "bash", "edit", "write"]);
    expect(sections["persona"]).toBeUndefined();
  });

  it("keeps the previous tool set when pi refuses the switch", () => {
    const fake = fakePi();
    bridge(fake);
    fake.failToolSwitch("unknown tool");
    const { sections } = startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
      persona: { name: "ask", tools: ["read"] },
    });
    // The guideline still lands, so the turn is not silently wrong.
    expect(sections["persona"]).toContain('"ask"');
  });

  it("restores normal tools when switching from a restricted to a guideline-only persona", () => {
    const fake = fakePi();
    bridge(fake);
    startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
      persona: { name: "ask", tools: ["read"] },
    });
    const { sections } = startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
      persona: { name: "review", guideline: "Ask before editing." },
    });
    expect(fake.applied.at(-1)).toEqual(["read", "bash", "edit", "write"]);
    expect(sections["persona"]).toContain("Ask before editing.");
    startTurn(fake, { version: BRIDGE_VERSION, context: CONTEXT });
    expect(fake.applied.at(-1)).toEqual(["read", "bash", "edit", "write"]);
  });

  it("leaves the tool set alone for a persona with no tools", () => {
    const fake = fakePi();
    bridge(fake);
    const { sections } = startTurn(fake, {
      version: BRIDGE_VERSION,
      context: CONTEXT,
      persona: { name: "free", guideline: "Ask before editing." },
    });
    expect(fake.applied).toEqual([]);
    expect(sections["persona"]).toContain("Ask before editing.");
  });
});

describe("the context file contract", () => {
  it("refuses a file from a different bridge version", () => {
    const file = turnContextFile(dir, PID);
    writeTurnContext(file, { version: BRIDGE_VERSION + 1, context: CONTEXT });
    expect(readTurnContext(file)).toBeUndefined();
  });

  it("refuses a file that is not an object", () => {
    const file = turnContextFile(dir, PID);
    writeFileSync(file, '"just a string"\n');
    expect(readTurnContext(file)).toBeUndefined();
  });

  it("refuses a file that is not JSON at all", () => {
    const file = turnContextFile(dir, PID);
    writeFileSync(file, "{oops\n");
    expect(readTurnContext(file)).toBeUndefined();
  });

  it("reports a missing file as missing, not as an error", () => {
    expect(readTurnContext(join(dir, "absent.json"))).toBeUndefined();
  });

  it("writes 0600, because the file carries the user's shell state", () => {
    const file = turnContextFile(dir, PID);
    expect(
      writeTurnContext(file, { version: BRIDGE_VERSION, context: CONTEXT }),
    ).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reports a directory it cannot write to instead of throwing", () => {
    expect(
      writeTurnContext(join(dir, "nope", "x.json"), {
        version: BRIDGE_VERSION,
        context: CONTEXT,
      }),
    ).toBe(false);
  });

  it("removes a file that is already gone without complaint", () => {
    expect(() => removeTurnContext(join(dir, "absent.json"))).not.toThrow();
  });
});

describe("the section text", () => {
  it("says so when there are no recent commands", () => {
    const section = renderShellContext({ ...CONTEXT, recent: [] });
    expect(section).toContain("Recent commands: (none)");
    expect(section).not.toContain("  [0]");
  });

  it("omits an exit code the shell never reported", () => {
    const section = renderShellContext(CONTEXT);
    expect(section).toContain("git pull (exit 0)");
    expect(section).toContain("bun test auth\n");
  });

  it("has no persona section without a persona", () => {
    expect(renderPersonaSection(undefined)).toBeUndefined();
  });

  it("names the persona even with no guideline and no tools", () => {
    expect(renderPersonaSection({ name: "free" })).toBe(
      'You are answering as the "free" persona.',
    );
  });

  it("wraps the same text the bridge patches, for the prepend fallback", () => {
    const section = renderShellContext(CONTEXT);
    const block = prependBlock(CONTEXT);
    expect(block).toBe(`<prefaix>\n${section}\n</prefaix>`);
    expect(prependBlock(CONTEXT, { name: "ask" })).toContain(
      "<persona>\nYou are answering as",
    );
  });
});
