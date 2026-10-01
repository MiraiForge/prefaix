import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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

const open: ShellSession[] = [];
const homes: string[] = [];
const mock = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2), get=n=>args[args.indexOf(n)+1];
const line=args.at(-1), file=get('--directives'), nonce=get('--nonce');
fs.appendFileSync(process.env.PFX_CALLS, JSON.stringify(args)+'\\n');
fs.mkdirSync(path.dirname(file),{recursive:true});
const fields={nonce:line.includes('stale')?'wrong':nonce,conversation:'c_01ARZ3NDEKTSV4RRFFQ69G5FAV',status:'ready',buffer:line.includes('restore')?'echo safe; touch '+process.env.PFX_UNSAFE:'',cursor:0};
if(line.includes('unicode')) {
  fields.buffer="printf '%s' > unicode 日本語🙂後";
  delete fields.cursor;
  if(line.includes('cursor')) fields.cursor=Array.from(fields.buffer).length-1;
  if(line.includes('invalid')) fields.cursor='999999999999999999999999999999';
}
fs.writeFileSync(file,Object.entries(fields).flat().join('\\0')+'\\0');
console.log('fixture received');
`;
async function session(
  shell: ShellKind,
  extra = "",
  bin?: string,
  passthrough?: string,
) {
  const home = mkdtempSync(join(tmpdir(), "pfx-plugin-"));
  homes.push(home);
  const shims = join(home, "bin");
  mkdirSync(shims);
  writeFileSync(join(shims, "prefaix"), mock);
  chmodSync(join(shims, "prefaix"), 0o755);
  const env = {
    HOME: home,
    XDG_STATE_HOME: join(home, "state"),
    XDG_RUNTIME_DIR: join(home, "run"),
    XDG_DATA_HOME: join(home, "data"),
    PFX_CALLS: join(home, "calls"),
    PFX_UNSAFE: join(home, "unsafe"),
    PATH: shims + ":" + process.env["PATH"],
    ...(passthrough === undefined
      ? {}
      : { PREFAIX_GRAMMAR_PASSTHROUGH: passthrough }),
  };
  const config = defaultConfig();
  const paths = resolvePaths({ home, env });
  const script = initShell(shell, {
    config: {
      ...config,
      ...(passthrough === undefined ? {} : { grammar: { passthrough } }),
      ui: { ...config.ui, rprompt: "off" },
    },
    paths,
  });
  const s = await ShellSession.start({
    shell,
    env,
    initScript: script + "\n" + extra,
    ...(bin ? { bin } : {}),
  });
  open.push(s);
  return {
    s,
    home,
    script,
    calls: () =>
      existsSync(env.PFX_CALLS)
        ? readFileSync(env.PFX_CALLS, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as string[])
        : [],
  };
}
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
  for (const h of homes.splice(0)) {
    const lock = join(h, "run/prefaix/daemon.lock");
    if (existsSync(lock)) {
      try {
        process.kill(Number(readFileSync(lock, "utf8").trim()), "SIGTERM");
      } catch {
        /* already stopped */
      }
    }
    rmSync(h, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

for (const shell of TEST_SHELLS)
  describe(`${shell} shell plugin`, () => {
    it("intercepts raw prompts, keeps history and identity, and refreshes the prompt", async () => {
      const { s, calls, home, script } = await session(shell);
      expect(await s.run("echo ordinary")).toBe("ordinary");
      const line = ": hello it's $(touch unsafe) *.ts ! | 日本語";
      const row = s.promptRow();
      s.sendLine(line);
      await expect.poll(calls, { timeout: 8000 }).toHaveLength(1);
      await s.waitForPrompt({ afterRow: row });
      expect(calls()).toHaveLength(1);
      expect(calls()[0]?.at(-1)).toBe(line);
      s.press("up");
      await s.waitFor(/__pfx : hello.*日本語$/u);
      s.press("ctrl-c");
      await s.waitForPrompt();
      expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toBe(
        "c_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      );
      expect(await s.readVariable("PREFAIX_STATUS")).toBe("ready");
      expect(
        await s.run(
          shell === "fish"
            ? "builtin history search --contains 'hello'"
            : "fc -ln -10",
        ),
      ).toContain(line);
      expect(await s.run("env")).not.toMatch(
        /^PREFAIX_(SHELL_ID|CONVERSATION_ID|STATUS)=/m,
      );
      const identity = await s.readVariable("PREFAIX_SHELL_ID");
      writeFileSync(join(home, "plugin"), script);
      await s.run(`source '${join(home, "plugin")}'`);
      expect(await s.readVariable("PREFAIX_SHELL_ID")).toBe(identity);
      expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toBe(
        "c_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      );
      const next = s.promptRow();
      s.sendLine(": next");
      await expect.poll(calls, { timeout: 8000 }).toHaveLength(2);
      await s.waitForPrompt({ afterRow: next });
      expect(calls()[1]).toContain("c_01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(calls()[1]?.[calls()[1]!.indexOf("--shell-id") + 1]).toBe(
        calls()[0]?.[calls()[0]!.indexOf("--shell-id") + 1],
      );
    });
    it("preserves a bracketed multiline prompt as one argument", async () => {
      const { s, calls } = await session(shell);
      const line = ": hello from multiple lines\nit's $(literal) * ! |\n";
      const row = s.promptRow();
      s.paste(line);
      s.press("enter");
      await expect.poll(calls, { timeout: 8000 }).toHaveLength(1);
      await s.waitForPrompt({ afterRow: row });
      expect(calls()[0]?.at(-1)).toBe(line);
    });
    it("delegates passthrough and multiline shell input without invoking the client", async () => {
      const { s, calls } = await session(shell);
      for (const line of [": > passthrough-file", " : ignored"]) {
        const before = s.promptRow();
        s.sendLine(line);
        await s.waitForPrompt({ afterRow: before });
      }
      expect(existsSync(join(s.cwd, "passthrough-file"))).toBe(true);
      if (shell !== "fish") {
        const before = s.promptRow();
        s.sendLine(": ${PFX_VALUE:=1}");
        await s.waitForPrompt({ afterRow: before });
        expect(await s.readVariable("PFX_VALUE")).toBe("1");
      }
      const row = s.promptRow();
      s.send("echo first \\\r");
      await s.waitFor("first");
      s.sendLine(": second");
      await s.waitForPrompt({ afterRow: row });
      expect(calls()).toHaveLength(0);
      const quoteRow = s.promptRow();
      s.sendLine('echo "first');
      await s.waitFor("first");
      s.sendLine(': second"');
      await s.waitForPrompt({ afterRow: quoteRow });
      expect(calls()).toHaveLength(0);
    });
    it("restores directives as editable data, with no implicit execution", async () => {
      const { s, home } = await session(shell);
      s.sendLine(": restore");
      await s.waitFor("echo safe; touch");
      expect(existsSync(join(home, "unsafe"))).toBe(false);
      // The restored cursor is zero. Observe a real edit before Ctrl+C;
      // the buffer can be painted before the editor resumes reading input.
      s.send("X");
      await s.waitFor("Xecho safe; touch");
      expect(existsSync(join(home, "unsafe"))).toBe(false);
      s.send("\x03");
      expect(await s.run("echo recovered")).toBe("recovered");
      expect(existsSync(join(home, "unsafe"))).toBe(false);
    });
    it.each([
      ["default", "日本語🙂後X"],
      ["cursor", "日本語🙂X後"],
      ["invalid", "日本語🙂後X"],
    ])(
      "restores Unicode with a %s cursor and preserves appended bytes",
      async (mode, expected) => {
        const { s } = await session(shell);
        s.sendLine(`: unicode ${mode}`);
        await s.waitFor("日本語🙂後");
        expect(existsSync(join(s.cwd, "unicode"))).toBe(false);
        const row = s.promptRow();
        s.sendLine("X");
        await s.waitForPrompt({ afterRow: row });
        expect(readFileSync(join(s.cwd, "unicode"))).toEqual(
          Buffer.from(expected!),
        );
      },
    );
    it("ignores stale directives and leaves a usable prompt", async () => {
      const { s, calls } = await session(shell);
      const row = s.promptRow();
      s.sendLine(": stale restore");
      await expect.poll(calls, { timeout: 8000 }).toHaveLength(1);
      await s.waitForPrompt({ afterRow: row });
      expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toBe("");
      expect(await s.run("echo recovered")).toBe("recovered");
    });
    it("records recent exit codes and renders cached status with no external command", async () => {
      const { s, calls, home } = await session(shell);
      let row = s.promptRow();
      s.sendLine("false");
      await s.waitForPrompt({ afterRow: row });
      row = s.promptRow();
      s.sendLine(": context please");
      await expect.poll(calls, { timeout: 8000 }).toHaveLength(1);
      await s.waitForPrompt({ afterRow: row });
      expect(calls()[0]).toContain("1:false");
      const id = await s.readVariable("PREFAIX_SHELL_ID");
      writeFileSync(
        join(home, "run/prefaix/shells", id, "status"),
        "✓ cached\n",
      );
      const counter = join(home, "external-execs");
      const counters = join(home, "counter-bin");
      mkdirSync(counters);
      for (const name of [
        "prefaix",
        "node",
        "bun",
        "git",
        "sed",
        "awk",
        "cut",
        "date",
        "stty",
        "uname",
        "mktemp",
        "rm",
        "cat",
        "sleep",
        "head",
        "tail",
        "wc",
      ]) {
        const shim = join(counters, name);
        writeFileSync(
          shim,
          `#!/bin/sh\nprintf '${name}\\n' >> '${counter}'\nexit 1\n`,
        );
        chmodSync(shim, 0o755);
      }
      await s.run(
        shell === "fish" ? `set -gx PATH '${counters}'` : `PATH='${counters}'`,
      );
      for (let repeat = 0; repeat < 3; repeat++)
        expect(await s.run("true; printf 'ordinary\\n'")).toBe("ordinary");
      expect(existsSync(counter) ? readFileSync(counter, "utf8") : "").toBe("");
      expect(await s.run("prefaix_prompt_info; printf '\\n'")).toBe("✓ cached");
      expect(calls()).toHaveLength(1);
      let elapsedMs: number;
      if (shell === "fish") {
        await s.run(
          "set -l index 0; while test $index -lt 1000; prefaix_prompt_info >/dev/null; set index (math $index + 1); end",
        );
        elapsedMs = Number(await s.readVariable("CMD_DURATION"));
      } else if (shell === "zsh") {
        await s.run(
          "start=$EPOCHREALTIME; repeat 1000 prefaix_prompt_info >/dev/null; elapsed=$(( (EPOCHREALTIME-start)*1000 ))",
        );
        elapsedMs = Number(await s.readVariable("elapsed"));
      } else {
        elapsedMs =
          Number(
            await s.run(
              "TIMEFORMAT=%R; time { for (( index=0; index<1000; index++ )); do prefaix_prompt_info >/dev/null; done; }",
            ),
          ) * 1000;
      }
      expect(
        elapsedMs / 1000,
        `${shell} cached prompt rendering milliseconds`,
      ).toBeLessThan(1);
      expect(existsSync(counter) ? readFileSync(counter, "utf8") : "").toBe("");
    });
    it("installs Enter interception in vi mode", async () => {
      const { s, calls, home } = await session(
        shell,
        shell === "fish"
          ? `set -g fish_escape_delay_ms 500
fish_vi_key_bindings; __prefaix_bind
function __pfx_test_mode --on-variable fish_bind_mode
  printf '%s' "$fish_bind_mode" > "$PFX_CALLS.mode"
end`
          : shell === "zsh"
            ? "bindkey -v; __prefaix_bind"
            : "set -o vi; __prefaix_bind",
      );
      const row = s.promptRow();
      s.sendLine(": hello vi");
      await expect.poll(calls, { timeout: 8000 }).toHaveLength(1);
      await s.waitForPrompt({ afterRow: row });
      expect(calls()).toHaveLength(1);
      const commandRow = s.promptRow();
      const modeFile = join(home, "calls.mode");
      rmSync(modeFile, { force: true });
      s.send(": command mode\x1b");
      if (shell === "fish") {
        // Escape may still be part of an input sequence. Observe its vi mode
        // transition before Enter, even with a deliberately slow escape delay.
        await expect
          .poll(
            () => (existsSync(modeFile) ? readFileSync(modeFile, "utf8") : ""),
            { timeout: 8000 },
          )
          .toBe("default");
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      s.press("enter");
      await expect.poll(calls, { timeout: 8000 }).toHaveLength(2);
      await s.waitForPrompt({ afterRow: commandRow });
      expect(calls()).toHaveLength(2);
    });
  });
