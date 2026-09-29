import { defineConfig } from "vitest/config";

// The project target is 95% or better on every metric. It is enforced when
// coverage runs, so `bun run coverage` and the CI coverage step fail if a
// change is not tested; `bun run test` stays fast and does not measure.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts", "test/contract/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Coverage is about the code prefaix ships, not the test harness.
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: {
        statements: 95,
        branches: 95,
        functions: 95,
        lines: 95,
      },
    },
  },
});
