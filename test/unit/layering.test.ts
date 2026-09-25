import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const eslint = new ESLint({ cwd: root });

describe("architecture import boundaries", () => {
  it.each([
    [
      "client value import",
      "src/client/run.ts",
      'import { PiAdapter } from "../agents/pi/adapter.js"; export { PiAdapter };',
      "no-restricted-imports",
    ],
    [
      "nested client import",
      "src/client/render/output.ts",
      'export { PiAdapter } from "../../agents/pi/adapter.js";',
      "no-restricted-imports",
    ],
    [
      "client type import",
      "src/client/run.ts",
      'import type { Session } from "../agents/pi/adapter.js"; export type { Session };',
      "no-restricted-imports",
    ],
    [
      "shell re-export",
      "src/shells/grammar.ts",
      'export * from "../agents/registry.js";',
      "no-restricted-imports",
    ],
    [
      "core registry import",
      "src/core/events.ts",
      'export * from "../agents/registry.js";',
      "no-restricted-imports",
    ],
    [
      "daemon concrete adapter",
      "src/daemon/pool.ts",
      'export * from "../agents/pi/adapter.js";',
      "no-restricted-imports",
    ],
    [
      "client dynamic import",
      "src/client/run.ts",
      'export const adapter = import("../agents/pi/adapter.js");',
      "no-restricted-syntax",
    ],
    [
      "shell import type expression",
      "src/shells/grammar.ts",
      'export type Session = import("../agents/pi/adapter.js").Session;',
      "no-restricted-syntax",
    ],
    [
      "daemon dynamic concrete adapter",
      "src/daemon/pool.ts",
      'export const adapter = import("../agents/pi/adapter.js");',
      "no-restricted-syntax",
    ],
  ])("rejects %s", async (_name, filePath, code, rule) => {
    const [result] = await eslint.lintText(code, { filePath });
    expect(result?.messages.map((message) => message.ruleId)).toContain(rule);
  });

  it.each([
    ["src/client/run.ts", 'export * from "../core/agent-port.js";'],
    ["src/client/run.ts", 'export * from "../core/agents-tools.js";'],
    ["src/shells/grammar.ts", 'export * from "../core/events.js";'],
    ["src/daemon/pool.ts", 'export * from "../agents/registry.js";'],
    [
      "src/daemon/pool.ts",
      'export const registry = import("../agents/registry.js");',
    ],
    ["src/agents/registry.ts", 'export * from "./pi/adapter.js";'],
    ["src/agents/pi/adapter.ts", 'export * from "./rpc.js";'],
    [
      "test/unit/adapter.test.ts",
      'export * from "../../src/agents/pi/adapter.js";',
    ],
  ])("allows valid wiring in %s: %s", async (filePath, code) => {
    const [result] = await eslint.lintText(code, { filePath });
    expect(result?.messages).toEqual([]);
  });

  it("exits unsuccessfully when the CLI lints a client-to-agent import", () => {
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(
          new URL("../../node_modules/eslint/bin/eslint.js", import.meta.url),
        ),
        "--stdin",
        "--stdin-filename",
        "src/client/boundary-probe.ts",
      ],
      {
        cwd: root,
        input: 'export * from "../agents/pi/adapter.js";',
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("no-restricted-imports");
  });
});
