import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  encodeReply,
  nativeApi,
  profileFiles,
  recordNativeM1,
} from "../../scripts/spikes/m1-native.js";
import rpcUiProbe from "../../scripts/spikes/rpc-ui.js";

describe("M1 controlled-native probe safety and scripted API", () => {
  it("encodes text/tool SSE with complete JSON arguments and honest scripted usage", () => {
    const wire = encodeReply([
      { type: "text", text: "hello" },
      {
        type: "tool_use",
        id: "local",
        name: "read",
        input: { path: "relative.txt" },
      },
    ]);
    expect(wire).toContain('"stop_reason":"tool_use"');
    expect(wire).toContain(
      JSON.stringify({
        partial_json: JSON.stringify({ path: "relative.txt" }),
      }).slice(1, -1),
    );
    expect(wire).toContain("event: message_stop");
    expect(encodeReply([{ type: "text", text: "answer" }])).toContain(
      '"stop_reason":"end_turn"',
    );
  });
  it("accepts only exact literal loopback profiles with dummy auth and no warming/retry", () => {
    expect(
      profileFiles("http://127.0.0.1:1234")["settings.json"],
    ).toMatchObject({
      cacheWarming: "off",
      retry: { enabled: false },
      enableInstallTelemetry: false,
    });
    for (const url of [
      "https://api.kimi.com",
      "http://localhost:1",
      "http://127.0.0.1:1/path",
    ])
      expect(() => profileFiles(url)).toThrow();
  });
  it("refuses missing selection before filesystem creation and rejects invalid samples", async () => {
    const root = mkdtempSync(join(tmpdir(), "pfx-m1-safety-"));
    try {
      const out = join(root, "recording");
      await expect(recordNativeM1(out, 20, {})).rejects.toThrow();
      await expect(
        recordNativeM1(out, 1, {
          PREFAIX_LIVE_PROVIDER: "kimi-coding",
          PREFAIX_LIVE_MODEL: "kimi-coding/k3",
        }),
      ).rejects.toThrow();
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("bounds methods, routes, model IDs, bodies and request count without forwarding", async () => {
    const api = await nativeApi(() => [{ type: "text", text: "scripted" }]);
    try {
      const request = (body: string, path = "/v1/messages") =>
        fetch(api.baseUrl + path, {
          method: "POST",
          body,
        });
      expect((await fetch(api.baseUrl + "/v1/messages")).status).toBe(400);
      expect((await request("{}", "/unexpected")).status).toBe(400);
      expect((await request('{"model":"wrong"}')).status).toBe(400);
      expect((await request("invalid JSON")).status).toBe(400);
      expect((await request("x".repeat(1_048_577))).status).toBe(400);
      for (let n = 0; n < 25; n++)
        expect((await request('{"model":"k3"}')).status).toBe(200);
      expect((await request('{"model":"k3"}')).status).toBe(400);
      expect(api.bodies).toHaveLength(25);
      expect(api.problem).toMatch(/refused/);
    } finally {
      await api.close();
    }
  });
  it("only requests UI for the probe marker, offering data rather than executing a command", async () => {
    let handler!: (event: { prompt?: string }, ctx: never) => Promise<void>;
    const calls: string[] = [];
    rpcUiProbe({
      on: (_name, fn) => {
        handler = fn;
      },
    });
    const ctx = {
      ui: {
        select: async () => "main",
        notify: (text: string) => calls.push(text),
        setStatus: () => {},
        setEditorText: (text: string) => calls.push(text),
      },
    };
    await handler({ prompt: "not a probe" }, ctx as never);
    expect(calls).toEqual([]);
    await handler({ prompt: "S9 DIALOG" }, ctx as never);
    expect(calls).toEqual([
      "S9 selected main",
      "echo suggestion-waits-for-enter",
    ]);
    ctx.ui.select = async () => undefined as never;
    await handler({ prompt: "S9 DIALOG" }, ctx as never);
    expect(calls).toContain("S9 selected cancelled");
  });
});
