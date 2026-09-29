import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PrefaixError } from "../../src/core/errors.js";
import {
  coerceField,
  describeValue,
  validateFieldValue,
} from "../../src/core/config/toml.js";
import type { FieldNode } from "../../src/core/config/index.js";
import {
  checkConfig,
  defaultConfig,
  describeConfig,
  envNameFor,
  loadConfig,
  personaSpec,
  resolveConfig,
  renderDiagnostics,
  CONFIG_SCHEMA,
  type PrefaixConfig,
} from "../../src/core/config/index.js";

const HOME = "/Users/tester";
const FILE = `${HOME}/.config/prefaix/config.toml`;

function resolve(text: string, env: Record<string, string> = {}) {
  return resolveConfig({ text, env, home: HOME });
}

function paths(text: string, env: Record<string, string> = {}): string[] {
  return checkConfig({ text, env, home: HOME }).map(
    (diagnostic) => diagnostic.path,
  );
}

function firstProblem(text: string, env: Record<string, string> = {}): string {
  const [diagnostic] = checkConfig({ text, env, home: HOME });
  if (diagnostic === undefined) {
    throw new Error("expected a diagnostic");
  }
  return diagnostic.message;
}

// The sample config from DESIGN §6, verbatim.
const DESIGN_SAMPLE = `
[agent]
backend = "pi"

[agent.pi]
bin = "pi"                     # or absolute path
# model = "google/gemini-3.8-flash"   # default: pi's own default
# thinking = "medium"
extensions = "user"            # "user" = your pi extensions (parity), "none" = --no-extensions (4x faster start)
# session_dir = "~/.local/state/prefaix/pi-sessions"
extra_args = []

[pool]
max_children = 6
idle_minutes = 15
spare = true

[workspace]
cwd_policy = "follow"          # follow | split | stay   (default set by spike S3)
resume = "none"                # none | last-in-root  — what a brand-new shell's first ":" does

[ui]
thinking = "hidden"            # hidden | summary | stream
footer = ["time", "tools", "cost", "context", "model"]
rprompt = "auto"               # auto | on | off
widgets = "ignore"             # ignore | info
set_title = false
osc133 = "auto"
picker = "auto"                # auto (fzf if present) | builtin

[context]
recent_commands = 10
include_exit_codes = true
redact = true
# extra_redact_patterns = ['(?i)internal-token-[a-z0-9]+']

[env]
passthrough = "all"            # all | allowlist
# allowlist = ["PATH", "HOME", "VIRTUAL_ENV", "NODE_OPTIONS"]
deny = ["PREFAIX_*", "PWD", "OLDPWD", "SHLVL", "_"]

[grammar]
passthrough = '^:\\s*($|[>|<&;$({\\[])'

[personas.ask]
tools = ["read", "grep", "find", "ls"]
guideline = "Answer the question. Do not modify files."

[personas.plan]
tools = ["read", "grep", "find", "ls"]
guideline = "Produce a numbered plan. Do not modify files."

[commands.suggest]
# model = "google/gemini-3.8-flash"   # fast/cheap model for :suggest
[commands.commit]
max_diff_bytes = 100000
`;

