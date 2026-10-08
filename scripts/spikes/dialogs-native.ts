// Opt-in native pre-ack UI deadline/cancellation proof. Isolated dummy auth,
// actual pi and AgentPool, scripted loopback SSE only: no paid model request.
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
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  createPiAdapter,
  type PiSession,
} from "../../src/agents/pi/adapter.js";
import type { AgentEvent } from "../../src/core/agent-port.js";
import { defaultConfig } from "../../src/core/config/schema.js";
import { AgentPool } from "../../src/daemon/pool.js";
import { assertLiveAllowed, type Env } from "../live-guard.js";
import { nativeApi, profileFiles } from "./m1-native.js";
import {
  ISOLATION_ARGS,
  object,
  Recording,
  spawnRpcProcess,
} from "./rpc-live.js";

export async function recordNativeDialogs(dir: string, env: Env = process.env) {
  const live = assertLiveAllowed(env);
  assert.equal(live.provider, "kimi-coding");
  assert.equal(live.model, "kimi-coding/k3");
  dir = resolve(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const workspace = mkdtempSync(join(tmpdir(), "pfx-dialogs-native-"));
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
  const recording = new Recording(dir, "dialogs", info);
  const api = await nativeApi(() => [
    { type: "text", text: "Scripted dialog answer." },
  ]);
  let pool: AgentPool | undefined;
  try {
    const profile = join(workspace, "profile");
    mkdirSync(profile);
    for (const [name, data] of Object.entries(profileFiles(api.baseUrl)))
      writeFileSync(join(profile, name), JSON.stringify(data), { mode: 0o600 });
    const extension = join(workspace, "dialog.ts");
    writeFileSync(
      extension,
      `export default function(pi) {
      pi.on("before_agent_start", async (_event, ctx) => {
        if (_event.prompt.startsWith("Silent preflight")) {
          await new Promise((done) => setTimeout(done, 2000));
          return;
        }
        const choice = await ctx.ui.select("Native deadline probe", ["Continue"]);
        ctx.ui.notify("Native hook released: " + (choice ?? "cancelled"), "info");
      });
    }`,
      { mode: 0o600 },
    );
    const turnsDir = join(workspace, "turns");
    mkdirSync(turnsDir);
    const adapter = createPiAdapter({
      bin,
      provider: live.provider,
      model: live.model,
      bridgePath: resolve("dist/pi-bridge.js"),
      turnsDir,
      rpc: {
        requestTimeoutMs: 500,
        readyTimeoutMs: 15000,
        spawn: (binary, args, options) =>
          recording.wrap(spawnRpcProcess)(
            binary,
            [
              ...args,
              ...ISOLATION_ARGS,
              "--extension",
              extension,
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
    const acquire = (native?: PiSession["native"]) =>
      pool!.acquire({
        conversationId: "native-dialogs",
        root: workspace,
        env: { ...baseEnv, PI_CODING_AGENT_DIR: profile },
        ...(native === undefined ? {} : { native }),
      }) as Promise<PiSession>;
    const session = await acquire();
    const pid = session.pid;
    const native = { ...session.native };
    const turns = [];
    const recordedSessionId = () =>
      object(
        recording.records.filter((r) => r["command"] === "get_state").at(-1)?.[
          "data"
        ],
      )["sessionId"];
    const prompt = async (
      child: PiSession,
      text: string,
      abort: "signal" | "method" | false,
    ) => {
      assertLiveAllowed(env);
      assert.deepEqual((await child.state()).model, {
        provider: live.provider,
        id: "k3",
      });
      assert.equal(
        object(
          object(
            recording.records
              .filter((r) => r["command"] === "get_state")
              .at(-1)?.["data"],
          )["model"],
        )["baseUrl"],
        api.baseUrl,
      );
      assert(child.bridgeLive);
      const controller = new AbortController();
      const before = api.bodies.length;
      const recordStart = recording.records.length;
      const events: AgentEvent[] = [];
      let heldMs = 0;
      for await (const event of child.prompt(
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
        controller.signal,
      )) {
        events.push(event);
        if (event.type === "ui_request") {
          const start = performance.now();
          await delay(1500);
          heldMs = performance.now() - start;
          const heldWire = recording.records.slice(recordStart);
          assert(
            !heldWire.some((r) => r["command"] === "prompt"),
            "native prompt acknowledged before UI answer",
          );
          assert(
            !heldWire.some((r) => r["type"] === "agent_start"),
            "native agent started before UI answer",
          );
          assert.equal(
            api.bodies.length,
            before,
            "request while native dialog held",
          );
          if (abort === "signal") controller.abort();
          else if (abort === "method") await child.abort();
          else child.respondUi(event.id, { value: "Continue" });
        }
      }
      assert.equal(events.filter((e) => e.type === "ui_request").length, 1);
      assert.equal(events.filter((e) => e.type === "settled").length, 1);
      assert.deepEqual(events.at(-1), {
        type: "settled",
        stopReason: abort === false ? "stop" : "aborted",
      });
      assert(heldMs > 1000, "dialog was not held beyond the RPC deadline");
      if (abort !== false) {
        assert(!child.isAlive, "aborted native child is still usable");
        assert(child.pid !== undefined);
        assert.throws(() => process.kill(child.pid!, 0), /ESRCH/);
        await delay(100);
        assert.equal(
          api.bodies.length,
          before,
          "request after native dialog abort",
        );
        assert(
          !recording.records
            .slice(recordStart)
            .some((r) => r["type"] === "agent_start"),
          "orphaned native agent work",
        );
      } else assert.equal(api.bodies.length, before + 1);
      return {
        text,
        heldMs,
        loopbackRequests: api.bodies.length - before,
        settledCount: 1,
        stopReason: abort === false ? "stop" : "aborted",
        pid: child.pid,
        native: child.native,
        childAlive: child.isAlive,
      };
    };
    turns.push(
      await prompt(session, "Answer after holding the dialog.", false),
    );
    assert.equal(session.pid, pid);
    const warm = await acquire(native);
    assert.equal(warm.pid, pid);
    turns.push(
      await prompt(warm, "Abort the unanswered dialog by signal.", "signal"),
    );
    const resumed = await acquire(native);
    assert.notEqual(resumed.pid, pid);
    assert.equal(recordedSessionId(), native.sessionId);
    assert.equal(resumed.native.sessionFile, native.sessionFile);
    turns.push(
      await prompt(resumed, "Recover on the same conversation.", false),
    );
    const recoveredPid = resumed.pid;
    const warmAgain = await acquire(native);
    assert.equal(warmAgain.pid, recoveredPid);
    turns.push(
      await prompt(
        warmAgain,
        "Abort the unanswered dialog by method.",
        "method",
      ),
    );
    const resumedAgain = await acquire(native);
    assert.notEqual(resumedAgain.pid, recoveredPid);
    assert.deepEqual(resumedAgain.native, resumed.native);
    assert.equal(recordedSessionId(), native.sessionId);
    turns.push(
      await prompt(resumedAgain, "Recover again after method abort.", false),
    );
    assert.equal(api.bodies.length, 3);
    const beforeTimeout = api.bodies.length;
    assertLiveAllowed(env);
    assert.deepEqual((await resumedAgain.state()).model, {
      provider: live.provider,
      id: "k3",
    });
    assert.equal(
      object(
        object(
          recording.records
            .filter((r) => r["command"] === "get_state")
            .at(-1)?.["data"],
        )["model"],
      )["baseUrl"],
      api.baseUrl,
    );
    const timeoutEvents: AgentEvent[] = [];
    for await (const event of resumedAgain.prompt(
      {
        ...{
          text: "Silent preflight must never start after timeout.",
          context: {
            shell: {
              kind: "zsh" as const,
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
      },
      new AbortController().signal,
    ))
      timeoutEvents.push(event);
    assert.deepEqual(
      timeoutEvents.filter((event) => event.type === "settled"),
      [
        {
          type: "settled",
          stopReason: "error",
          error: "pi prompt timed out after 500ms",
        },
      ],
    );
    assert(!resumedAgain.isAlive);
    assert(resumedAgain.pid !== undefined);
    assert.throws(() => process.kill(resumedAgain.pid!, 0), /ESRCH/);
    await delay(2100);
    assert.equal(
      api.bodies.length,
      beforeTimeout,
      "late request after silent preflight timeout",
    );
    turns.push({
      text: "Silent preflight must never start after timeout.",
      heldMs: 0,
      loopbackRequests: 0,
      settledCount: 1,
      stopReason: "error",
      pid: resumedAgain.pid,
      native: resumedAgain.native,
      childAlive: false,
    });
    const afterTimeout = await acquire(native);
    assert.equal(recordedSessionId(), native.sessionId);
    turns.push(
      await prompt(
        afterTimeout,
        "Recover after silent preflight timeout.",
        false,
      ),
    );
    assert.equal(api.bodies.length, 4);
    assert.equal(api.problem, undefined);
    assert(native.sessionFile);
    const transcript = readFileSync(native.sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const userTexts = transcript
      .filter((record) => object(record["message"])["role"] === "user")
      .map((record) => object(record["message"])["content"])
      .map((content) =>
        typeof content === "string"
          ? content
          : (content as Record<string, unknown>[])
              .map((block) => block["text"])
              .join(""),
      );
    assert.deepEqual(
      userTexts,
      turns
        .filter((turn) => turn.stopReason === "stop")
        .map((turn) => turn.text),
    );
    writeFileSync(
      join(dir, "api-requests.json"),
      JSON.stringify(api.bodies, null, 2) + "\n",
      { mode: 0o600 },
    );
    const summary = {
      ...info,
      platform: process.platform,
      parentNode: process.version,
      ...(process.versions["bun"] === undefined
        ? {}
        : { parentBun: process.versions["bun"] }),
      requestTimeoutMs: 500,
      dialogHoldMs: 1500,
      turns,
      loopbackRequests: api.bodies.length,
      remoteModelRequests: 0,
      transcriptRecords: transcript.length,
      transcriptUserMessages: userTexts,
      abortedOrTimedOutUserMessages: 0,
      abortStrategy:
        "terminate held-dialog child; resume native conversation on replacement",
    };
    writeFileSync(
      join(dir, "summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
      { mode: 0o600 },
    );
    return summary;
  } finally {
    try {
      await pool?.close();
    } finally {
      await api.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  recordNativeDialogs(
    process.argv[2] ?? join("build", "spikes", `dialogs-native-${Date.now()}`),
  ).then(
    (report) => console.log(JSON.stringify(report, null, 2)),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