if (process.platform === "darwin")
  it("bash 3.2 exposes pfx without taking over colon", async () => {
    const { s, calls } = await session("bash", "", "/bin/bash");
    const row = s.promptRow();
    s.sendLine(": builtin");
    await s.waitForPrompt({ afterRow: row });
    expect(calls()).toHaveLength(0);
    await s.run("pfx 'hello old bash'");
    expect(calls()[0]?.at(-1)).toBe(": hello old bash");
  });

for (const shell of TEST_SHELLS)
  describe(`${shell} real client plugin lifecycle`, () => {
    async function real(scenario = "hello", vi = false, passthrough?: string) {
      const initialized = await session(
        shell,
        vi
          ? shell === "fish"
            ? "fish_vi_key_bindings; __prefaix_bind"
            : shell === "zsh"
              ? "bindkey -v; __prefaix_bind"
              : "set -o vi; __prefaix_bind"
          : "",
        undefined,
        passthrough,
      );
      const bin = join(process.cwd(), "dist/prefaix.js");
      writeFileSync(
        join(initialized.home, "bin", "prefaix"),
        `#!/bin/sh\nexport PREFAIX_BACKEND=fake PREFAIX_FAKE_SCENARIO=${scenario}\nexec '${process.execPath}' '${bin}' "$@"\n`,
      );
      return initialized;
    }
    it("uses the authoritative classifier for custom JavaScript regexes", async () => {
      const { s } = await real("hello", false, "^:(?= custom\\b)");
      let row = s.promptRow();
      s.sendLine(": custom; printf 'custom-shell\\n'");
      await s.waitForPrompt({ afterRow: row });
      expect(s.screenText()).toContain("custom-shell");
      expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toBe("");
      row = s.promptRow();
      s.sendLine(": hello");
      await s.waitForPrompt({ afterRow: row, timeoutMs: 15000 });
      expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toMatch(/^c_/);
    });
    it("keeps the buffer unexecuted when classification reports invalid config", async () => {
      const { s, home } = await real("hello", false, "^:skip$");
      writeFileSync(
        join(home, "bin", "prefaix"),
        `#!/bin/sh\n'${process.execPath}' '${join(process.cwd(), "dist/prefaix.js")}' "$@"\ncode=$?\nsleep 0.15\nexit "$code"\n`,
      );
      await s.run(
        shell === "fish"
          ? "set -gx PREFAIX_GRAMMAR_PASSTHROUGH '['"
          : "export PREFAIX_GRAMMAR_PASSTHROUGH='['",
      );
      const line = ":; touch " + join(home, "must-not-run");
      s.sendLine(line);
      await s.waitFor("not a valid");
      // Diagnostics can arrive before the classifier exits. First wait for
      // the restored display, then verify that the editor handles input.
      const escapedLine = line.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      await s.waitFor(
        new RegExp("not a valid[\\s\\S]*\\n__pfx " + escapedLine + "$", "u"),
      );
      expect(existsSync(join(home, "must-not-run"))).toBe(false);
      // A repaint alone does not prove input readiness. Bracketed paste
      // must reach the editor before Ctrl+C can cancel its buffer.
      s.paste("x");
      await s.waitFor(new RegExp("\\n__pfx " + escapedLine + "x$", "u"));
      expect(existsSync(join(home, "must-not-runx"))).toBe(false);
      s.press("ctrl-c");
      expect(await s.run("echo recovered")).toBe("recovered");
    });
    it("passes pure punctuation and invalid agent-command names to the shell", async () => {
      const { s, home } = await real();
      const punctuation = join(home, "bin", "::");
      writeFileSync(punctuation, "#!/bin/sh\nprintf 'punctuation-passed\\n'\n");
      chmodSync(punctuation, 0o755);
      mkdirSync(join(s.cwd, ":"));
      const slash = join(s.cwd, ":", "1bad");
      writeFileSync(slash, "#!/bin/sh\nprintf 'slash-passed\\n'\n");
      chmodSync(slash, 0o755);
      let row = s.promptRow();
      s.sendLine("::");
      await s.waitForPrompt({ afterRow: row });
      expect(s.screenText()).toContain("punctuation-passed");
      row = s.promptRow();
      s.sendLine(":/1bad");
      await s.waitForPrompt({ afterRow: row });
      expect(s.screenText()).toContain("slash-passed");
      expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toBe("");
    });
    it("continues a conversation across two raw turns and refreshes prompt hooks", async () => {
      const { s } = await real();
      await s.run(
        shell === "fish"
          ? "set -g prompt_count 0; function count_prompt --on-event fish_prompt; set -g prompt_count (math $prompt_count + 1); end"
          : shell === "zsh"
            ? "prompt_count=0; count_prompt() { (( prompt_count++ )); }; precmd_functions+=(count_prompt)"
            : "prompt_count=0; PROMPT_COMMAND+='; (( prompt_count++ ))'",
      );
      const before = Number(await s.readVariable("prompt_count"));
      let row = s.promptRow();
      s.sendLine(": hello");
      await s.waitForPrompt({ afterRow: row, timeoutMs: 15000 });
      expect(s.screenText()).toContain("Hello from the fake backend");
      const id = await s.readVariable("PREFAIX_CONVERSATION_ID");
      expect(id).toMatch(/^c_/);
      row = s.promptRow();
      s.sendLine(": second");
      await s.waitForPrompt({ afterRow: row });
      expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toBe(id);
      expect(Number(await s.readVariable("prompt_count"))).toBeGreaterThan(
        before + 2,
      );
      row = s.promptRow();
      s.sendLine(":info");
      await s.waitForPrompt({ afterRow: row });
      expect(s.screenText()).toMatch(/2 turns|Turns: 2|turns: 2/i);
      row = s.promptRow();
      s.sendLine(":new");
      await s.waitForPrompt({ afterRow: row });
      const second = await s.readVariable("PREFAIX_CONVERSATION_ID");
      expect(second).not.toBe(id);
      row = s.promptRow();
      s.sendLine(`:c ${id}`);
      await s.waitForPrompt({ afterRow: row });
      expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toBe(id);
      row = s.promptRow();
      s.sendLine(":c -");
      await s.waitForPrompt({ afterRow: row });
      expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toBe(second);
    });
    for (const vi of [false, true])
      for (const key of ["\x1b", "\x03"])
        it(`aborts with ${key === "\x1b" ? "Esc" : "Ctrl+C"}${vi ? " in vi mode" : ""} and restores tty`, async () => {
          const { s } = await real("long", vi);
          async function ttyMode() {
            expect(await s.status("stty -g > .pfx-tty-mode")).toBe(0);
            return readFileSync(join(s.cwd, ".pfx-tty-mode"), "utf8");
          }
          const before = await ttyMode();
          const row = s.promptRow();
          s.sendLine(": take a while");
          await s.waitFor("Streaming a long answer", { timeoutMs: 15000 });
          s.send(key);
          await s.waitForPrompt({ afterRow: row, timeoutMs: 15000 });
          expect(await ttyMode()).toBe(before);
          const foregroundRow = s.promptRow();
          s.sendLine("printf '__pfx_foreground_ready\\n'; sleep 30");
          await s.waitFor(/^__pfx_foreground_ready$/mu);
          s.press("ctrl-c");
          await s.waitForPrompt({ afterRow: foregroundRow });
          expect(await s.run("echo recovered")).toBe("recovered");
          for (const warning of s
            .raw()
            .matchAll(
              /bash: child setpgid \([^\r\n]*\): Operation not permitted/gu,
            ))
            process.stderr.write(
              `Native Bash warning; tty and foreground recovery verified: ${warning[0]}\n`,
            );
        });
    it("restores typeahead without executing it", async () => {
      const { s, home } = await real("long");
      s.sendLine(": capture typing");
      await s.waitFor("Streaming a long answer", { timeoutMs: 15000 });
      s.send("touch " + join(home, "typed-must-wait"));
      s.send("\x1b");
      await s.waitFor("typed-must-wait");
      expect(existsSync(join(home, "typed-must-wait"))).toBe(false);
      // A repaint can precede the editor's next input cycle. Prove the restored
      // buffer is editable before Ctrl+C, rather than treating paint as readiness.
      s.send("X");
      await s.waitFor(/typed-must-wait\s*X/u);
      expect(existsSync(join(home, "typed-must-waitX"))).toBe(false);
      s.send("\x03");
      expect(await s.run("echo recovered")).toBe("recovered");
      expect(existsSync(join(home, "typed-must-wait"))).toBe(false);
      expect(existsSync(join(home, "typed-must-waitX"))).toBe(false);
    });
    it("recovers from a daemon killed during a turn", async () => {
      const { s, home } = await real("long");
      const row = s.promptRow();
      s.sendLine(": survive failure");
      await s.waitFor("Streaming a long answer", { timeoutMs: 15000 });
      const pid = Number(
        readFileSync(join(home, "run/prefaix/daemon.lock"), "utf8").trim(),
      );
      process.kill(pid, "SIGKILL");
      await s.waitForPrompt({ afterRow: row, timeoutMs: 15000 });
      const next = s.promptRow();
      s.sendLine(": try again");
      await s.waitFor("Streaming a long answer", { timeoutMs: 15000 });
      s.send("\x1b");
      await s.waitForPrompt({ afterRow: next, timeoutMs: 15000 });
      expect(await s.run("echo alive")).toBe("alive");
    });
  });
