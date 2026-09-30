// Lightweight help metadata; importing this must not construct the fixtures.
export const SCENARIO_NAMES = [
  "buffer",
  "burst",
  "dialog",
  "error",
  "hello",
  "long",
  "markdown",
  "retry",
  "tools",
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];
