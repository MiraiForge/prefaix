import { existsSync, rmSync } from "node:fs";
import { defineConfig, type Options } from "tsup";

export default defineConfig(() => {
  const entry = Object.fromEntries(
    Object.entries({
      prefaix: "src/cli/bin.ts",
      "pi-bridge": "src/agents/pi/bridge.ts",
    }).filter(([, path]) => existsSync(path)),
  );

  if (Object.keys(entry).length === 0) {
    rmSync("dist", { recursive: true, force: true });
    console.info("No application entry points yet; skipping build.");
    return [];
  }

  // Clean once before either build starts; per-build cleaning can delete
  // another configuration's output while tsup runs them concurrently.
  rmSync("dist", { recursive: true, force: true });
  const common: Options = {
    format: ["esm"],
    platform: "node",
    target: "node22",
    outDir: "dist",
    outExtension: () => ({ js: ".js" }),
    sourcemap: true,
    minify: true,
    noExternal: ["smol-toml"],
    clean: false,
  };
  return [
    { ...common, entry, splitting: true },
    ...(existsSync("src/cli/run.ts")
      ? [
          {
            ...common,
            // One cacheable foreground module, without pulling daemon/adapters
            // into it or resolving a graph of shared chunks on every shell turn.
            entry: { client: "src/cli/run.ts" },
            splitting: false,
          },
        ]
      : []),
  ];
});
