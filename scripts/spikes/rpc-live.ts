// S1's opt-in recorder. Refusal happens before any filesystem work or spawn.
// Normal tests use the injectable child seam, never a model or pi's defaults.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PiRpc,
  type ChildExit,
  type PiChild,
  type SpawnChild,
} from "../../src/agents/pi/rpc.js";
import {
  assertLiveAllowed,
  type Env,
  type LiveRequest,
} from "../live-guard.js";
import { WAIT_STARTED, WAIT_TOOL } from "./rpc-wait-tool.js";

type WireRecord = Record<string, unknown>;
type Scenario = "stream" | "abort-text" | "abort-tool" | "kill-text";
const CONTINUITY_CODE = "S1_CONTINUITY_7ac30fc6";
export const ISOLATION_ARGS = [
  "--offline",
  "--no-approve",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-mcp",
] as const;
const LONG_PROMPT =
  "Write a long numbered list of 500 short sentences about counting. " +
  "Start the answer immediately, without tools or a preamble.";

export interface LifecycleOptions {
  readonly recordDir: string;
  readonly env?: Env;
  readonly signal?: AbortSignal;
  /** Test seams. An injected child is labeled synthetic in every artifact. */
  readonly spawn?: SpawnChild;
  readonly piVersion?: string;
  readonly timeoutMs?: number;
  readonly readyTimeoutMs?: number;
  readonly shutdownGraceMs?: number;
}

interface TurnObservation {
  readonly recordStart: number;
  readonly recordEnd: number;
  readonly events: readonly string[];
  readonly stopReasons: readonly string[];
  readonly settledCount: number;
}

interface ScenarioObservation {
  readonly scenario: Scenario;
  readonly turns: TurnObservation[];
  sessionId?: string;
  sessionFile?: string;
  shutdown?: { readonly exit: ChildExit; readonly escalatedTo: string };
}

export interface LifecycleReport {
  readonly format: "prefaix-s1-report";
  readonly source: "live" | "synthetic";
  readonly provider: string;
  readonly model: string;
  piVersion: string;
  readonly node: string;
  readonly platform: string;
  readonly recordedAt: string;
  status: "failed" | "passed";
  error?: string;
  readonly scenarios: ScenarioObservation[];
  retriesObserved: number;
  compactionsObserved: number;
}

export function object(value: unknown): WireRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as WireRecord)
    : {};
}

