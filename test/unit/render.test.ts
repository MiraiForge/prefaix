import { describe, expect, it } from "vitest";
import { MarkdownStream } from "../../src/client/render/styler.js";
import {
  Spinner,
  ToolLineManager,
  formatMs,
  renderFooter,
  renderNotice,
} from "../../src/client/render/chrome.js";
import { capabilities, paint } from "../../src/client/render/theme.js";
import { Renderer } from "../../src/client/render/renderer.js";
import {
  DialogRefused,
  MAX_SELECT_OPTIONS,
  renderSelect,
  runConfirm,
  runDialog,
  runInput,
  runSelect,
  validate,
  type DialogIo,
  type DialogRequest,
} from "../../src/client/render/dialogs.js";
import { buildContext, readTerminal } from "../../src/context/shell-context.js";
import type { AgentEvent } from "../../src/core/agent-port.js";

const TTY_ENV = { TERM: "xterm-256color", COLUMNS: "100", LINES: "30" };
const PLAIN = { env: { TERM: "xterm-256color" }, isTty: false };

/** Feeds a whole string in one chunk, the way a fast model would. */
function styleAll(text: string, env: Record<string, string> = TTY_ENV): string {
  const stream = new MarkdownStream({
    caps: capabilities({ env, isTty: true }),
  });
  return `${stream.push(text)}${stream.flush()}`;
}

/** Feeds a string in chunks of `size`, the way a real stream arrives. */
function styleChunked(
  text: string,
  size: number,
  env: Record<string, string> = TTY_ENV,
): string {
  const stream = new MarkdownStream({
    caps: capabilities({ env, isTty: true }),
  });
  let out = "";
  for (let at = 0; at < text.length; at += size) {
    out += stream.push(text.slice(at, at + size));
  }
  return `${out}${stream.flush()}`;
}

