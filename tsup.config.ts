import { existsSync, rmSync } from "node:fs";
import { defineConfig } from "tsup";

export default defineConfig(() => {
  const entry = Object.fromEntries(
    Object.entries({
      prefaix: "src/cli/index.ts",
      "pi-bridge": "src/agents/pi/bridge.ts",
    }).filter(([, path]) => existsSync(path)),
  );

  if (Object.keys(entry).length === 0) {
    rmSync("dist", { recursive: true, force: true });
    console.info("No application entry points yet; skipping build.");
    return [];
  }

  return {
    entry,
    format: ["esm"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    outExtension: () => ({ js: ".js" }),
    sourcemap: true,
    splitting: false,
    clean: true,
  };
});
