import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  recordRpcLifecycle,
  rpcLiveMain,
  spawnRpcProcess,
} from "../../scripts/spikes/rpc-live.js";
import { WAIT_STARTED, WAIT_TOOL } from "../../scripts/spikes/rpc-wait-tool.js";
import type {
  ChildExit,
  PiChild,
  SpawnChild,
} from "../../src/agents/pi/rpc.js";

type RecordValue = Record<string, unknown>;
type Fault =
  | "provider"
  | "model"
  | "ready-timeout"
  | "settle-timeout"
  | "fast-text"
  | "fast-tool"
  | "handled"
  | "queued"
  | "forgot"
  | "session"
  | "malformed"
  | "unterminated"
  | "shutdown"
  | "abort-error"
  | "turn-error"
  | "spawn-error"
  | "kill-settled"
  | "double-settled"
  | "late-text"
  | "provider-switch"
  | "no-trigger"
  | "retry-compaction";
const allowed = {
  PREFAIX_LIVE_PROVIDER: "google",
  PREFAIX_LIVE_MODEL: "google/gemini-3.8-flash",
};
const roots: string[] = [];
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "pfx-s1-test-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function jsonl(path: string): RecordValue[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordValue);
}

// A causal raw-wire child, not a model. Abort emits settle before its response;
// normal completions happen in the same read as acceptance to expose races.
class ReplayChild implements PiChild {
  readonly pid = 123;
  readonly commands: RecordValue[] = [];
  readonly signals: NodeJS.Signals[] = [];
  stdinClosed = false;
  #stdout: (chunk: string) => void = () => {};
  #stderr: (chunk: string) => void = () => {};
  #exit: (exit: ChildExit) => void = () => {};
  #error: (problem: string) => void = () => {};
  #busy = false;
  #exited = false;
  #promptCount = 0;
  #code = "";
  #lastText = "";
  constructor(
    readonly scenario: number,
    readonly fault?: Fault,
  ) {}
  onStdout(fn: (chunk: string) => void): void {
    this.#stdout = fn;
  }
  onStderr(fn: (chunk: string) => void): void {
    this.#stderr = fn;
  }
  onExit(fn: (exit: ChildExit) => void): void {
    this.#exit = fn;
  }
  onError(fn: (problem: string) => void): void {
    this.#error = fn;
  }
  #emit(record: RecordValue): void {
    const raw = JSON.stringify(record);
    // Split a record, keep Unicode separators as data, and preserve whitespace.
    this.#stdout(`${raw.slice(0, 7)}`);
    this.#stdout(`${raw.slice(7)} \n`);
  }
  #finish(aborted: boolean): void {
    if (this.scenario === 2) {
      this.#emit({
        type: "tool_execution_end",
        toolName: WAIT_TOOL,
        toolCallId: "call1",
        result: { content: [] },
        isError: aborted,
      });
    } else {
      this.#lastText =
        this.fault === "forgot" && this.#promptCount > 1
          ? "forgotten"
          : this.#code;
      this.#emit({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason:
            this.fault === "turn-error"
              ? "error"
              : aborted
                ? "aborted"
                : "stop",
          content: [{ type: "text", text: this.#lastText }],
        },
      });
    }
    this.#emit({ type: "turn_end" });
    this.#emit({ type: "agent_end", messages: [], willRetry: false });
    if (this.fault !== "settle-timeout") this.#emit({ type: "agent_settled" });
    if (this.fault === "double-settled") this.#emit({ type: "agent_settled" });
    if (this.fault === "late-text")
      this.#emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "too late" },
      });
    this.#busy = false;
  }
  write(line: string): void {
    const command = JSON.parse(line) as RecordValue;
    this.commands.push(command);
    const ok = (data?: unknown) =>
      this.#emit({
        type: "response",
        id: command["id"],
        command: command["type"],
        success: true,
        ...(data === undefined ? {} : { data }),
      });
    switch (command["type"]) {
      case "get_state":
        if (this.fault === "spawn-error") {
          this.#error("fixture spawn failed");
          return;
        }
        if (this.fault === "ready-timeout") return;
        this.#stderr("synthetic stderr\u2029data\n");
        ok({
          model: {
            provider:
              this.fault === "provider" ||
              (this.fault === "provider-switch" && this.#promptCount > 0)
                ? "openai-codex"
                : "google",
            id: this.fault === "model" ? "different" : "gemini-3.8-flash",
          },
          isStreaming: this.#busy,
          isCompacting: false,
          sessionId:
            this.fault === "session" && this.#promptCount > 1
              ? "other"
              : "s1-session",
          sessionFile: "/synthetic/s1-session.jsonl",
        });
        break;
      case "prompt": {
        this.#promptCount++;
        const text = String(command["message"]);
        this.#code = /S1_CONTINUITY_\w+/u.exec(text)?.[0] ?? this.#code;
        ok({
          disposition:
            this.fault === "handled"
              ? "handled"
              : this.fault === "queued"
                ? "queued"
                : "started",
        });
        if (this.fault === "malformed") this.#stdout("null\n{not-json}\n");
        this.#busy = true;
        this.#emit({ type: "agent_start" });
        this.#emit({ type: "turn_start" });
        if (this.fault === "retry-compaction" && this.#promptCount === 1) {
          this.#emit({
            type: "message_end",
            message: { role: "assistant", stopReason: "error" },
          });
          this.#emit({ type: "turn_end" });
          this.#emit({ type: "agent_end", willRetry: true, messages: [] });
          this.#emit({
            type: "auto_retry_start",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 0,
            errorMessage: "synthetic retry",
          });
          this.#emit({ type: "compaction_start", reason: "overflow" });
          this.#emit({
            type: "compaction_end",
            reason: "overflow",
            aborted: false,
            willRetry: true,
            result: {},
          });
          this.#emit({ type: "agent_start" });
          this.#emit({ type: "turn_start" });
          this.#emit({ type: "auto_retry_end", success: true, attempt: 1 });
        }
        this.#emit({ type: "message_start", message: { role: "assistant" } });
        if (this.scenario === 2) {
          this.#emit({
            type: "message_end",
            message: { role: "assistant", stopReason: "toolUse" },
          });
          this.#emit({
            type: "tool_execution_start",
            toolName: WAIT_TOOL,
            toolCallId: "call1",
            args: {},
          });
          this.#emit({
            type: "tool_execution_update",
            toolName: WAIT_TOOL,
            toolCallId: "call1",
            partialResult: { content: [{ type: "text", text: WAIT_STARTED }] },
          });
          if (this.fault === "fast-tool") this.#finish(false);
        } else {
          if (this.fault !== "no-trigger")
            this.#emit({
              type: "message_update",
              assistantMessageEvent: {
                type: "text_delta",
                delta: "synthetic 🚀\u2028data",
              },
            });
          if (this.scenario === 0 || this.fault === "fast-text")
            this.#finish(false);
        }
        break;
      }
      case "get_last_assistant_text":
        ok({ text: this.#lastText });
        break;
      case "clear_queue":
        this.#emit({ type: "queue_update", steering: [], followUp: [] });
        ok();
        break;
      case "abort":
        if (this.fault === "abort-error") {
          this.#emit({
            type: "response",
            id: command["id"],
            command: "abort",
            success: false,
            error: "synthetic abort failure",
          });
        } else {
          this.#finish(true);
          ok();
        }
        break;
      default:
        throw new Error(
          `Unexpected fixture command ${String(command["type"])}`,
        );
    }
  }
  endStdin(): void {
    this.stdinClosed = true;
    if (this.#exited || this.fault === "shutdown") return;
    this.#stderr("stderr tail before close\n");
    if (this.fault === "unterminated") this.#stdout('{"type":"tail"}');
    this.#exited = true;
    this.#exit({ code: 0, signal: null });
  }
  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
    if (this.#exited) return;
    this.#exited = true;
    if (this.fault === "kill-settled") this.#emit({ type: "agent_settled" });
    this.#exit({
      code: signal === "SIGTERM" ? 143 : null,
      signal: signal === "SIGTERM" ? null : signal,
    });
  }
}

