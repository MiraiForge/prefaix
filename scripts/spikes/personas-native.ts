// Opt-in M4 persona proof: actual pi/bridge/AgentPool, isolated dummy auth and
// loopback SSE only. Replies and usage are scripted, not live-provider evidence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPiAdapter,
  type PiSession,
} from "../../src/agents/pi/adapter.js";
import { AgentPool } from "../../src/daemon/pool.js";
import { defaultConfig } from "../../src/core/config/schema.js";
import { personaSpec } from "../../src/core/config/index.js";
import { PLAN_EXECUTION_PROMPT } from "../../src/core/protocol.js";
import { assertLiveAllowed, type Env } from "../live-guard.js";
import { nativeApi, profileFiles } from "./m1-native.js";
import {
  ISOLATION_ARGS,
  object,
  Recording,
  spawnRpcProcess,
} from "./rpc-live.js";

/** Native pi transcripts store tool additions/removals as system deltas. */
export function transcriptToolSets(
  records: readonly Record<string, unknown>[],
) {
  const active = new Set<string>();
  const snapshots: string[][] = [];
  for (const record of records) {
    const message = object(record["message"]);
    if (message["role"] === "system") {
      for (const tool of (message["toolsAdded"] as Record<string, unknown>[]) ??
        [])
        active.add(String(tool["name"]));
      for (const tool of (message["toolsRemoved"] as Record<
        string,
        unknown
      >[]) ?? [])
        active.delete(String(tool["name"]));
    }
    if (message["role"] === "user") snapshots.push([...active].sort());
  }
  return snapshots;
}