/** The styled text with every escape code removed, for content assertions. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex -- stripping escapes is the point
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("what the terminal can do", () => {
  it("paints a terminal it is talking to", () => {
    const caps = capabilities({ env: TTY_ENV, isTty: true });
    expect(caps.color).toBe(true);
    expect(caps.spinner).toBe(true);
    expect(paint(caps, "\u001b[1m", "x")).not.toBe("x");
  });

  it("assumes no terminal when the caller did not say", () => {
    // The default is the safe one: without a tty there is nothing to draw on.
    const caps = capabilities({ env: TTY_ENV });
    expect(caps.color).toBe(false);
    expect(caps.spinner).toBe(false);
  });

  it("paints nothing into a pipe", () => {
    const caps = capabilities(PLAIN);
    expect(caps.color).toBe(false);
    expect(caps.inPlace).toBe(false);
    expect(paint(caps, "\u001b[1m", "x")).toBe("x");
  });

  it("obeys NO_COLOR", () => {
    expect(
      capabilities({ env: { ...TTY_ENV, NO_COLOR: "1" }, isTty: true }).color,
    ).toBe(false);
  });

  it("keeps color for an empty NO_COLOR, which is what the spec says", () => {
    // https://no-color.org: the variable disables color "when present and not
    // an empty string", so `NO_COLOR=` is a user who has not opted out.
    expect(
      capabilities({ env: { ...TTY_ENV, NO_COLOR: "" }, isTty: true }).color,
    ).toBe(true);
  });

  it("obeys PREFAIX_PLAIN", () => {
    expect(
      capabilities({ env: { ...TTY_ENV, PREFAIX_PLAIN: "1" }, isTty: true })
        .spinner,
    ).toBe(false);
  });

  it("obeys a dumb terminal", () => {
    expect(capabilities({ env: { TERM: "dumb" }, isTty: true }).color).toBe(
      false,
    );
  });

  it("reports a width it can work with even when the shell said nothing", () => {
    expect(
      capabilities({ env: {}, isTty: false }).width,
    ).toBeGreaterThanOrEqual(20);
  });
});

describe("the streaming markdown styler", () => {
  const cases: readonly string[] = [
    "plain text",
    "# A heading",
    "## A smaller heading",
    "a line\n# a heading on the second line",
    "- a bullet\n- another",
    "1. first\n2. second",
    "> a quotation",
    "**bold** and *italic* and _also italic_",
    "a `code span` in a sentence",
    "```ts\nconst x = 1; // *not italic*\n```",
    "~~~\nraw fence\n~~~",
    "| a | b |\n| - | - |",
    "2 * 3 is arithmetic",
    "snake_case_word stays one word",
    "text with émojis 🎉 and 日本語",
    "",
    "\n",
    "trailing spaces   \nnext",
  ];

  it("is chunking-invariant: the styled output does not depend on the deltas", () => {
    for (const text of cases) {
      const whole = styleAll(text);
      for (const size of [1, 2, 3, 5, 7]) {
        expect(styleChunked(text, size), `size ${String(size)}: ${text}`).toBe(
          whole,
        );
      }
    }
  });

  it("never loses or invents a character", () => {
    for (const text of cases) {
      expect(plain(styleAll(text))).toBe(text);
    }
  });

  it("never hard-wraps, so a copy-paste gets the original line", () => {
    const long = "x".repeat(500);
    expect(plain(styleAll(long))).toBe(long);
  });

  it("styles a heading", () => {
    expect(styleAll("# Title")).toContain("\u001b[1m");
  });

  it("leaves a fenced block alone", () => {
    const styled = styleAll("```\n*not* italic\n```");
    expect(plain(styled)).toBe("```\n*not* italic\n```");
    // The fence markers are dimmed, and nothing inside them is.
    expect(styled.includes("\u001b[3m*not*")).toBe(false);
  });

  it("knows it is inside a fence", () => {
    const stream = new MarkdownStream({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
    });
    stream.push("```\n");
    expect(stream.inFence).toBe(true);
    stream.push("more\n");
    expect(stream.inFence).toBe(true);
    stream.push("```\n");
    expect(stream.inFence).toBe(false);
  });

  it("closes an unterminated fence at the end of the block", () => {
    const stream = new MarkdownStream({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
    });
    stream.push("```\nunterminated");
    stream.flush();
    expect(stream.inFence).toBe(true);
  });

  it("emits nothing when a terminal cannot be painted", () => {
    const stream = new MarkdownStream({ caps: capabilities(PLAIN) });
    expect(`${stream.push("# Title")}${stream.flush()}`).toBe("# Title");
  });

  it("starts a new block with no fence and no hold-back", () => {
    const stream = new MarkdownStream({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
    });
    stream.push("```\n");
    stream.reset(1);
    expect(stream.inFence).toBe(false);
    expect(stream.block).toBe(1);
    expect(plain(`${stream.push("text")}${stream.flush()}`)).toBe("text");
  });

  it("holds a marker back until it can tell an emphasis from punctuation", () => {
    const stream = new MarkdownStream({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
    });
    // `2 * 3` and `*emphasis*` differ only in what follows the star, so the
    // star is held until a partner turns up or the window closes.
    expect(stream.push("2 *")).toBe("2 ");
    const rest = `${stream.push(" 3 and more")}${stream.flush()}`;
    // "2 " came out on the first push; the held star arrives once the window
    // closes with no partner in it.
    expect(plain(`2 ${rest}`)).toBe("2 * 3 and more");
  });

  it("reports how much of the text it is still holding, and styles it whole", () => {
    const stream = new MarkdownStream({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
    });
    // A whole string is what a notice or a footer needs, and `pending` is how a
    // caller can tell that something is still being held back.
    expect(stream.pending).toBe(0);
    expect(plain(stream.render("**bold**"))).toBe("**bold**");
    expect(stream.pending).toBe(0);
    const out: string[] = [stream.push("a ")];
    expect(stream.pending).toBe(0);
    out.push(stream.push("*b"));
    expect(stream.pending).toBeGreaterThan(0);
    // The held marker is released with the rest when the string is closed out.
    out.push(stream.render(" c* d"));
    expect(plain(out.join(""))).toBe("a *b c* d");
    expect(stream.pending).toBe(0);
  });

  it("pairs a marker with a partner that arrives far ahead of it", () => {
    const stream = new MarkdownStream({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
    });
    const styled = `${stream.push("*emphasis that runs on*")}${stream.flush()}`;
    expect(plain(styled)).toBe("*emphasis that runs on*");
    expect(styled).toContain("\u001b[3m");
  });

  it("leaves a fence unmarked in a terminal that paints nothing", () => {
    const stream = new MarkdownStream({ caps: capabilities(PLAIN) });
    const out = [stream.push("```ts\nconst x = 1;\n")];
    expect(stream.inFence).toBe(true);
    // A pipe gets the backticks and nothing else: no colour, no reset, and no
    // escape codes a file redirect would only fill with noise.
    out.push(stream.push("more\n"), stream.flush());
    expect(plain(out.join(""))).toBe("```ts\nconst x = 1;\nmore\n");
  });

  it("opens a fence the moment three backticks arrive at a line start", () => {
    const stream = new MarkdownStream({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
    });
    expect(stream.inFence).toBe(false);
    stream.push("```\n");
    expect(stream.inFence).toBe(true);
  });
});

describe("tool lines", () => {
  function manager(
    env: Record<string, string> = TTY_ENV,
    isTty = true,
    now?: () => number,
  ) {
    return new ToolLineManager({
      caps: capabilities({ env, isTty }),
      ...(now ? { now } : {}),
    });
  }

  it("starts a line with the name and the adapter's summary", () => {
    const tools = manager();
    tools.start("t1", "bash", "$ bun test");
    expect(tools.lines[0]).toMatchObject({
      name: "bash",
      summary: "$ bun test",
      done: false,
    });
  });

  it("finalizes with a duration and a check mark", () => {
    let now = 0;
    const tools = manager(TTY_ENV, true, () => now);
    tools.start("t1", "read", "src/a.ts");
    now = 1_200;
    tools.end("t1", true, undefined, 1_200);
    const rendered = plain(tools.render(tools.lines[0] as never));
    expect(rendered).toContain("✓ 1.2s");
    expect(rendered).toContain("read");
  });

  it("marks a failure with a cross", () => {
    const tools = manager();
    tools.start("t1", "grep", "pattern");
    tools.end("t1", false);
    expect(plain(tools.render(tools.lines[0] as never))).toContain("✗");
  });

  it("appends the result the adapter reported for an edit", () => {
    const tools = manager();
    tools.start("t1", "edit", "src/a.ts");
    tools.end("t1", true, "+3 −1");
    expect(tools.lines[0]?.summary).toBe("src/a.ts +3 −1");
  });

  it("redraws a running tool in place, and stops once it is done", () => {
    const tools = manager();
    tools.start("t1", "bash", "$ bun run check");
    expect(tools.pending()?.id).toBe("t1");
    tools.update("t1", "$ tsc --noEmit");
    expect(tools.pending()?.id).toBe("t1");
    tools.end("t1", true);
    expect(tools.pending()).toBeUndefined();
  });

  it("does not redraw in place without a terminal", () => {
    const tools = manager(TTY_ENV, false);
    tools.start("t1", "bash", "$ ls");
    expect(tools.pending()).toBeUndefined();
  });

  it("ignores an update for a tool it never saw", () => {
    const tools = manager();
    expect(() => tools.update("nope")).not.toThrow();
    expect(() => tools.end("nope", true)).not.toThrow();
    expect(tools.lines).toEqual([]);
  });

  it("ignores an update that arrives after the tool finished", () => {
    const tools = manager();
    tools.start("t1", "bash", "$ ls");
    tools.end("t1", true);
    tools.update("t1", "late");
    expect(tools.lines[0]?.result).toBeUndefined();
  });

  it("keeps a bounded history so a long turn does not scroll away", () => {
    const tools = manager();
    for (let at = 0; at < 40; at++) {
      tools.start(`t${String(at)}`, "bash", `$ step ${String(at)}`);
      tools.end(`t${String(at)}`, true);
    }
    tools.trim(5);
    expect(tools.lines.length).toBeLessThanOrEqual(5);
  });

  it("marks a line as drawn so it is written once", () => {
    const tools = manager();
    tools.start("t1", "read", "a.ts");
    tools.end("t1", true);
    tools.markDrawn("t1");
    expect(tools.lines[0]?.drawn).toBe(true);
  });

  it("formats a duration the way a person reads it", () => {
    expect(formatMs(undefined)).toBe("");
    expect(formatMs(12)).toBe("12ms");
    expect(formatMs(1_240)).toBe("1.2s");
  });
});

describe("the spinner", () => {
  it("does not start without a terminal", () => {
    const lines: string[] = [];
    const spinner = new Spinner({
      caps: capabilities(PLAIN),
      write: (text) => lines.push(text),
      erase: () => undefined,
    });
    spinner.start("thinking");
    expect(spinner.active).toBe(false);
    spinner.stop();
    expect(lines).toEqual([]);
  });

  it("erases before it draws and again when it stops", () => {
    let erases = 0;
    const written: string[] = [];
    const spinner = new Spinner({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
      intervalMs: 5,
      write: (text) => written.push(text),
      erase: () => {
        erases += 1;
      },
    });
    spinner.start("thinking");
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        spinner.stop();
        expect(written.length).toBeGreaterThan(0);
        expect(plain(written[0] ?? "")).toContain("esc to abort");
        expect(erases).toBeGreaterThan(0);
        resolve();
      }, 30);
    });
  });

  it("erases nothing when it never drew", () => {
    let erases = 0;
    const spinner = new Spinner({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
      write: () => undefined,
      erase: () => {
        erases += 1;
      },
    });
    spinner.start("thinking");
    spinner.stop();
    expect(erases).toBe(0);
  });
});

describe("the footer", () => {
  it("leaves out a field the renderer has nothing for", () => {
    const caps = capabilities({ env: TTY_ENV, isTty: true, cols: 80 });
    // No tools have run, so there is no tool count to show; showing zero would
    // be a claim the renderer cannot back up.
    expect(renderFooter({}, ["tools"], caps)).toBe("");
    expect(renderFooter({}, ["cost", "context", "model"], caps)).toBe("");
  });

  it("shows the fields the config asked for, in order", () => {
    const caps = capabilities({ env: TTY_ENV, isTty: true });
    const line = plain(
      renderFooter(
        {
          time: "14.2s",
          tools: 3,
          costUsd: 0.018,
          contextPct: 22,
          model: "flash",
        },
        ["time", "tools", "cost", "context", "model"],
        caps,
      ),
    );
    expect(line).toBe("── 14.2s · 3 tools · $0.018 · ctx 22% · flash");
  });

  it("leaves out a field it has no value for", () => {
    const caps = capabilities({ env: TTY_ENV, isTty: true });
    expect(plain(renderFooter({ tools: 2 }, ["time", "tools"], caps))).toBe(
      "── 2 tools",
    );
  });

  it("leaves out a context percentage the backend does not know", () => {
    const caps = capabilities({ env: TTY_ENV, isTty: true });
    expect(plain(renderFooter({ contextPct: null }, ["context"], caps))).toBe(
      "",
    );
  });

  it("prints nothing when it has nothing to say", () => {
    expect(renderFooter({}, [], capabilities(PLAIN))).toBe("");
  });
});

describe("notices", () => {
  it("is one dim line", () => {
    const caps = capabilities({ env: TTY_ENV, isTty: true });
    expect(plain(renderNotice("warn", "retrying", caps))).toBe("retrying");
    expect(renderNotice("error", "boom", caps)).toContain("\u001b[31m");
  });
});

describe("the renderer", () => {
  function make(env: Record<string, string> = TTY_ENV, isTty = true) {
    const out: string[] = [];
    const err: string[] = [];
    const renderer = new Renderer({
      caps: capabilities({ env, isTty, cols: 80 }),
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      footer: ["time", "tools", "cost"],
    });
    return { renderer, out, err };
  }

  const events = (): AgentEvent[] => [
    { type: "turn_start" },
    { type: "text_delta", block: 0, text: "Hello " },
    { type: "text_delta", block: 0, text: "there.\n" },
    { type: "text_end", block: 0 },
    { type: "tool_start", id: "t1", name: "bash", summary: "$ ls" },
    { type: "tool_end", id: "t1", ok: true, ms: 10 },
    {
      type: "usage",
      input: 10,
      output: 20,
      costUsd: 0.5,
      contextPct: 30,
    },
    { type: "settled", stopReason: "stop" },
  ];

  it("writes assistant text to stdout and chrome to stderr", () => {
    const { renderer, out, err } = make();
    renderer.begin();
    for (const event of events()) {
      renderer.handle(event);
    }
    expect(plain(out.join(""))).toBe("Hello there.\n");
    expect(plain(err.join(""))).toContain("⏺ bash");
    expect(plain(err.join(""))).toContain("── ");
  });

  it("draws each finished tool line exactly once", () => {
    const { renderer, err } = make();
    renderer.handle({
      type: "tool_start",
      id: "t1",
      name: "bash",
      summary: "$ ls",
    });
    renderer.handle({ type: "tool_end", id: "t1", ok: true, ms: 10 });
    renderer.handle({ type: "text_delta", block: 0, text: "x" });
    renderer.handle({ type: "text_end", block: 0 });
    // The live in-place line also shows a check, so the assertion is on the
    // finalized line's own duration, which only it carries.
    expect(plain(err.join("")).split("✓ 10ms")).toHaveLength(2);
  });

  it("prints a notice for a retry and for a compaction", () => {
    const { renderer, err } = make();
    renderer.handle({
      type: "retry",
      attempt: 1,
      max: 3,
      delayMs: 500,
      reason: "429",
    });
    renderer.handle({
      type: "compaction",
      phase: "start",
      reason: "threshold",
    });
    const text = plain(err.join(""));
    expect(text).toContain("retrying (1/3): 429");
    expect(text).toContain("compacting (threshold)");
  });

  it("keeps a status map for :info", () => {
    const { renderer } = make();
    renderer.handle({ type: "status", key: "mcp", text: "10 servers" });
    renderer.handle({ type: "status", key: "mcp" });
    expect(renderer.statuses()).toEqual({});
  });

  it("collects a buffer the agent asked to hand back", () => {
    const { renderer } = make();
    renderer.handle({ type: "set_buffer", text: "git status" });
    expect(renderer.takeBuffer()).toBe("git status");
    expect(renderer.takeBuffer()).toBe("");
  });

  it("accumulates the assistant's text for :copy and the last answer", () => {
    const { renderer } = make();
    for (const event of events()) {
      renderer.handle(event);
    }
    expect(renderer.stats.lastText).toBe("Hello there.\n");
    expect(renderer.stats.tools).toBe(1);
    expect(renderer.stats.costUsd).toBe(0.5);
  });

  it("prints the reason a turn failed", () => {
    const { renderer, err } = make();
    renderer.handle({
      type: "settled",
      stopReason: "error",
      error: "rate limited",
    });
    expect(plain(err.join(""))).toContain("rate limited");
  });

  it("reports nothing it has not been told", () => {
    const { renderer } = make();
    // Before anything happens there is no model, no cost, and no context, and
    // the footer has to say that by saying nothing at all.
    expect(renderer.stats).toMatchObject({ tools: 0, lastText: "" });
    expect(renderer.stats).not.toHaveProperty("model");
    expect(renderer.stats).not.toHaveProperty("costUsd");
    expect(renderer.stats).not.toHaveProperty("contextPct");
    expect(renderer.stats).not.toHaveProperty("buffer");
  });

  it("reports the model, cost, context, and buffer a turn set", () => {
    const { renderer } = make();
    for (const event of events()) {
      renderer.handle(event);
    }
    // The model arrives from the client, not from the event stream: `:model`
    // changes it between turns and the footer has to show the new one.
    renderer.setModel("pi/flash");
    renderer.handle({ type: "set_buffer", text: "git status" });
    expect(renderer.stats).toMatchObject({
      costUsd: 0.5,
      contextPct: 30,
      buffer: "git status",
    });
    expect(renderer.stats.model).toBe("pi/flash");
    renderer.setModel(undefined);
    expect(renderer.stats.model).toBeUndefined();
    expect(renderer.takeBuffer()).toBe("git status");
    expect(renderer.stats.buffer).toBeUndefined();
  });

  it("keeps the last cost a usage event gave it", () => {
    const { renderer } = make();
    // A backend that reports tokens without a price must not erase the price
    // from an earlier turn.
    renderer.handle({ type: "usage", input: 1, output: 2, costUsd: 0.25 });
    renderer.handle({ type: "usage", input: 3, output: 4 });
    expect(renderer.stats.costUsd).toBe(0.25);
    // A context reading of "no idea" clears the field rather than showing zero.
    renderer.handle({ type: "usage", input: 5, output: 6, contextPct: null });
    expect(renderer.stats.contextPct).toBeNull();
  });

  it("flushes a held marker when a block is cut short", () => {
    const out: string[] = [];
    const renderer = new Renderer({
      caps: capabilities({ env: TTY_ENV, isTty: true, cols: 80 }),
      out: (text) => out.push(text),
      err: () => undefined,
      footer: [],
    });
    // A `*` on its own is held back waiting for a partner; the block ending
    // before one arrives has to give it back or the answer loses a character.
    renderer.handle({ type: "text_delta", block: 0, text: "2 *" });
    renderer.handle({ type: "text_end", block: 0 });
    expect(plain(out.join(""))).toContain("2 *");
    // And ending a block that is already closed is not an error.
    renderer.handle({ type: "text_end", block: 0 });
  });

  it("erases nothing on a terminal that cannot rewrite its line", () => {
    const err: string[] = [];
    const renderer = new Renderer({
      caps: capabilities({ env: {}, isTty: false }),
      out: () => undefined,
      err: (text) => err.push(text),
      footer: [],
    });
    // A spinner in a pipe has no row to erase, so the erase is a no-op rather
    // than a stream of escape codes nobody can act on.
    renderer.handle({ type: "turn_start" });
    expect(plain(err.join(""))).not.toContain("\u001b[2K");
  });

  it("ignores a second settle, because a turn has exactly one", () => {
    const { renderer, err } = make();
    renderer.handle({ type: "settled", stopReason: "stop" });
    const first = err.length;
    renderer.handle({ type: "settled", stopReason: "stop" });
    expect(err.length).toBe(first);
  });

  it("prints plain text for a command's own output", () => {
    const { renderer, out } = make();
    renderer.line("conversation: none");
    expect(out.join("")).toBe("conversation: none\n");
    renderer.line("");
    expect(out.join("")).toBe("conversation: none\n\n");
  });
});

describe("dialogs", () => {
  function io(
    keys: { name: string; text: string }[] = [],
    lines: string[] = [],
  ): DialogIo & { written: string[] } {
    const written: string[] = [];
    const queue = [...keys];
    return {
      written,
      caps: capabilities({ env: TTY_ENV, isTty: true }),
      write: (text) => written.push(text),
      erase: () => undefined,
      readKey: () =>
        Promise.resolve(queue.shift() ?? { name: "esc", text: "" }),
      readLine: () => Promise.resolve(lines.shift() ?? ""),
    };
  }

  const select: DialogRequest = {
    id: "u1",
    kind: "select",
    title: "Pick one",
    options: ["first", "second"],
  };

  it("refuses a select with no options", () => {
    expect(() => validate({ ...select, options: [] })).toThrow(DialogRefused);
  });

  it("refuses a select that arrived without options at all", () => {
    // A backend that omits the field entirely is a different mistake from one
    // that sends an empty list, and both have to be refused.
    const broken = {
      id: "u1",
      kind: "select",
      title: "Pick one",
    } as DialogRequest;
    expect(() => validate(broken)).toThrow(DialogRefused);
  });

  it("refuses a select too long to show inline", () => {
    const options = Array.from(
      { length: MAX_SELECT_OPTIONS + 1 },
      (_, at) => `o${String(at)}`,
    );
    expect(() => validate({ ...select, options })).toThrow(DialogRefused);
  });

  it("refuses an editor, which this build answers as cancelled", () => {
    expect(() => validate({ id: "u", kind: "editor", title: "edit" })).toThrow(
      /editor/,
    );
  });

  it("moves through the list and returns the chosen option", async () => {
    const dialog = io([
      { name: "down", text: "" },
      { name: "enter", text: "" },
    ]);
    expect(await runSelect(select, dialog)).toEqual({ value: "second" });
  });

  it("wraps around the ends of the list", async () => {
    const dialog = io([
      { name: "up", text: "" },
      { name: "enter", text: "" },
    ]);
    expect(await runSelect(select, dialog)).toEqual({ value: "second" });
  });

  it("cancels on Esc, which is the answer an agent can handle", async () => {
    expect(await runSelect(select, io())).toEqual({ cancelled: true });
    const cancelDialog = io([{ name: "ctrl-c", text: "" }]);
    expect(await runSelect(select, cancelDialog)).toEqual({ cancelled: true });
  });

  it("marks the current choice in the rendered list", () => {
    const rendered = plain(
      renderSelect(select, 1, capabilities({ env: TTY_ENV, isTty: true })),
    );
    expect(rendered).toContain("❯ second");
    expect(rendered).toContain("  first");
    expect(rendered).toContain("↑/↓ to choose");
  });

  it("shows the message above the list when there is one", () => {
    const rendered = renderSelect(
      { ...select, message: "which one?" },
      0,
      capabilities({ env: TTY_ENV, isTty: true }),
    );
    expect(rendered.indexOf("which one?")).toBeLessThan(
      rendered.indexOf("first"),
    );
  });

  it("confirms only on y or yes", async () => {
    expect(
      await runConfirm(
        { id: "u", kind: "confirm", title: "Apply?" },
        io([], ["y"]),
      ),
    ).toEqual({ confirmed: true });
    expect(
      await runConfirm(
        { id: "u", kind: "confirm", title: "Apply?" },
        io([], ["YES"]),
      ),
    ).toEqual({ confirmed: true });
    expect(
      await runConfirm(
        { id: "u", kind: "confirm", title: "Apply?" },
        io([], ["n"]),
      ),
    ).toEqual({ confirmed: false });
    expect(
      await runConfirm({ id: "u", kind: "confirm", title: "Apply?" }, io([])),
    ).toEqual({ confirmed: false });
  });

  it("falls back to the prefill when the answer is empty", async () => {
    const request: DialogRequest = {
      id: "u",
      kind: "input",
      title: "Name?",
      prefill: "default",
    };
    expect(await runInput(request, io([], [""]))).toEqual({ value: "default" });
    expect(await runInput(request, io([], ["typed"]))).toEqual({
      value: "typed",
    });
  });

  it("answers a refused dialog with cancelled rather than hanging the turn", async () => {
    const dialog = io();
    const response = await runDialog(
      { id: "u", kind: "select", title: "Pick", options: [] },
      dialog,
    );
    expect(response).toEqual({ cancelled: true });
    expect(plain(dialog.written.join(""))).toContain("no options");
  });

  it("answers each kind of dialog it supports", async () => {
    // The four kinds route to four different readers: keys for select, a line
    // for the rest. Each one has to reach its own answer.
    expect(
      await runDialog(
        { id: "u", kind: "input", title: "Name?" },
        io([], ["x"]),
      ),
    ).toEqual({ value: "x" });
    expect(
      await runDialog(
        { id: "u", kind: "confirm", title: "Apply?" },
        io([], ["y"]),
      ),
    ).toEqual({ confirmed: true });
    expect(await runDialog(select, io([{ name: "enter", text: "" }]))).toEqual({
      value: "first",
    });
    expect(
      await runDialog({ id: "u", kind: "editor", title: "Edit" }, io()),
    ).toEqual({ cancelled: true });
  });

  it("answers an editor with cancelled", async () => {
    expect(
      await runDialog({ id: "u", kind: "editor", title: "Edit" }, io()),
    ).toEqual({ cancelled: true });
  });

  it("answers a dialog with no terminal attached as cancelled", async () => {
    const answered: { request: DialogRequest; response: unknown }[] = [];
    const renderer = new Renderer({
      caps: capabilities({ env: TTY_ENV, isTty: true }),
      out: () => undefined,
      err: () => undefined,
      footer: [],
      answer: (request, response) => {
        answered.push({ request, response });
      },
    });
    renderer.handle({
      type: "ui_request",
      id: "u1",
      kind: "select",
      title: "Pick",
      options: ["a"],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(answered).toHaveLength(1);
    expect(answered[0]?.response).toEqual({ cancelled: true });
    expect(answered[0]?.request).toMatchObject({ id: "u1", kind: "select" });
  });
});

describe("what the model is told about the shell", () => {
  it("reads the terminal's own answer about itself", () => {
    expect(
      readTerminal({ TERM: "xterm-256color", COLUMNS: "120", LINES: "40" }),
    ).toEqual({
      cols: 120,
      rows: 40,
      isTty: true,
      colors: 256,
    });
    expect(readTerminal({ TERM: "", COLORTERM: "truecolor" }).colors).toBe(0);
    expect(readTerminal({ TERM: "dumb" }).isTty).toBe(false);
    expect(
      readTerminal({ TERM: "xterm", TERM_PROGRAM: "iTerm.app" }).program,
    ).toBe("iTerm.app");
  });

  it("omits the program when the shell did not name one", () => {
    const probe = readTerminal({ TERM: "xterm" });
    expect("program" in probe).toBe(false);
    expect(readTerminal({ TERM: "xterm", TERM_PROGRAM: "" }).program).toBe("");
  });

  it("falls back to a usable size when the shell said nothing", () => {
    expect(readTerminal({ TERM: "xterm" })).toMatchObject({
      cols: 80,
      rows: 24,
    });
    expect(readTerminal({ TERM: "xterm", COLUMNS: "wide" }).cols).toBe(80);
  });

  it("sends the cwd, the shell, and the terminal", () => {
    const built = buildContext(
      {
        env: { ...TTY_ENV },
        shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 7 },
        cwd: "/Users/tester/proj",
        recent: [{ cmd: "git pull", exit: 0 }],
        contextLimit: 10,
        includeExitCodes: true,
        redact: true,
      },
      { passthrough: "all", allowlist: null, deny: [] },
    );
    expect(built.context.cwd).toBe("/Users/tester/proj");
    expect(built.context.shell.kind).toBe("zsh");
    expect(built.context.recent).toEqual([{ cmd: "git pull", exit: 0 }]);
    // The OS the model is told about is the one this test is running on, so
    // the assertion is the platform rather than a name that only holds on the
    // machine the test was written on.
    expect(built.context.os).toContain(process.platform);
  });

  it("carries the terminal program when the shell named one", () => {
    const built = buildContext(
      {
        env: { TERM: "xterm-256color", TERM_PROGRAM: "iTerm.app" },
        shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
        cwd: "/r",
        recent: [],
        contextLimit: 10,
        includeExitCodes: true,
        redact: true,
      },
      { passthrough: "all", allowlist: null, deny: [] },
    );
    // The prompt reads this too, so both the context and the term summary have
    // to carry it rather than one of them losing it on the way.
    expect(built.context.term.program).toBe("iTerm.app");
    expect(built.term.program).toBe("iTerm.app");
  });

  it("omits the program when the shell did not name one", () => {
    const built = buildContext(
      {
        env: { TERM: "xterm" },
        shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
        cwd: "/r",
        recent: [],
        contextLimit: 10,
        includeExitCodes: true,
        redact: true,
      },
      { passthrough: "all", allowlist: null, deny: [] },
    );
    expect("program" in built.context.term).toBe(false);
    expect("program" in built.term).toBe(false);
  });

  it("redacts a secret before it leaves the client", () => {
    const built = buildContext(
      {
        env: { TERM: "xterm" },
        shell: { kind: "bash", version: "5.2", shellId: "1-1-a", pid: 1 },
        cwd: "/r",
        recent: [{ cmd: "export TOKEN=sk-abcdefghijklmnopqrstuvwx", exit: 0 }],
        contextLimit: 10,
        includeExitCodes: true,
        redact: true,
      },
      { passthrough: "all", allowlist: null, deny: [] },
    );
    expect(built.context.recent[0]?.cmd).toBe("export TOKEN=‹redacted›");
  });

  it("keeps the secret when redaction is switched off", () => {
    const built = buildContext(
      {
        env: { TERM: "xterm" },
        shell: { kind: "bash", version: "5.2", shellId: "1-1-a", pid: 1 },
        cwd: "/r",
        recent: [{ cmd: "export TOKEN=plain", exit: 0 }],
        contextLimit: 10,
        includeExitCodes: true,
        redact: false,
      },
      { passthrough: "all", allowlist: null, deny: [] },
    );
    expect(built.context.recent[0]?.cmd).toBe("export TOKEN=plain");
  });

  it("applies a user pattern from the config", () => {
    const built = buildContext(
      {
        env: { TERM: "xterm" },
        shell: { kind: "bash", version: "5.2", shellId: "1-1-a", pid: 1 },
        cwd: "/r",
        recent: [{ cmd: "deploy internal-token-abc", exit: 0 }],
        contextLimit: 10,
        includeExitCodes: true,
        redact: true,
        extraRedactPatterns: ["(?i)internal-token-[a-z0-9]+"],
      },
      { passthrough: "all", allowlist: null, deny: [] },
    );
    expect(built.context.recent[0]?.cmd).toBe("deploy ‹redacted›");
  });

  it("keeps only the newest commands, because the limit is about noise", () => {
    const built = buildContext(
      {
        env: { TERM: "xterm" },
        shell: { kind: "bash", version: "5.2", shellId: "1-1-a", pid: 1 },
        cwd: "/r",
        recent: [
          { cmd: "one", exit: 0 },
          { cmd: "two", exit: 0 },
          { cmd: "three", exit: 0 },
        ],
        contextLimit: 2,
        includeExitCodes: true,
        redact: true,
      },
      { passthrough: "all", allowlist: null, deny: [] },
    );
    expect(built.context.recent.map((entry) => entry.cmd)).toEqual([
      "two",
      "three",
    ]);
  });

  it("leaves the exit codes out when the config says so", () => {
    const built = buildContext(
      {
        env: { TERM: "xterm" },
        shell: { kind: "bash", version: "5.2", shellId: "1-1-a", pid: 1 },
        cwd: "/r",
        recent: [{ cmd: "ls", exit: 1 }],
        contextLimit: 10,
        includeExitCodes: false,
        redact: true,
      },
      { passthrough: "all", allowlist: null, deny: [] },
    );
    expect(built.context.recent[0]?.exit).toBeNull();
  });

  it("gives the agent a filtered environment, not the client's own", () => {
    const built = buildContext(
      {
        env: { TERM: "xterm", PATH: "/usr/bin", PWD: "/somewhere" },
        shell: { kind: "bash", version: "5.2", shellId: "1-1-a", pid: 1 },
        cwd: "/r",
        recent: [],
        contextLimit: 10,
        includeExitCodes: true,
        redact: true,
      },
      { passthrough: "all", allowlist: null, deny: ["PWD"] },
    );
    expect(built.agentEnv).toEqual({ TERM: "xterm", PATH: "/usr/bin" });
  });
});
