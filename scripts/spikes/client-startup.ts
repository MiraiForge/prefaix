import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { cpus, release, tmpdir } from "node:os";
import { join } from "node:path";

const node = process.env["PREFAIX_STARTUP_NODE"] ?? "node";
const bun = process.env["PREFAIX_STARTUP_BUN"] ?? "bun";
const samples = Number(process.env["PREFAIX_STARTUP_SAMPLES"] ?? 50);
assert(Number.isInteger(samples) && samples >= 50, "S8 needs 50+ samples.");
const startedAt = new Date().toISOString();
const home = mkdtempSync(join(tmpdir(), "pfx-s8-"));
const socketPath = join(home, "s");
const source = join(home, "client.ts");
const bundle = join(home, "client.mjs");
const compiled = join(home, "client");
const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home };
const greeting = "prefaix-startup\n";
const sockets = new Set<Socket>();
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("error", () => socket.destroy());
  socket.on("close", () => sockets.delete(socket));
  socket.end(greeting);
});
let active: ChildProcess | undefined;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  active?.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);

interface Sample {
  helloMs: number;
  exitMs: number;
}
async function measure(bin: string, args: string[]): Promise<Sample> {
  assert(!interrupted, "Startup probe interrupted.");
  const started = performance.now();
  const child = spawn(bin, args, {
    env,
    cwd: home,
    stdio: ["ignore", "pipe", "pipe"],
  });
  active = child;
  let output = "";
  let error = "";
  let helloMs = 0;
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
    if (helloMs === 0 && output.includes(greeting))
      helloMs = performance.now() - started;
  });
  child.stderr.on("data", (data: Buffer) => {
    error += data.toString();
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const [code] = await once(child, "close");
    assert.equal(code, 0, error);
    assert.equal(output, greeting, "The child must receive the socket reply.");
    assert(helloMs > 0);
    return { helloMs, exitMs: performance.now() - started };
  } finally {
    clearTimeout(timer);
    active = undefined;
  }
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}
function artifact(path: string) {
  const bytes = readFileSync(path);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

try {
  writeFileSync(
    source,
    `import { connect } from "node:net";
const socket = connect(process.argv[2]!);
socket.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
socket.on("data", (data) => process.stdout.write(data));
`,
  );
  execFileSync(bun, ["build", source, "--target=node", `--outfile=${bundle}`], {
    env,
    stdio: "pipe",
    timeout: 60_000,
  });
  execFileSync(bun, ["build", source, "--compile", `--outfile=${compiled}`], {
    env,
    stdio: "pipe",
    timeout: 60_000,
  });
  server.listen(socketPath);
  await once(server, "listening");
  const variants = [
    {
      name: "node-bundle",
      bin: node,
      args: [bundle, socketPath],
      path: bundle,
    },
    { name: "bun-compiled", bin: compiled, args: [socketPath], path: compiled },
  ];
  const results = new Map<string, Sample[]>();
  for (const variant of variants) {
    results.set(variant.name, []);
    await measure(variant.bin, variant.args);
  }
  for (let round = 0; round < samples; round++) {
    // Alternate which runtime goes first so machine drift cannot favor one.
    for (const variant of round % 2 === 0
      ? variants
      : [...variants].reverse()) {
      results.get(variant.name)!.push(await measure(variant.bin, variant.args));
    }
  }
  const report = {
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    harnessNode: process.versions.node,
    node: execFileSync(node, ["--version"], { env, encoding: "utf8" }).trim(),
    bun: execFileSync(bun, ["--version"], { env, encoding: "utf8" }).trim(),
    samples,
    method:
      "Fresh processes connect to a local Unix socket, print its greeting, and exit. One warmup per runtime excluded; alternate runtime order. helloMs ends when the parent observes the child's received greeting; exitMs includes process shutdown. This is a loader/socket floor, not the full production client or a model request.",
    variants: Object.fromEntries(
      variants.map((variant) => {
        const raw = results.get(variant.name)!;
        return [
          variant.name,
          {
            artifact: artifact(variant.path),
            helloMs: distribution(raw.map((sample) => sample.helloMs)),
            exitMs: distribution(raw.map((sample) => sample.exitMs)),
            raw,
          },
        ];
      }),
    ),
  };
  console.log(JSON.stringify(report, null, 2));
  const output = process.env["PREFAIX_STARTUP_REPORT"];
  if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  for (const socket of sockets) socket.destroy();
  if (server.listening)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
}
