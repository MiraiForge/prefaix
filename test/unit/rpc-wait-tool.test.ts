import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerWaitTool, {
  WAIT_STARTED,
  WAIT_TOOL,
  type WaitTool,
} from "../../scripts/spikes/rpc-wait-tool.js";

// Accelerate only the duration. Node still supplies the real cancellation and
// timer cleanup behavior; its promises timers are not Vitest's fake timers.
vi.mock("node:timers/promises", async (importOriginal) => {
  const timers = await importOriginal<typeof import("node:timers/promises")>();
  return {
    ...timers,
    setTimeout: vi.fn((ms, value, options) =>
      timers.setTimeout(Math.min(ms as number, 20), value, options),
    ),
  };
});

function registeredTool(): WaitTool {
  let tool: WaitTool | undefined;
  registerWaitTool({
    registerTool(value) {
      tool = value;
    },
  });
  if (tool === undefined) throw new Error("S1 wait tool was not registered");
  return tool;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("S1's side-effect-free abort target", () => {
  it("registers an empty-argument tool without starting timers or model work", () => {
    const tool = registeredTool();
    expect(tool.name).toBe(WAIT_TOOL);
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(delay).not.toHaveBeenCalled();
  });

  it("reports that execution started, requests 30 seconds, and reports completion", async () => {
    const updates = vi.fn();
    const controller = new AbortController();
    const completed = registeredTool().execute(
      "call1",
      {},
      controller.signal,
      updates,
    );
    expect(updates).toHaveBeenCalledExactlyOnceWith({
      content: [{ type: "text", text: WAIT_STARTED }],
      details: undefined,
    });
    expect(delay).toHaveBeenCalledExactlyOnceWith(30_000, undefined, {
      signal: controller.signal,
    });
    await expect(completed).resolves.toEqual({
      content: [{ type: "text", text: "S1_WAIT_COMPLETED" }],
      details: undefined,
    });
    controller.abort();
  });

  it("cancels the wait on mid-tool abort", async () => {
    const controller = new AbortController();
    const completed = registeredTool().execute("call1", {}, controller.signal);
    const rejected = expect(completed).rejects.toThrow(/abort/iu);
    controller.abort();
    await rejected;
  });

  it("does not report a start or allocate a timer for an already-aborted turn", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already aborted"));
    const updates = vi.fn();
    await expect(
      registeredTool().execute("call1", {}, controller.signal, updates),
    ).rejects.toThrow(/already aborted/);
    expect(updates).not.toHaveBeenCalled();
    expect(delay).not.toHaveBeenCalled();
  });

  it("also honors a cancellation from the update callback", async () => {
    const controller = new AbortController();
    await expect(
      registeredTool().execute("call1", {}, controller.signal, () =>
        controller.abort(),
      ),
    ).rejects.toThrow(/abort/iu);
  });

  it("works without an optional signal or update callback", async () => {
    await expect(
      registeredTool().execute("call1", {}, undefined),
    ).resolves.toMatchObject({ content: [{ text: "S1_WAIT_COMPLETED" }] });
    expect(delay).toHaveBeenCalledExactlyOnceWith(30_000, undefined, {});
  });
});
