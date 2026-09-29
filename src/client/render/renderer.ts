// The renderer (DESIGN §4.2.1). It turns normalized AgentEvents into what a
// person sees, and it is the only place that writes to the terminal.
//
// The split is the design's: the assistant's text goes to stdout so a user can
// pipe a turn, and every piece of chrome goes to stderr so it never ends up in
// the middle of a copy-paste. Nothing here knows what a tool is; the adapter
// already turned it into a summary string.

import type { AgentEvent, UiResponse } from "../../core/agent-port.js";
import {
  IN_PLACE,
  Spinner,
  ToolLineManager,
  renderFooter,
  renderNotice,
  type FooterField,
} from "./chrome.js";
import { runDialog, type DialogIo, type DialogRequest } from "./dialogs.js";
import { MarkdownStream } from "./styler.js";
import { DIM, GREY, paint, type Capabilities } from "./theme.js";

export interface RendererOptions {
  readonly caps: Capabilities;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly footer: readonly FooterField[];
  readonly now?: () => number;
  readonly dialogs?: DialogIo;
  /** Answers a dialog by id, through the daemon. */
  readonly answer?: (request: DialogRequest, response: UiResponse) => void;
}

export interface RenderStats {
  readonly tools: number;
  readonly startedAt: number;
  model?: string;
  costUsd?: number;
  contextPct?: number | null;
  buffer?: string;
  /** The last assistant text, for the `buffer` directive on an abort. */
  lastText: string;
}

export class Renderer {
  readonly #caps: Capabilities;
  readonly #out: (text: string) => void;
  readonly #err: (text: string) => void;
  readonly #footer: readonly FooterField[];
  readonly #now: () => number;
  readonly #tools: ToolLineManager;
  readonly #spinner: Spinner;
  readonly #streams = new Map<number, MarkdownStream>();
  readonly #answer:
    ((request: DialogRequest, response: UiResponse) => void) | undefined;
  readonly #dialogs: DialogIo | undefined;
  #toolsRun = 0;
  readonly #startedAt: number;
  #model: string | undefined;
  #costUsd: number | undefined;
  #contextPct: number | null | undefined;
  #lastText = "";
  #openBlock: number | undefined;
  /** True while a tool line owns the last row, which blocks in-place rewrites. */
  #rowBusy = false;
  #status = new Map<string, string>();
  #buffer = "";
  #finished = false;

