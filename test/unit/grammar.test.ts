import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  DEFAULT_PASSTHROUGH,
  parseLine,
  suggestions,
  type Parsed,
} from "../../src/shells/grammar.js";

// DESIGN §12.1: a table of about 150 cases, including the passthrough idioms,
// unicode, and multi-line input. Every row is one buffer a user can type.

type Expect =
  | { kind: "pass" }
  | {
      kind: "prompt";
      text: string;
      newConversation?: boolean;
      persona?: string;
    }
  | {
      kind: "command";
      name: string;
      args?: string;
      known?: boolean;
      class?: "run" | "edit";
    }
  | { kind: "agent"; name: string; args: string };

const CASES: readonly [string, Expect][] = [
  // ── ordinary shell lines: prefaix is not involved ────────────────────────
  ["ls", { kind: "pass" }],
  ["", { kind: "pass" }],
  ["git status", { kind: "pass" }],
  ["  : hidden", { kind: "pass" }],
  ["\t: tabbed", { kind: "pass" }],
  ["\\: escaped", { kind: "pass" }],
  ["\\::double", { kind: "pass" }],
  ["::", { kind: "pass" }],
  ["echo ': not a command'", { kind: "pass" }],
  ["http://example.com", { kind: "pass" }],

  // ── passthrough idioms: the builtins still work after a colon ───────────
  // A bare `:` belongs to the shell: the documented passthrough pattern
  // claims it, so the shell's own empty-line handling is what runs.
  [":", { kind: "pass" }],
  [": ", { kind: "pass" }],
  [":>out.txt", { kind: "pass" }],
  [": >>out.txt", { kind: "pass" }],
  [": | less", { kind: "pass" }],
  [": > f", { kind: "pass" }],
  [": ${X:=1}", { kind: "pass" }],
  [": ; echo done", { kind: "pass" }],
  [": $(date)", { kind: "pass" }],
  [": [ -f x ]", { kind: "pass" }],
  [": { echo hi; }", { kind: "pass" }],
  [": && echo ok", { kind: "pass" }],
  [": || echo no", { kind: "pass" }],

  // ── a plain prompt ───────────────────────────────────────────────────────
  [": fix the failing test", { kind: "prompt", text: "fix the failing test" }],
  [":fix the failing test", { kind: "prompt", text: "fix the failing test" }],
  [":   spaced out", { kind: "prompt", text: "spaced out" }],
  [":  it's fine", { kind: "prompt", text: "it's fine" }],
  [": echo $(pwd) now", { kind: "prompt", text: "echo $(pwd) now" }],
  [": cat *.ts", { kind: "prompt", text: "cat *.ts" }],
  [": why?!", { kind: "prompt", text: "why?!" }],
  [": 100% done?", { kind: "prompt", text: "100% done?" }],
  [": ¿qué?", { kind: "prompt", text: "¿qué?" }],
  [": 日本語で答えて", { kind: "prompt", text: "日本語で答えて" }],
  [": emoji 🎉 works", { kind: "prompt", text: "emoji 🎉 works" }],
  [": a\ttab", { kind: "prompt", text: "a\ttab" }],
  [": a back\\slash", { kind: "prompt", text: "a back\\slash" }],
  [": --flag=value", { kind: "prompt", text: "--flag=value" }],
  [": #1 priority", { kind: "prompt", text: "#1 priority" }],
  [": 3 + 4", { kind: "prompt", text: "3 + 4" }],
  [": 50% off `now`", { kind: "prompt", text: "50% off `now`" }],

  // ── multi-line buffers: only the first line decides ─────────────────────
  [": first line\nsecond line", { kind: "prompt", text: "first line" }],
  [": info\nthis is still a note", { kind: "command", name: "info", args: "" }],
  ["normal\n: not reached", { kind: "pass" }],
  [": trailing newline\n", { kind: "prompt", text: "trailing newline" }],
  [": windows\r\nline two", { kind: "prompt", text: "windows" }],

  // ── MVP commands ─────────────────────────────────────────────────────────
  [": new", { kind: "command", name: "new", args: "" }],
  [":n", { kind: "command", name: "n", args: "" }],
  [
    ": new start a thing",
    { kind: "command", name: "new", args: "start a thing" },
  ],
  [": conversation", { kind: "command", name: "conversation", args: "" }],
  [":c", { kind: "command", name: "c", args: "" }],
  [":c -", { kind: "command", name: "c", args: "-" }],
  [":c auth work", { kind: "command", name: "c", args: "auth work" }],
  [": model", { kind: "command", name: "model", args: "" }],
  [":m", { kind: "command", name: "m", args: "" }],
  [":m gemini", { kind: "command", name: "m", args: "gemini" }],
  [": think", { kind: "command", name: "think", args: "" }],
  [": think high", { kind: "command", name: "think", args: "high" }],
  [": info", { kind: "command", name: "info", args: "" }],
  [":i", { kind: "command", name: "i", args: "" }],
  [": copy", { kind: "command", name: "copy", args: "" }],
  [": help", { kind: "command", name: "help", args: "" }],
  [":?", { kind: "command", name: "?", args: "" }],
  [":? quick", { kind: "command", name: "?", args: "quick" }],
  [": doctor", { kind: "command", name: "doctor", args: "" }],

  // ── M4 commands: parsed, and reported as not yet implemented ─────────────
  [
    ": suggest how do I bisect",
    {
      kind: "command",
      name: "suggest",
      args: "how do I bisect",
      class: "edit",
      known: false,
    },
  ],
  [":s", { kind: "command", name: "s", args: "", class: "edit", known: false }],
  [
    ": commit",
    { kind: "command", name: "commit", args: "", class: "edit", known: false },
  ],
  [
    ": commit fix auth",
    {
      kind: "command",
      name: "commit",
      args: "fix auth",
      class: "edit",
      known: false,
    },
  ],
  [": retry", { kind: "command", name: "retry", args: "", known: false }],
  [":r", { kind: "command", name: "r", args: "", known: false }],
  [": compact", { kind: "command", name: "compact", args: "", known: false }],
  [
    ": compact the auth part",
    { kind: "command", name: "compact", args: "the auth part", known: false },
  ],
  [
    ": rename auth work",
    { kind: "command", name: "rename", args: "auth work", known: false },
  ],
  [
    ":rn shorter",
    { kind: "command", name: "rn", args: "shorter", known: false },
  ],
  [
    ": skill review",
    { kind: "command", name: "skill", args: "review", known: false },
  ],
  [": attach", { kind: "command", name: "attach", args: "", known: false }],
  [": abort", { kind: "command", name: "abort", args: "", known: false }],
  [": tui", { kind: "command", name: "tui", args: "", known: false }],
  [": backend", { kind: "command", name: "backend", args: "", known: false }],

  // ── personas: a verb when it has an argument, a prompt when it does not ──
  [
    ": ask why is this slow",
    { kind: "prompt", text: "why is this slow", persona: "ask" },
  ],
  [
    ":plan how to split this",
    { kind: "prompt", text: "how to split this", persona: "plan" },
  ],
  [": ask", { kind: "command", name: "ask", args: "", known: false }],
  [": plan", { kind: "command", name: "plan", args: "", known: false }],
  [": asdk something", { kind: "prompt", text: "asdk something" }],

  // ── agent slash commands ─────────────────────────────────────────────────
  [":/review", { kind: "agent", name: "review", args: "" }],
  [":/review src/core", { kind: "agent", name: "review", args: "src/core" }],
  [
    ":/skill:dataviz build a chart",
    { kind: "agent", name: "skill:dataviz", args: "build a chart" },
  ],
  [":/", { kind: "pass" }],
  [":/  spaced", { kind: "pass" }],

  // ── unknown names ────────────────────────────────────────────────────────
  // A name with text after it is a prompt, because that is what `: fix the
  // failing test` looks like. A bare name that is one edit from a real command
  // is an error, because there is no prompt it could have meant.
  [": nope", { kind: "prompt", text: "nope" }],
  // One edit from `:new`, so the error listing the closest matches is the
  // right answer rather than sending `Nw` to the model as a question.
  [":Nw", { kind: "command", name: "Nw", known: false }],
  [": modle gemini", { kind: "prompt", text: "modle gemini" }],
  [": modle", { kind: "command", name: "modle", known: false }],
  [": helo", { kind: "command", name: "helo", known: false }],
  [": inf", { kind: "command", name: "inf", known: false }],
  [": retrying the build", { kind: "prompt", text: "retrying the build" }],
  [": compacting the disk", { kind: "prompt", text: "compacting the disk" }],
  [": now do the thing", { kind: "prompt", text: "now do the thing" }],
  [": run the tests", { kind: "prompt", text: "run the tests" }],
  [": build it", { kind: "prompt", text: "build it" }],
  [": copy the file", { kind: "prompt", text: "copy the file" }],
  // A command that takes an argument keeps the name, so a sentence that begins
  // with one of them is read as that command with a long argument. The client
  // reports an argument it cannot use rather than silently ignoring it.
  [
    ": commit message please",
    {
      kind: "command",
      name: "commit",
      args: "message please",
      class: "edit",
      known: false,
    },
  ],
  [
    ": rename this variable",
    { kind: "command", name: "rename", args: "this variable", known: false },
  ],
  [": attach the debugger", { kind: "prompt", text: "attach the debugger" }],
  // `:help` takes an optional topic, so a sentence that starts with it is that
  // command rather than a prompt.
  [
    ": help me understand this",
    { kind: "command", name: "help", args: "me understand this" },
  ],
  [
    ": think about the design",
    { kind: "command", name: "think", args: "about the design" },
  ],
  [": new file needed", { kind: "command", name: "new", args: "file needed" }],
  [
    ": model the domain",
    { kind: "command", name: "model", args: "the domain" },
  ],
  [": doctor the logs", { kind: "prompt", text: "doctor the logs" }],
  [": tui in a pty", { kind: "prompt", text: "tui in a pty" }],
  [": abort everything", { kind: "prompt", text: "abort everything" }],
  [
    ": skill up on rust",
    { kind: "command", name: "skill", args: "up on rust", known: false },
  ],
  [
    ": compact the answer",
    { kind: "command", name: "compact", args: "the answer", known: false },
  ],
];

