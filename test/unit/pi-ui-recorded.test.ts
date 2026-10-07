import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createPiAdapter,
  type PiSession,
} from "../../src/agents/pi/adapter.js";
import { Recording, spawnRpcProcess } from "../../scripts/spikes/rpc-live.js";
import type { AgentEvent, PromptInput } from "../../src/core/agent-port.js";
import { expectTurnInvariants } from "../contract/suite.js";

const root = resolve(".");
const input: PromptInput = {
  text: "recorded native UI, no model call",
  context: {
    shell: { kind: "zsh", version: "test", shellId: "test", pid: 1 },
    cwd: root,
    recent: [],
    os: "test",
    term: { cols: 80, rows: 24, colors: 256 },
  },
};
describe("native pre-acknowledgment dialog replay", () => {
  it("requires a fresh matching UI response before prompt acknowledgment on every turn", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pfx-native-ui-"));
    const recording = new Recording(dir, "replay", {
      source: "synthetic",
      provider: "kimi-coding",
      model: "kimi-coding/k3",
      piVersion: "replay",
      recordedAt: "test",
    });
    const session = (await createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          join(root, "test/fixtures/pi/child.mjs"),
          join(root, "test/fixtures/pi/recorded/bridge.jsonl"),
        ],
        spawn: recording.wrap(spawnRpcProcess),
        readyTimeoutMs: 4000,
        requestTimeoutMs: 2000,
      },
    }).open({ root, env: {} })) as PiSession;
    try {
      for (let turn = 0; turn < 2; turn++) {
        const start = recording.records.length;
        const events: AgentEvent[] = [];
        for await (const event of session.prompt(
          input,
          new AbortController().signal,
        )) {
          events.push(event);
          if (event.type === "ui_request") {
            expect(
              recording.records
                .slice(start)
                .some((r) => r["command"] === "prompt"),
            ).toBe(false);
            session.respondUi(event.id, { value: "main" });
          }
        }
        expectTurnInvariants(events);
        expect(events.at(-1)).toEqual({ type: "settled", stopReason: "stop" });
        expect(events).toContainEqual({
          type: "set_buffer",
          text: "echo suggestion-waits-for-enter",
        });
        const wire = recording.records.slice(start);
        const ui = wire.findIndex(
          (r) =>
            r["type"] === "extension_ui_request" && r["method"] === "select",
        );
        const ack = wire.findIndex((r) => r["command"] === "prompt");
        const agent = wire.findIndex((r) => r["type"] === "agent_start");
        expect(ui).toBeLessThan(ack);
        expect(ack).toBeLessThan(agent);
      }
    } finally {
      await session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("aborts locally while a pre-ack dialog is unanswered, without waiting for its timeout", async () => {
    const session = await createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: [
          join(root, "test/fixtures/pi/child.mjs"),
          join(root, "test/fixtures/pi/recorded/bridge.jsonl"),
        ],
        readyTimeoutMs: 4000,
        requestTimeoutMs: 30000,
      },
    }).open({ root, env: {} });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    try {
      for await (const event of session.prompt(input, controller.signal)) {
        events.push(event);
        if (event.type === "ui_request") controller.abort();
      }
      expect(events.at(-1)).toEqual({ type: "settled", stopReason: "aborted" });
      expectTurnInvariants(events);
    } finally {
      await session.close();
    }
  });
  it("rejects a pending prompt promptly and leaves no abandoned queue read for the next turn", async () => {
    const script = `let n=0;require("readline").createInterface({input:process.stdin}).on("line",line=>{
      const c=JSON.parse(line);const w=x=>console.log(JSON.stringify(x));
      if(c.type==="get_state"){w({id:c.id,type:"response",command:c.type,success:true,data:{sessionId:"test"}});return;}
      if(c.type==="prompt"&&n++===0){w({id:c.id,type:"response",command:c.type,success:false,error:"rejected"});return;}
      w({id:c.id,type:"response",command:c.type,success:true});
      w({type:"agent_start"});w({type:"agent_settled"});
    });`;
    const session = await createPiAdapter({
      rpc: {
        bin: process.execPath,
        args: ["-e", script],
        readyTimeoutMs: 4000,
        requestTimeoutMs: 2000,
      },
    }).open({ root, env: {} });
    try {
      const collect = async () => {
        const events: AgentEvent[] = [];
        for await (const event of session.prompt(
          input,
          new AbortController().signal,
        ))
          events.push(event);
        return events;
      };
      expect((await collect()).at(-1)).toMatchObject({
        type: "settled",
        stopReason: "error",
        error: expect.stringContaining("rejected"),
      });
      expect((await collect()).at(-1)).toEqual({
        type: "settled",
        stopReason: "stop",
      });
    } finally {
      await session.close();
    }
  });
});
