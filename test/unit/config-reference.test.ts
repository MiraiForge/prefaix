import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { configReference } from "../../scripts/config-reference.js";

it("keeps the published configuration reference equal to the schema", () => {
  const reference = configReference();
  expect(readFileSync("docs/CONFIGURATION.md", "utf8")).toBe(reference);
  expect(reference).toContain("PREFAIX_AGENT_PI_SESSION_DIR");
  expect(reference).toContain("personas.<name>.tools");
});
