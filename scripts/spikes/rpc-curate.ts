// Reviewable curation, never a recording or a model request. Original raw
// evidence stays untouched; provenance hashes and record ranges link it back.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertLiveAllowed } from "../live-guard.js";
import { object } from "./rpc-live.js";

type RecordValue = Record<string, unknown>;
const EVENTS = new Set([
  "agent_start",
  "agent_end",
  "agent_settled",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "auto_retry_start",
  "auto_retry_end",
  "compaction_start",
  "compaction_end",
]);
const OMIT = new Set([
  "timestamp",
  "thinkingSignature",
  "textSignature",
  "signature",
  "partial",
  "responseId",
  "providerThinkingLevel",
  "details",
]);

/** Only supported S1 captures; reject synthetic tests and failed runs. */
export function curateRpcCapture(options: {
  recordDir: string;
  outputDir: string;
}): string[] {
  const report = object(
    JSON.parse(readFileSync(join(options.recordDir, "summary.json"), "utf8")),
  );
  assert.equal(
    report["status"],
    "passed",
    "Do not curate an incomplete recording",
  );
  assert(
    report["source"] === "live" || report["source"] === "controlled",
    "Synthetic children are not recorded pi evidence",
  );
  assert(
    report["format"] === "prefaix-s1-report" ||
      report["format"] === "prefaix-s1-controlled-report",
  );
  assertLiveAllowed({
    PREFAIX_LIVE_PROVIDER: String(report["provider"]),
    PREFAIX_LIVE_MODEL: String(report["model"]),
  });
  assert(Array.isArray(report["scenarios"]));
  const prepared: { name: string; text: string }[] = [];
  for (const entry of report["scenarios"]) {
    const scenario = object(entry);
    const name = String(scenario["scenario"]);
    assert(
      /^(stream|abort-text|abort-tool|kill-text|retry-success|retry-exhausted|retry-abort|compact-threshold|compact-overflow|compact-manual)$/u.test(
        name,
      ),
    );
    const capture = `${name}.jsonl`;
    const raw = readFileSync(join(options.recordDir, capture), "utf8");
    const records = raw
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => object(JSON.parse(line)));
    const header = records.shift();
    assert.equal(header?.["type"], "prefaix_fixture_header");
    for (const field of [
      "source",
      "provider",
      "model",
      "piVersion",
      "recordedAt",
    ])
      assert.equal(header[field], report[field], `Mismatched ${field}`);
    assert(Array.isArray(scenario["turns"]) && scenario["turns"].length > 0);
    // Threshold is exercised on the first turn; overflow on the second.
    const turnIndex = name === "compact-overflow" ? 1 : 0;
    const selected = object(scenario["turns"][turnIndex]);
    const start =
      name === "compact-manual"
        ? records.findIndex((r) => r["type"] === "compaction_start")
        : Number(selected["recordStart"]);
    const end =
      name === "compact-manual"
        ? records.length
        : Number(selected["recordEnd"]);
    assert(
      Number.isSafeInteger(start) &&
        start >= 0 &&
        Number.isSafeInteger(end) &&
        end > start &&
        end <= records.length,
      "Invalid capture record range",
    );
    const ids = new Map<string, string>();
    const clean = (value: unknown, key = ""): unknown => {
      if (Array.isArray(value))
        return value
          .filter((part) => object(part)["type"] !== "thinking")
          .map((part) => clean(part));
      if (value !== null && typeof value === "object")
        return Object.fromEntries(
          Object.entries(object(value))
            .filter(([field]) => !OMIT.has(field))
            .map(([field, part]) => [field, clean(part, field)]),
        );
      if (
        typeof value === "string" &&
        (key === "toolCallId" || key === "firstKeptEntryId" || key === "id")
      ) {
        const known = ids.get(value) ?? `id-${ids.size + 1}`;
        ids.set(value, known);
        return known;
      }
      return value;
    };
    const events: RecordValue[] = [];
    let held = false;
    let paced = false;
    for (const r of records.slice(start, end)) {
      if (!EVENTS.has(String(r["type"]))) continue;
      const message = object(r["message"]);
      if (
        (r["type"] === "message_start" || r["type"] === "message_end") &&
        message["role"] !== "assistant" &&
        message["role"] !== "toolResult"
      )
        continue;
      const nested = object(r["assistantMessageEvent"]);
      if (
        r["type"] === "message_update" &&
        String(nested["type"]).startsWith("thinking_")
      )
        continue;
      const terminalAbort =
        name === "abort-tool"
          ? r["type"] === "tool_execution_end"
          : name === "abort-text"
            ? r["type"] === "message_end" && message["stopReason"] === "aborted"
            : name === "retry-abort"
              ? r["type"] === "auto_retry_end"
              : false;
      if (terminalAbort && !held) {
        events.push({ untilCommand: "abort" });
        held = true;
      }
      const copy = object(clean(r));
      // These arrays duplicate message contents; no mapper uses them.
      if (r["type"] === "agent_end") copy["messages"] = [];
      events.push(copy);
      if (name === "stream" && nested["type"] === "text_delta" && !paced) {
        // A state query in the contract needs an in-flight turn. This is replay
        // pacing, not a measurement of provider latency.
        events.push({ delay: 400 });
        paced = true;
      }
    }
    const killed = name === "kill-text";
    if (killed) events.push({ untilCommand: "prefaix_fixture_kill" });
    else if (name !== "compact-manual")
      assert.equal(events.at(-1)?.["type"], "agent_settled");
    if (name.startsWith("abort-") || name === "retry-abort")
      assert(held, "Missing recorded cancellation boundary");
    const fixtureHeader = {
      ...header,
      curated: true,
      provenance: {
        capture,
        sha256: createHash("sha256").update(raw).digest("hex"),
        recordRange: [start, end],
      },
      transforms: [
        "remove responses, startup/state, user/system messages, thinking and signatures, timestamps, provider request IDs and details",
        "normalize opaque IDs",
        "omit duplicate agent_end messages",
        "add causal replay holds/pacing",
      ],
      replay:
        name === "compact-manual"
          ? { command: "compact" }
          : held
            ? { abort: "drain" }
            : killed
              ? { terminal: "kill" }
              : {},
    };
    const text =
      [fixtureHeader, ...events].map((r) => JSON.stringify(r)).join("\n") +
      "\n";
    assert(
      !/\/home\/|\/Users\/|\/tmp\/|op:\/\/|Bearer\s|sk-[a-zA-Z0-9_-]{16,}/iu.test(
        text,
      ),
      "Capture needs further private-data review",
    );
    prepared.push({ name: `${name}.jsonl`, text });
  }
  // Prepare and validate everything before creating files. Never overwrite.
  mkdirSync(options.outputDir, { mode: 0o700 });
  for (const { name, text } of prepared)
    writeFileSync(join(options.outputDir, name), text, {
      flag: "wx",
      mode: 0o600,
    });
  return prepared.map((file) => file.name);
}

export function rpcCurateMain(argv: readonly string[]): void {
  if (argv.length === 1 && argv[0] === "--help") {
    console.log(
      "Usage: bun scripts/spikes/rpc-curate.ts <record-directory> <new-output-directory>\nNo model requests. Review outputs before adding them to test fixtures.",
    );
    return;
  }
  assert(
    argv.length === 2 &&
      argv.every((arg) => arg !== "" && !arg.startsWith("--")),
    "Usage: bun scripts/spikes/rpc-curate.ts <record-directory> <new-output-directory>",
  );
  const files = curateRpcCapture({
    recordDir: resolve(argv[0]!),
    outputDir: resolve(argv[1]!),
  });
  console.log(
    `Prepared ${files.length} replay fixtures; review before sharing.`,
  );
}
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    rpcCurateMain(process.argv.slice(2));
  } catch (cause) {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