function harness(fault?: Fault, faultScenario = 0) {
  const children: ReplayChild[] = [];
  const spawns: { args: readonly string[]; cwd: string }[] = [];
  const spawn: SpawnChild = (_bin, args, options) => {
    const child = new ReplayChild(
      children.length,
      children.length === faultScenario ? fault : undefined,
    );
    children.push(child);
    spawns.push({ args, cwd: options.cwd });
    return child;
  };
  const recordDir = join(directory(), "recording");
  return {
    children,
    spawns,
    recordDir,
    options: {
      recordDir,
      env: allowed,
      spawn,
      piVersion: "synthetic-pi",
      timeoutMs: 20,
      readyTimeoutMs: 20,
      shutdownGraceMs: 5,
    },
  };
}

describe("S1 guarded lifecycle recorder", () => {
  it("refuses before spawning or creating artifacts, including forbidden provider prefixes", async () => {
    for (const env of [
      {},
      { PREFAIX_LIVE_PROVIDER: "google" },
      { ...allowed, PREFAIX_LIVE_PROVIDER: "anthropic-compatible" },
      { ...allowed, PREFAIX_LIVE_PROVIDER: "openai-codex-custom" },
      { ...allowed, PREFAIX_LIVE_MODEL: "openrouter/openai/gpt" },
    ]) {
      const setup = harness();
      await expect(
        recordRpcLifecycle({ ...setup.options, env }),
      ).rejects.toThrow(/Refusing/);
      expect(setup.children).toHaveLength(0);
      expect(existsSync(setup.recordDir)).toBe(false);
    }
  });

  it("records five causal turns, unmodified stdout, native identity, and shutdown evidence", async () => {
    const setup = harness();
    const report = await recordRpcLifecycle(setup.options);
    expect(report).toMatchObject({
      status: "passed",
      source: "synthetic",
      provider: "google",
      model: allowed.PREFAIX_LIVE_MODEL,
      piVersion: "synthetic-pi",
      retriesObserved: 0,
      compactionsObserved: 0,
    });
    expect(
      report.scenarios.map((s) => s.turns.map((t) => t.settledCount)),
    ).toEqual([[1, 1], [1], [1], [0]]);
    expect(report.scenarios[1]?.turns[0]?.stopReasons).toEqual(["aborted"]);
    // The last assistant already said toolUse; do not invent a raw aborted message.
    expect(report.scenarios[2]?.turns[0]?.stopReasons).toEqual(["toolUse"]);
    expect(report.scenarios[3]?.shutdown?.exit.signal).toBe("SIGKILL");
    expect(
      setup.children[0]?.commands.filter((c) => c["type"] === "prompt"),
    ).toHaveLength(2);
    for (const index of [1, 2]) {
      const types = setup.children[index]?.commands.map((c) => c["type"]) ?? [];
      expect(types.indexOf("clear_queue")).toBeLessThan(types.indexOf("abort"));
    }
    for (const entry of setup.spawns) {
      expect(entry.args).toContain("--provider");
      expect(entry.args[entry.args.indexOf("--provider") + 1]).toBe("google");
      expect(entry.args[entry.args.indexOf("--model") + 1]).toBe(
        allowed.PREFAIX_LIVE_MODEL,
      );
      for (const flag of [
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-context-files",
        "--no-mcp",
        "--no-approve",
      ])
        expect(entry.args).toContain(flag);
      expect(existsSync(entry.cwd)).toBe(false);
    }
    expect(setup.spawns[2]?.args).toContain(WAIT_TOOL);
    expect(setup.spawns[0]?.args).toContain("--no-tools");
    const stream = jsonl(join(setup.recordDir, "stream.jsonl"));
    expect(stream[0]).toMatchObject({
      type: "prefaix_fixture_header",
      source: "synthetic",
      provider: "google",
      model: allowed.PREFAIX_LIVE_MODEL,
    });
    expect(
      readFileSync(join(setup.recordDir, "stream.jsonl"), "utf8"),
    ).toContain('"delta":"synthetic 🚀\u2028data"}} \n');
    expect(
      readFileSync(join(setup.recordDir, "stream.stderr.log"), "utf8"),
    ).toContain("stderr tail before close\n");
    const trace = jsonl(join(setup.recordDir, "kill-text.trace.jsonl"));
    expect(trace.find((r) => r["kind"] === "signal")?.["data"]).toBe("SIGKILL");
    expect(trace.at(-1)).toMatchObject({
      kind: "exit",
      data: { signal: "SIGKILL" },
    });
    expect(
      jsonl(join(setup.recordDir, "kill-text.jsonl")).some(
        (r) => r["type"] === "agent_settled",
      ),
    ).toBe(false);
    expect(
      JSON.parse(readFileSync(join(setup.recordDir, "summary.json"), "utf8")),
    ).toEqual(report);
    expect(statSync(setup.recordDir).mode & 0o777).toBe(0o700);
    for (const file of readdirSync(setup.recordDir))
      expect(statSync(join(setup.recordDir, file)).mode & 0o777).toBe(0o600);
  });

  it.each([
    ["provider", 0, /different provider/],
    ["model", 0, /exact model ID/],
    ["ready-timeout", 0, /ready|timed out/],
    ["settle-timeout", 0, /agent_settled/],
    ["fast-text", 1, /settled before/],
    ["fast-tool", 2, /settled before/],
    ["handled", 0, /did not start/],
    ["queued", 0, /did not start/],
    ["forgot", 0, /remember/],
    ["session", 0, /session ID changed/],
    ["malformed", 0, /malformed/],
    ["unterminated", 0, /unterminated/],
    ["shutdown", 0, /escalation/],
    ["abort-error", 1, /abort failure/],
    ["turn-error", 0, /successfully/],
    ["spawn-error", 0, /spawn failed/],
    ["kill-settled", 3, /unexpectedly wrote/],
    ["double-settled", 0, /exactly one/],
    ["late-text", 0, /after agent_settled/],
    ["provider-switch", 0, /different provider/],
    ["no-trigger", 1, /abort-text trigger/],
  ] as const)(
    "fails honestly on %s and keeps partial evidence",
    async (fault, scenario, error) => {
      const setup = harness(fault, scenario);
      await expect(recordRpcLifecycle(setup.options)).rejects.toThrow(error);
      const report = JSON.parse(
        readFileSync(join(setup.recordDir, "summary.json"), "utf8"),
      ) as RecordValue;
      expect(report).toMatchObject({ status: "failed", source: "synthetic" });
      expect(String(report["error"])).toMatch(error);
      expect(
        setup.children.every(
          (child) =>
            child.stdinClosed ||
            child.signals.length > 0 ||
            fault === "spawn-error",
        ),
      ).toBe(true);
      expect(setup.spawns.every((entry) => !existsSync(entry.cwd))).toBe(true);
      if (fault === "provider" || fault === "model")
        expect(
          setup.children[0]?.commands.some((c) => c["type"] === "prompt"),
        ).toBe(false);
    },
  );

  it("counts synthetic retries/compactions without treating agent_end as settlement", async () => {
    const setup = harness("retry-compaction");
    const report = await recordRpcLifecycle(setup.options);
    expect(report).toMatchObject({
      source: "synthetic",
      status: "passed",
      retriesObserved: 1,
      compactionsObserved: 1,
    });
    const first = report.scenarios[0]?.turns[0];
    expect(first?.stopReasons).toEqual(["error", "stop"]);
    expect(first?.settledCount).toBe(1);
    expect(first?.events.filter((type) => type === "agent_end")).toHaveLength(
      2,
    );
  });

  it("never overwrites an existing recording", async () => {
    const setup = harness();
    await recordRpcLifecycle(setup.options);
    const before = readFileSync(join(setup.recordDir, "summary.json"), "utf8");
    await expect(recordRpcLifecycle(setup.options)).rejects.toThrow(/EEXIST/);
    expect(setup.children).toHaveLength(4);
    expect(readFileSync(join(setup.recordDir, "summary.json"), "utf8")).toBe(
      before,
    );
  });

  it("does not create artifacts or spawn if cancellation preceded the run", async () => {
    const setup = harness();
    const controller = new AbortController();
    controller.abort(new Error("cancelled beforehand"));
    await expect(
      recordRpcLifecycle({ ...setup.options, signal: controller.signal }),
    ).rejects.toThrow(/cancelled beforehand/);
    expect(setup.children).toHaveLength(0);
    expect(existsSync(setup.recordDir)).toBe(false);
  });

  it("kills an active child on interruption and records failure instead of success", async () => {
    const setup = harness();
    const controller = new AbortController();
    const spawn: SpawnChild = (bin, args, options) => {
      const child = setup.options.spawn(bin, args, options);
      const write = child.write.bind(child);
      child.write = (line) => {
        write(line);
        if ((JSON.parse(line) as RecordValue)["type"] === "prompt")
          controller.abort(new Error("test interruption"));
      };
      return child;
    };
    await expect(
      recordRpcLifecycle({
        ...setup.options,
        spawn,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(setup.children[0]?.signals).toContain("SIGKILL");
    expect(
      JSON.parse(readFileSync(join(setup.recordDir, "summary.json"), "utf8")),
    ).toMatchObject({ status: "failed", error: "Error: test interruption" });
  });

  it("records version-probe failure without opening an RPC child", async () => {
    const setup = harness();
    await expect(
      recordRpcLifecycle({
        recordDir: setup.recordDir,
        spawn: setup.options.spawn,
        env: {
          ...allowed,
          PREFAIX_AGENT_PI_BIN: join(directory(), "missing-pi"),
        },
      }),
    ).rejects.toThrow(/ENOENT/);
    expect(setup.children).toHaveLength(0);
    expect(
      JSON.parse(readFileSync(join(setup.recordDir, "summary.json"), "utf8")),
    ).toMatchObject({ status: "failed", piVersion: "unknown" });
  });
});

describe("S1 recorder command", () => {
  it("has no-model help and rejects unknown/missing arguments", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await rpcLiveMain(["--help"], {});
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Sends five prompts"),
    );
    for (const argv of [
      ["--record"],
      ["--record", ""],
      ["--record", "--help"],
      ["--wat"],
      ["extra", "path"],
    ]) {
      await expect(rpcLiveMain(argv, {})).rejects.toThrow(/Usage/);
    }
  });
  it("cleans up signal handlers even on refusal", async () => {
    const before = [
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ];
    await expect(rpcLiveMain([], {})).rejects.toThrow(/Refusing/);
    expect([
      process.listenerCount("SIGINT"),
      process.listenerCount("SIGTERM"),
    ]).toEqual(before);
  });
  it("exits nonzero at the actual CLI boundary before pi or artifact creation", () => {
    const recordDir = join(directory(), "cli-recording");
    const result = spawnSync(
      "bun",
      [resolve("scripts/spikes/rpc-live.ts"), "--record", recordDir],
      {
        env: {
          PATH: process.env["PATH"] ?? "/usr/bin:/bin",
          HOME: directory(),
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/PREFAIX_LIVE_PROVIDER.*Refusing/su);
    expect(existsSync(recordDir)).toBe(false);
  });
});

describe("the recorder's native process seam", () => {
  it("decodes split UTF-8 and drains stderr before reporting close, without a model", async () => {
    const child = spawnRpcProcess(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
      process.stdin.on('data', () => {
        const bytes = Buffer.from('🚀\\u2028data\\n');
        process.stdout.write(bytes.subarray(0, 2));
        setTimeout(() => process.stdout.write(bytes.subarray(2)), 5);
      });
      process.stdin.on('end', () => setTimeout(() => {
        process.stderr.write('last stderr\\n', () => process.exit(0));
      }, 10));
    `,
      ],
      { cwd: directory(), env: {} },
    );
    let stdout = "";
    let stderr = "";
    const closed = new Promise<ChildExit>((resolve, reject) => {
      child.onStdout((chunk) => {
        stdout += chunk;
      });
      child.onStderr((chunk) => {
        stderr += chunk;
      });
      child.onExit(resolve);
      child.onError((problem) => reject(new Error(problem)));
    });
    expect(child.pid).toBeTypeOf("number");
    child.write("anything\n");
    child.endStdin();
    try {
      expect(await closed).toEqual({ code: 0, signal: null });
      expect(stdout).toBe("🚀\u2028data\n");
      expect(stderr).toBe("last stderr\n");
    } finally {
      child.kill("SIGKILL");
    }
  });
  it("reports spawn errors rather than crashing the recorder", async () => {
    const child = spawnRpcProcess(join(directory(), "missing-pi"), [], {
      cwd: directory(),
      env: {},
    });
    const problem = new Promise<string>((resolve) => child.onError(resolve));
    expect(await problem).toMatch(/ENOENT/);
  });
});
