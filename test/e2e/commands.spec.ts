import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/core/config/schema.js";
import type { FakeSession } from "../../src/agents/fake/adapter.js";
import { PLAN_EXECUTION_PROMPT } from "../../src/core/protocol.js";
import { resolvePaths } from "../../src/core/paths.js";
import { Daemon } from "../../src/daemon/daemon.js";
import { initShell } from "../../src/shells/plugins/index.js";
import { ShellSession, TEST_SHELLS } from "./harness.js";

const BIN = fileURLToPath(new URL("../../dist/prefaix.js", import.meta.url));
let daemon: Daemon | undefined;
let shell: ShellSession | undefined;
let home = "";
afterEach(async () => {
  await shell?.close();
  shell = undefined;
  await daemon?.stop();
  daemon = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
});

// One installed shell is sufficient for command routing; shell-plugins.spec
// covers the same interception and directive contract across all shell versions.
const kind = TEST_SHELLS[0]!;
async function start(shellKind = kind, proposal?: string) {
  home = mkdtempSync(join(tmpdir(), "pfx-cmd-e2e-"));
  const shims = join(home, "bin");
  mkdirSync(shims);
  writeFileSync(
    join(shims, "prefaix"),
    `#!/bin/sh\nexec '${process.execPath}' '${BIN}' "$@"\n`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(shims, "pbcopy"),
    `#!${process.execPath}\nconst fs=require('node:fs'); let text=''; process.stdin.on('data', c=>text+=c); process.stdin.on('end',()=>fs.writeFileSync(process.env.COPY_TARGET,text));\n`,
    { mode: 0o700 },
  );
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_DATA_HOME: join(home, "data"),
    XDG_RUNTIME_DIR: join(home, "run"),
    PATH: `${shims}:${process.env["PATH"]}`,
    PREFAIX_BACKEND: "fake",
    COPY_TARGET: join(home, "clipboard"),
    ...(proposal === undefined
      ? {}
      : { PREFAIX_FAKE_PROPOSAL: proposal.replaceAll("$HOME", home) }),
  };
  const paths = resolvePaths({ home, env });
  mkdirSync(join(home, "config", "prefaix"), { recursive: true });
  writeFileSync(
    paths.configFile,
    '[ui]\nrprompt = "off"\npicker = "builtin"\n[personas.audit]\ntools = ["read"]\nguideline = "Audit dependencies."\n',
  );
  const defaults = defaultConfig();
  const config = {
    ...defaults,
    agent: { ...defaults.agent, backend: "fake" as const },
    ui: { ...defaults.ui, rprompt: "off" as const, picker: "builtin" as const },
    personas: {
      ...defaults.personas,
      audit: { tools: ["read"], guideline: "Audit dependencies." },
    },
  };
  daemon = new Daemon({
    paths,
    config,
    env,
    version: "0.0.0",
    checkOwner: false,
  });
  await daemon.start();
  shell = await ShellSession.start({
    shell: shellKind,
    env,
    initScript: initShell(shellKind, { paths, config }),
    timeoutMs: 20000,
  });
  return shell;
}
async function command(s: ShellSession, line: string): Promise<string> {
  await s.waitForPrompt();
  const row = s.promptRow();
  s.sendLine(line);
  await s.waitForPrompt({ afterRow: row });
  return s.screenText();
}

