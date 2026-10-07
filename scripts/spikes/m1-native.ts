// S2/S3/S9: real installed pi, isolated profiles and a loopback-only API.
// Replies/usage/tool choices are SCRIPTED; never natural-provider evidence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { PiRpc } from "../../src/agents/pi/rpc.js";
import { PiSession } from "../../src/agents/pi/adapter.js";
import {
  BRIDGE_VERSION,
  turnContextFile,
  writeTurnContext,
} from "../../src/agents/pi/bridge-context.js";
import type { PersonaSpec, ShellContext } from "../../src/core/agent-port.js";
import { assertLiveAllowed, type Env } from "../live-guard.js";
import {
  checkedState,
  ISOLATION_ARGS,
  object,
  observation,
  Recording,
  spawnRpcProcess,
} from "./rpc-live.js";

type RecordValue = Record<string, unknown>;
type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: RecordValue };
const DUMMY = "prefaix-m1-loopback-dummy-not-a-credential";
export function encodeReply(blocks: readonly Block[]): string {
  const events: RecordValue[] = [
    {
      type: "message_start",
      message: {
        id: "local-m1-message",
        type: "message",
        role: "assistant",
        model: "k3",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 64, output_tokens: 0 },
      },
    },
  ];
  blocks.forEach((block, index) => {
    events.push({
      type: "content_block_start",
      index,
      content_block:
        block.type === "text"
          ? { type: "text", text: "" }
          : { ...block, input: {} },
    });
    events.push({
      type: "content_block_delta",
      index,
      delta:
        block.type === "text"
          ? { type: "text_delta", text: block.text }
          : {
              type: "input_json_delta",
              partial_json: JSON.stringify(block.input),
            },
    });
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: blocks.some((b) => b.type === "tool_use")
          ? "tool_use"
          : "end_turn",
        stop_sequence: null,
      },
      usage: { output_tokens: 8 },
    },
    { type: "message_stop" },
  );
  return events
    .map((e) => `event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
}
export async function nativeApi(
  reply: (body: RecordValue, ordinal: number) => readonly Block[],
) {
  const bodies: RecordValue[] = [];
  let problem: string | undefined;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST");
      assert.equal(
        new URL(req.url ?? "/", "http://127.0.0.1").pathname,
        "/v1/messages",
      );
      let raw = "";
      for await (const chunk of req) {
        raw += String(chunk);
        assert(raw.length < 1_048_576);
      }
      const body = object(JSON.parse(raw));
      assert.equal(body["model"], "k3");
      assert(bodies.length < 25, "Loopback request budget exceeded");
      bodies.push(body);
      const blocks = reply(body, bodies.length);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(encodeReply(blocks));
    } catch {
      problem = "Loopback stub refused an unexpected request";
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: problem } }));
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
    bodies,
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
export function profileFiles(baseUrl: string) {
  assert(/^http:\/\/127\.0\.0\.1:\d+$/u.test(baseUrl));
  return {
    "models.json": {
      providers: {
        "kimi-coding": {
          baseUrl,
          apiKey: DUMMY,
          modelOverrides: {
            k3: {
              reasoning: false,
              maxTokens: 512,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          },
        },
      },
    },
    "settings.json": {
      compaction: { enabled: false },
      retry: { enabled: false, provider: { maxRetries: 0 } },
      cacheWarming: "off",
      enableInstallTelemetry: false,
      enableAnalytics: false,
      defaultProjectTrust: "never",
    },
  };
}
function transcript(path: string): RecordValue[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => object(JSON.parse(line)));
}
const text = (value: string): Block[] => [{ type: "text", text: value }];
const names = (body: RecordValue): string[] =>
  ((body["tools"] as RecordValue[]) ?? []).map((t) => String(t["name"])).sort();
const rss = (pid: number): number =>
  Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim(),
  ) * 1024;

export async function recordNativeM1(
  dir: string,
  samples = 20,
  env: Env = process.env,
) {
  const live = assertLiveAllowed(env);
  assert.equal(live.provider, "kimi-coding");
  assert.equal(live.model, "kimi-coding/k3");
  assert(Number.isSafeInteger(samples) && samples >= 2 && samples <= 100);
  assert(
    ["linux", "darwin"].includes(process.platform),
    "RSS probe requires native ps",
  );
  dir = resolve(dir);
  mkdirSync(dir, { mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "pfx-m1-native-"));
  const bin = env["PREFAIX_AGENT_PI_BIN"] ?? "pi";
  const baseEnv = {
    PATH: env["PATH"] ?? process.env["PATH"] ?? "",
    HOME: workspace,
    KIMI_API_KEY: DUMMY,
  };
  const piVersion = execFileSync(
    bin,
    ["--version", ...ISOLATION_ARGS, ...live.args],
    {
      env: { ...baseEnv, PI_OFFLINE: "1" },
      timeout: 10000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  const report = {
    format: "prefaix-m1-native-report",
    source: "controlled",
    provider: live.provider,
    model: live.model,
    piVersion,
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    driver: process.version,
    samples,
    remoteModelRequests: 0,
    status: "failed",
    error: undefined as string | undefined,
    s2: {} as RecordValue,
    s3: {} as RecordValue,
    s9: {} as RecordValue,
  };
  const info = {
    source: "controlled" as const,
    provider: live.provider,
    model: live.model,
    piVersion,
    recordedAt: report.recordedAt,
    stimulus: {
      api: "loopback-stub",
      remoteModelRequests: 0,
      scriptedUsage: true,
    },
  };
  let counter = 0;
  const open = async (
    name: string,
    api: Awaited<ReturnType<typeof nativeApi>>,
    opts: {
      cwd?: string;
      resume?: string;
      bridge?: boolean;
      offline?: boolean;
    } = {},
  ) => {
    const profile = join(workspace, `profile-${++counter}`);
    mkdirSync(profile, { mode: 0o700 });
    for (const [name, data] of Object.entries(profileFiles(api.baseUrl))) {
      writeFileSync(join(profile, name), JSON.stringify(data), { mode: 0o600 });
    }
    const turns = join(profile, "turns");
    mkdirSync(turns, { mode: 0o700 });
    const recording = new Recording(dir, name, info);
    const started = performance.now();
    const rpc = new PiRpc({
      bin,
      args: [
        "--mode",
        "rpc",
        ...ISOLATION_ARGS.filter(
          (a) => opts.offline !== false || a !== "--offline",
        ),
        "--tools",
        "read,bash",
        "--session-dir",
        join(dir, "sessions"),
        "--thinking",
        "off",
        ...live.args,
        ...(opts.resume === undefined ? [] : ["--session", opts.resume]),
        ...(opts.bridge === true
          ? [
              "-e",
              resolve("dist/pi-bridge.js"),
              "-e",
              resolve("scripts/spikes/rpc-ui.ts"),
            ]
          : []),
      ],
      cwd: opts.cwd ?? workspace,
      env: {
        ...baseEnv,
        PI_CODING_AGENT_DIR: profile,
        ...(opts.offline === false ? {} : { PI_OFFLINE: "1" }),
        PREFAIX_BRIDGE_DIR: turns,
      },
      readyTimeoutMs: 30000,
      requestTimeoutMs: 30000,
      spawn: recording.wrap(spawnRpcProcess),
    });
    try {
      await rpc.waitReady();
    } catch (cause) {
      await rpc.close();
      throw cause;
    }
    const readyMs = performance.now() - started;
    const check = async () => {
      const state = await checkedState(rpc, env);
      assert.equal(
        object(state["model"])["baseUrl"],
        api.baseUrl,
        "Refuse a non-loopback endpoint",
      );
      return state;
    };
    const close = async () => {
      const result = await rpc.close();
      assert.equal(result.escalatedTo, "stdin");
      assert.deepEqual(result.exit, { code: 0, signal: null });
      assert(!recording.malformed);
      assert.equal(readFileSync(join(dir, name + ".stderr.log"), "utf8"), "");
      assert.equal(api.problem, undefined);
    };
    return {
      rpc,
      recording,
      turns,
      cwd: opts.cwd ?? workspace,
      readyMs,
      check,
      close,
    };
  };
  type Child = Awaited<ReturnType<typeof open>>;
  const prompt = async (
    child: Child,
    message: string,
    persona?: PersonaSpec,
  ) => {
    await child.check();
    {
      const context: ShellContext = {
        shell: { kind: "zsh", version: "probe", shellId: "probe", pid: 1 },
        cwd: child.cwd,
        recent: [],
        os: process.platform,
        term: { cols: 80, rows: 24, colors: 256 },
      };
      writeTurnContext(turnContextFile(child.turns, child.rpc.pid!), {
        version: BRIDGE_VERSION,
        context,
        ...(persona === undefined ? {} : { persona }),
      });
    }
    const start = child.recording.records.length;
    // A before_agent_start dialog may block the prompt acknowledgment itself.
    const accepted = child.rpc.request("prompt", { message });
    let acceptanceError: unknown;
    void accepted.catch((cause) => {
      acceptanceError = cause;
    });
    const answered = new Set<string>();
    const deadline = performance.now() + 30000;
    while (
      !child.recording.records
        .slice(start)
        .some((r) => r["type"] === "agent_settled")
    ) {
      if (acceptanceError !== undefined) throw acceptanceError;
      assert(!child.rpc.exited);
      assert(performance.now() < deadline, "Native prompt deadline");
      for (const r of child.recording.records.slice(start)) {
        if (r["type"] !== "extension_ui_request" || r["method"] !== "select")
          continue;
        const id = String(r["id"]);
        if (answered.has(id)) continue;
        answered.add(id);
        child.rpc.writeRaw(
          JSON.stringify({ type: "extension_ui_response", id, value: "main" }),
        );
      }
      await delay(5);
    }
    await accepted;
    const seen = observation(child.recording, start);
    assert.equal(seen.settledCount, 1);
    assert.equal(seen.stopReasons.at(-1), "stop");
    await child.check();
    return seen;
  };
  try {
    const api = await nativeApi(() => text("S2 scripted reply."));
    try {
      const measurements: RecordValue[] = [];
      for (let sample = 0; sample < samples; sample++) {
        for (const variant of sample % 2 === 0
          ? ["offline", "metadata-online", "bridge"]
          : ["bridge", "metadata-online", "offline"]) {
          const child = await open(`pool-${sample}-${variant}`, api, {
            offline: variant !== "metadata-online",
            bridge: variant === "bridge",
          });
          try {
            measurements.push({
              sample,
              variant,
              readyMs: child.readyMs,
              idleRssBytes: rss(child.rpc.pid!),
            });
          } finally {
            await child.close();
          }
        }
      }
      const spare = await open("pool-adoption", api);
      try {
        const before = await spare.check();
        const idleRssBytes = rss(spare.rpc.pid!);
        await spare.rpc.request("set_session_name", {
          name: "S2 adopted spare",
        });
        await spare.rpc.request("set_model", {
          provider: live.provider,
          modelId: "k3",
        });
        await spare.rpc.request("set_thinking_level", { level: "off" });
        const turn = await prompt(spare, "S2 harmless turn.");
        const after = await spare.check();
        assert.equal(before["sessionId"], after["sessionId"]);
        assert.equal(before["sessionFile"], after["sessionFile"]);
        assert.equal(after["sessionName"], "S2 adopted spare");
        assert.equal(
          transcript(String(after["sessionFile"])).filter(
            (r) => object(r["message"])["role"] === "user",
          ).length,
          1,
        );
        report.s2 = {
          measurements,
          adoption: {
            samePid: true,
            sameSessionId: true,
            sameSessionFile: true,
            idleRssBytes,
            afterTurnRssBytes: rss(spare.rpc.pid!),
            turn,
          },
          apiRequests: api.bodies.length,
        };
      } finally {
        await spare.close();
      }
    } finally {
      await api.close();
    }
    const a = join(workspace, "A"),
      b = join(workspace, "B");
    for (const [cwd, sentinel] of [
      [a, "S3_FROM_A"],
      [b, "S3_FROM_B"],
    ]) {
      mkdirSync(cwd!, { mode: 0o700 });
      writeFileSync(join(cwd!, "relative.txt"), sentinel!, { mode: 0o600 });
    }
    const cwdApi = await nativeApi((_body, ordinal) =>
      ordinal === 2
        ? [
            {
              type: "tool_use",
              id: "local-pwd",
              name: "bash",
              input: { command: "pwd" },
            },
            {
              type: "tool_use",
              id: "local-read",
              name: "read",
              input: { path: "relative.txt" },
            },
          ]
        : text("S3 scripted continuation."),
    );
    try {
      const seed = await open("cwd-A", cwdApi, { cwd: a });
      let seedState: RecordValue;
      try {
        await prompt(seed, "S3 seed in A.");
        seedState = await seed.check();
      } finally {
        await seed.close();
      }
      const resumed = await open("cwd-B", cwdApi, {
        cwd: b,
        resume: String(seedState["sessionFile"]),
      });
      try {
        const state = await resumed.check();
        assert.equal(state["sessionId"], seedState["sessionId"]);
        assert.equal(state["sessionFile"], seedState["sessionFile"]);
        const turn = await prompt(resumed, "S3 inspect cwd and relative file.");
        const results = resumed.recording.records.filter(
          (r) => r["type"] === "tool_execution_end",
        );
        assert.equal(results.length, 2);
        assert(results.every((r) => r["isError"] === false));
        const output = (name: string) =>
          JSON.stringify(
            results.find((r) => r["toolName"] === name)?.["result"],
          );
        // Native pi 1.0.4 restores the session header cwd, NOT launch cwd.
        // A negative result is spike evidence, not something to conceal.
        assert(
          output("bash").includes(a),
          "Revisit S3: native cwd behavior changed",
        );
        assert(output("read").includes("S3_FROM_A"));
        assert(!output("read").includes("S3_FROM_B"));
        const records = transcript(String(state["sessionFile"]));
        const systems = records.filter(
          (r) => object(r["message"])["role"] === "system",
        );
        assert(JSON.stringify(systems.at(-1)).includes(a));
        assert(JSON.stringify(cwdApi.bodies[1]).includes("S3 seed in A."));
        report.s3 = {
          sameSessionId: true,
          sameSessionFile: true,
          historyPreserved: true,
          bashCwd: "A",
          relativeRead: "S3_FROM_A",
          latestCwdSection: "A",
          decision: "split",
          originalHeaderCwd: object(records[0])["cwd"] === a ? "A" : "other",
          apiRequests: cwdApi.bodies.length,
          turn,
        };
      } finally {
        await resumed.close();
      }
    } finally {
      await cwdApi.close();
    }
    const bridgeApi = await nativeApi(() =>
      text("S9 scripted native bridge answer."),
    );
    try {
      const child = await open("bridge", bridgeApi, { bridge: true });
      try {
        const pid = child.rpc.pid!;
        const turns = [];
        turns.push(
          await prompt(child, "S9 ask.", { name: "ask", tools: ["read"] }),
        );
        assert.deepEqual(names(bridgeApi.bodies[0]!), ["read"]);
        turns.push(
          await prompt(child, "S9 plan.", {
            name: "plan",
            tools: ["bash", "read"],
          }),
        );
        assert.deepEqual(names(bridgeApi.bodies[1]!), ["bash", "read"]);
        turns.push(await prompt(child, "S9 default."));
        assert.deepEqual(names(bridgeApi.bodies[2]!), ["bash", "read"]);
        const dialog = await prompt(child, "S9 DIALOG");
        turns.push(dialog);
        assert.equal(child.rpc.pid, pid);
        const state = await child.check();
        const records = transcript(String(state["sessionFile"]));
        const users = records.filter(
          (r) => object(r["message"])["role"] === "user",
        );
        assert.deepEqual(
          users.map((r) => object(r["message"])["content"]),
          ["S9 ask.", "S9 plan.", "S9 default.", "S9 DIALOG"].map((t) => [
            { type: "text", text: t },
          ]),
        );
        const systems = records.filter(
          (r) => object(r["message"])["role"] === "system",
        );
        assert(
          systems.some((r) =>
            JSON.stringify(object(r["message"])["sections"]).includes(
              "<prefaix>",
            ),
          ),
        );
        const ui = child.recording.records.filter(
          (r) => r["type"] === "extension_ui_request",
        );
        assert(ui.some((r) => r["method"] === "select"));
        assert(ui.some((r) => r["method"] === "set_editor_text"));
        assert(
          ui.some(
            (r) =>
              r["method"] === "notify" && r["message"] === "S9 selected main",
          ),
        );
        report.s9 = {
          samePid: true,
          userMessagesUnchanged: true,
          toolSets: bridgeApi.bodies.map(names),
          sectionBesidePi: true,
          nativeUiRoundTrip: true,
          apiRequests: bridgeApi.bodies.length,
          turns,
        };
        const summary = {
          ...info,
          format: "prefaix-s9-report",
          status: "passed",
          scenarios: [{ scenario: "bridge", turns: [dialog] }],
        };
        writeFileSync(
          join(dir, "s9-summary.json"),
          JSON.stringify(summary, null, 2) + "\n",
          { mode: 0o600 },
        );
        const verification = await open("bridge-adapter", bridgeApi, {
          bridge: true,
        });
        try {
          const native = await verification.check();
          const session = new PiSession(
            verification.rpc,
            {
              sessionId: String(native["sessionId"]),
              sessionFile: String(native["sessionFile"]),
            },
            {},
            {
              bin,
              root: workspace,
              turnsDir: verification.turns,
              pid: verification.rpc.pid!,
            },
          );
          assert(
            session.probeBridge({ bridgePath: resolve("dist/pi-bridge.js") }),
          );
          const events = [];
          await verification.check();
          for await (const event of session.prompt(
            {
              text: "S9 DIALOG",
              context: {
                shell: {
                  kind: "zsh",
                  version: "probe",
                  shellId: "probe",
                  pid: 1,
                },
                cwd: workspace,
                recent: [],
                os: process.platform,
                term: { cols: 80, rows: 24, colors: 256 },
              },
            },
            new AbortController().signal,
          )) {
            events.push(event);
            if (event.type === "ui_request")
              session.respondUi(event.id, { value: "main" });
          }
          assert.equal(events.filter((e) => e.type === "settled").length, 1);
          assert.deepEqual(events.at(-1), {
            type: "settled",
            stopReason: "stop",
          });
          assert(events.some((e) => e.type === "set_buffer"));
          report.s9["adapterUiRoundTrip"] = true;
          report.s9["apiRequests"] = bridgeApi.bodies.length;
        } finally {
          await verification.close();
        }
      } finally {
        await child.close();
      }
    } finally {
      await bridgeApi.close();
    }
    report.status = "passed";
    return report;
  } catch (cause) {
    report.error = String(cause);
    throw cause;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    writeFileSync(
      join(dir, "summary.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
}
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  recordNativeM1(
    process.argv[2] ?? join("build", "spikes", `M1-native-${Date.now()}`),
    Number(process.argv[3] ?? 20),
  )
    .then(() =>
      console.log(
        "S2/S3/S9 native evidence passed; zero remote model requests.",
      ),
    )
    .catch((cause: unknown) => {
      console.error(String(cause));
      process.exitCode = 1;
    });
}
