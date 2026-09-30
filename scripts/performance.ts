import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { cpus, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { measureStreamThroughput } from "./stream-throughput.js";
import { resolvePaths } from "../src/core/paths.js";
import { decodeDirectives } from "../src/shells/directives.js";
import {
  assessIdleMemoryBudget,
  IDLE_RSS_LIMIT_BYTES,
} from "./performance-budget.js";

const node = process.env["PREFAIX_PERF_NODE"] ?? "node";
const idleRssLimitBytes = IDLE_RSS_LIMIT_BYTES;
const idleRssLimitMib = idleRssLimitBytes / 1024 / 1024;
const count = Number(process.env["PREFAIX_PERF_SAMPLES"] ?? 50);
assert(
  Number.isInteger(count) && count >= 50,
  "Performance gates need at least 50 samples.",
);
const home = mkdtempSync(join(tmpdir(), "pfx-perf-"));
const bin = resolve("dist/prefaix.js");
function artifactHash(): string {
  const hash = createHash("sha256");
  for (const file of readdirSync(dirname(bin)).sort()) {
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(join(dirname(bin), file)));
  }
  return hash.digest("hex");
}
const artifactSha256 = artifactHash();
const env = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME: home,
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_STATE_HOME: join(home, "state"),
  XDG_CACHE_HOME: join(home, "cache"),
  XDG_RUNTIME_DIR: join(home, "real"),
  PREFAIX_BACKEND: "fake",
  PREFAIX_FAKE_SCENARIO: "hello",
  PREFAIX_POOL_SPARE: "false",
  PREFAIX_PLAIN: "1",
};
const realPaths = resolvePaths({ env, home });
const clientEnv = { ...env, XDG_RUNTIME_DIR: join(home, "proxy") };
const proxyPaths = resolvePaths({ env: clientEnv, home });
assert(
  !realPaths.runtimeFallback && !proxyPaths.runtimeFallback,
  "Temporary socket paths must fit without falling back to a shared runtime directory.",
);
mkdirSync(proxyPaths.runtimeDir, { recursive: true, mode: 0o700 });
const sockets = new Set<Socket>();
interface Sample {
  started: number;
  helloMs: number;
  tokenMs: number;
  stdout: string;
  stderr: string;
}
let currentSample: Sample | undefined;
const proxy = createServer((socket) => {
  const sample = currentSample;
  const upstream = connect(realPaths.socket);
  sockets.add(socket);
  sockets.add(upstream);
  let received = "";
  upstream.on("data", (data: Buffer) => {
    if (sample === undefined || sample.helloMs > 0) return;
    received += data.toString("utf8");
    const end = received.indexOf("\n");
    if (end !== -1) {
      try {
        const record = JSON.parse(received.slice(0, end)) as { t?: string };
        if (record.t === "hello")
          sample.helloMs = performance.now() - sample.started;
      } catch {
        sample.stderr += "Daemon sent an invalid handshake.\n";
        socket.destroy();
      }
    }
  });
  for (const peer of [socket, upstream]) {
    peer.on("error", () => {
      socket.destroy();
      upstream.destroy();
    });
    peer.on("close", () => sockets.delete(peer));
  }
  socket.pipe(upstream).pipe(socket);
});
const daemon = spawn(node, [bin, "daemon", "--foreground"], {
  env,
  cwd: home,
  stdio: ["ignore", "ignore", "pipe"],
});
let daemonError = "";
daemon.stderr.on("data", (data: Buffer) => {
  daemonError += data.toString();
});
daemon.on("error", (error) => {
  daemonError += error.message;
});
let active: ChildProcess | undefined;
const hello: number[] = [];
const firstToken: number[] = [];
let conversation = "";
function daemonRssMb(): number {
  const rssKb = Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(daemon.pid)], {
      encoding: "utf8",
    }).trim(),
  );
  assert(
    Number.isFinite(rssKb) && rssKb > 0,
    "The real daemon RSS must be observable.",
  );
  return rssKb / 1024;
}
async function terminate(child: ChildProcess | undefined): Promise<void> {
  if (
    child === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  const closed = once(child, "close");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 1_500);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}
