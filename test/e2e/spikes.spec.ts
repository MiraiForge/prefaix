// Opt-in native probes, never a model request. Dependency paths point to
// separately installed/reviewed shell addons; no downloads or user rc edits.
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config/schema.js";
import { resolvePaths } from "../../src/core/paths.js";
import { initShell } from "../../src/shells/plugins/index.js";
import { ShellSession, TEST_SHELLS, type ShellKind } from "./harness.js";

const homes: string[] = [],
  sessions: ShellSession[] = [];
function dependency(key: string, fallback: string): string {
  const path = process.env[key] ?? fallback;
  if (!existsSync(path))
    throw new Error(`Missing native spike dependency ${key}: ${path}`);
  return path.replaceAll("'", "'\\''");
}
async function fixture(
  shell: ShellKind,
  before = "",
  after = "",
  existingHome?: string,
  rprompt: "off" | "on" = "off",
) {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), "pfx-native-shell-"));
  if (existingHome === undefined) homes.push(home);
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(
    join(home, "bin/prefaix"),
    `#!/bin/sh\nexport PREFAIX_BACKEND=fake PREFAIX_FAKE_SCENARIO=long\nexec '${process.execPath}' '${join(process.cwd(), "dist/prefaix.js")}' "$@"\n`,
  );
  chmodSync(join(home, "bin/prefaix"), 0o755);
  writeFileSync(
    join(home, "starship.toml"),
    'format = "__pfx "\nright_format = "right"\nadd_newline = false\n',
  );
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "run"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"),
    STARSHIP_CONFIG: join(home, "starship.toml"),
    PATH: join(home, "bin") + ":" + process.env["PATH"],
  };
  const config = defaultConfig();
  const script = initShell(shell, {
    config: { ...config, ui: { ...config.ui, rprompt } },
    paths: resolvePaths({ home, env }),
  });
  const s = await ShellSession.start({
    shell,
    env,
    initScript: before + "\n" + script + "\n" + after,
    timeoutMs: 15_000,
    promptPattern:
      /^[^\w]*__pfx(?:\s+prefaix · [\w/-]+ · \d+% · (?:ready|idle|aborted|error|busy|streaming))?(?:[^\w]*right)?[^\w]*$/u,
  });
  sessions.push(s);
  return { s, home };
}
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const home of homes.splice(0)) {
    const lock = join(home, "run/prefaix/daemon.lock");
    if (existsSync(lock)) {
      try {
        process.kill(Number(readFileSync(lock, "utf8").trim()), "SIGTERM");
      } catch {
        /* stopped */
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
});

async function lifecycle(s: ShellSession) {
  const row = s.promptRow();
  s.paste(": native bracketed prompt");
  s.press("enter");
  await s.waitFor("Streaming a long answer");
  // A complete arrow sequence must not be mistaken for a lone abort Esc.
  s.send("\x1b[A");
  s.resize(72, 22);
  s.send("typed-must-wait");
  s.send("\x1b");
  await s.waitFor("typed-must-wait");
  s.send("X");
  await s.waitFor(/typed-must-wait\s*X/u);
  s.press("ctrl-c");
  await s.waitForPrompt({ afterRow: row });
  // A theme can paint before the editor accepts input. Prove edit readiness.
  s.paste("echo recovered");
  await s.waitFor(/__pfx[^\n]*echo recovered/u);
  s.press("enter");
  await s.waitFor(/^recovered$/mu);
  await s.waitForPrompt();
  expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toMatch(/^c_/u);
}

describe.skipIf(process.env["PREFAIX_SHELL_SPIKES"] !== "1")(
  "S4–S7 native shell probes",
  () => {
    for (const shell of TEST_SHELLS) {
      it(`${shell}: Node restores the widget's exact termios; Ctrl+C is a raw byte and resize is observed`, async () => {
        const { s, home } = await fixture(shell);
        const probe = join(home, "raw.cjs");
        const output = join(home, "raw.json");
        writeFileSync(
          probe,
          `const fs=require('node:fs'),cp=require('node:child_process');
const snapshot=()=>cp.execFileSync('stty',['-g'],{stdio:[0,'pipe','pipe'],encoding:'utf8'}).trim();
const result={before:snapshot(),resize:false};
process.stdin.setRawMode(true);result.raw=snapshot();
process.stdout.on('resize',()=>{result.resize=true;console.log('native resized');});
console.log('native raw ready');
process.stdin.once('data',bytes=>{result.bytes=[...bytes];process.stdin.setRawMode(false);result.after=snapshot();fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(result));process.stdin.pause();});`,
        );
        // Invoked through the actual plugin widget, not an ordinary shell command.
        writeFileSync(
          join(home, "bin/prefaix"),
          `#!/bin/sh\nexec '${process.execPath}' '${probe}'\n`,
        );
        const row = s.promptRow();
        s.sendLine(": raw child");
        await s.waitFor("native raw ready");
        s.resize(64, 18);
        await s.waitFor("native resized");
        s.send("\x03");
        await s.waitForPrompt({ afterRow: row });
        const result = JSON.parse(readFileSync(output, "utf8")) as {
          before: string;
          raw: string;
          after: string;
          bytes: number[];
          resize: boolean;
        };
        expect(result.raw).not.toBe(result.before);
        expect(result.after).toBe(result.before);
        expect(result.bytes).toEqual([3]);
        expect(result.resize).toBe(true);
        expect(await s.run("echo recovered")).toBe("recovered");
      });
      it(`${shell}: real client preserves arrow/typeahead and handles SIGWINCH`, async () => {
        const { s } = await fixture(shell);
        await lifecycle(s);
      });
    }
    if (TEST_SHELLS.includes("bash"))
      it("bash-preexec + starship retain the Enter macro and tty handoff", async () => {
        const preexec = dependency(
          "PREFAIX_SPIKE_PREEXEC",
          "/usr/share/bash-preexec/bash-preexec.sh",
        );
        execFileSync("starship", ["--version"]);
        const { s } = await fixture(
          "bash",
          `source '${preexec}'\neval "$(starship init bash)"`,
        );
        await lifecycle(s);
      });
    if (TEST_SHELLS.includes("fish"))
      it("fish starship right prompt wraps without breaking repaint/history", async () => {
        execFileSync("starship", ["--version"]);
        const { s } = await fixture(
          "fish",
          "starship init fish | source",
          "",
          undefined,
          "on",
        );
        expect(
          await s.run(
            "functions --query __prefaix_right_prompt_wrapped; echo $status",
          ),
        ).toBe("0");
        expect(await s.run("__prefaix_abbr :info")).toBe(":info");
        expect(await s.run("abbr --show __prefaix_command")).toContain(
          "--regex",
        );
        s.resize(42, 20);
        await lifecycle(s);
        expect(
          (await s.run("history --max=15")).includes(
            ": native bracketed prompt",
          ),
        ).toBe(true);
      });
    if (TEST_SHELLS.includes("zsh")) {
      it("zsh-vi-mode + autosuggestions + syntax-highlighting preserve Enter and bracketed paste", async () => {
        const vi = dependency(
          "PREFAIX_SPIKE_ZVM",
          "/usr/share/zsh/plugins/zsh-vi-mode/zsh-vi-mode.zsh",
        );
        const autosuggest = dependency(
          "PREFAIX_SPIKE_AUTOSUGGEST",
          "/usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh",
        );
        const highlight = dependency(
          "PREFAIX_SPIKE_HIGHLIGHT",
          "/usr/share/zsh/plugins/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh",
        );
        const { s } = await fixture(
          "zsh",
          `source '${vi}'\nsource '${autosuggest}'`,
          `source '${highlight}'`,
        );
        await lifecycle(s);
        expect(s.raw()).not.toContain("No such widget");
      });
      it("p10k generates then loads its real instant-prompt cache without duplicate prompt lines", async () => {
        const theme = dependency(
          "PREFAIX_SPIKE_P10K",
          "/usr/share/zsh-theme-powerlevel10k/powerlevel10k.zsh-theme",
        );
        const setup = `typeset -g POWERLEVEL9K_DISABLE_CONFIGURATION_WIZARD=true POWERLEVEL9K_DISABLE_GITSTATUS=true POWERLEVEL9K_INSTANT_PROMPT=quiet
if [[ -r "$XDG_CACHE_HOME/p10k-instant-prompt-\${(%):-%n}.zsh" ]]; then source "$XDG_CACHE_HOME/p10k-instant-prompt-\${(%):-%n}.zsh"; fi
source '${theme}'
typeset -g POWERLEVEL9K_LEFT_PROMPT_ELEMENTS=(pfx) POWERLEVEL9K_RIGHT_PROMPT_ELEMENTS=()
function prompt_pfx() { p10k segment -t '__pfx '; }`;
        const cold = await fixture("zsh", setup);
        await cold.s.run("true");
        const cache = readdirSync(join(cold.home, "cache")).filter(
          (name) =>
            name.startsWith("p10k-instant-prompt-") && name.endsWith(".zsh"),
        );
        expect(cache).toHaveLength(1);
        await cold.s.close();
        const warm = await fixture("zsh", setup, "", cold.home);
        await lifecycle(warm.s);
        expect(warm.s.raw()).not.toContain(
          "console output during zsh initialization",
        );
        expect(warm.s.screenText()).not.toMatch(/__pfx\s*\n\s*__pfx/u);
      });
    }
  },
);
