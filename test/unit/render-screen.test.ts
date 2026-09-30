import { describe, expect, it } from "vitest";
import { Renderer } from "../../src/client/render/renderer.js";
import { capabilities } from "../../src/client/render/theme.js";
import { screen, type Screen } from "../support/screen.js";
import type { AgentEvent } from "../../src/core/agent-port.js";

const TTY = { env: { TERM: "xterm-256color", COLUMNS: "100" }, isTty: true };

/** A renderer drawing to a real screen, with the whole turn given at once. */
function turn(events: readonly AgentEvent[]): {
  readonly at: Screen;
  readonly text: () => string;
} {
  const at = screen();
  const r = new Renderer({
    caps: capabilities({ env: TTY.env, isTty: true }),
    out: (text) => {
      at.write(text);
    },
    err: (text) => {
      at.write(text);
    },
    footer: [],
  });
  for (const event of events) {
    r.handle(event);
  }
  return { at, text: (): string => at.text() };
}

function deltas(...text: string[]): AgentEvent[] {
  return text.map((one) => ({ type: "text_delta", block: 0, text: one }));
}

describe("answer text on a screen that has one cursor", () => {
  it("keeps the half of a line that arrived before the status line drew", async () => {
    // The spinner clears its row with a carriage return and an erase-line. If
    // the cursor is part-way along a streamed line, that row holds the answer,
    // and clearing it eats the start of a sentence.
    const at = screen();
    let clock = 0;
    const r = new Renderer({
      caps: capabilities({ env: TTY.env, isTty: true }),
      out: (text) => {
        at.write(text);
      },
      err: (text) => {
        at.write(text);
      },
      footer: [],
      now: () => {
        clock += 20;
        return clock;
      },
    });
    r.begin();
    r.handle({ type: "turn_start" });
    r.handle({
      type: "text_delta",
      block: 0,
      text: "Body text with **bold**, ",
    });
    // A real spinner frame lands here, between the two halves of the sentence.
    await new Promise((resolve) => setTimeout(resolve, 200));
    r.handle({
      type: "text_delta",
      block: 0,
      text: "*italic*, and the rest.",
    });
    r.handle({ type: "text_end", block: 0 });
    r.handle({ type: "settled", stopReason: "stop" });
    expect(at.text()).toContain(
      "Body text with **bold**, *italic*, and the rest.",
    );
  });

  it("draws the status line again once the line is finished", async () => {
    // The row is the spinner's again as soon as the line ends, so the status
    // line must come back rather than staying silent for the rest of the turn.
    const at = screen();
    const r = new Renderer({
      caps: capabilities({ env: TTY.env, isTty: true }),
      out: (text) => {
        at.write(text);
      },
      err: (text) => {
        at.write(text);
      },
      footer: [],
    });
    r.begin();
    r.handle({ type: "turn_start" });
    r.handle({ type: "text_delta", block: 0, text: "A line that stops " });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(at.text()).not.toContain("esc to abort");
    r.handle({ type: "text_delta", block: 0, text: "mid-word.\n" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(at.text()).toContain("esc to abort");
    expect(at.text()).toContain("A line that stops mid-word.");
    r.handle({ type: "text_end", block: 0 });
    r.handle({ type: "settled", stopReason: "stop" });
  });

  it("leaves a finished answer and its footer on the screen", () => {
    const { text } = turn([
      { type: "turn_start" },
      ...deltas("First line.\n", "Second line.\n"),
      { type: "text_end", block: 0 },
      { type: "settled", stopReason: "stop" },
    ]);
    expect(text()).toContain("First line.");
    expect(text()).toContain("Second line.");
    // Settling takes the status line down, so what is left is the answer and
    // nothing that was only ever a placeholder for it.
    expect(text()).not.toContain("esc to abort");
    expect(text().split("\n")).toHaveLength(2);
  });

  it("styles a marker the same whether it arrives whole or split", () => {
    // The styler holds a marker back until it can tell an emphasis from
    // punctuation. Holding back is only possible if the hold survives to the
    // next delta, which is a property of the renderer and not the styler.
    const styled = (...deltasToFeed: readonly string[]): string => {
      let out = "";
      const r = new Renderer({
        caps: capabilities({ env: TTY.env, isTty: true }),
        out: (text) => {
          out += text;
        },
        err: () => {},
        footer: [],
      });
      r.handle({ type: "turn_start" });
      for (const one of deltasToFeed) {
        r.handle({ type: "text_delta", block: 0, text: one });
      }
      r.handle({ type: "text_end", block: 0 });
      return out;
    };
    expect(styled("*emphasis* done")).toContain("\u001b[3m");
    expect(styled("*em", "phasis* done")).toBe(styled("*emphasis* done"));
  });
});
