import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config/schema.js";
import { resolvePaths } from "../../src/core/paths.js";
import { initShell, type PluginShell } from "../../src/shells/plugins/index.js";

const shells: PluginShell[] = ["zsh", "fish", "bash"];
describe("embedded shell plugins", () => {
  it.each(shells)(
    "emits syntactically valid %s with safe literal configuration",
    (shell) => {
      const config = defaultConfig();
      const malicious =
        "/tmp/a'$(touch /tmp/prefaix-must-not-execute)`echo bad`\\path";
      const paths = { ...resolvePaths(), runtimeDir: malicious };
      const script = initShell(shell, {
        paths,
        config: { ...config, grammar: { passthrough: "^: skip(?:me)?\\s*$" } },
      });
      const checked = spawnSync(shell, ["-n"], {
        input: script,
        encoding: "utf8",
      });
      expect(checked.stderr).toBe("");
      expect(checked.status).toBe(0);
      const settings = script.split("\n").slice(0, 5).join("\n");
      const printed = spawnSync(
        shell,
        ["-c", settings + "\nprintf '%s' \"$__prefaix_runtime\""],
        { encoding: "utf8" },
      );
      expect(printed.stdout).toBe(malicious);
    },
  );
  it.each(shells)(
    "embeds %s without runtime file reads or unsafe directives evaluation",
    (shell) => {
      const script = initShell(shell);
      expect(script).toContain("prefaix_prompt_info");
      expect(script).toContain("--previous-conversation");
      expect(script).not.toMatch(/\beval\b|\bsource\b/);
    },
  );
  it("rejects NUL settings before emitting shell code", () => {
    expect(() =>
      initShell("bash", {
        paths: { ...resolvePaths(), runtimeDir: "bad\0value" },
      }),
    ).toThrow(/NUL/);
  });
});