  constructor(options: RendererOptions) {
    this.#caps = options.caps;
    this.#out = options.out;
    this.#err = options.err;
    this.#footer = options.footer;
    this.#now = options.now ?? Date.now;
    this.#tools = new ToolLineManager({ caps: options.caps, now: this.#now });
    this.#spinner = new Spinner({
      caps: options.caps,
      now: this.#now,
      write: (text) => this.#err(`${text}\n`),
      erase: () => this.#eraseRow(),
    });
    this.#answer = options.answer;
    this.#dialogs = options.dialogs;
    this.#startedAt = this.#now();
  }

  get stats(): RenderStats {
    return {
      tools: this.#toolsRun,
      startedAt: this.#startedAt,
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#costUsd === undefined ? {} : { costUsd: this.#costUsd }),
      ...(this.#contextPct === undefined
        ? {}
        : { contextPct: this.#contextPct }),
      ...(this.#buffer === "" ? {} : { buffer: this.#buffer }),
      lastText: this.#lastText,
    };
  }

  /** Text the agent asked to hand back to the prompt, if any. */
  takeBuffer(): string {
    const text = this.#buffer;
    this.#buffer = "";
    return text;
  }

  statuses(): Record<string, string> {
    return Object.fromEntries(this.#status);
  }

  begin(): void {
    this.#spinner.start("thinking");
  }

  /** Draws one event. Returns nothing; the event stream is the only input. */
  handle(event: AgentEvent): void {
    this.#clearRow();
    switch (event.type) {
      case "turn_start":
        return;
      case "text_delta": {
        this.#closeOpenBlock();
        const stream = this.#streamFor(event.block);
        this.#out(stream.push(event.text));
        this.#openBlock = event.block;
        this.#lastText += event.text;
        return;
      }
      case "text_end": {
        this.#closeOpenBlock();
        this.#streams.delete(event.block);
        return;
      }
      case "thinking_delta":
        // `ui.thinking = "hidden"` is the default, so thinking is a spinner
        // label rather than another stream of text.
        this.#spinner.label2("thinking");
        return;
      case "tool_start":
        this.#closeOpenBlock();
        this.#toolsRun += 1;
        this.#tools.start(event.id, event.name, event.summary);
        this.#flushTool();
        this.#spinner.label2(event.name);
        return;
      case "tool_update":
        this.#tools.update(event.id, event.preview);
        this.#flushTool();
        return;
      case "tool_end":
        this.#closeOpenBlock();
        this.#tools.end(event.id, event.ok, event.summary, event.ms);
        this.#flushTool();
        return;
      case "notice":
        this.#closeOpenBlock();
        this.#err(`${renderNotice(event.level, event.text, this.#caps)}\n`);
        return;
      case "status":
        if (event.text === undefined) {
          this.#status.delete(event.key);
        } else {
          this.#status.set(event.key, event.text);
        }
        return;
      case "retry":
        this.#closeOpenBlock();
        this.#err(
          `${renderNotice("warn", `retrying (${String(event.attempt)}/${String(event.max)}): ${event.reason}`, this.#caps)}\n`,
        );
        return;
      case "compaction":
        if (event.phase === "start") {
          this.#err(
            `${renderNotice("info", `compacting (${event.reason})`, this.#caps)}\n`,
          );
        }
        return;
      case "usage":
        this.#costUsd =
          event.costUsd === undefined ? this.#costUsd : event.costUsd;
        this.#contextPct = event.contextPct;
        return;
      case "set_buffer":
        // An agent or extension can hand the user a command to review. It is
        // never executed; the plugin waits for Enter.
        this.#buffer = event.text;
        return;
      case "ui_request":
        this.#voidDialog(event);
        return;
      case "settled":
        this.#finish(event.stopReason, event.error);
        return;
    }
  }

  #streamFor(block: number): MarkdownStream {
    let stream = this.#streams.get(block);
    if (stream === undefined) {
      stream = MarkdownStream.forBlock(this.#caps, block);
      this.#streams.set(block, stream);
    }
    return stream;
  }

  #closeOpenBlock(): void {
    if (this.#openBlock === undefined) {
      return;
    }
    const rest = this.#streams.get(this.#openBlock)?.flush() ?? "";
    if (rest !== "") {
      this.#out(rest);
    }
    this.#openBlock = undefined;
  }

  /** Erases the spinner row, which every other write has to do first. */
  #clearRow(): void {
    if (this.#rowBusy) {
      this.#spinner.stop();
    }
  }

  #eraseRow(): void {
    if (!this.#caps.inPlace) {
      return;
    }
    this.#err(IN_PLACE);
  }

  /**
   * Draws what has not been drawn. A finished line is written once and only
   * once: redrawing every line on every event would scroll a long turn's tool
   * history down the screen again and again.
   */
  #flushTool(): void {
    this.#tools.trim();
    for (const line of this.#tools.lines) {
      if (!line.done || line.drawn) {
        continue;
      }
      this.#rowBusy = true;
      this.#eraseRow();
      this.#err(`${this.#tools.render(line)}\n`);
      this.#tools.markDrawn(line.id);
    }
    const live = this.#tools.pending();
    if (live !== undefined) {
      // No trailing newline: the line occupies the current row and is erased
      // before the next write, which is what makes it an in-place update rather
      // than a scrollback entry.
      this.#rowBusy = true;
      this.#eraseRow();
      this.#err(live.text);
    }
  }

  #voidDialog(request: DialogRequest): void {
    if (this.#dialogs === undefined || this.#answer === undefined) {
      // A detached turn has no terminal to answer on, so the answer is
      // immediate and the agent's own timeout still applies (DESIGN §4.2.2).
      this.#answer?.(request, { cancelled: true });
      return;
    }
    void runDialog(request, this.#dialogs).then((response) => {
      this.#answer?.(request, response);
    });
  }

  #finish(stopReason: string, error?: string): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.#closeOpenBlock();
    this.#spinner.stop();
    if (error !== undefined && error !== "") {
      this.#err(`${renderNotice("error", error, this.#caps)}\n`);
    }
    this.#flushTool();
    this.#rowBusy = false;
    this.#printFooter(stopReason);
  }

  #printFooter(stopReason: string): void {
    const seconds = ((this.#now() - this.#startedAt) / 1000).toFixed(1);
    const line = renderFooter(
      {
        time: `${seconds}s${stopReason === "stop" ? "" : ` (${stopReason})`}`,
        tools: this.#toolsRun,
        ...(this.#costUsd === undefined ? {} : { costUsd: this.#costUsd }),
        ...(this.#contextPct === undefined
          ? {}
          : { contextPct: this.#contextPct }),
        ...(this.#model === undefined ? {} : { model: this.#model }),
      },
      this.#footer,
      this.#caps,
    );
    if (line !== "") {
      this.#err(`${line}\n`);
    }
  }

  /** A one-line message that is not part of the turn's output. */
  notice(text: string, level: "info" | "warn" | "error" = "info"): void {
    this.#closeOpenBlock();
    this.#spinner.stop();
    this.#err(`${renderNotice(level, text, this.#caps)}\n`);
  }

  /** Plain text for a command's own output, such as `:info`. */
  line(text: string): void {
    this.#out(text === "" ? "\n" : `${text}\n`);
  }

  setModel(model: string | undefined): void {
    this.#model = model;
  }

  get dimmed(): (text: string) => string {
    return (text: string) => paint(this.#caps, DIM, text);
  }

  get grey(): (text: string) => string {
    return (text: string) => paint(this.#caps, GREY, text);
  }
}