function check(parsed: Parsed, expected: Expect): void {
  if (expected.kind === "pass") {
    expect(parsed.kind, "kind").toBe("pass");
    return;
  }
  expect(parsed.kind, "kind").toBe(expected.kind);
  if (parsed.kind === "prompt" && expected.kind === "prompt") {
    expect(parsed.text).toBe(expected.text);
    expect(parsed.newConversation).toBe(expected.newConversation ?? false);
    if (expected.persona !== undefined) {
      expect(parsed.persona).toBe(expected.persona);
    }
    return;
  }
  if (parsed.kind === "command" && expected.kind === "command") {
    expect(parsed.name).toBe(expected.name);
    if (expected.args !== undefined) {
      expect(parsed.args).toBe(expected.args);
    }
    if (expected.class !== undefined) {
      expect(parsed.class).toBe(expected.class);
    }
    if (expected.known !== undefined) {
      expect(parsed.known).toBe(expected.known);
    }
    return;
  }
  if (parsed.kind === "agent" && expected.kind === "agent") {
    expect(parsed.name).toBe(expected.name);
    expect(parsed.args).toBe(expected.args);
  }
}

describe("the line grammar", () => {
  it("has the documented number of cases", () => {
    // A table that quietly shrinks is worse than a small one, because the
    // cases that disappeared are the ones nobody re-reads.
    expect(CASES.length).toBeGreaterThanOrEqual(100);
  });

  for (const [buffer, expected] of CASES) {
    it(`${JSON.stringify(buffer)} is ${expected.kind}`, () => {
      check(parseLine(buffer), expected);
    });
  }
});

