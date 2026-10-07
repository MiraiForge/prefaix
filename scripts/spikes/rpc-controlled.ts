// Actual pi RPC events with a loopback-only API, not synthetic wire events.
// No credential access or remote model requests. Keep this evidence separate
// from the live Kimi captures: HTTP failures, replies, and usage are scripted.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PiRpc, type PiChild } from "../../src/agents/pi/rpc.js";
import { assertLiveAllowed, type Env } from "../live-guard.js";
import {
  checkedState,
  ISOLATION_ARGS,
  object,
  observation,
  Recording,
  spawnRpcProcess,
  until,
  type LifecycleOptions,
} from "./rpc-live.js";

export const CONTROLLED_CASES = [
  "retry-success",
  "retry-exhausted",
  "retry-abort",
  "compact-threshold",
  "compact-overflow",
  "compact-manual",
] as const;
export type ControlledCase = (typeof CONTROLLED_CASES)[number];
const DUMMY_KEY = "prefaix-s1-loopback-dummy-not-a-credential";
const SEED =
  "Remember this harmless counting exercise. " +
  "one two three four five. ".repeat(40);

function sse(text: string, input: number): string {
  const events = [
    {
      type: "message_start",
      message: {
        id: "local-message",
        type: "message",
        role: "assistant",
        model: "k3",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: input, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  ];
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

/** No forwarding path exists; unexpected methods, paths, or models fail closed. */
export async function startLocalApi(scenario: ControlledCase) {
  let requests = 0;
  let problem: string | undefined;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(
        new URL(request.url ?? "/", "http://127.0.0.1").pathname,
        "/v1/messages",
      );
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
        assert(body.length <= 1_048_576, "Local probe request too large");
      }
      assert.equal(object(JSON.parse(body))["model"], "k3");
      assert(++requests <= 8, "Local probe request budget exceeded");
      const transient =
        scenario.startsWith("retry-") &&
        (scenario !== "retry-success" || requests === 1);
      const overflow = scenario === "compact-overflow" && requests === 2;
      if (transient || overflow) {
        response.writeHead(transient ? 503 : 400, {
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            type: "error",
            error: {
              type: transient ? "overloaded_error" : "invalid_request_error",
              message: transient
                ? "S1 controlled 503 overloaded"
                : "prompt is too long: 5000 tokens > 4096 maximum",
            },
          }),
        );
        return;
      }
      const input =
        scenario === "compact-threshold" && requests === 1 ? 3500 : 64;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse(`S1 controlled ${scenario} response ${requests}.`, input),
      );
    } catch {
      // Never put request bodies or headers into diagnostics.
      problem = "Local probe refused an unexpected request";
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: problem } }));
    }
  });
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", fail);
      done();
    });
  });
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    get requests() {
      return requests;
    },
    get problem() {
      return problem;
    },
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}

