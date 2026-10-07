import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTROLLED_CASES,
  recordRpcControlled,
  rpcControlledMain,
  startLocalApi,
  type ControlledCase,
} from "../../scripts/spikes/rpc-controlled.js";
import type {
  ChildExit,
  PiChild,
  SpawnChild,
} from "../../src/agents/pi/rpc.js";

const selected = {
  PREFAIX_LIVE_PROVIDER: "kimi-coding",
  PREFAIX_LIVE_MODEL: "kimi-coding/k3",
};
const roots: string[] = [];
function directory() {
  const root = mkdtempSync(join(tmpdir(), "pfx-controlled-test-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function tape(name: string): Record<string, unknown>[] {
  return readFileSync(
    resolve(`test/fixtures/pi/recorded/${name}.jsonl`),
    "utf8",
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

class Child implements PiChild {
  readonly pid = 123;
  closed = false;
  prompts = 0;
  #busy = false;
  #stdout: (chunk: string) => void = () => {};
  #exit: (exit: ChildExit) => void = () => {};
  #pending: Record<string, unknown>[] = [];
  constructor(
    readonly scenario: ControlledCase,
    readonly endpoint: string,
    readonly fault?: "endpoint" | "settle",
  ) {}
  onStdout(fn: (chunk: string) => void) {
    this.#stdout = fn;
  }
  onStderr() {}
  onExit(fn: (exit: ChildExit) => void) {
    this.#exit = fn;
  }
  onError() {}
  #emit(record: Record<string, unknown>) {
    if (record["type"] === "agent_start") this.#busy = true;
    if (record["type"] === "agent_settled") {
      if (this.fault === "settle") return;
      this.#busy = false;
    }
    this.#stdout(`${JSON.stringify(record)}\n`);
  }
  #play(records: Record<string, unknown>[]) {
    const at = records.findIndex((r) => r["untilCommand"] === "abort");
    const ready = at < 0 ? records : records.slice(0, at);
    this.#pending = at < 0 ? [] : records.slice(at + 1);
    for (const r of ready)
      if (
        typeof r["type"] === "string" &&
        r["type"] !== "prefaix_fixture_header"
      )
        this.#emit(r);
  }
  write(line: string) {
    const cmd = JSON.parse(line) as Record<string, unknown>;
    const ok = (data?: unknown) =>
      this.#emit({
        type: "response",
        id: cmd["id"],
        command: cmd["type"],
        success: true,
        data,
      });
    switch (cmd["type"]) {
      case "get_state":
        ok({
          model: {
            provider: "kimi-coding",
            id: "k3",
            baseUrl:
              this.fault === "endpoint"
                ? "https://api.kimi.com/coding"
                : this.endpoint,
          },
          isStreaming: this.#busy,
          isCompacting: false,
          sessionId: "synthetic",
          sessionFile: "/synthetic/session",
        });
        break;
      case "prompt": {
        this.prompts++;
        ok({ disposition: "started" });
        const name =
          this.scenario === "compact-overflow" && this.prompts === 1
            ? "stream"
            : this.scenario === "compact-manual" ||
                (this.scenario === "compact-threshold" && this.prompts > 1)
              ? "stream"
              : this.scenario;
        this.#play(tape(name));
        break;
      }
      case "clear_queue":
        ok();
        break;
      case "abort":
        this.#play(this.#pending);
        ok();
        break;
      case "compact":
        this.#play(tape("compact-manual"));
        ok({ summary: "synthetic" });
        break;
      default:
        throw new Error("Unexpected synthetic command");
    }
  }
  endStdin() {
    this.closed = true;
    this.#exit({ code: 0, signal: null });
  }
  kill(signal: NodeJS.Signals) {
    this.closed = true;
    this.#exit({ code: null, signal });
  }
}
function setup(fault?: "endpoint" | "settle") {
  const children: Child[] = [];
  const plans: {
    args: readonly string[];
    env: NodeJS.ProcessEnv;
    cwd: string;
  }[] = [];
  const spawn: SpawnChild = (_bin, args, options) => {
    const profile = options.env["PI_CODING_AGENT_DIR"]!;
    const models = JSON.parse(
      readFileSync(join(profile, "models.json"), "utf8"),
    ) as { providers: { "kimi-coding": { baseUrl: string } } };
    const child = new Child(
      basename(profile) as ControlledCase,
      models.providers["kimi-coding"].baseUrl,
      fault,
    );
    children.push(child);
    plans.push({ args, env: options.env, cwd: options.cwd });
    return child;
  };
  return {
    children,
    plans,
    options: {
      recordDir: join(directory(), "recording"),
      env: selected,
      spawn,
      piVersion: "synthetic",
      timeoutMs: 20,
      readyTimeoutMs: 100,
      shutdownGraceMs: 5,
    },
  };
}

