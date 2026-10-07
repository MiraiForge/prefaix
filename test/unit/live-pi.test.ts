import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openLivePi } from "../../scripts/live-pi.js";
import { PiSession } from "../../src/agents/pi/adapter.js";
import type { SpawnChild } from "../../src/agents/pi/rpc.js";
import { spawnRpcProcess } from "../../scripts/spikes/rpc-live.js";

const root = resolve(".");
const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const allowed = {
  PREFAIX_LIVE_PROVIDER: "kimi-coding",
  PREFAIX_LIVE_MODEL: "kimi-coding/k3",
};
function fixture(name = "recorded/stream.jsonl") {
  const dir = mkdtempSync(join(tmpdir(), "pfx-live-policy-"));
  dirs.push(dir);
  const trace = join(dir, "commands.jsonl");
  const spawn = vi.fn<SpawnChild>((_bin, _args, options) =>
    spawnRpcProcess(
      process.execPath,
      [
        join(root, "test/fixtures/pi/child.mjs"),
        join(root, "test/fixtures/pi", name),
      ],
      { ...options, env: { PREFAIX_CHILD_TRACE: trace } },
    ),
  );
  return {
    spawn,
    trace,
    config: { rpc: { spawn, readyTimeoutMs: 4000, requestTimeoutMs: 2000 } },
  };
}
const options = { root, env: {} };
describe("guarded adapter launch (scripted child, never a model)", () => {
  it("pins both exact launch flags and verifies actual state before returning", async () => {
    const f = fixture();
    const session = await openLivePi(options, f.config, allowed);
    try {
      const args = f.spawn.mock.calls[0]![1];
      expect(
        args.slice(args.indexOf("--provider"), args.indexOf("--provider") + 2),
      ).toEqual(["--provider", "kimi-coding"]);
      expect(
        args.slice(args.indexOf("--model"), args.indexOf("--model") + 2),
      ).toEqual(["--model", "kimi-coding/k3"]);
      const commands = readFileSync(f.trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      expect(commands.some((c) => c.type === "get_state")).toBe(true);
      expect(commands.some((c) => c.type === "prompt")).toBe(false);
    } finally {
      await session.close();
    }
  });
  it.each([
    {},
    { PREFAIX_LIVE_PROVIDER: "kimi-coding" },
    {
      PREFAIX_LIVE_PROVIDER: "anthropic",
      PREFAIX_LIVE_MODEL: "anthropic/claude",
    },
    { PREFAIX_LIVE_PROVIDER: "google", PREFAIX_LIVE_MODEL: "kimi-coding/k3" },
    {
      PREFAIX_LIVE_PROVIDER: "kimi-coding",
      PREFAIX_LIVE_MODEL: "kimi-coding/",
    },
  ])(
    "refuses missing, forbidden or inconsistent selections before spawn: %j",
    async (env) => {
      const f = fixture();
      await expect(openLivePi(options, f.config, env)).rejects.toThrow();
      expect(f.spawn).not.toHaveBeenCalled();
    },
  );
  it("refuses an open-option override before spawning", async () => {
    const f = fixture();
    await expect(
      openLivePi(
        { ...options, model: { provider: "zai", id: "glm-5.3-flash" } },
        f.config,
        allowed,
      ),
    ).rejects.toThrow("differs");
    expect(f.spawn).not.toHaveBeenCalled();
  });
  it("closes a child with a mismatched native selection, without prompting", async () => {
    const f = fixture("stream.jsonl");
    const close = vi.spyOn(PiSession.prototype, "close");
    await expect(openLivePi(options, f.config, allowed)).rejects.toThrow(
      "did not select",
    );
    expect(close).toHaveBeenCalledOnce();
    expect(readFileSync(f.trace, "utf8")).not.toContain('"type":"prompt"');
  });
  it("closes on state failure and preserves that error even if close fails", async () => {
    const f = fixture();
    vi.spyOn(PiSession.prototype, "state").mockRejectedValueOnce(
      new Error("state failed"),
    );
    const original = PiSession.prototype.close;
    vi.spyOn(PiSession.prototype, "close").mockImplementationOnce(
      async function (this: PiSession) {
        await original.call(this);
        throw new Error("close failed");
      },
    );
    await expect(openLivePi(options, f.config, allowed)).rejects.toThrow(
      "state failed",
    );
    expect(readFileSync(f.trace, "utf8")).not.toContain('"type":"prompt"');
  });
});
