import {
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
async function start() {
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
  };
  const paths = resolvePaths({ home, env });
  mkdirSync(join(home, "config", "prefaix"), { recursive: true });
  writeFileSync(
    paths.configFile,
    '[ui]\nrprompt = "off"\npicker = "builtin"\n',
  );
  const defaults = defaultConfig();
  const config = {
    ...defaults,
    agent: { ...defaults.agent, backend: "fake" as const },
    ui: { ...defaults.ui, rprompt: "off" as const, picker: "builtin" as const },
  };
  daemon = new Daemon({ paths, config, version: "0.0.0", checkOwner: false });
  await daemon.start();
  shell = await ShellSession.start({
    shell: kind,
    env,
    initScript: initShell(kind, { paths, config }),
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

describe(`${kind} MVP commands with the installed client and fake backend`, () => {
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