describe.each(TEST_SHELLS)(
  "%s suggest edits with the installed client",
  (shellKind) => {
    it("keeps the proposed command editable, cancellable, and unexecuted until Enter", async () => {
      const s = await start(
        shellKind,
        "printf '%s' '日本語🙂' > '$HOME/suggest-output'",
      );
      const marker = join(home, "suggest-output");
      s.sendLine(":s write a greeting");
      await s.waitFor("suggest-output");
      expect(existsSync(marker)).toBe(false);
      s.send("; false");
      await s.waitFor(/suggest-output'\s*;\s*false/u);
      expect(existsSync(marker)).toBe(false);
      s.press("ctrl-c");
      expect(await s.run("echo recovered")).toBe("recovered");
      expect(existsSync(marker)).toBe(false);
      s.sendLine(":suggest write a greeting");
      await s.waitFor(/suggest-output'$/mu);
      s.send("; true");
      await s.waitFor(/suggest-output'\s*;\s*true/u);
      expect(existsSync(marker)).toBe(false);
      const beforeEnter = s.promptRow();
      s.press("enter");
      await s.waitForPrompt({ afterRow: beforeEnter });
      expect(readFileSync(marker, "utf8")).toBe("日本語🙂");
      expect(await s.run("echo alive")).toBe("alive");
    });
  },
);

describe(`${kind} commands with the installed client and fake backend`, () => {
  it("continues turns, starts new conversations, switches and toggles, and renders info/status", async () => {
    const s = await start();
    expect(await command(s, ": explain the code")).toContain(
      "Hello from the fake backend",
    );
    const first = await s.readVariable("PREFAIX_CONVERSATION_ID");
    expect(first).toMatch(/^c_/u);
    await command(s, ":new");
    const second = await s.readVariable("PREFAIX_CONVERSATION_ID");
    expect(second).not.toBe(first);
    expect(await command(s, ":n new topic")).toContain(
      "Hello from the fake backend",
    );
    const third = await s.readVariable("PREFAIX_CONVERSATION_ID");
    expect(third).not.toBe(second);
    await command(s, `:conversation ${first}`);
    expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toBe(first);
    await command(s, ":c -");
    expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toBe(third);
    expect(await command(s, ":info")).toContain("backend: fake");
    expect(await command(s, ":i")).toContain("1 turns");
    expect(await s.readVariable("PREFAIX_STATUS")).toContain("prefaix");
  });
  it("sets/picks models and thinking, copies answers, shows help/doctor, passes slash commands and typos", async () => {
    const s = await start();
    await command(s, ":new");
    expect(await command(s, ":model fake-slow")).toContain(
      "model: fake/fake-slow",
    );
    expect(await command(s, ":m fake-fast")).toContain("model: fake/fake-fast");
    expect(await command(s, ":think high")).toContain("thinking: high");
    const row = s.promptRow();
    s.sendLine(":think");
    await s.waitFor("Thinking level:");
    s.send("\u001b[B\r");
    await s.waitForPrompt({ afterRow: row });
    expect(await command(s, ":info")).toContain("thinking: low");
    expect(await command(s, ":/review src")).toContain(
      "Hello from the fake backend",
    );
    await command(s, ":copy");
    expect(readFileSync(join(home, "clipboard"), "utf8")).toContain(
      "Hello from the fake backend",
    );
    expect(await command(s, ":help")).toContain("prefaix line grammar:");
    expect(await command(s, ":?")).toContain(":conversation");
    expect(await command(s, ":doctor")).toMatch(
      /prefaix doctor|clipboard|Clipboard/u,
    );
    expect(await command(s, ":modle")).toContain("Did you mean :model?");
  });
  it("rejects tight typos with arguments without making a turn, resolves shorthand, and keeps help local", async () => {
    const s = await start();
    await command(s, ":new");
    expect(await command(s, ":modle gemini")).toContain("Did you mean :model?");
    expect(await command(s, ":fix foo")).toContain("is not a command");
    expect(await command(s, ":info extra")).toContain(
      "does not take arguments",
    );
    expect(await command(s, ":info")).toContain("0 turns");
    expect(await command(s, ":review src")).toContain(
      "Hello from the fake backend",
    );
    expect(await command(s, ":info")).toContain("1 turns");
    await daemon!.stop();
    daemon = undefined;
    expect(await command(s, ":help")).toContain(
      "agent commands (cached for this conversation)",
    );
    expect(s.screenText()).toContain(":review");
  });

  it("routes personas and :go through the real shell without changing conversations", async () => {
    const s = await start();
    expect(await command(s, ":ask explain this")).toContain(
      "Hello from the fake backend",
    );
    const id = await s.readVariable("PREFAIX_CONVERSATION_ID");
    expect(id, s.screenText()).toMatch(/^c_/u);
    const session = daemon!.pool.session(id) as FakeSession;
    expect(session.lastPrompt?.persona?.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
    ]);
    await command(s, ":audit the dependencies");
    expect(daemon!.pool.session(id)).toBe(session);
    expect(session.lastPrompt?.persona).toMatchObject({
      name: "audit",
      tools: ["read"],
    });
    expect(await command(s, ":audti dependencies")).toContain(
      "Did you mean :audit?",
    );
    expect(session.turnsRun).toBe(2);
    await command(s, ":plan refactor this");
    expect(session.persona?.name).toBe("plan");
    expect(await command(s, ":info")).toContain("persona: plan");
    await command(s, ":go");
    expect(await s.readVariable("PREFAIX_CONVERSATION_ID")).toBe(id);
    expect(daemon!.pool.session(id)).toBe(session);
    expect(session.persona).toBeUndefined();
    expect(session.lastPrompt?.text).toBe(PLAN_EXECUTION_PROMPT);
    expect(await command(s, ":info")).toContain("persona: default");
    expect(await command(s, ":go")).toContain("no completed plan");
    expect(session.turnsRun).toBe(4);
  });

  it("opens and cancels the built-in conversation/model pickers with a usable prompt", async () => {
    const s = await start();
    await command(s, ":new first");
    for (const [line, title] of [
      [":c", "Conversations:"],
      [":m", "Models:"],
    ] as const) {
      const row = s.promptRow();
      s.sendLine(line);
      await s.waitFor(title);
      s.send("\u001b");
      await s.waitForPrompt({ afterRow: row });
    }
    expect(await s.run("echo restored")).toBe("restored");
  });
});