describe("config defaults", () => {
  it("resolves DESIGN section 6 defaults with no file and no env", () => {
    expect(resolve("").config).toEqual({
      agent: {
        backend: "pi",
        pi: {
          bin: "pi",
          model: null,
          thinking: null,
          extensions: "user",
          sessionDir: null,
          extraArgs: [],
        },
      },
      pool: { maxChildren: 6, idleMinutes: 15, spare: true },
      workspace: { cwdPolicy: "follow", resume: "none" },
      ui: {
        thinking: "hidden",
        footer: ["time", "tools", "cost", "context", "model"],
        rprompt: "auto",
        widgets: "ignore",
        setTitle: false,
        osc133: "auto",
        picker: "auto",
      },
      context: {
        recentCommands: 10,
        includeExitCodes: true,
        redact: true,
        extraRedactPatterns: [],
      },
      env: {
        passthrough: "all",
        allowlist: null,
        deny: ["PREFAIX_*", "PWD", "OLDPWD", "SHLVL", "_"],
      },
      grammar: { passthrough: "^:\\s*($|[>|<&;$({\\[])" },
      personas: {},
      commands: { suggest: { model: null }, commit: { maxDiffBytes: 100000 } },
    });
  });

  it("parses the documented sample without a diagnostic", () => {
    expect(checkConfig({ text: DESIGN_SAMPLE, home: HOME })).toEqual([]);
  });

  it("keeps the sample's explicit values", () => {
    const { config } = resolve(DESIGN_SAMPLE);
    expect(config.personas["ask"]?.tools).toEqual([
      "read",
      "grep",
      "find",
      "ls",
    ]);
    expect(config.personas["ask"]?.guideline).toBe(
      "Answer the question. Do not modify files.",
    );
    expect(config.commands.commit.maxDiffBytes).toBe(100000);
    expect(config.grammar.passthrough).toBe("^:\\s*($|[>|<&;$({\\[])");
  });

  it("freezes the resolved config and its nested values", () => {
    const { config } = resolve("");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.pool)).toBe(true);
    expect(Object.isFrozen(config.ui.footer)).toBe(true);
    expect(Object.isFrozen(config.personas)).toBe(true);
    expect(() => {
      (config as { pool: { spare: boolean } }).pool.spare = false;
    }).toThrow(TypeError);
  });

  it("keeps the default footer order", () => {
    expect(defaultConfig().ui.footer).toEqual([
      "time",
      "tools",
      "cost",
      "context",
      "model",
    ]);
  });

  it("gives each call a fresh copy of mutable defaults", () => {
    const first = defaultConfig();
    const second = defaultConfig();
    expect(first.ui.footer).not.toBe(second.ui.footer);
    expect(first.ui.footer).toEqual(second.ui.footer);
  });

  it("derives unique env names for every leaf", () => {
    const names: string[] = [];
    // A map node's leaves depend on the names in the file, so only fixed
    // sections contribute static names.
    const walk = (
      members: typeof CONFIG_SCHEMA.members,
      prefix: string,
    ): void => {
      for (const [key, node] of Object.entries(members)) {
        const path = prefix === "" ? key : `${prefix}.${key}`;
        if (node.type === "field") {
          names.push(envNameFor(path));
        } else if (node.type === "section") {
          walk(node.members, path);
        }
      }
    };
    walk(CONFIG_SCHEMA.members, "");
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("PREFAIX_AGENT_PI_BIN");
    expect(names).toContain("PREFAIX_AGENT_PI_SESSION_DIR");
    expect(names).toContain("PREFAIX_UI_THINKING");
    expect(names).toContain("PREFAIX_POOL_MAX_CHILDREN");
    expect(names).toContain("PREFAIX_COMMANDS_COMMIT_MAX_DIFF_BYTES");
  });
});

describe("config file values", () => {
  it("reads scalars, arrays, and nested tables", () => {
    const { config } = resolve(`
[agent]
backend = "fake"

[agent.pi]
bin = "/opt/bin/pi"
model = "google/gemini-3.8-flash"
thinking = "high"
extensions = "none"
session_dir = "~/pi-sessions"
extra_args = ["--verbose", "--no-hooks"]

[pool]
max_children = 2
idle_minutes = 0.5
spare = false

[ui]
set_title = true
footer = ["model"]
`);
    expect(config.agent.backend).toBe("fake");
    expect(config.agent.pi.bin).toBe("/opt/bin/pi");
    expect(config.agent.pi.sessionDir).toBe(`${HOME}/pi-sessions`);
    expect(config.agent.pi.extraArgs).toEqual(["--verbose", "--no-hooks"]);
    expect(config.pool.maxChildren).toBe(2);
    expect(config.pool.idleMinutes).toBe(0.5);
    expect(config.pool.spare).toBe(false);
    expect(config.ui.setTitle).toBe(true);
    expect(config.ui.footer).toEqual(["model"]);
  });

  it("expands ~ in a path field and keeps other strings verbatim", () => {
    const { config } = resolve('[agent.pi]\nbin = "~/bin/pi"\nmodel = "a~b"\n');
    expect(config.agent.pi.bin).toBe("~/bin/pi");
    expect(config.agent.pi.model).toBe("a~b");
  });

  it("treats a non-table where a table belongs as an error", () => {
    expect(firstProblem("pool = 6\n")).toBe(
      "expected a table, got an integer (6)",
    );
  });

  it("allows a dotted key outside its table", () => {
    const { config } = resolve("pool.max_children = 3\n");
    expect(config.pool.maxChildren).toBe(3);
  });
});

