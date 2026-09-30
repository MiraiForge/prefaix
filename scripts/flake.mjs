import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repeats = Number(process.env.PREFAIX_FLAKE_RUNS ?? 50);
if (!Number.isInteger(repeats) || repeats < 50) {
  throw new Error("The M3 flake gate requires at least 50 reruns.");
}
const concurrency = Number(process.env.PREFAIX_FLAKE_CONCURRENCY ?? 1);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
  throw new Error("PREFAIX_FLAKE_CONCURRENCY must be an integer from 1 to 8.");
}
const output = process.env.PREFAIX_FLAKE_REPORT_DIR ?? "build/flake";
mkdirSync(output, { recursive: true });
function artifactHash() {
  const hash = createHash("sha256");
  for (const file of readdirSync("dist").sort())
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(join("dist", file)));
  return hash.digest("hex");
}
const artifactSha256 = artifactHash();
function suiteHash() {
  const hash = createHash("sha256");
  function add(path) {
    hash.update(path).update("\0").update(readFileSync(path));
  }
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else add(path);
    }
  }
  walk("src");
  walk("test/e2e");
  add("vitest.e2e.config.ts");
  add("scripts/flake.mjs");
  return hash.digest("hex");
}
const suiteSha256 = suiteHash();
const startedAt = new Date().toISOString();
const shells = Object.fromEntries(
  ["zsh", "fish", "bash"].map((shell) => {
    const binary = process.env[`PREFAIX_E2E_${shell.toUpperCase()}`] ?? shell;
    const version = spawnSync(binary, ["--version"], { encoding: "utf8" });
    if (version.status !== 0)
      throw new Error(`Required shell unavailable: ${binary}`);
    return [shell, { binary, version: version.stdout.split("\n")[0] }];
  }),
);
const runs = [];
let nextRun = 1;
let changed = false;
async function worker() {
  while (nextRun <= repeats && !changed) {
    if (artifactHash() !== artifactSha256 || suiteHash() !== suiteSha256) {
      changed = true;
      return;
    }
    const run = nextRun++;
    const started = Date.now();
    const result = await new Promise((resolve) =>
      execFile(
        "bunx",
        [
          "vitest",
          "run",
          "--config",
          "vitest.e2e.config.ts",
          "test/e2e/shell-plugins.spec.ts",
          "test/e2e/commands.spec.ts",
          "test/e2e/setup.spec.ts",
        ],
        {
          env: { ...process.env, PREFAIX_E2E_REQUIRED: "1" },
          encoding: "utf8",
          timeout: 240_000,
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      ),
    );
    const passed = !result.error;
    writeFileSync(
      join(output, `run-${run}.log`),
      result.stdout + result.stderr + (result.error?.message ?? ""),
    );
    runs.push({ run, passed, ms: Date.now() - started });
    console.log(`M3 rerun ${run}/${repeats}: ${passed ? "passed" : "FAILED"}`);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
runs.sort((a, b) => a.run - b.run);
const failures = runs.filter((run) => !run.passed).length;
const report = {
  platform: process.platform,
  node: process.version,
  artifactSha256,
  suiteSha256,
  concurrency,
  startedAt,
  finishedAt: new Date().toISOString(),
  shells,
  repeats,
  failures,
  failureRate: failures / repeats,
  runs,
};
if (changed || artifactHash() !== artifactSha256 || suiteHash() !== suiteSha256)
  throw new Error(
    "The build or test inputs changed during stability testing; restart with frozen inputs.",
  );
writeFileSync(
  join(output, "summary.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
if (report.failureRate >= 0.01)
  throw new Error(
    `${failures}/${repeats} reruns failed; M3 requires <1%. See ${output}.`,
  );
