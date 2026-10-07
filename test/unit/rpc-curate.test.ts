import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  curateRpcCapture,
  rpcCurateMain,
} from "../../scripts/spikes/rpc-curate.js";

const roots: string[] = [];
function setup(
  options: {
    source?: string;
    status?: string;
    scenario?: string;
    privateText?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pfx-curate-"));
  roots.push(root);
  const scenario = options.scenario ?? "stream";
  const header = {
    type: "prefaix_fixture_header",
    source: options.source ?? "live",
    provider: "kimi-coding",
    model: "kimi-coding/k3",
    piVersion: "1.0.4",
    recordedAt: "test",
  };
  const records: Record<string, unknown>[] = [
    { type: "response", data: { sessionFile: "/private/path" } },
    { type: "agent_start" },
    {
      type: "message_start",
      message: { role: "user", content: "/home/private" },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        delta: "private thought",
      },
    },
    {
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        delta: options.privateText ?? "Hello",
      },
    },
    {
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 1,
        content: [
          { type: "thinking", thinkingSignature: "private signature" },
          {
            type: "text",
            text: options.privateText ?? "Hello",
            textSignature: "opaque",
          },
        ],
        stopReason: scenario === "abort-text" ? "aborted" : "stop",
      },
    },
    {
      type: "agent_end",
      messages: [{ private: "duplicate" }],
      willRetry: false,
    },
    { type: "agent_settled" },
  ];
  if (scenario === "kill-text") records.splice(5);
  if (scenario === "abort-tool")
    records.splice(
      5,
      0,
      {
        type: "tool_execution_start",
        toolCallId: "opaque-id",
        toolName: "prefaix_s1_wait",
        args: {},
      },
      {
        type: "tool_execution_end",
        toolCallId: "opaque-id",
        toolName: "prefaix_s1_wait",
        isError: true,
      },
    );
  if (scenario === "retry-abort")
    records.splice(5, 0, { type: "auto_retry_end", success: false });
  if (scenario === "compact-manual")
    records.splice(
      0,
      records.length,
      { type: "compaction_start", reason: "manual" },
      {
        type: "compaction_end",
        reason: "manual",
        result: { summary: "summary", firstKeptEntryId: "opaque-entry" },
      },
    );
  const summary = {
    ...header,
    format: "prefaix-s1-report",
    status: options.status ?? "passed",
    scenarios: [
      { scenario, turns: [{ recordStart: 0, recordEnd: records.length }] },
    ],
  };
  writeFileSync(join(root, "summary.json"), JSON.stringify(summary));
  const capture = join(root, `${scenario}.jsonl`);
  const raw =
    [header, ...records].map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(capture, raw);
  return { root, capture, raw, outputDir: join(root, "curated"), scenario };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("S1 reviewed-fixture curation", () => {
  it.each([
    "stream",
    "abort-text",
    "abort-tool",
    "kill-text",
    "retry-abort",
    "compact-manual",
  ])(
    "curates %s with source/provenance and causal replay metadata",
    (scenario) => {
      const test = setup({
        scenario,
        source:
          scenario.startsWith("retry-") || scenario.startsWith("compact-")
            ? "controlled"
            : "live",
      });
      expect(
        curateRpcCapture({ recordDir: test.root, outputDir: test.outputDir }),
      ).toEqual([`${scenario}.jsonl`]);
      const output = readFileSync(
        join(test.outputDir, `${scenario}.jsonl`),
        "utf8",
      );
      expect(output).not.toMatch(
        /private thought|private signature|\/home\/private|\/private\/path|"thinkingSignature"|"textSignature"|"timestamp"|"response"/iu,
      );
      const records = output
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records[0]).toMatchObject({
        source:
          scenario.startsWith("retry-") || scenario.startsWith("compact-")
            ? "controlled"
            : "live",
        curated: true,
        provenance: {
          capture: `${scenario}.jsonl`,
          recordRange: [
            0,
            JSON.parse(readFileSync(join(test.root, "summary.json"), "utf8"))
              .scenarios[0].turns[0].recordEnd,
          ],
        },
      });
      expect(readFileSync(test.capture, "utf8")).toBe(test.raw);
      if (scenario.startsWith("abort-") || scenario === "retry-abort")
        expect(records.some((r) => r["untilCommand"] === "abort")).toBe(true);
      if (scenario === "kill-text")
        expect(records.at(-1)).toEqual({
          untilCommand: "prefaix_fixture_kill",
        });
      if (scenario === "stream")
        expect(records.some((r) => r["delay"] === 400)).toBe(true);
      if (scenario === "abort-tool") expect(output).not.toContain("opaque-id");
      expect(() =>
        curateRpcCapture({ recordDir: test.root, outputDir: test.outputDir }),
      ).toThrow(/EEXIST/u);
    },
  );
  it.each([
    { source: "synthetic" },
    { status: "failed" },
    { scenario: "../../escape" },
    { privateText: "Bearer private-key" },
  ])("refuses unsafe/incomplete evidence: %j", (options) => {
    if (options.scenario !== undefined) {
      const test = setup();
      const path = join(test.root, "summary.json");
      const report = JSON.parse(readFileSync(path, "utf8"));
      report.scenarios[0].scenario = options.scenario;
      writeFileSync(path, JSON.stringify(report));
      expect(() =>
        curateRpcCapture({ recordDir: test.root, outputDir: test.outputDir }),
      ).toThrow();
      expect(existsSync(test.outputDir)).toBe(false);
      return;
    }
    const test = setup(options);
    expect(() =>
      curateRpcCapture({ recordDir: test.root, outputDir: test.outputDir }),
    ).toThrow();
    expect(existsSync(test.outputDir)).toBe(false);
  });
  it("refuses a capture/header mismatch and invalid record ranges", () => {
    for (const fault of ["header", "range"] as const) {
      const test = setup();
      const path = join(test.root, "summary.json");
      const report = JSON.parse(readFileSync(path, "utf8"));
      if (fault === "header") report.piVersion = "different";
      else report.scenarios[0].turns[0].recordEnd = 999;
      writeFileSync(path, JSON.stringify(report));
      expect(() =>
        curateRpcCapture({ recordDir: test.root, outputDir: test.outputDir }),
      ).toThrow();
      expect(existsSync(test.outputDir)).toBe(false);
    }
  });
  it("shows no-model help and rejects invalid CLI arguments", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    rpcCurateMain(["--help"]);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("No model requests"),
    );
    for (const argv of [[], ["--unknown"], ["input", "--out"]])
      expect(() => rpcCurateMain(argv)).toThrow(/Usage/u);
    const test = setup();
    rpcCurateMain([test.root, test.outputDir]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Prepared 1"));
  });
});