describe("configurable behaviour", () => {
  it("honours a configured passthrough pattern", () => {
    // A user who wants `:!` to mean "run a shell command" says so in config.
    expect(parseLine(":!ls", { passthrough: "^:!" }).kind).toBe("pass");
    expect(parseLine(": !ls", { passthrough: "^:\\s*!" }).kind).toBe("pass");
    expect(parseLine(": !ls", { passthrough: "^:!" }).kind).toBe("prompt");
  });

  it("falls back to the documented default when the configured pattern is broken", () => {
    expect(parseLine(": > f", { passthrough: "([unclosed" }).kind).toBe("pass");
    expect(parseLine(": fix it", { passthrough: "([unclosed" }).kind).toBe(
      "prompt",
    );
  });

  it("decides on the first line of a multi-line buffer", () => {
    // A `:` further down is part of what the user is sending, not a command
    // they are asking prefaix to run.
    expect(parseLine("first line\n: second")).toMatchObject({
      kind: "pass",
      line: "first line\n: second",
    });
    // `run` takes no argument, so a line with words after it is a prompt that
    // happens to start with a command's name, and only the first line counts.
    expect(parseLine(": run this\n: and this")).toMatchObject({
      kind: "prompt",
      text: "run this",
    });
    expect(parseLine(": new\n: and this")).toMatchObject({ kind: "command" });
  });

  it("strips the carriage return a pasted buffer carries", () => {
    // A buffer pasted from a Windows terminal keeps its `\r`; without this the
    // turn would see a sentence with a stray control character on the end.
    expect(parseLine(": read the file\r")).toMatchObject({
      kind: "prompt",
      text: "read the file",
    });
    expect(parseLine(": new \r")).toMatchObject({
      kind: "command",
      name: "new",
    });
  });

  it("treats a colon followed by nothing as a prompt with no text", () => {
    // With passthrough turned off there is nothing else a bare colon can be.
    expect(parseLine(":", { passthrough: "^$" })).toMatchObject({
      kind: "prompt",
      text: "",
    });
    expect(parseLine(":   ", { passthrough: "^$" })).toMatchObject({
      kind: "prompt",
      text: "",
    });
  });

  it("passes a slash that is not an agent command name back to the shell", () => {
    // `:/ 2 + 2` is arithmetic and `:/ model` needs the name tight against the
    // slash, so neither is an agent command and the shell keeps both.
    expect(parseLine(":/ 2 + 2")).toMatchObject({ kind: "pass" });
    expect(parseLine(":/ model --fast")).toMatchObject({ kind: "pass" });
    expect(parseLine(":/model")).toMatchObject({
      kind: "agent",
      name: "model",
    });
    expect(parseLine(":/model --fast")).toMatchObject({
      kind: "agent",
      name: "model",
      args: "--fast",
    });
  });

  it("keeps a name that is not a plain word whole", () => {
    // The name is the first run of non-space characters whatever it is made
    // of, so a non-latin word is a prompt rather than a mangled command.
    expect(parseLine(":日本語")).toMatchObject({
      kind: "prompt",
      text: "日本語",
    });
    expect(parseLine(":info")).toMatchObject({ kind: "command", name: "info" });
  });

  it("accepts a persona the user defined", () => {
    const parsed = parseLine(": audit the deps", { personas: ["audit"] });
    expect(parsed).toMatchObject({ kind: "prompt", persona: "audit" });
  });

  it("marks an M4 command known once this build reaches M4", () => {
    const parsed = parseLine(": compact", { implemented: "M4" });
    expect(parsed).toMatchObject({ kind: "command", known: true });
  });
});