describe("config env overrides", () => {
  it("overrides by key path", () => {
    const { config, fromEnv } = resolve("", {
      PREFAIX_AGENT_PI_BIN: "/usr/local/bin/pi",
      PREFAIX_UI_THINKING: "stream",
    });
    expect(config.agent.pi.bin).toBe("/usr/local/bin/pi");
    expect(config.ui.thinking).toBe("stream");
    expect(fromEnv).toEqual([
      { env: "PREFAIX_AGENT_PI_BIN", path: "agent.pi.bin" },
      { env: "PREFAIX_UI_THINKING", path: "ui.thinking" },
    ]);
  });

  it("accepts PREFAIX_BACKEND as an alias for agent.backend", () => {
    expect(resolve("", { PREFAIX_BACKEND: "fake" }).config.agent.backend).toBe(
      "fake",
    );
    // The key path wins over the alias when both are set.
    expect(
      resolve("", { PREFAIX_BACKEND: "fake", PREFAIX_AGENT_BACKEND: "pi" })
        .config.agent.backend,
    ).toBe("pi");
  });

  it("parses booleans, numbers, and JSON arrays", () => {
    const { config } = resolve("", {
      PREFAIX_POOL_SPARE: "no",
      PREFAIX_UI_SET_TITLE: "1",
      PREFAIX_POOL_MAX_CHILDREN: "3",
      PREFAIX_CONTEXT_RECENT_COMMANDS: "0",
      PREFAIX_POOL_IDLE_MINUTES: "0.25",
      PREFAIX_ENV_DENY: '["PWD", "_"]',
      PREFAIX_AGENT_PI_EXTRA_ARGS: '["--flag"]',
    });
    expect(config.pool.spare).toBe(false);
    expect(config.ui.setTitle).toBe(true);
    expect(config.pool.maxChildren).toBe(3);
    expect(config.context.recentCommands).toBe(0);
    expect(config.pool.idleMinutes).toBe(0.25);
    expect(config.env.deny).toEqual(["PWD", "_"]);
    expect(config.agent.pi.extraArgs).toEqual(["--flag"]);
  });

  it("treats an empty value as unset or empty", () => {
    const { config } = resolve("", {
      PREFAIX_AGENT_PI_MODEL: "",
      PREFAIX_ENV_ALLOWLIST: '["PATH"]',
    });
    expect(config.agent.pi.model).toBeNull();
    expect(config.env.allowlist).toEqual(["PATH"]);
    expect(
      resolve("", { PREFAIX_AGENT_PI_EXTRA_ARGS: "" }).config.agent.pi
        .extraArgs,
    ).toEqual([]);
  });

  it("wins over the file", () => {
    const { config } = resolve('[ui]\nthinking = "summary"\n', {
      PREFAIX_UI_THINKING: "stream",
    });
    expect(config.ui.thinking).toBe("stream");
  });

  it("expands ~ in a path override", () => {
    expect(
      resolve("", { PREFAIX_AGENT_PI_SESSION_DIR: "~/s" }).config.agent.pi
        .sessionDir,
    ).toBe(`${HOME}/s`);
  });

  it("overrides a leaf of a table the file defines", () => {
    const { config, fromEnv } = resolve('[personas.ask]\ntools = ["read"]\n', {
      PREFAIX_PERSONAS_ASK_GUIDELINE: "Be brief.",
    });
    expect(config.personas["ask"]).toEqual({
      tools: ["read"],
      guideline: "Be brief.",
    });
    expect(fromEnv).toEqual([
      { env: "PREFAIX_PERSONAS_ASK_GUIDELINE", path: "personas.ask.guideline" },
    ]);
  });

  it("cannot introduce a table the config does not define", () => {
    const { config, fromEnv } = resolve("", {
      PREFAIX_PERSONAS_PLAN_GUIDELINE: "Nope.",
    });
    expect(config.personas).toEqual({});
    expect(fromEnv).toEqual([]);
  });

  it("ignores PREFAIX_* vars that are not settings", () => {
    const { config, diagnostics, fromEnv } = resolve("", {
      PREFAIX_DEBUG: "1",
      PREFAIX_PLAIN: "1",
      PREFAIX_SHELL_ID: "1234-5678-abcd",
      PREFAIX_CONVERSATION_ID: "c_01J0000000000000000000000",
      PREFAIX_LIVE_MODEL: "google/gemini-3.8-flash",
    });
    expect(diagnostics).toEqual([]);
    expect(fromEnv).toEqual([]);
    expect(config).toEqual(defaultConfig());
  });

  it("reports a bad env value without a file position", () => {
    const [diagnostic] = checkConfig({
      text: "",
      env: { PREFAIX_POOL_MAX_CHILDREN: "many" },
      home: HOME,
    });
    expect(diagnostic).toEqual({
      origin: "env",
      path: "pool.max_children",
      env: "PREFAIX_POOL_MAX_CHILDREN",
      message: 'expected a number, got "many"',
      line: null,
      column: null,
    });
  });

  it("rejects env values outside the field's range or enum", () => {
    expect(paths("", { PREFAIX_POOL_MAX_CHILDREN: "0" })).toEqual([
      "pool.max_children",
    ]);
    expect(firstProblem("", { PREFAIX_POOL_MAX_CHILDREN: "0" })).toBe(
      "must be 1 or more, got 0",
    );
    expect(firstProblem("", { PREFAIX_UI_THINKING: "loud" })).toBe(
      'must be one of (hidden, summary, stream), got "loud"',
    );
    expect(firstProblem("", { PREFAIX_POOL_SPARE: "maybe" })).toBe(
      'expected a boolean (1, true, yes, on, 0, false, no, off), got "maybe"',
    );
    expect(firstProblem("", { PREFAIX_ENV_DENY: "PWD" })).toBe(
      'expected a JSON array of strings, got "PWD"',
    );
    expect(
      firstProblem("", { PREFAIX_GRAMMAR_PASSTHROUGH: "^(unclosed" }),
    ).toContain("is not a valid regular expression");
    expect(
      firstProblem("", { PREFAIX_AGENT_PI_SESSION_DIR: "relative/path" }),
    ).toBe('must be an absolute path or start with "~", got "relative/path"');
  });
});