/** Node's native child as PiRpc's already-tested transport seam. */
export const spawnRpcProcess: SpawnChild = (bin, args, options) => {
  const child = spawn(bin, [...args], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let onError: (problem: string) => void = () => {};
  child.on("error", (error: Error) => onError(error.message));
  child.stdin.on("error", (error: Error) => onError(error.message));
  return {
    pid: child.pid,
    write: (line) => {
      child.stdin.write(line);
    },
    endStdin: () => {
      child.stdin.end();
    },
    kill: (signal) => {
      child.kill(signal);
    },
    onStdout: (fn) => {
      child.stdout.on("data", fn);
    },
    onStderr: (fn) => {
      child.stderr.on("data", fn);
    },
    // close, not exit: drain both pipes before finalizing the recordings.
    onExit: (fn) => {
      child.on("close", (code, signal) => fn({ code, signal }));
    },
    onError: (fn) => {
      onError = fn;
    },
  };
};

export interface CaptureInfo {
  readonly source: "live" | "controlled" | "synthetic";
  readonly provider: string;
  readonly model: string;
  readonly piVersion: string;
  readonly recordedAt: string;
  readonly stimulus?: WireRecord;
}

export class Recording {
  readonly records: WireRecord[] = [];
  readonly #started = performance.now();
  readonly #wire: string;
  readonly #trace: string;
  readonly #stderr: string;
  #buffer = "";
  malformed = false;
  child: PiChild | undefined;

  constructor(dir: string, scenario: string, report: CaptureInfo) {
    this.#wire = join(dir, `${scenario}.jsonl`);
    this.#trace = join(dir, `${scenario}.trace.jsonl`);
    this.#stderr = join(dir, `${scenario}.stderr.log`);
    const header = {
      type: "prefaix_fixture_header",
      version: 1,
      scenario,
      source: report.source,
      provider: report.provider,
      model: report.model,
      piVersion: report.piVersion,
      recordedAt: report.recordedAt,
      ...(report.stimulus === undefined ? {} : { stimulus: report.stimulus }),
    };
    for (const [path, content] of [
      [this.#wire, `${JSON.stringify(header)}\n`],
      [this.#trace, ""],
      [this.#stderr, ""],
    ] as const) {
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    }
  }

  trace(kind: string, data: unknown): void {
    appendFileSync(
      this.#trace,
      `${JSON.stringify({ atMs: performance.now() - this.#started, kind, data })}\n`,
    );
  }

  wrap(spawnChild: SpawnChild): SpawnChild {
    return (bin, args, options) => {
      const child = spawnChild(bin, args, options);
      const wrapped: PiChild = {
        pid: child.pid,
        write: (line) => {
          this.trace("stdin", line);
          child.write(line);
        },
        endStdin: () => {
          this.trace("stdin-close", null);
          child.endStdin();
        },
        kill: (signal) => {
          this.trace("signal", signal);
          child.kill(signal);
        },
        onStdout: (fn) =>
          child.onStdout((chunk) => {
            appendFileSync(this.#wire, chunk);
            this.trace("stdout", chunk);
            this.#buffer += chunk;
            for (
              let at = this.#buffer.indexOf("\n");
              at !== -1;
              at = this.#buffer.indexOf("\n")
            ) {
              const line = this.#buffer.slice(0, at);
              this.#buffer = this.#buffer.slice(at + 1);
              if (line === "") continue;
              try {
                const value: unknown = JSON.parse(line);
                const record = object(value);
                if (typeof record["type"] !== "string") this.malformed = true;
                else this.records.push(record);
              } catch {
                this.malformed = true;
              }
            }
            fn(chunk);
          }),
        onStderr: (fn) =>
          child.onStderr((chunk) => {
            appendFileSync(this.#stderr, chunk);
            this.trace("stderr", chunk);
            fn(chunk);
          }),
        onExit: (fn) =>
          child.onExit((exit) => {
            if (this.#buffer !== "") this.malformed = true;
            this.trace("exit", exit);
            fn(exit);
          }),
        onError: (fn) =>
          child.onError((problem) => {
            this.trace("error", problem);
            fn(problem);
          }),
      };
      this.child = wrapped;
      this.trace("spawn", { bin, args, pid: child.pid });
      return wrapped;
    };
  }
}

export function modelId(live: LiveRequest): string {
  const prefix = `${live.provider}/`;
  return live.model.startsWith(prefix)
    ? live.model.slice(prefix.length)
    : live.model;
}

export async function checkedState(rpc: PiRpc, env: Env): Promise<WireRecord> {
  const live = assertLiveAllowed(env);
  const state = object(await rpc.request("get_state"));
  const model = object(state["model"]);
  assert.equal(
    model["provider"],
    live.provider,
    "pi selected a different provider; refusing to prompt",
  );
  assert.equal(
    model["id"],
    modelId(live),
    "Use an exact model ID, not a fuzzy pattern or thinking suffix",
  );
  assert.equal(state["isStreaming"], false, "pi is still streaming");
  assert.equal(state["isCompacting"], false, "pi is still compacting");
  assert(typeof state["sessionId"] === "string", "pi returned no session ID");
  assert(
    typeof state["sessionFile"] === "string",
    "pi returned no session file",
  );
  return state;
}

export async function until(
  predicate: () => boolean,
  rpc: PiRpc,
  options: LifecycleOptions,
  description: string,
): Promise<void> {
  const timeout = options.timeoutMs ?? 120_000;
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    options.signal?.throwIfAborted();
    assert(!rpc.exited, `pi exited while waiting for ${description}`);
    assert(
      performance.now() < deadline,
      `Timed out after ${timeout}ms waiting for ${description}`,
    );
    await delay(5);
  }
  options.signal?.throwIfAborted();
}

function hasSettled(records: readonly WireRecord[]): boolean {
  return records.some((record) => record["type"] === "agent_settled");
}

function textDelta(record: WireRecord): boolean {
  const event = object(record["assistantMessageEvent"]);
  return (
    record["type"] === "message_update" &&
    event["type"] === "text_delta" &&
    typeof event["delta"] === "string" &&
    event["delta"] !== ""
  );
}

function toolRunning(record: WireRecord): boolean {
  const content = object(record["partialResult"])["content"];
  return (
    record["type"] === "tool_execution_update" &&
    record["toolName"] === WAIT_TOOL &&
    Array.isArray(content) &&
    content.some((part: unknown) => object(part)["text"] === WAIT_STARTED)
  );
}

export function observation(
  recording: Recording,
  start: number,
): TurnObservation {
  const records = recording.records.slice(start);
  return {
    recordStart: start,
    recordEnd: recording.records.length,
    events: records
      .filter((r) => r["type"] !== "response")
      .map((r) => {
        const nested = object(r["assistantMessageEvent"])["type"];
        return typeof nested === "string"
          ? `${String(r["type"])}:${nested}`
          : String(r["type"]);
      }),
    stopReasons: records
      .filter(
        (r) =>
          r["type"] === "message_end" &&
          object(r["message"])["role"] === "assistant",
      )
      .map((r) => String(object(r["message"])["stopReason"])),
    settledCount: records.filter((r) => r["type"] === "agent_settled").length,
  };
}

async function turn(
  scenario: Scenario,
  message: string,
  rpc: PiRpc,
  recording: Recording,
  options: LifecycleOptions,
  env: Env,
): Promise<TurnObservation> {
  await checkedState(rpc, env);
  assert(
    !recording.malformed,
    "pi wrote malformed stdout; inspect the raw capture",
  );
  const start = recording.records.length;
  const records = () => recording.records.slice(start);
  const accepted = object(await rpc.request("prompt", { message }));
  assert(
    accepted["disposition"] === undefined ||
      accepted["disposition"] === "started",
    "Prompt did not start a run",
  );
  if (scenario !== "stream") {
    const trigger = scenario === "abort-tool" ? toolRunning : textDelta;
    await until(
      () => records().some(trigger),
      rpc,
      options,
      `${scenario} trigger`,
    );
    // Fast completion is not a successful mid-turn abort/kill observation.
    const stillRunning = () => {
      assert(
        !hasSettled(records()),
        "Turn settled before the abort/kill could be sent",
      );
      if (scenario === "abort-tool") {
        assert(
          !records().some(
            (r) =>
              r["type"] === "tool_execution_end" && r["toolName"] === WAIT_TOOL,
          ),
          "Wait tool already completed",
        );
      } else {
        assert(
          !records().some(
            (r) =>
              r["type"] === "message_end" &&
              object(r["message"])["role"] === "assistant",
          ),
          "Text already completed",
        );
      }
    };
    stillRunning();
    if (scenario === "kill-text") {
      recording.child?.kill("SIGKILL");
      await until(() => rpc.exited, rpc, options, "SIGKILL exit");
      assert.equal(rpc.exitInfo?.signal, "SIGKILL");
      assert(
        !hasSettled(records()),
        "A killed pi unexpectedly wrote agent_settled; inspect the recording",
      );
      return observation(recording, start);
    }
    await rpc.request("clear_queue");
    stillRunning();
    await rpc.request("abort", {}, { timeoutMs: options.timeoutMs ?? 120_000 });
  }
  await until(() => hasSettled(records()), rpc, options, "agent_settled");
  await checkedState(rpc, env);
  assert(
    !recording.malformed,
    "pi wrote malformed stdout; inspect the raw capture",
  );
  const result = observation(recording, start);
  assert.equal(result.settledCount, 1, "Expected exactly one agent_settled");
  const end = result.events.lastIndexOf("agent_end");
  const settled = result.events.indexOf("agent_settled");
  assert(end >= 0 && end < settled, "agent_end must precede agent_settled");
  assert(
    !result.events
      .slice(settled + 1)
      .some((type) => /^(agent_|turn_|message_|tool_execution_)/u.test(type)),
    "Run events arrived after agent_settled",
  );
  if (scenario === "stream") {
    assert(
      records().some(textDelta),
      "The normal turn produced no text deltas",
    );
    assert.equal(
      result.stopReasons.at(-1),
      "stop",
      "The normal turn did not complete successfully",
    );
  }
  return result;
}

export async function recordRpcLifecycle(
  options: LifecycleOptions,
): Promise<LifecycleReport> {
  const env = options.env ?? process.env;
  const live = assertLiveAllowed(env);
  options.signal?.throwIfAborted();
  const childEnv = Object.fromEntries(
    Object.entries(env).filter(
      (pair): pair is [string, string] => pair[1] !== undefined,
    ),
  );
  const bin = env["PREFAIX_AGENT_PI_BIN"] ?? "pi";
  const dir = resolve(options.recordDir);
  mkdirSync(dirname(dir), { recursive: true });
  // Never overwrite previous evidence, even when a previous run failed.
  mkdirSync(dir, { mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "pfx-s1-"));
  const report: LifecycleReport = {
    format: "prefaix-s1-report",
    source: options.spawn === undefined ? "live" : "synthetic",
    provider: live.provider,
    model: live.model,
    piVersion: options.piVersion ?? "unknown",
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    recordedAt: new Date().toISOString(),
    status: "failed",
    scenarios: [],
    retriesObserved: 0,
    compactionsObserved: 0,
  };
  let active: PiChild | undefined;
  const interrupt = () => active?.kill("SIGKILL");
  options.signal?.addEventListener("abort", interrupt, { once: true });
  try {
    const version =
      options.piVersion ??
      execFileSync(bin, ["--version", ...ISOLATION_ARGS, ...live.args], {
        env: childEnv,
        timeout: 10_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    // The version is captured before any protocol child or model request.
    report.piVersion = version;
    for (const scenario of [
      "stream",
      "abort-text",
      "abort-tool",
      "kill-text",
    ] as const) {
      options.signal?.throwIfAborted();
      const recording = new Recording(dir, scenario, report);
      const result: ScenarioObservation = { scenario, turns: [] };
      report.scenarios.push(result);
      const args = [
        "--mode",
        "rpc",
        ...ISOLATION_ARGS,
        "--session-dir",
        join(dir, "sessions"),
        "--thinking",
        "off",
        ...live.args,
        ...(scenario === "abort-tool"
          ? [
              "-e",
              fileURLToPath(new URL("./rpc-wait-tool.ts", import.meta.url)),
              "--tools",
              WAIT_TOOL,
            ]
          : ["--no-tools"]),
      ];
      const wrappedSpawn = recording.wrap(options.spawn ?? spawnRpcProcess);
      const rpc = new PiRpc({
        bin,
        args,
        cwd: workspace,
        env: childEnv,
        readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
        termGraceMs: options.shutdownGraceMs ?? 3_000,
        killGraceMs: options.shutdownGraceMs ?? 5_000,
        spawn: (childBin, childArgs, childOptions) => {
          const child = wrappedSpawn(childBin, childArgs, childOptions);
          active = child;
          return child;
        },
      });
      try {
        await rpc.waitReady();
        const state = await checkedState(rpc, env);
        result.sessionId = String(state["sessionId"]);
        result.sessionFile = String(state["sessionFile"]);
        const message =
          scenario === "stream"
            ? `Remember the code ${CONTINUITY_CODE}. Reply with that code and one short greeting sentence. Do not use tools.`
            : scenario === "abort-tool"
              ? `Call ${WAIT_TOOL} exactly once with no arguments, then say done. Do not answer without calling the tool.`
              : LONG_PROMPT;
        result.turns.push(
          await turn(scenario, message, rpc, recording, options, env),
        );
        if (scenario === "stream") {
          const second = await turn(
            scenario,
            "What code did I ask you to remember? Reply with that code only.",
            rpc,
            recording,
            options,
            env,
          );
          result.turns.push(second);
          const lastText = object(await rpc.request("get_last_assistant_text"))[
            "text"
          ];
          assert(
            typeof lastText === "string" && lastText.includes(CONTINUITY_CODE),
            "The second turn did not remember the first",
          );
          const continued = await checkedState(rpc, env);
          assert.equal(
            continued["sessionId"],
            result.sessionId,
            "The session ID changed between turns",
          );
          assert.equal(
            continued["sessionFile"],
            result.sessionFile,
            "The native session file changed between turns",
          );
        }
      } finally {
        result.shutdown = await rpc.close();
        active = undefined;
        report.retriesObserved += recording.records.filter(
          (r) => r["type"] === "auto_retry_start",
        ).length;
        report.compactionsObserved += recording.records.filter(
          (r) => r["type"] === "compaction_start",
        ).length;
      }
      assert(
        !recording.malformed,
        "pi wrote malformed or unterminated stdout; inspect the raw capture",
      );
      if (scenario !== "kill-text") {
        assert.equal(
          result.shutdown.escalatedTo,
          "stdin",
          "Closing stdin needed signal escalation",
        );
        assert.deepEqual(
          result.shutdown.exit,
          { code: 0, signal: null },
          "stdin close did not exit cleanly",
        );
      }
    }
    options.signal?.throwIfAborted();
    report.status = "passed";
    return report;
  } catch (cause) {
    report.error = String(
      options.signal?.aborted ? options.signal.reason : cause,
    );
    throw cause;
  } finally {
    options.signal?.removeEventListener("abort", interrupt);
    rmSync(workspace, { recursive: true, force: true });
    writeFileSync(
      join(dir, "summary.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
}

export async function rpcLiveMain(
  argv: readonly string[],
  env: Env = process.env,
): Promise<void> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(
      "Usage: bun run spike:rpc-live [--record <new-directory>]\nRequires PREFAIX_LIVE_PROVIDER and PREFAIX_LIVE_MODEL. Sends five prompts; records stay private until reviewed.",
    );
    return;
  }
  assert(
    argv.length === 0 ||
      (argv.length === 2 &&
        argv[0] === "--record" &&
        argv[1] !== "" &&
        !argv[1]?.startsWith("--")),
    "Usage: bun run spike:rpc-live [--record <new-directory>]",
  );
  const recordDir = argv[1] ?? join("build", "spikes", `S1-${Date.now()}`);
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("S1 recorder interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await recordRpcLifecycle({ recordDir, env, signal: controller.signal });
    console.log(
      `S1 lifecycle recordings written to ${resolve(recordDir)}. Retry/compaction coverage must be reviewed separately.`,
    );
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  rpcLiveMain(process.argv.slice(2)).catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
