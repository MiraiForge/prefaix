import { describe, expect, it } from "vitest";
import {
  recordNativePersonas,
  transcriptToolSets,
} from "../../scripts/spikes/personas-native.js";

describe("native persona cost guard", () => {
  it("reconstructs transcript tool schemas at every user turn from native deltas", () => {
    const records = [
      { type: "session" },
      {
        message: {
          role: "system",
          toolsAdded: [{ name: "read" }, { name: "bash" }],
        },
      },
      { message: { role: "user" } },
      { message: { role: "assistant" } },
      {
        message: {
          role: "system",
          sections: { persona: "ask" },
          toolsRemoved: [{ name: "bash" }],
        },
      },
      { message: { role: "user" } },
      {
        message: {
          role: "system",
          sections: { persona: null },
          toolsAdded: [{ name: "bash" }],
        },
      },
      { message: { role: "user" } },
    ];
    expect(transcriptToolSets(records)).toEqual([
      ["bash", "read"],
      ["read"],
      ["bash", "read"],
    ]);
    expect(transcriptToolSets([])).toEqual([]);
  });

  it.each([
    {},
    { PREFAIX_LIVE_PROVIDER: "openai", PREFAIX_LIVE_MODEL: "openai/test" },
    {
      PREFAIX_LIVE_PROVIDER: "kimi-coding",
      PREFAIX_LIVE_MODEL: "openrouter/anthropic/test",
    },
  ])("refuses before spawning or writing evidence with %j", async (env) => {
    await expect(recordNativePersonas("/never-created", env)).rejects.toThrow(
      "Refusing to send a model request",
    );
  });
  it.each([
    { PREFAIX_LIVE_PROVIDER: "google", PREFAIX_LIVE_MODEL: "google/test" },
    {
      PREFAIX_LIVE_PROVIDER: "kimi-coding",
      PREFAIX_LIVE_MODEL: "kimi-coding/other",
    },
  ])(
    "refuses an allowed but non-loopback pair before spawning %j",
    async (env) => {
      await expect(recordNativePersonas("/never-created", env)).rejects.toThrow(
        "Expected values to be strictly equal",
      );
    },
  );
});