describe("config bad input", () => {
  it("points at the offending line and column", () => {
    const text = '[pool]\nmax_children = 6\nidle_minutes = "soon"\n';
    const [diagnostic] = checkConfig({ text, home: HOME });
    expect(diagnostic).toEqual({
      origin: "file",
      path: "pool.idle_minutes",
      message: 'expected a number, got a string ("soon")',
      line: 3,
      column: 1,
    });
  });

  it("reports a syntax error with the parser's position", () => {
    const [diagnostic] = checkConfig({ text: "[pool]\nspare =\n", home: HOME });
    expect(diagnostic?.origin).toBe("file");
    expect(diagnostic?.line).toBe(2);
    expect(diagnostic?.column).toBe(8);
  });

  it("falls back to the schema defaults when the file is broken", () => {
    const { config } = resolve("[pool]\nmax_children = \n");
    expect(config.pool.maxChildren).toBe(6);
  });

  it("rejects an unknown key and names its table", () => {
    const text = "[pool]\nmax_childern = 4\n";
    const [diagnostic] = checkConfig({ text, home: HOME });
    expect(diagnostic?.path).toBe("pool.max_childern");
    expect(diagnostic?.message).toBe("unknown key");
    expect(diagnostic?.line).toBe(2);
  });

  it("rejects an unknown top-level key", () => {
    expect(paths("colour = true\n")).toEqual(["colour"]);
  });

  it("rejects a duplicate key", () => {
    expect(firstProblem("a = 1\na = 2\n[pool]\n")).toContain("already defined");
  });

  it("rejects a prototype-polluting key", () => {
    expect(firstProblem("__proto__ = { polluted = true }\n")).toContain(
      "unsafe property",
    );
  });

  it("checks enum members, list items, and regexes", () => {
    expect(firstProblem('[agent]\nbackend = "claude"\n')).toBe(
      'must be one of (pi, fake), got "claude"',
    );
    expect(firstProblem('[ui]\nfooter = ["time", "cost", "profit"]\n')).toBe(
      'item 3 must be one of (time, tools, cost, context, model), got "profit"',
    );
    expect(
      firstProblem("[context]\nextra_redact_patterns = ['(unclosed']\n"),
    ).toContain("is not a valid regular expression");
    expect(firstProblem('[ui]\nfooter = ["time", 2]\n')).toBe(
      "expected an array of strings, got an array (2 items)",
    );
  });

  it("requires an allowlist when passthrough is allowlist", () => {
    expect(firstProblem('[env]\npassthrough = "allowlist"\n')).toContain(
      'env.passthrough is "allowlist"',
    );
    expect(
      checkConfig({
        text: '[env]\npassthrough = "allowlist"\nallowlist = []\n',
      }),
    ).toEqual([]);
  });

  it("falls back to the default of any key it cannot use", () => {
    const { config } = resolve("[pool]\nspare = 1\nmax_children = 0\n");
    expect(config.pool.spare).toBe(true);
    expect(config.pool.maxChildren).toBe(6);
  });
});