describe("the passthrough pattern itself", () => {
  it("is the one DESIGN §3.1 documents", () => {
    expect(DEFAULT_PASSTHROUGH).toBe("^:\\s*($|[>|<&;$({\\[])");
  });
});

describe("suggestions for a misspelling", () => {
  it("names the closest commands", () => {
    expect(suggestions("modle")).toContain("model");
    expect(suggestions("hel")).toContain("help");
    expect(suggestions("cnversation")).toContain("conversation");
  });

  it("says nothing for a name that is nothing like a command", () => {
    expect(suggestions("zzzzzzzz")).toEqual([]);
  });

  it("is empty for an empty name", () => {
    expect(suggestions("")).toEqual([]);
  });

  it("can search a caller-supplied list", () => {
    expect(suggestions("bark", ["back", "bark"])[0]).toBe("bark");
  });
});

describe("the command table", () => {
  it("has a unique name and alias for every command", () => {
    const seen = new Set<string>();
    for (const command of COMMANDS) {
      for (const name of [command.name, ...command.aliases]) {
        expect(seen.has(name), `duplicate: ${name}`).toBe(false);
        seen.add(name);
      }
    }
  });

  it("gives every command a summary and a milestone", () => {
    for (const command of COMMANDS) {
      expect(command.summary.length).toBeGreaterThan(10);
      expect(["MVP", "M4", "M5"]).toContain(command.milestone);
    }
  });

  it("keeps the edit class to the two commands that fill a buffer", () => {
    expect(
      COMMANDS.filter((command) => command.class === "edit").map((c) => c.name),
    ).toEqual(["suggest", "commit"]);
  });
});
