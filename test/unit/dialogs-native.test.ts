import { describe, expect, it } from "vitest";
import { recordNativeDialogs } from "../../scripts/spikes/dialogs-native.js";

describe("native dialog probe cost guard", () => {
  it.each([
    {},
    { PREFAIX_LIVE_PROVIDER: "openai", PREFAIX_LIVE_MODEL: "openai/test" },
    {
      PREFAIX_LIVE_PROVIDER: "anthropic",
      PREFAIX_LIVE_MODEL: "anthropic/test",
    },
    {
      PREFAIX_LIVE_PROVIDER: "kimi-coding",
      PREFAIX_LIVE_MODEL: "openrouter/anthropic/test",
    },
  ])("refuses before spawning or writing evidence with %j", async (env) => {
    await expect(recordNativeDialogs("/never-created", env)).rejects.toThrow(
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
    "refuses allowed but non-loopback pairs before spawning with %j",
    async (env) => {
      await expect(recordNativeDialogs("/never-created", env)).rejects.toThrow(
        "Expected values to be strictly equal",
      );
    },
  );
});
