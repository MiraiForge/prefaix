import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ShellSession,
  TEST_SHELLS,
  probeShell,
  resolveShellBin,
} from "./harness.js";
import { runSetup, shellRcFile, setupBlock } from "../../src/cli/setup.js";
import { defaultConfig } from "../../src/core/config/schema.js";
import { resolvePaths } from "../../src/core/paths.js";
import { initShell } from "../../src/shells/plugins/index.js";

const bundle = fileURLToPath(new URL("../../dist/prefaix.js", import.meta.url));
const node = process.execPath.includes("bun") ? "node" : process.execPath;
const homes: string[] = [];
const sessions: ShellSession[] = [];
afterEach(async () => {
  while (sessions.length > 0) await sessions.pop()!.close();
  while (homes.length > 0)
    rmSync(homes.pop()!, { recursive: true, force: true });
});
for (const shell of TEST_SHELLS) {
  const available = await probeShell(shell);
  describe.skipIf(!available.available)(
    `setup and uninstall in a temporary ${shell} HOME`,
    () => {
      if (shell === "bash") {
        it.each([".bash_profile", ".bash_login", ".profile"])(
          "loads the plugin in native bash -lic using the documented %s source line",
          async (profile) => {
            const home = mkdtempSync(join(tmpdir(), "pfx-login-"));
            homes.push(home);
            const bin = join(home, "bin");
            mkdirSync(bin);
            const env = {
              HOME: home,
              SHELL: resolveShellBin("bash"),
              PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
              TERM: "xterm-256color",
              XDG_RUNTIME_DIR: join(home, "run"),
              PREFAIX_PLUGIN_LOADED: "",
            };
            const plugin = join(home, "plugin.bash");
            writeFileSync(
              plugin,
              initShell("bash", {
                config: defaultConfig(),
                paths: resolvePaths({ home, env }),
              }),
            );
            writeFileSync(
              join(bin, "prefaix"),
              `#!/bin/sh\n[ "$1" = init ] && [ "$2" = bash ] || exit 2\nexec /bin/cat '${plugin}'\n`,
              { mode: 0o755 },
            );
            expect(
              await runSetup(["--shell", "bash", "--yes"], {
                env,
                out: () => undefined,
              }),
            ).toBe(0);
            const sourceLine = '[ -f "$HOME/.bashrc" ] && . "$HOME/.bashrc"\n';
            writeFileSync(join(home, profile), sourceLine);
            const output = execFileSync(
              resolveShellBin("bash"),
              [
                "-lic",
                'printf "plugin=%s shell=%s\\n" "$PREFAIX_PLUGIN_LOADED" "$PREFAIX_SHELL"; declare -F __prefaix_directives',
              ],
              {
                env,
                cwd: home,
                encoding: "utf8",
                timeout: 10_000,
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            expect(output).toContain("plugin=1 shell=bash");
            expect(output).toContain("__prefaix_directives");
            expect(readFileSync(join(home, profile), "utf8")).toBe(sourceLine);
          },
        );
      }
      it("installs a usable plugin once, backs up the rc, and preserves later user edits", async () => {
        const home = mkdtempSync(join(tmpdir(), "pfx-install-"));
        homes.push(home);
        const bin = join(home, "bin");
        mkdirSync(bin);
        // The real installed command is on PATH; no caller has to know the bundle location.
        writeFileSync(
          join(bin, "prefaix"),
          `#!/bin/sh\nexec '${node}' '${bundle}' "$@"\n`,
          { mode: 0o755 },
        );
        const env = {
          HOME: home,
          SHELL: resolveShellBin(shell),
          PATH: `${bin}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_STATE_HOME: join(home, "state"),
          XDG_CACHE_HOME: join(home, "cache"),
          XDG_RUNTIME_DIR: join(home, "run"),
          ZDOTDIR: home,
          PREFAIX_BACKEND: "fake",
          PREFAIX_SHELL: shell,
          PREFAIX_PLUGIN_LOADED: "",
          TERM: "xterm-256color",
        };
        const rc = shellRcFile(shell, home, env);
        mkdirSync(dirname(rc), { recursive: true });
        const original = "# Existing personal shell config\n";
        writeFileSync(rc, original);
        const cli = (command: string) =>
          execFileSync(node, [bundle, command, "--yes"], {
            env,
            encoding: "utf8",
            timeout: 10_000,
          });
        expect(cli("setup")).toContain("Installed prefaix initialization");
        const installed = readFileSync(rc, "utf8");
        expect(installed).toBe(original + setupBlock(shell));
        expect(cli("setup")).toContain("already installed");
        expect(readFileSync(rc, "utf8")).toBe(installed);
        const backupNames = readdirSync(dirname(rc)).filter((name) =>
          name.includes(".prefaix-backup-"),
        );
        expect(backupNames).toHaveLength(1);
        expect(readFileSync(join(dirname(rc), backupNames[0]!), "utf8")).toBe(
          original,
        );
        // Source the generated rc in a real interactive tty so syntax and plugin loading are exercised.
        const tty = await ShellSession.start({
          shell,
          env,
          cwd: home,
          initScript: `source '${rc}'`,
          timeoutMs: 20_000,
        });
        sessions.push(tty);
        const loaded = await tty.run(
          "printf 'plugin=%s\\n' \"$PREFAIX_PLUGIN_LOADED\"",
        );
        expect(loaded).toContain("plugin=1");
        writeFileSync(rc, installed + "# Added after setup\n");
        expect(cli("uninstall")).toContain("Removed prefaix initialization");
        expect(readFileSync(rc, "utf8")).toBe(
          original + "# Added after setup\n",
        );
        expect(cli("uninstall")).toContain("not installed");
        const unloaded = await ShellSession.start({
          shell,
          env,
          cwd: home,
          initScript: `source '${rc}'`,
          timeoutMs: 20_000,
        });
        sessions.push(unloaded);
        expect(
          await unloaded.run(
            "printf 'plugin=%s\\n' \"$PREFAIX_PLUGIN_LOADED\"",
          ),
        ).not.toContain("plugin=1");
      });
    },
  );
}
