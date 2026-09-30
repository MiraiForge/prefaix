// The streaming markdown styler (DESIGN §4.2.1).
//
// It styles text as it arrives and holds back at most a few characters when a
// `*`, a backtick, or an underscore needs disambiguation, which is what makes
// `2 * 3` and `*emphasis*` both come out right without waiting for the whole
// message.
//
// The buffer is the whole design: a character is emitted only once the next few
// characters after it have arrived, so the output is identical however the
// deltas happened to be split. Two rules are load-bearing and easy to break:
// output is never hard-wrapped, so copy-paste gets the original text; and inside
// a fence there is no inline styling at all, so a code block's asterisks are
// what the author wrote.

import { BOLD, DIM, ITALIC, RESET, type Capabilities } from "./theme.js";

export interface StylerOptions {
  readonly caps: Capabilities;
  /** How many characters of line start may be held back before styling it. */
  readonly holdBack?: number;
  /**
   * How far ahead an inline marker looks for its partner. This is larger than
   * the line-start hold because `*emphasis*` can be any length, and holding
   * only starts once a marker has been seen, so ordinary text streams through
   * with no delay at all.
   */
  readonly markerWindow?: number;
}

const DEFAULT_HOLD_BACK = 3;
const DEFAULT_MARKER_WINDOW = 40;
const INLINE_MARKERS = "*_`";

/** The line's own styling, which is decided from the characters after a newline. */
interface LineState {
  fence: string | undefined;
}

export class MarkdownStream {
  readonly #caps: Capabilities;
  readonly #holdBack: number;
  readonly #markerWindow: number;
  #state: LineState = { fence: undefined };
  #buffer = "";
  #atLineStart = true;
  /** Which text block this stream is styling, for the renderer's own logs. */
  block = -1;

  constructor(options: StylerOptions) {
    this.#caps = options.caps;
    this.#holdBack = Math.max(1, options.holdBack ?? DEFAULT_HOLD_BACK);
    this.#markerWindow = Math.max(
      1,
      options.markerWindow ?? DEFAULT_MARKER_WINDOW,
    );
  }

  static forBlock(caps: Capabilities, block: number): MarkdownStream {
    const stream = new MarkdownStream({ caps });
    stream.reset(block);
    return stream;
  }

  /** A new block starts with no fence and no hold-back, whatever came before. */
  reset(block: number): void {
    this.block = block;
    this.#state = { fence: undefined };
    this.#buffer = "";
    this.#atLineStart = true;
  }

  get inFence(): boolean {
    return this.#state.fence !== undefined;
  }

  /**
   * Whether the cursor is at the start of a row. False means the last thing
   * written left the cursor part-way along a line, which is the renderer's cue
   * that the current row belongs to streamed text and must not be erased.
   */
  get atLineStart(): boolean {
    return this.#atLineStart;
  }

  /** How much is still being held back, which is at most the hold-back window. */
  get pending(): number {
    return this.#buffer.length;
  }

  /**
   * Feeds a delta and returns the text to write now. The return value may be
   * shorter than the delta, or empty; `flush` releases the rest when the block
   * ends.
   */
  push(delta: string): string {
    this.#buffer += delta;
    return this.#drain(false);
  }

  /** Releases whatever is still held back, styling it as ordinary text. */
  flush(): string {
    return this.#drain(true);
  }

  /** Styles a whole string at once, for a notice or a footer. */
  render(text: string): string {
    return `${this.push(text)}${this.flush()}`;
  }

  #drain(final: boolean): string {
    let out = "";
    for (;;) {
      if (this.#buffer === "") {
        return out;
      }
      if (this.#atLineStart) {
        const line = this.#lineStart(final);
        if (line === "wait") {
          return out;
        }
        this.#atLineStart = false;
        if (line !== "") {
          out += line;
          continue;
        }
      }
      const next = this.#one(final);
      if (next === undefined) {
        return out;
      }
      out += next;
    }
  }

  /**
   * Decides the line's own styling from what has arrived. Returning `""` means
   * "this line needs nothing of its own", which is different from `wait`.
   */
  #lineStart(final: boolean): string | "wait" {
    const head = this.#buffer;
    const partial = /^ {0,3}(`+|~+)/u.exec(head)?.[1];
    if (partial !== undefined && partial.length < 3 && !final) {
      // A run of backticks that could still reach three is held, whether it is
      // about to open a block or close one.
      return "wait";
    }
    const fence = /^ {0,3}(`{3,}|~{3,})/u.exec(head)?.[1];
    if (fence !== undefined) {
      // The group matched three or more of one character, so it has a first.
      const marker = fence[0] as string;
      if (this.#state.fence === undefined) {
        this.#state.fence = marker;
      } else if (marker === this.#state.fence) {
        this.#state.fence = undefined;
      } else {
        // A different fence character inside a block is ordinary text.
        return "";
      }
      this.#buffer = head.slice(fence.length);
      return this.#fence(fence);
    }
    if (this.#state.fence !== undefined) {
      // Inside a fence a line is copied through untouched.
      return "";
    }
    if (
      !final &&
      head.length < this.#holdBack &&
      /[ `*~_>#-]/u.test(head.slice(-1))
    ) {
      // A short line could still turn into a heading, a quote, or a fence.
      return "wait";
    }
    const heading = /^(#{1,6})\s/u.exec(head);
    if (heading !== null) {
      this.#buffer = head.slice(heading[0].length);
      return `${this.#open(BOLD)}${heading[0]}`;
    }
    if (/^ {0,3}>/u.test(head)) {
      return this.#open(ITALIC);
    }
    const bullet = /^(\s*)([-*+]\s|\d+[.)]\s)/u.exec(head);
    if (bullet !== null) {
      this.#buffer = head.slice(bullet[0].length);
      return bullet[0];
    }
    return "";
  }

  /** One inline decision, or undefined when the buffer is not decided yet. */
  #one(final: boolean): string | undefined {
    if (this.#state.fence !== undefined) {
      return this.#take(1);
    }
    const first = this.#buffer.slice(0, 1);
    if (!INLINE_MARKERS.includes(first)) {
      return this.#take(1);
    }
    // Look for a partner within the hold-back window. Found: an emphasis pair.
    // Not found and the window is not full yet: wait for more. Not found and
    // the window is full: the marker was arithmetic or snake_case punctuation.
    const window = this.#buffer.slice(0, this.#markerWindow);
    const partner = window.slice(1).indexOf(first);
    if (partner !== -1) {
      const pair = window.slice(0, partner + 2);
      this.#buffer = this.#buffer.slice(pair.length);
      return `${this.#open(ITALIC)}${pair}${this.#close()}`;
    }
    if (!final && this.#buffer.length < this.#markerWindow) {
      // A marker with no partner yet: hold until one shows up or the window
      // closes, whichever comes first.
      return undefined;
    }
    return this.#take(1);
  }

  #take(width: number): string {
    const text = this.#buffer.slice(0, width);
    this.#buffer = this.#buffer.slice(width);
    if (text.includes("\n")) {
      this.#atLineStart = true;
    }
    return text;
  }

  #fence(marker: string): string {
    return this.#caps.color ? `${DIM}${marker}${RESET}` : marker;
  }

  #open(code: string): string {
    return this.#caps.color ? code : "";
  }

  #close(): string {
    return this.#caps.color ? RESET : "";
  }
}

/** Renders text that is not a stream: notices, error text, help output. */
export function styleOnce(text: string, caps: Capabilities): string {
  return caps.color ? `${text}${RESET}` : text;
}
