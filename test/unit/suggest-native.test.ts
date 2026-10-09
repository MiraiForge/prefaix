import { expect, it } from "vitest";
import { recordNativeSuggest } from "../../scripts/spikes/suggest-native.js";
it.each([
  {},
  { PREFAIX_LIVE_PROVIDER: "kimi-coding" },
  { PREFAIX_LIVE_MODEL: "kimi-coding/k3" },
  { PREFAIX_LIVE_PROVIDER: "anthropic", PREFAIX_LIVE_MODEL: "claude" },
  { PREFAIX_LIVE_PROVIDER: "openai-codex", PREFAIX_LIVE_MODEL: "gpt" },
  { PREFAIX_LIVE_PROVIDER: "openrouter", PREFAIX_LIVE_MODEL: "openai/gpt" },
  {
    PREFAIX_LIVE_PROVIDER: "openrouter",
    PREFAIX_LIVE_MODEL: "anthropic/claude",
  },
])(
  "refuses native suggest capture before creating files, children, or APIs %#",
  async (env) => {
    await expect(
      recordNativeSuggest("/path-that-must-not-be-created", env),
    ).rejects.toThrow();
  },
);