const interrupt = () => {
  active?.kill("SIGTERM");
  daemon.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
function percentile(values: number[], fraction: number): number {
  return (
    [...values].sort((a, b) => a - b)[
      Math.ceil(values.length * fraction) - 1
    ] ?? Infinity
  );
}
try {
  const readyDeadline = Date.now() + 10_000;
  while (!daemonError.includes("listening on")) {
    assert(
      daemon.exitCode === null &&
        daemon.signalCode === null &&
        Date.now() < readyDeadline,
      `Daemon failed to start: ${daemonError}`,
    );
    await delay(10);
  }
  proxy.listen(proxyPaths.socket);
  await once(proxy, "listening");
  // An untouched daemon is measured before warming the fake session.
  const idleDaemonRssMb = daemonRssMb();
  for (let i = -1; i < count; i++) {
    const directives = join(home, "directives");
    const sample: Sample = {
      started: performance.now(),
      helloMs: 0,
      tokenMs: 0,
      stdout: "",
      stderr: "",
    };
    currentSample = sample;
    const client = spawn(
      node,
      [
        bin,
        "run",
        "--shell",
        "zsh",
        "--shell-id",
        "1-1-perf",
        "--nonce",
        "perf",
        "--directives",
        directives,
        "--cwd",
        home,
        "--conversation",
        conversation,
        "--",
        ": performance sample",
      ],
      {
        env: clientEnv,
        cwd: home,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    active = client;
    client.stdout.on("data", (data: Buffer) => {
      if (sample.tokenMs === 0)
        sample.tokenMs = performance.now() - sample.started;
      sample.stdout += data.toString();
    });
    client.stderr.on("data", (data: Buffer) => {
      sample.stderr += data.toString();
    });
    const timer = setTimeout(() => client.kill("SIGKILL"), 10_000);
    try {
      const [code] = await once(client, "close");
      assert.equal(code, 0, sample.stderr);
    } finally {
      clearTimeout(timer);
    }
    active = undefined;
    currentSample = undefined;
    assert(
      sample.stdout.includes("Hello from the fake backend"),
      "The real CLI must render the fake response.",
    );
    assert(
      sample.helloMs > 0 && sample.tokenMs > 0,
      "Both hello and the first rendered token must be observed.",
    );
    conversation =
      decodeDirectives(readFileSync(directives))?.conversation ?? "";
    assert(conversation.startsWith("c_"));
    if (i >= 0) {
      hello.push(sample.helloMs);
      firstToken.push(sample.tokenMs);
    }
  }
  const postSamplesDaemonRssMb = daemonRssMb();
  const quiescenceMs = 5_000;
  await delay(quiescenceMs);
  const warmIdleDaemonRssMb = daemonRssMb();
  const burst = await measureStreamThroughput(node, bin);
  const nodeVersion = execFileSync(node, ["--version"], {
    encoding: "utf8",
  }).trim();
  const idleMemoryBudget = assessIdleMemoryBudget(nodeVersion, [
    { stage: "fresh", rssMiB: idleDaemonRssMb },
    { stage: "post-use", rssMiB: warmIdleDaemonRssMb },
    { stage: "post-burst", rssMiB: burst.idleRssMb },
  ]);
  const report = {
    burst,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    artifactSha256,
    node: nodeVersion,
    samples: count,
    clientHelloMs: {
      p50: percentile(hello, 0.5),
      p95: percentile(hello, 0.95),
    },
    warmFirstTokenMs: {
      p50: percentile(firstToken, 0.5),
      p95: percentile(firstToken, 0.95),
    },
    idleDaemonRssMb,
    postSamplesDaemonRssMb,
    warmIdleDaemonRssMb,
    idleRssLimitBytes,
    idleMemoryBudget,
    quiescenceMs,
    rssMethod:
      "OS ps resident-set size of the real daemon before its first client, after 50+ ordinary turns, and after three 2000-delta bursts; post-use measurements follow 5 seconds without clients. All three idle states are measured; Node 26 has an explicitly approved idle-RSS exception.",
    method:
      "Built Node CLI through a Unix-socket proxy to the real fake-backend daemon; first token includes fake pacing and renderer. One warmup excluded.",
  };
  assert.equal(
    artifactHash(),
    artifactSha256,
    "The built artifact changed during the run; rerun without concurrent builds.",
  );
  console.log(JSON.stringify(report, null, 2));
  const output = process.env["PREFAIX_PERF_REPORT"];
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  assert(report.clientHelloMs.p50 < 60, "Client hello p50 must be <60ms.");
  assert(report.clientHelloMs.p95 < 120, "Client hello p95 must be <120ms.");
  assert(
    report.warmFirstTokenMs.p50 < 100,
    "Warm first-token p50 must be <100ms including fake pacing.",
  );
  assert(
    report.burst.slowestEventsPerSecond > 1000,
    "The real daemon and renderer must sustain over 1000 text events/second.",
  );
  const overBudget = idleMemoryBudget.overBudget
    .map(({ stage, rssMiB }) => `${stage} ${rssMiB.toFixed(2)} MiB`)
    .join(", ");
  assert.notEqual(
    idleMemoryBudget.status,
    "failed",
    `Idle daemon RSS must be <60 MB (${idleRssLimitMib.toFixed(2)} MiB); over budget: ${overBudget}.`,
  );
  if (idleMemoryBudget.status === "allowlisted") {
    console.warn(
      `Node 26 idle-RSS exception applied (${overBudget}); timing and throughput budgets remain enforced.`,
    );
  }
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await terminate(active);
  for (const socket of sockets) socket.destroy();
  await terminate(daemon);
  if (proxy.listening)
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
}