describe("controlled native RPC recorder mechanics (synthetic child)", () => {
  it("refuses missing, forbidden, or unsupported selections before files/spawn", async () => {
    for (const env of [
      {},
      { ...selected, PREFAIX_LIVE_PROVIDER: "openai-custom" },
      { PREFAIX_LIVE_PROVIDER: "zai", PREFAIX_LIVE_MODEL: "zai/glm-5.3-flash" },
    ]) {
      const test = setup();
      await expect(
        recordRpcControlled({ ...test.options, env }),
      ).rejects.toThrow();
      expect(test.children).toHaveLength(0);
      expect(existsSync(test.options.recordDir)).toBe(false);
    }
  });
  it("labels injected children synthetic, isolates credentials, cleans profiles, and records all scenarios", async () => {
    const test = setup();
    const report = await recordRpcControlled({
      ...test.options,
      env: {
        ...selected,
        ANTHROPIC_API_KEY: "do-not-inherit",
        NODE_OPTIONS: "do-not-inherit",
        OP_SERVICE_ACCOUNT_TOKEN: "do-not-inherit",
      },
    });
    expect(report).toMatchObject({
      source: "synthetic",
      status: "passed",
      stimulus: { remoteModelRequests: 0 },
    });
    expect(report.scenarios.map((s) => s.scenario)).toEqual(CONTROLLED_CASES);
    for (const plan of test.plans) {
      expect(plan.env["ANTHROPIC_API_KEY"]).toBeUndefined();
      expect(plan.env["NODE_OPTIONS"]).toBeUndefined();
      expect(plan.env["OP_SERVICE_ACCOUNT_TOKEN"]).toBeUndefined();
      expect(plan.env["KIMI_API_KEY"]).toContain("dummy-not-a-credential");
      expect(plan.args[plan.args.indexOf("--provider") + 1]).toBe(
        "kimi-coding",
      );
      expect(plan.args[plan.args.indexOf("--model") + 1]).toBe(
        "kimi-coding/k3",
      );
      expect(existsSync(plan.env["PI_CODING_AGENT_DIR"]!)).toBe(false);
      expect(existsSync(plan.cwd)).toBe(false);
    }
    expect(test.children.every((c) => c.closed)).toBe(true);
    await expect(recordRpcControlled(test.options)).rejects.toThrow(/EEXIST/u);
  });
  it.each(["endpoint", "settle"] as const)(
    "fails honestly on %s and closes resources",
    async (fault) => {
      const test = setup(fault);
      await expect(recordRpcControlled(test.options)).rejects.toThrow(
        fault === "endpoint" ? /non-loopback/u : /settlement/u,
      );
      expect(test.children.every((c) => c.closed)).toBe(true);
      expect(
        JSON.parse(
          readFileSync(join(test.options.recordDir, "summary.json"), "utf8"),
        ),
      ).toMatchObject({ status: "failed", source: "synthetic" });
    },
  );
  it("supports no-model help and rejects malformed CLI arguments with handler cleanup", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await rpcControlledMain(["--help"], {});
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("no real credentials"),
    );
    for (const argv of [["--record"], ["--record", "--help"], ["extra"]])
      await expect(rpcControlledMain(argv, {})).rejects.toThrow(/Usage/u);
    const before = process.listenerCount("SIGINT");
    await expect(rpcControlledMain([], {})).rejects.toThrow(/Refusing/u);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });
  it("does not start if already interrupted", async () => {
    const test = setup();
    const signal = AbortSignal.abort(new Error("cancelled"));
    await expect(
      recordRpcControlled({ ...test.options, signal }),
    ).rejects.toThrow(/cancelled/u);
    expect(existsSync(test.options.recordDir)).toBe(false);
  });
});

describe("loopback-only API stimuli", () => {
  it.each(CONTROLLED_CASES)(
    "scripts %s without a remote forwarding path",
    async (scenario) => {
      const api = await startLocalApi(scenario);
      try {
        const call = () =>
          fetch(`${api.baseUrl}/v1/messages?beta=true`, {
            method: "POST",
            body: JSON.stringify({ model: "k3" }),
          });
        const first = await call();
        expect(first.status).toBe(scenario.startsWith("retry-") ? 503 : 200);
        const body = await first.text();
        expect(body).toContain(
          scenario.startsWith("retry-") ? "controlled 503" : "message_stop",
        );
        const second = await call();
        expect(second.status).toBe(
          scenario === "compact-overflow"
            ? 400
            : scenario === "retry-abort" || scenario === "retry-exhausted"
              ? 503
              : 200,
        );
        await second.text();
        expect(api.requests).toBe(2);
        expect(api.problem).toBeUndefined();
      } finally {
        await api.close();
      }
    },
  );
  it("rejects bad methods, paths, models, JSON, oversized bodies, and over-budget requests", async () => {
    const api = await startLocalApi("retry-success");
    try {
      for (const [path, method, body] of [
        ["/v1/messages", "GET", undefined],
        ["/elsewhere", "POST", "{}"],
        ["/v1/messages", "POST", '{"model":"other"}'],
        ["/v1/messages", "POST", "not-json"],
        ["/v1/messages", "POST", "x".repeat(1_048_577)],
      ] as const) {
        const result = await fetch(api.baseUrl + path, {
          method,
          ...(body === undefined ? {} : { body }),
        });
        expect(result.status).toBe(400);
        await result.text();
      }
      for (let i = 0; i < 9; i++) {
        const result = await fetch(`${api.baseUrl}/v1/messages`, {
          method: "POST",
          body: '{"model":"k3"}',
        });
        expect(result.status).toBe(i === 0 ? 503 : i === 8 ? 400 : 200);
        await result.text();
      }
      expect(api.problem).toBe("Local probe refused an unexpected request");
    } finally {
      await api.close();
    }
  });
});
