import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/e2e/**/*.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // A pty test that leaves a shell behind would poison the next one.
    fileParallelism: false,
  },
});