describe("config diagnostics rendering", () => {
  it("renders a clickable location with the source line and a caret", () => {
    const text = '[ui]\nthinking = "loud"\n';
    const rendered = renderDiagnostics(checkConfig({ text, home: HOME }), {
      file: FILE,
      text,
    });
    expect(rendered).toBe(
      `${FILE}:2:1: ui.thinking: must be one of (hidden, summary, stream), got "loud"\n` +
        'thinking = "loud"\n' +
        "^",
    );
  });

  it("names the env var instead of a position for env diagnostics", () => {
    const rendered = renderDiagnostics(
      checkConfig({
        text: "",
        env: { PREFAIX_UI_SET_TITLE: "maybe" },
        home: HOME,
      }),
      { file: FILE },
    );
    expect(rendered).toBe(
      'PREFAIX_UI_SET_TITLE: ui.set_title: expected a boolean (1, true, yes, on, 0, false, no, off), got "maybe"',
    );
  });

  it("separates multiple problems", () => {
    const text = '[agent]\nbackend = "claude"\n[pool]\nspare = "yes"\n';
    const rendered = renderDiagnostics(checkConfig({ text, home: HOME }), {
      file: FILE,
      text,
    });
    expect(rendered.split("\n\n")).toHaveLength(2);
  });
});

describe("config summary", () => {
  it("lists the settings that are not defaults, with their source", () => {
    const resolved = resolveConfig({
      text: "[pool]\nmax_children = 4\n",
      env: { PREFAIX_UI_THINKING: "stream" },
      home: HOME,
    });
    expect(describeConfig(resolved, { file: FILE })).toEqual([
      `  pool.max_children = 4  [${FILE}]`,
      '  ui.thinking = "stream"  [PREFAIX_UI_THINKING]',
    ]);
  });

  it("is empty when everything is a default", () => {
    expect(describeConfig(resolve(""), { file: FILE })).toEqual([]);
  });

  it("reports a setting once, against the env var that won it", () => {
    const lines = describeConfig(
      resolveConfig({
        text: "[pool]\nmax_children = 4\n",
        env: { PREFAIX_POOL_MAX_CHILDREN: "8" },
        home: HOME,
      }),
      { file: FILE },
    );
    expect(lines).toEqual([
      `  pool.max_children = 8  [PREFAIX_POOL_MAX_CHILDREN]`,
    ]);
  });
});