export async function recordNativePersonas(
  dir: string,
  env: Env = process.env,
) {
  const live = assertLiveAllowed(env);
  assert.equal(live.provider, "kimi-coding");
  assert.equal(live.model, "kimi-coding/k3");
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "pfx-personas-native-"));
  const baseEnv = {
    PATH: env["PATH"] ?? process.env["PATH"] ?? "",
    HOME: workspace,
    PI_OFFLINE: "1",
    KIMI_API_KEY: "prefaix-loopback-dummy",
  };
  const bin = env["PREFAIX_AGENT_PI_BIN"] ?? "pi";
  const piVersion = execFileSync(
    bin,
    ["--version", ...ISOLATION_ARGS, ...live.args],
    {
      env: baseEnv,
      timeout: 10000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  const info = {
    source: "controlled" as const,
    provider: live.provider,
    model: live.model,
    piVersion,
    recordedAt: new Date().toISOString(),
    stimulus: {
      api: "loopback-stub",
      remoteModelRequests: 0,
      scriptedUsage: true,
    },
  };
  const recording = new Recording(dir, "personas", info);
  const api = await nativeApi(() => [
    { type: "text", text: "Scripted persona answer." },
  ]);
  let pool: AgentPool | undefined;
  try {
    const profile = join(workspace, "profile");
    mkdirSync(profile);
    for (const [name, data] of Object.entries(profileFiles(api.baseUrl)))
      writeFileSync(join(profile, name), JSON.stringify(data), { mode: 0o600 });
    const turnsDir = join(workspace, "turns");
    mkdirSync(turnsDir);
    const adapter = createPiAdapter({
      bin,
      provider: live.provider,
      model: live.model,
      bridgePath: resolve("dist/pi-bridge.js"),
      turnsDir,
      rpc: {
        spawn: (binary, args, options) =>
          recording.wrap(spawnRpcProcess)(
            binary,
            [
              ...args,
              ...ISOLATION_ARGS,
              "--thinking",
              "off",
              "--session-dir",
              join(dir, "sessions"),
            ],
            options,
          ),
      },
    });
    pool = new AgentPool({
      backend: adapter,
      config: defaultConfig(),
      spare: false,
    });
    const acquire = (
      id: string,
      persona: Parameters<AgentPool["acquire"]>[0]["persona"],
    ) =>
      pool!.acquire({
        conversationId: id,
        root: workspace,
        env: { ...baseEnv, PI_CODING_AGENT_DIR: profile },
        ...(persona === undefined ? {} : { persona }),
      }) as Promise<PiSession>;
    const prompt = async (
      session: PiSession,
      text: string,
      expectedError?: string,
    ) => {
      assertLiveAllowed(env);
      assert.deepEqual((await session.state()).model, {
        provider: live.provider,
        id: "k3",
      });
      assert(session.bridgeLive);
      const events = [];
      for await (const event of session.prompt(
        {
          text,
          context: {
            shell: { kind: "zsh", version: "probe", shellId: "probe", pid: 1 },
            cwd: workspace,
            recent: [],
            os: process.platform,
            term: { cols: 80, rows: 24, colors: 256 },
          },
        },
        new AbortController().signal,
      ))
        events.push(event);
      assert.equal(events.filter((e) => e.type === "settled").length, 1);
      assert.deepEqual(
        events.at(-1),
        expectedError === undefined
          ? { type: "settled", stopReason: "stop" }
          : { type: "settled", stopReason: "error", error: expectedError },
      );
      assert.equal(api.problem, undefined);
    };
    const names = (body: Record<string, unknown>) =>
      ((body["tools"] as Record<string, unknown>[]) ?? [])
        .map((t) => String(t["name"]))
        .sort();
    const baseline = await acquire("baseline", undefined);
    await prompt(baseline, "Normal baseline.");
    const normal = names(api.bodies[0]!);
    for (const tool of ["bash", "read", "edit", "write"])
      assert(normal.includes(tool));
    await pool.release("baseline");
    const plan = personaSpec(defaultConfig(), "plan")!;
    const session = await acquire("personas", plan);
    const pid = session.pid;
    // A fresh persona child starts with normal tools for restoration. Losing
    // context delivery must refuse before any native prompt/model request.
    const beforeFailure = api.bodies.length;
    rmSync(turnsDir, { recursive: true, force: true });
    await prompt(
      session,
      "This prompt must never reach pi.",
      "could not deliver turn context to the pi bridge; prompt not sent",
    );
    assert.equal(api.bodies.length, beforeFailure);
    assert.equal(session.busy, false);
    assert.equal(session.pid, pid);
    mkdirSync(turnsDir, { mode: 0o700 });
    const prompts = [
      "Plan this refactor.",
      "Answer read-only.",
      "Audit dependencies.",
      "Review with normal tools.",
      "Revise the plan.",
      PLAN_EXECUTION_PROMPT,
    ];
    const personas = [
      plan,
      personaSpec(defaultConfig(), "ask")!,
      { name: "audit", tools: ["read"], guideline: "Audit dependencies." },
      { name: "review", guideline: "Ask before editing." },
      plan,
      null,
    ];
    for (let i = 0; i < prompts.length; i++) {
      assert.equal(await acquire("personas", personas[i]), session);
      await prompt(session, prompts[i]!);
      assert.equal(session.pid, pid);
    }
    assert.deepEqual(api.bodies.slice(1).map(names), [
      [...plan.tools!].sort(),
      [...plan.tools!].sort(),
      ["read"],
      normal,
      [...plan.tools!].sort(),
      normal,
    ]);
    const transcript = readFileSync(session.native.sessionFile!, "utf8")
      .trim()
      .split("\n")
      .map((line) => object(JSON.parse(line)));
    const users = transcript.filter(
      (r) => object(r["message"])["role"] === "user",
    );
    assert.deepEqual(
      users.map((r) => object(r["message"])["content"]),
      prompts.map((text) => [{ type: "text", text }]),
    );
    const systems = transcript.filter(
      (r) => object(r["message"])["role"] === "system",
    );
    assert(
      String(
        object(object(systems[0]!["message"])["sections"])["persona"],
      ).includes('"plan"'),
    );
    const lastSections = object(object(systems.at(-1)!["message"])["sections"]);
    assert.equal(lastSections["persona"], null);
    assert(String(lastSections["tools"]).includes("- write:"));
    const transcriptTools = transcriptToolSets(transcript);
    assert.deepEqual(transcriptTools, api.bodies.slice(1).map(names));
    const report = {
      ...info,
      status: "passed",
      platform: process.platform,
      arch: process.arch,
      driver: process.version,
      samePid: true,
      userMessagesUnchanged: true,
      contextDeliveryFailure: {
        loopbackRequests: 0,
        transcriptUserMessages: 0,
        recoveredSameChild: true,
      },
      toolSets: api.bodies.map(names),
      transcriptTools,
      apiRequests: api.bodies.length,
      transcriptSystemSections: systems.map(
        (r) => object(r["message"])["sections"],
      ),
      remoteModelRequests: 0,
    };
    writeFileSync(
      join(dir, "summary.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    return report;
  } finally {
    await pool?.close();
    await api.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  recordNativePersonas(
    process.argv[2] ?? join("build", "spikes", `personas-native-${Date.now()}`),
  )
    .then(() =>
      console.log(
        "Native persona tools and transcript verified; zero remote model requests.",
      ),
    )
    .catch((cause: unknown) => {
      console.error(String(cause));
      process.exitCode = 1;
    });
}
