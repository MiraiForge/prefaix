import { describe, expect, it } from "vitest";
import { assertLiveAllowed, LiveGuardError } from "../../scripts/live-guard.js";

const allowed = {
  PREFAIX_LIVE_PROVIDER: "google",
  PREFAIX_LIVE_MODEL: "google/gemini-3.8-flash",
};

describe("live guard", () => {
  it("passes an allowed provider and model, with both pinned on argv", () => {
    expect(assertLiveAllowed(allowed)).toEqual({
      provider: "google",
      model: "google/gemini-3.8-flash",
      args: ["--provider", "google", "--model", "google/gemini-3.8-flash"],
    });
  });

  it("refuses when either variable is missing", () => {
    expect(() => assertLiveAllowed({})).toThrow(/PREFAIX_LIVE_PROVIDER/);
    expect(() =>
      assertLiveAllowed({ PREFAIX_LIVE_PROVIDER: "google" }),
    ).toThrow(/PREFAIX_LIVE_MODEL/);
    expect(() =>
      assertLiveAllowed({ ...allowed, PREFAIX_LIVE_MODEL: "" }),
    ).toThrow(LiveGuardError);
  });

  it("refuses the vendors development never bills", () => {
    for (const provider of [
      "anthropic",
      "anthropic-compatible",
      "openai",
      "openai-compatible",
      "openai-codex",
      "openai-codex-custom",
    ]) {
      expect(() =>
        assertLiveAllowed({ ...allowed, PREFAIX_LIVE_PROVIDER: provider }),
      ).toThrow(/not allowed/);
    }
  });

  it("is case insensitive about the refused vendors", () => {
    expect(() =>
      assertLiveAllowed({ ...allowed, PREFAIX_LIVE_PROVIDER: "OpenAI" }),
    ).toThrow(/not allowed/);
  });

  it("refuses a refused vendor behind an allowed router", () => {
    expect(() =>
      assertLiveAllowed({
        PREFAIX_LIVE_PROVIDER: "openrouter",
        PREFAIX_LIVE_MODEL: "anthropic/claude-sonnet-5",
      }),
    ).toThrow(/not allowed/);
    expect(() =>
      assertLiveAllowed({
        PREFAIX_LIVE_PROVIDER: "openrouter",
        PREFAIX_LIVE_MODEL: "openai/gpt-5",
      }),
    ).toThrow(/not allowed/);
  });

  it("refuses a refused vendor anywhere in a router-qualified slug", () => {
    // The prefix check alone would pass this, because it starts with
    // "openrouter", and pi would then be asked for a refused vendor.
    for (const slug of [
      "openrouter/anthropic/claude-sonnet-5",
      "some-router/openai/gpt-5",
      "gateway/openai-codex/o3",
      "gateway/anthropic-compatible/claude",
      "gateway/openai-compatible/gpt",
    ]) {
      expect(() =>
        assertLiveAllowed({
          PREFAIX_LIVE_PROVIDER: "openrouter",
          PREFAIX_LIVE_MODEL: slug,
        }),
      ).toThrow(/not allowed/);
    }
  });

  it("still allows an allowed model through a router", () => {
    expect(
      assertLiveAllowed({
        PREFAIX_LIVE_PROVIDER: "openrouter",
        PREFAIX_LIVE_MODEL: "openrouter/google/gemini-3.8-flash",
      }).model,
    ).toBe("openrouter/google/gemini-3.8-flash");
  });

  it("refuses a model with no vendor, which would fall back to the default", () => {
    expect(() =>
      assertLiveAllowed({ ...allowed, PREFAIX_LIVE_MODEL: "gemini-3.8-flash" }),
    ).toThrow(/no provider prefix/);
  });

  it("points at the alternatives instead of just refusing", () => {
    expect(() => assertLiveAllowed({})).toThrow(/fixture|no-model probe/);
  });
});