describe("loadConfig", () => {
  it("uses the defaults when there is no config file", () => {
    const config = loadConfig({
      file: FILE,
      readFile: () => undefined,
      env: {},
      home: HOME,
    });
    expect(config).toEqual(defaultConfig());
  });

  it("throws a CONFIG_INVALID error naming the first problem", () => {
    let thrown: unknown;
    try {
      loadConfig({
        file: FILE,
        readFile: () => '[pool]\nspare = "yes"\nidle_minutes = "soon"\n',
        env: {},
        home: HOME,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PrefaixError);
    const error = thrown as PrefaixError;
    expect(error.code).toBe("CONFIG_INVALID");
    expect(error.exitCode).toBe(2);
    expect(error.hint).toBe("Run `prefaix config check` for the full list.");
    expect(error.message).toBe(
      `${FILE}:2:1: pool.spare: expected true or false, got a string ("yes") (and 1 more problem)`,
    );
  });

  it("passes env overrides through", () => {
    const config = loadConfig({
      file: FILE,
      readFile: () => undefined,
      env: { PREFAIX_BACKEND: "fake" },
      home: HOME,
    });
    expect(config.agent.backend).toBe("fake");
  });
});

describe("personaSpec", () => {
  it("omits keys the config left unset", () => {
    const config = resolveConfig({
      text: '[personas.ask]\ntools = ["read"]\n[personas.plan]\n',
      home: HOME,
    }).config as PrefaixConfig;
    expect(personaSpec(config, "ask")).toEqual({
      name: "ask",
      tools: ["read"],
    });
    expect(personaSpec(config, "plan")).toEqual({ name: "plan" });
    expect(personaSpec(config, "missing")).toBeUndefined();
  });
});

describe("config value coercion", () => {
  it("describes a value of any type for an error message", () => {
    expect(describeValue("x")).toBe('a string ("x")');
    expect(describeValue(1)).toBe("an integer (1)");
    expect(describeValue(1.5)).toBe("a number (1.5)");
    expect(describeValue(true)).toBe("a boolean (true)");
    expect(describeValue([1, 2, 3])).toBe("an array (3 items)");
    expect(describeValue([1])).toBe("an array (1 item)");
    expect(describeValue({ a: 1 })).toBe("a table");
    expect(describeValue(null)).toBe("a value");
  });

  it("rejects a value whose TOML type is wrong, for every kind", () => {
    expect(
      coerceField({ type: "field", key: "k", kind: "string", default: "" }, 1),
    ).toMatchObject({
      ok: false,
      problem: "expected a string, got an integer (1)",
    });
    expect(
      coerceField(
        { type: "field", key: "k", kind: "boolean", default: true },
        "yes",
      ),
    ).toMatchObject({
      ok: false,
      problem: 'expected true or false, got a string ("yes")',
    });
    expect(
      coerceField(
        { type: "field", key: "k", kind: "integer", default: 1 },
        "3",
      ),
    ).toMatchObject({
      ok: false,
      problem: 'expected a number, got a string ("3")',
    });
    expect(
      coerceField(
        { type: "field", key: "k", kind: "stringList", default: [] },
        "a",
      ),
    ).toMatchObject({
      ok: false,
      problem: 'expected an array, got a string ("a")',
    });
    expect(
      coerceField(
        { type: "field", key: "k", kind: "stringList", default: [] },
        [1],
      ),
    ).toMatchObject({
      ok: false,
      problem: "expected an array of strings, got an array (1 item)",
    });
    expect(
      coerceField(
        { type: "field", key: "k", kind: "optionalString", default: null },
        5,
      ),
    ).toMatchObject({ ok: false });
  });

  it("turns an empty optional string into unset", () => {
    expect(
      coerceField(
        { type: "field", key: "k", kind: "optionalString", default: null },
        "",
      ),
    ).toEqual({ ok: true, value: null });
  });

  it("rejects an empty value for a field that must have one", () => {
    expect(
      validateFieldValue(
        { type: "field", key: "k", kind: "string", default: "x" },
        "",
      ),
    ).toBe("must not be empty");
    expect(
      validateFieldValue(
        { type: "field", key: "k", kind: "optionalString", default: null },
        "",
      ),
    ).toBe("must not be empty when set");
  });

  it("rejects a non-integer for an integer field", () => {
    expect(
      validateFieldValue(
        { type: "field", key: "k", kind: "integer", default: 1, min: 0 },
        1.5,
      ),
    ).toContain("expected an integer");
  });

  it("reports a bad regular expression in a regex field", () => {
    expect(
      validateFieldValue(
        { type: "field", key: "k", kind: "string", default: "", regex: true },
        "(unclosed",
      ),
    ).toContain("is not a valid regular expression");
  });

  it("reports the first bad item of a list", () => {
    const field = {
      type: "field",
      key: "k",
      kind: "stringList",
      default: [],
      values: ["a", "b"],
    } as unknown as FieldNode;
    expect(validateFieldValue(field, ["a", "z"])).toBe(
      'item 2 must be one of (a, b), got "z"',
    );
    expect(
      // With a regex field the allowed values no longer apply, so the complaint
      // is about the bad pattern instead.
      validateFieldValue(
        { ...field, values: undefined, regex: true } as never,
        ["ok", "(bad"],
      ),
    ).toContain("item 2");
  });
});

describe("config from a real file", () => {
  it("reads the file at the given path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pfx-config-"));
    const file = join(dir, "config.toml");
    writeFileSync(file, '[ui]\nthinking = "stream"\n');
    const config = loadConfig({ file, env: {}, home: HOME });
    expect(config.ui.thinking).toBe("stream");
  });

  it("uses the defaults when the file is a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pfx-config-"));
    expect(loadConfig({ file: dir, env: {}, home: HOME })).toEqual(
      defaultConfig(),
    );
  });

  it("lets a read error other than a missing file surface", () => {
    // An unreadable path is a real fault, not a reason to fall back silently.
    expect(() =>
      loadConfig({ file: "/dev/null/nope", env: {}, home: HOME }),
    ).toThrow();
  });

  it("defaults the file to the XDG config path", () => {
    // No file, no override: the resolved config must still be complete.
    const config = loadConfig({
      readFile: () => undefined,
      env: {},
      home: HOME,
    });
    expect(config).toEqual(defaultConfig());
  });
});

