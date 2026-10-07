import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPiAdapter,
  type PiSession,
} from "../../src/agents/pi/adapter.js";
import { TurnMapper } from "../../src/agents/pi/mapping.js";
import {
  PiRpc,
  type PiChild,
  type SpawnChild,
} from "../../src/agents/pi/rpc.js";
import type { AgentEvent, PromptInput } from "../../src/core/agent-port.js";
import {
  Recording,
  spawnRpcProcess,
  until,
} from "../../scripts/spikes/rpc-live.js";
import { assertLiveAllowed } from "../../scripts/live-guard.js";
import { expectTurnInvariants } from "../contract/suite.js";

const ROOT = resolve(".");
const CHILD = join(ROOT, "test/fixtures/pi/child.mjs");
const FIXTURES = join(ROOT, "test/fixtures/pi/recorded");
const roots: string[] = [];
const directory = () => {
  const root = mkdtempSync(join(tmpdir(), "pfx-recorded-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const input: PromptInput = {
  text: "fixture replay, never a model request",
  context: {
    shell: { kind: "zsh", version: "5.9", shellId: "test", pid: 1 },
    cwd: ROOT,
    recent: [],
    os: "test",
    term: { cols: 80, rows: 24, colors: 256 },
  },
};
function records(name: string): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
async function session(name: string, spawn?: SpawnChild): Promise<PiSession> {
  return (await createPiAdapter({
    rpc: {
      bin: process.execPath,
      args: [CHILD, join(FIXTURES, `${name}.jsonl`)],
      ...(spawn === undefined ? {} : { spawn }),
      readyTimeoutMs: 2000,
      requestTimeoutMs: 2000,
      termGraceMs: 100,
      killGraceMs: 100,
    },
  }).open({ root: ROOT, env: {} })) as PiSession;
}

describe("reviewed native S1 fixtures", () => {
  it("keeps source, exact selection, provenance, and private-data redactions explicit", () => {
    const names = readdirSync(FIXTURES).filter((name) =>
      name.endsWith(".jsonl"),
    );
    expect(names).toHaveLength(11);
    for (const name of names) {
      const raw = readFileSync(join(FIXTURES, name), "utf8");
      const header = JSON.parse(raw.split("\n")[0]!) as Record<string, unknown>;
      expect(header).toMatchObject({
        type: "prefaix_fixture_header",
        curated: true,
        piVersion: "1.0.4",
        provider: "kimi-coding",
        model: "kimi-coding/k3",
      });
      expect(["live", "controlled"]).toContain(header["source"]);
      const provenance = header["provenance"] as Record<string, unknown>;
      expect(provenance["sha256"]).toMatch(/^[a-f0-9]{64}$/u);
      expect(provenance["recordRange"]).toHaveLength(2);
      expect(() =>
        assertLiveAllowed({
          PREFAIX_LIVE_PROVIDER: String(header["provider"]),
          PREFAIX_LIVE_MODEL: String(header["model"]),
        }),
      ).not.toThrow();
      expect(raw).not.toMatch(
        /thinkingSignature|textSignature|"timestamp"|"partial"|\/home\/|\/Users\/|op:\/\/|Bearer\s|sk-[a-zA-Z0-9_-]{16,}/u,
      );
      if (header["source"] === "controlled")
        expect(header["stimulus"]).toMatchObject({
          api: "loopback-stub",
          remoteModelRequests: 0,
          scriptedUsage: true,
        });
    }
  });

  it.each(["compact-threshold", "compact-overflow"])(
    "replays %s through the real adapter/transport without early settlement",
    async (name) => {
      const opened = await session(name);
      try {
        const events: AgentEvent[] = [];
        for await (const event of opened.prompt(
          input,
          new AbortController().signal,
        ))
          events.push(event);
        expectTurnInvariants(events);
        expect(events.at(-1)).toEqual({ type: "settled", stopReason: "stop" });
        expect(events.filter((e) => e.type === "compaction")).toMatchObject([
          { phase: "start" },
          { phase: "end", ok: true },
        ]);
        expect(events.findIndex((e) => e.type === "compaction")).toBeLessThan(
          events.length - 1,
        );
        // Overflow has a raw willRetry:false agent_end *before* recovery.
        const wire = records(name);
        expect(wire.find((r) => r["type"] === "agent_end")).toMatchObject({
          willRetry: false,
        });
        expect(wire.filter((r) => r["type"] === "agent_start")).toHaveLength(
          name === "compact-overflow" ? 2 : 1,
        );
      } finally {
        await opened.close();
      }
    },
  );

  it("manual compaction resolves its RPC response without inventing an agent_settled", async () => {
    const opened = await session("compact-manual");
    try {
      const result = await opened.compact();
      expect(result.summary).toContain("S1 controlled compact-manual");
      expect(result.tokensBefore).toBeGreaterThan(0);
      expect(
        records("compact-manual").some((r) => r["type"] === "agent_settled"),
      ).toBe(false);
      expect((await opened.state()).busy).toBe(false);
    } finally {
      await opened.close();
    }
  });

  it("a killed replay child synthesizes exactly one normalized error", async () => {
    let child: PiChild | undefined;
    const opened = await session("kill-text", (bin, args, options) => {
      child = spawnRpcProcess(bin, args, options);
      return child;
    });
    try {
      const events: AgentEvent[] = [];
      let killed = false;
      for await (const event of opened.prompt(
        input,
        new AbortController().signal,
      )) {
        events.push(event);
        if (event.type === "text_delta" && !killed) {
          expect(child).toBeDefined();
          child?.kill("SIGKILL");
          killed = true;
        }
      }
      expectTurnInvariants(events);
      expect(events.at(-1)).toMatchObject({
        type: "settled",
        stopReason: "error",
      });
      expect(
        records("kill-text").some((r) => r["type"] === "agent_settled"),
      ).toBe(false);
    } finally {
      await opened.close();
    }
  });

  it.each(["abort-text", "abort-tool", "retry-abort"])(
    "%s drains settlement before the abort response on every turn",
    async (name) => {
      const root = directory();
      const capture = new Recording(root, name, {
        source: "synthetic",
        provider: "kimi-coding",
        model: "kimi-coding/k3",
        piVersion: "replay",
        recordedAt: "test",
      });
      const rpc = new PiRpc({
        bin: process.execPath,
        args: [CHILD, join(FIXTURES, `${name}.jsonl`)],
        cwd: ROOT,
        env: {},
        spawn: capture.wrap(spawnRpcProcess),
        readyTimeoutMs: 2000,
        requestTimeoutMs: 2000,
      });
      try {
        await rpc.waitReady();
        for (let turn = 0; turn < 2; turn++) {
          const start = capture.records.length;
          await rpc.request("prompt", { message: "replay" });
          const wire = () => capture.records.slice(start);
          const trigger =
            name === "abort-tool"
              ? "tool_execution_update"
              : name === "retry-abort"
                ? "auto_retry_start"
                : "message_update";
          await until(
            () => wire().some((r) => r["type"] === trigger),
            rpc,
            { recordDir: root, timeoutMs: 2000 },
            "causal hold",
          );
          expect(wire().some((r) => r["type"] === "agent_settled")).toBe(false);
          await rpc.request("clear_queue");
          await rpc.request("abort");
          const settled = wire().findIndex(
            (r) => r["type"] === "agent_settled",
          );
          const ack = wire().findIndex(
            (r) => r["type"] === "response" && r["command"] === "abort",
          );
          expect(settled).toBeGreaterThan(0);
          expect(ack).toBeGreaterThan(settled);
          expect((await rpc.request("get_state")) as object).toMatchObject({
            isStreaming: false,
          });
        }
      } finally {
        await rpc.close();
      }
    },
  );

  it("preserves the mid-tool raw error while explicit abort intent stays authoritative", () => {
    const wire = records("abort-tool");
    const ended = wire.filter(
      (r) =>
        r["type"] === "message_end" &&
        (r["message"] as Record<string, unknown>)["role"] === "assistant",
    );
    expect(
      ended.map((r) => (r["message"] as Record<string, unknown>)["stopReason"]),
    ).toEqual(["toolUse", "error"]);
    const mapper = new TurnMapper();
    for (const record of wire) mapper.map(record as never);
    expect(mapper.settle("aborted")).toEqual({
      type: "settled",
      stopReason: "aborted",
    });
  });
});