export async function recordRpcControlled(options: LifecycleOptions) {
  const env = options.env ?? process.env;
  const live = assertLiveAllowed(env);
  assert(
    live.provider === "kimi-coding" && live.model === "kimi-coding/k3",
    "The loopback API probe supports the exact kimi-coding/k3 selection only",
  );
  options.signal?.throwIfAborted();
  const dir = resolve(options.recordDir);
  mkdirSync(dirname(dir), { recursive: true });
  mkdirSync(dir, { mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "pfx-s1-controlled-"));
  const bin = env["PREFAIX_AGENT_PI_BIN"] ?? "pi";
  // Do not inherit API keys, auth profiles, proxies, NODE_OPTIONS, or OP_*.
  const childEnv: NodeJS.ProcessEnv = {
    PATH: env["PATH"] ?? process.env["PATH"],
    HOME: workspace,
    PI_OFFLINE: "1",
    KIMI_API_KEY: DUMMY_KEY,
  };
  const report = {
    format: "prefaix-s1-controlled-report",
    source:
      options.spawn === undefined
        ? ("controlled" as const)
        : ("synthetic" as const),
    provider: live.provider,
    model: live.model,
    piVersion: options.piVersion ?? "unknown",
    recordedAt: new Date().toISOString(),
    stimulus: {
      api: "loopback-stub",
      remoteModelRequests: 0,
      scriptedUsage: true,
      contextWindow: 4096,
      reserveTokens: 2048,
      keepRecentTokens: 0,
      maxTokens: 512,
      agentRetries: 1,
      providerRetries: 0,
    },
    status: "failed",
    error: undefined as string | undefined,
    scenarios: [] as {
      scenario: ControlledCase;
      turns: ReturnType<typeof observation>[];
      apiRequests: number;
    }[],
  };
  let active: PiChild | undefined;
  const interrupt = () => active?.kill("SIGKILL");
  options.signal?.addEventListener("abort", interrupt, { once: true });
  try {
    report.piVersion =
      options.piVersion ??
      execFileSync(bin, ["--version", ...ISOLATION_ARGS, ...live.args], {
        env: childEnv,
        timeout: 10_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    for (const scenario of CONTROLLED_CASES) {
      options.signal?.throwIfAborted();
      const api = await startLocalApi(scenario);
      const result = {
        scenario,
        turns: [] as ReturnType<typeof observation>[],
        apiRequests: 0,
      };
      report.scenarios.push(result);
      try {
        const profile = join(workspace, scenario);
        mkdirSync(profile, { mode: 0o700 });
        writeFileSync(
          join(profile, "models.json"),
          JSON.stringify({
            providers: {
              "kimi-coding": {
                baseUrl: api.baseUrl,
                apiKey: DUMMY_KEY,
                modelOverrides: {
                  k3: {
                    contextWindow: 4096,
                    maxTokens: 512,
                    reasoning: false,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                },
              },
            },
          }),
          { mode: 0o600 },
        );
        writeFileSync(
          join(profile, "settings.json"),
          JSON.stringify({
            compaction: {
              enabled: !scenario.startsWith("retry-"),
              reserveTokens: 2048,
              keepRecentTokens: 0,
            },
            retry: {
              enabled: true,
              maxRetries: 1,
              baseDelayMs: scenario === "retry-abort" ? 30_000 : 20,
              provider: { maxRetries: 0 },
            },
            cacheWarming: "off",
            enableInstallTelemetry: false,
          }),
          { mode: 0o600 },
        );
        const recording = new Recording(dir, scenario, report);
        const rpc = new PiRpc({
          bin,
          args: [
            "--mode",
            "rpc",
            ...ISOLATION_ARGS,
            "--no-tools",
            "--session-dir",
            join(dir, "sessions"),
            "--thinking",
            "off",
            ...live.args,
          ],
          cwd: workspace,
          env: { ...childEnv, PI_CODING_AGENT_DIR: profile },
          readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
          termGraceMs: options.shutdownGraceMs ?? 3_000,
          killGraceMs: options.shutdownGraceMs ?? 5_000,
          spawn: recording.wrap((childBin, args, childOptions) => {
            active = (options.spawn ?? spawnRpcProcess)(
              childBin,
              args,
              childOptions,
            );
            return active;
          }),
        });
        try {
          await rpc.waitReady();
          const check = async () => {
            const state = await checkedState(rpc, env);
            assert.equal(
              object(state["model"])["baseUrl"],
              api.baseUrl,
              "Refusing a non-loopback model endpoint",
            );
          };
          const prompt = async (message: string, abortRetry = false) => {
            await check();
            const start = recording.records.length;
            await rpc.request("prompt", { message });
            const records = () => recording.records.slice(start);
            if (abortRetry) {
              await until(
                () => records().some((r) => r["type"] === "auto_retry_start"),
                rpc,
                options,
                "retry delay",
              );
              assert(
                !records().some((r) => r["type"] === "agent_settled"),
                "Retry settled before abort",
              );
              await rpc.request("clear_queue");
              await rpc.request(
                "abort",
                {},
                { timeoutMs: options.timeoutMs ?? 60_000 },
              );
            }
            await until(
              () => records().some((r) => r["type"] === "agent_settled"),
              rpc,
              options,
              "controlled settlement",
            );
            await check();
            const seen = observation(recording, start);
            assert.equal(seen.settledCount, 1);
            assert.equal(seen.events.at(-1), "agent_settled");
            result.turns.push(seen);
          };
          await prompt(SEED, scenario === "retry-abort");
          if (
            scenario === "compact-overflow" ||
            scenario === "compact-threshold"
          )
            await prompt("Continue the harmless counting exercise.");
          if (scenario === "compact-manual") {
            await check();
            await rpc.request(
              "compact",
              {},
              { timeoutMs: options.timeoutMs ?? 60_000 },
            );
            await check();
          }
          const records = recording.records;
          if (scenario.startsWith("retry-")) {
            assert(records.some((r) => r["type"] === "auto_retry_start"));
            const end = records.find((r) => r["type"] === "auto_retry_end");
            assert.equal(end?.["success"], scenario === "retry-success");
            assert.equal(
              result.turns[0]?.stopReasons.at(-1),
              scenario === "retry-success" ? "stop" : "error",
            );
          } else {
            const reason = scenario.slice("compact-".length);
            assert(
              records.some(
                (r) =>
                  r["type"] === "compaction_start" && r["reason"] === reason,
              ),
            );
            const end = records.find(
              (r) => r["type"] === "compaction_end" && r["reason"] === reason,
            );
            assert.equal(end?.["aborted"], false);
            assert.equal(end?.["willRetry"], scenario === "compact-overflow");
            assert(
              object(end?.["result"])["summary"],
              "Compaction produced no summary",
            );
            assert.equal(result.turns.at(-1)?.stopReasons.at(-1), "stop");
          }
          assert.equal(api.problem, undefined);
          assert(!recording.malformed, "Malformed native stdout");
        } finally {
          const shutdown = await rpc.close();
          assert(
            !recording.malformed,
            "Malformed native stdout after shutdown",
          );
          assert.equal(shutdown.escalatedTo, "stdin");
          assert.deepEqual(shutdown.exit, { code: 0, signal: null });
        }
      } finally {
        active = undefined;
        result.apiRequests = api.requests;
        await api.close();
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

export async function rpcControlledMain(
  argv: readonly string[],
  env: Env = process.env,
): Promise<void> {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(
      "Usage: bun run spike:rpc-controlled [--record <new-directory>]\nRequires explicit kimi-coding/k3 selection. Loopback-only: no real credentials or remote model requests.",
    );
    return;
  }
  assert(
    argv.length === 0 ||
      (argv.length === 2 &&
        argv[0] === "--record" &&
        argv[1] !== "" &&
        !argv[1]?.startsWith("--")),
    "Usage: bun run spike:rpc-controlled [--record <new-directory>]",
  );
  const controller = new AbortController();
  const interrupt = () =>
    controller.abort(new Error("S1 controlled probe interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    await recordRpcControlled({
      recordDir:
        argv[1] ?? join("build", "spikes", `S1-controlled-${Date.now()}`),
      env,
      signal: controller.signal,
    });
    console.log(
      "S1 native retry/compaction evidence recorded (controlled loopback API; zero remote model requests).",
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
  rpcControlledMain(process.argv.slice(2)).catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
}