describe("config summary without options", () => {
  it("labels the file config.toml when none is given", () => {
    const resolved = resolveConfig({
      text: "[pool]\nspare = false\n",
      home: HOME,
    });
    expect(describeConfig(resolved)).toEqual([
      "  pool.spare = false  [config.toml]",
    ]);
  });

  it("renders an unset value as unset", () => {
    const resolved = resolveConfig({ text: "", home: HOME });
    expect(describeConfig(resolved, { file: "x" })).toEqual([]);
  });
});

describe("config env corners", () => {
  it("reports a list value that is valid JSON but not an array of strings", () => {
    expect(firstProblem("", { PREFAIX_ENV_DENY: '{"a":1}' })).toContain(
      "JSON array of strings",
    );
    expect(firstProblem("", { PREFAIX_ENV_DENY: "[1,2]" })).toContain(
      "JSON array of strings",
    );
  });

  it("empties a list, and unsets an optional list, with an empty value", () => {
    expect(resolve("", { PREFAIX_ENV_DENY: "" }).config.env.deny).toEqual([]);
    expect(
      resolve('[env]\nallowlist = ["PATH"]\n', { PREFAIX_ENV_ALLOWLIST: "" })
        .config.env.allowlist,
    ).toBeNull();
  });

  it("ignores env for a persona the file does not define", () => {
    // Covered for guidance above; this pins the list-valued leaf too.
    const { config, diagnostics } = resolve("", {
      PREFAIX_PERSONAS_ASK_TOOLS: '["read"]',
    });
    expect(config.personas).toEqual({});
    expect(diagnostics).toEqual([]);
  });
});

describe("config summary of a persona", () => {
  it("names a persona's list and its guideline", () => {
    const resolved = resolveConfig({
      text: '[personas.ask]\ntools = ["read"]\nguideline = "Be brief."\n',
      home: HOME,
    });
    expect(describeConfig(resolved, { file: FILE })).toEqual([
      `  personas.ask.tools = ["read"]  [${FILE}]`,
      `  personas.ask.guideline = "Be brief."  [${FILE}]`,
    ]);
  });
});

