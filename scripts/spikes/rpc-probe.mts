// Spike S1: what pi's RPC mode looks like from the outside, with no model
// request. Run it after a pi upgrade and diff the output against
// docs/spikes/S1-pi-rpc-lifecycle.md; the protocol is pi's, not ours.
//
//   bunx tsx scripts/spikes/rpc-probe.mts [--record out.jsonl]
//
// Everything here is read-only with respect to a model: it spawns
// `--mode rpc`, sends state and catalog commands, and shuts the child down.
// It never sends a prompt. A run that needs a model goes through
// scripts/live-guard.ts instead.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const RECORD = process.argv.includes("--record")
  ? process.argv[process.argv.indexOf("--record") + 1]
  : undefined;

const READY_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 2_000;

interface Record {
  readonly at: number;
  readonly raw: unknown;
}

const records: Record[] = [];
let raw = "";
let ready = false;
let exited: { code: number | null; signal: string | null } | undefined;

const child = spawn(
  "pi",
  [
    "--mode",
    "rpc",
    "--offline",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
const started = Date.now();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  raw += chunk;
  for (let at = raw.indexOf("\n"); at !== -1; at = raw.indexOf("\n")) {
    const line = raw.slice(0, at);
    raw = raw.slice(at + 1);
    if (line === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      console.error(`non-JSON on stdout: ${line.slice(0, 120)}`);
      continue;
    }
    records.push({ at: Date.now() - started, raw: parsed });
    ready = true;
  }
});
const stderr: string[] = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk: string) => stderr.push(chunk.trimEnd()));
child.on("exit", (code, signal) => {
  exited = { code, signal };
});

function send(
  id: string,
  type: string,
  extra: Record<string, unknown> = {},
): void {
  child.stdin.write(`${JSON.stringify({ id, type, ...extra })}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function untilReady(): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  send("probe", "get_state");
  while (!ready && Date.now() < deadline) {
    await sleep(25);
  }
  if (!ready) {
    return false;
  }
  return true;
}

function summarize(): void {
  const responses = records.filter(
    (entry) => (entry.raw as { type?: string }).type === "response",
  );
  const events = records.filter(
    (entry) => (entry.raw as { type?: string }).type !== "response",
  );
  console.log(`ready: ${ready} in ${records[0]?.at ?? "-"}ms`);
  console.log(
    `responses: ${responses.length}, unsolicited events: ${events.length}`,
  );
  for (const entry of events) {
    const event = entry.raw as { type: string };
    console.log(`  event ${event.type} at ${entry.at}ms`);
  }
  const state = responses.find(
    (entry) => (entry.raw as { command?: string }).command === "get_state",
  );
  if (state !== undefined) {
    const data = (state.raw as { data?: Record<string, unknown> }).data ?? {};
    const model = data["model"] as
      { provider?: string; id?: string } | undefined;
    console.log(
      `default model: ${model?.provider ?? "none"}/${model?.id ?? "none"}` +
        ` sessionId: ${String(data["sessionId"])}`,
    );
    console.log(`state keys: ${Object.keys(data).sort().join(" ")}`);
  }
  for (const name of [
    "get_commands",
    "get_last_assistant_text",
    "get_session_stats",
  ]) {
    const found = responses.find(
      (entry) => (entry.raw as { command?: string }).command === name,
    );
    console.log(`${name}: ${JSON.stringify(found?.raw).slice(0, 200)}`);
  }
  const failure = records.find(
    (entry) => (entry.raw as { success?: boolean }).success === false,
  );
  console.log(`error shape: ${JSON.stringify(failure?.raw)}`);
}

const gotReady = await untilReady();
if (gotReady) {
  send("models", "get_available_models");
  send("levels", "get_available_thinking_levels");
  send("stats", "get_session_stats");
  send("lastText", "get_last_assistant_text");
  send("commands", "get_commands");
  send("bogus", "no_such_command");
  send("name", "set_session_name", { name: "spike s1" });
  send("abort", "abort");
  send("clear", "clear_queue");
  await sleep(600);
  summarize();
} else {
  console.error(
    `no ready response within ${READY_TIMEOUT_MS}ms: pi can block at startup ` +
      `with nothing on stdout or stderr. A transport must treat ready as a ` +
      `timeout, not a certainty.`,
  );
}

child.stdin.end();
const exitedCleanly = await Promise.race([
  new Promise<boolean>((resolve) => {
    const poll = setInterval(() => {
      if (exited !== undefined) {
        clearInterval(poll);
        resolve(true);
      }
    }, 25);
  }),
  sleep(SHUTDOWN_GRACE_MS).then(() => false),
]);
if (!exitedCleanly) {
  child.kill("SIGKILL");
}
console.log(
  `stdin close: exited=${exitedCleanly} code=${exited?.code} signal=${exited?.signal}`,
);
if (stderr.length > 0) {
  console.log(`stderr: ${stderr.join(" | ").slice(0, 300)}`);
}
if (RECORD !== undefined) {
  writeFileSync(
    RECORD,
    `${records.map((r) => JSON.stringify(r.raw)).join("\n")}\n`,
  );
  console.log(`wrote ${RECORD}`);
}
