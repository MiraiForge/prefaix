// Actual pi/bridge tool and restoration proof. Isolated dummy-auth loopback
// replies are SCRIPTED, not natural-model behavior or remote-provider evidence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
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
import { assertLiveAllowed, type Env } from "../live-guard.js";
import { nativeApi, profileFiles } from "./m1-native.js";
import {
  ISOLATION_ARGS,
  object,
  Recording,
  spawnRpcProcess,
} from "./rpc-live.js";
import { transcriptToolSets } from "./personas-native.js";

export async function recordNativeSuggest(dir: string, env: Env = process.env) {
  const live = assertLiveAllowed(env);
  assert.equal(live.provider, "kimi-coding");
  assert.equal(live.model, "kimi-coding/k3");
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "pfx-suggest-native-"));
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
  const recording = new Recording(dir, "suggest", info);
  const marker = join(workspace, "must-not-execute");
  const command = `printf '%s' '日本語🙂' > '${marker}'`;
  const api = await nativeApi((_body, ordinal) =>
    ordinal === 2
      ? [
          {
            type: "tool_use",
            id: "local-proposal",
            name: "propose_command",
            input: { command, explanation: "Review before Enter." },
          },
        ]
      : [{ type: "text", text: "Scripted normal answer." }],
  );
  let child: PiSession | undefined;
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
    child = (await adapter.open({
      root: workspace,
      env: { ...baseEnv, PI_CODING_AGENT_DIR: profile },
    })) as PiSession;
    const pid = child.pid;
    const results = [];
    for (const [index, text] of [
      "Normal baseline.",
      "/not-a-native-command",
      "Normal recovery.",
    ].entries()) {
      assertLiveAllowed(env);
      assert.deepEqual((await child.state()).model, {
        provider: live.provider,
        id: "k3",
      });
      const nativeState = object(
        recording.records.filter((r) => r["command"] === "get_state").at(-1)?.[
          "data"
        ],
      );
      assert.equal(
        object(nativeState["model"])["baseUrl"],
        api.baseUrl,
        "refuse any non-loopback model endpoint",
      );
      const before = api.bodies.length;
      const events = [];
      for await (const event of child.prompt(
        {
          text,
          ...(index === 1 ? { commandProposal: true } : {}),
          context: {
            shell: { kind: "fish", version: "probe", shellId: "probe", pid: 1 },
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
      assert.deepEqual(events.at(-1), { type: "settled", stopReason: "stop" });
      assert.equal(
        api.bodies.length,
        before + 1,
        "terminating proposal must not request an automatic follow-up",
      );
      assert.equal(api.problem, undefined);
      assert.equal(child.pid, pid);
      assert(!existsSync(marker), "generated command was executed");
      assert.deepEqual(
        events.filter((e) => e.type === "set_buffer"),
        index === 1 ? [{ type: "set_buffer", text: command }] : [],
      );
      results.push({
        edit: index === 1,
        loopbackRequests: api.bodies.length - before,
        settlements: 1,
        bufferCount: index === 1 ? 1 : 0,
        generatedCommandExecuted: false,
      });
    }
    const tools = api.bodies.map((body) =>
      ((body["tools"] as Record<string, unknown>[]) ?? [])
        .map((t) => String(t["name"]))
        .sort(),
    );
    assert(!tools[0]!.includes("propose_command"));
    assert(tools[0]!.includes("bash"));
    assert.deepEqual(tools[1], ["propose_command"]);
    assert.deepEqual(tools[2], tools[0]);
    const transcript = readFileSync(child.native.sessionFile!, "utf8")
      .trim()
      .split("\n")
      .map((line) => object(JSON.parse(line)));
    assert.deepEqual(transcriptToolSets(transcript), tools);
    const users = transcript.filter(
      (r) => object(r["message"])["role"] === "user",
    );
    assert.deepEqual(object(users[1]!["message"])["content"], [
      {
        type: "text",
        text: "Request for a suggested shell command:\n/not-a-native-command",
      },
    ]);
    const report = {
      ...info,
      status: "passed",
      platform: process.platform,
      arch: process.arch,
      driver: process.version,
      sameChild: true,
      remoteModelRequests: 0,
      apiRequests: api.bodies.length,
      toolSets: tools,
      transcriptTools: transcriptToolSets(transcript),
      turns: results,
    };
    writeFileSync(
      join(dir, "summary.json"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    writeFileSync(
      join(dir, "api-requests.json"),
      JSON.stringify(api.bodies, null, 2) + "\n",
      { mode: 0o600 },
    );
    return report;
  } finally {
    await child?.close();
    await api.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  recordNativeSuggest(
    process.argv[2] ?? join("build", "spikes", `suggest-native-${Date.now()}`),
  )
    .then(() =>
      console.log(
        "Native proposal tool and restoration verified; zero remote model requests.",
      ),
    )
    .catch((cause: unknown) => {
      console.error(String(cause));
      process.exitCode = 1;
    });
}