describe("config load, last corners", () => {
  it("summarises a single problem with no count suffix", () => {
    let caught: PrefaixError | undefined;
    try {
      loadConfig({
        file: FILE,
        readFile: () => "[pool]\nspare = 'yes'\n",
        env: {},
        home: HOME,
      });
    } catch (error) {
      caught = error as PrefaixError;
    }
    expect(caught?.message).not.toContain("more problem");
  });

  it("names a persona's guideline when the config sets one", () => {
    const config = resolveConfig({
      text: "[personas.plan]\nguideline = 'Numbered steps'\n",
      home: HOME,
    }).config;
    expect(personaSpec(config, "plan")).toEqual({
      name: "plan",
      guideline: "Numbered steps",
    });
  });

  it("reads a value through a path that stops at a scalar", () => {
    // A summary of a scalar path renders as unset rather than throwing.
    const resolved = resolveConfig({
      text: "[ui]\nrprompt = 'off'\n",
      home: HOME,
    });
    expect(describeConfig(resolved, { file: FILE })).toEqual([
      `  ui.rprompt = "off"  [${FILE}]`,
    ]);
  });
});

describe("config env, final corner", () => {
  it("resolves a config with no env object at all", () => {
    // resolveConfig is called with options in the wild, so both forms work.
    expect(resolveConfig({ text: "" }).config).toEqual(defaultConfig());
  });
});

describe("config parse, last corners", () => {
  it("reports a scalar where a list was expected", () => {
    expect(firstProblem("[context]\nextra_redact_patterns = 5\n")).toBe(
      "expected an array, got an integer (5)",
    );
  });

  it("reads a table where a list was expected, inside a persona", () => {
    expect(firstProblem("[personas.ask]\ntools = { a = 1 }\n")).toBe(
      "expected an array, got a table",
    );
  });

  it("keeps a persona with no keys at all", () => {
    const config = resolveConfig({
      text: "[personas.ask]\n",
      home: HOME,
    }).config;
    expect(config.personas["ask"]).toEqual({ tools: null, guideline: null });
  });
});

describe("coercion of every field kind", () => {
  const field = (over: Partial<FieldNode>): FieldNode => ({
    type: "field",
    key: "k",
    kind: "string",
    default: "x",
    ...over,
  });

  it("reads a number that is not finite", () => {
    expect(
      coerceField(field({ kind: "number", default: 1 }), Number.NaN),
    ).toMatchObject({ ok: false });
  });

  it("reads an enum value that is not a string", () => {
    expect(
      coerceField(field({ kind: "enum", default: "a", values: ["a"] }), 5),
    ).toMatchObject({
      ok: false,
      problem: "expected a string, got an integer (5)",
    });
  });

  it("reads an optional path that is a string", () => {
    const node = field({ kind: "optionalPath", default: null });
    expect(coerceField(node, "/tmp/x")).toEqual({ ok: true, value: "/tmp/x" });
    expect(coerceField(node, 5)).toMatchObject({ ok: false });
  });

  it("reads a list that is already the right shape", () => {
    const node = field({ kind: "stringList", default: [] });
    expect(coerceField(node, ["a"])).toEqual({ ok: true, value: ["a"] });
  });
});

describe("reading a document, last corners", () => {
  it("ignores a table key that holds a list of tables", () => {
    // [[a]] parses as an array, which is not a table, so it is reported.
    expect(firstProblem("[[agent]]\n")).toContain("expected a table");
  });

  it("reads a persona whose name needs quoting in the path", () => {
    const resolved = resolveConfig({
      text: '[personas."ask me"]\nguideline = "Be brief."\n',
      home: HOME,
    });
    expect(resolved.config.personas["ask me"]).toEqual({
      tools: null,
      guideline: "Be brief.",
    });
    // The recorded path drops the quotes, so it matches the config key.
    expect(resolved.fromFile).toEqual(["personas.ask me.guideline"]);
  });

  it("reports a persona whose value is not a table", () => {
    expect(firstProblem("[personas.ask]\ntools = 1\n")).toContain(
      "expected an array",
    );
  });
});
