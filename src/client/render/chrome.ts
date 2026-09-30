// Tool lines, the spinner, and the footer (DESIGN §3.4, §4.2.1).
//
// All three go to stderr, because the assistant's text goes to stdout and a
// user who pipes a turn should get the answer and nothing else. The layout the
// design fixes is the one Forge users already read:
//
//   ⏺ bash  $ bun test auth                          ✓ 1.2s
//   ── 14.2s · 3 tools · $0.018 · ctx 22% · gemini-3.8-flash

import {
  CLEAR_LINE,
  CYAN,
  DIM,
  GREEN,
  GREY,
  RED,
  SPINNER_FRAMES,
  paint,
  type Capabilities,
} from "./theme.js";

export interface ToolLine {
  readonly id: string;
  readonly name: string;
  summary: string;
  startedAt: number;
  /** Set once the tool has finished, which is when the line stops updating. */
  done: boolean;
  ok: boolean;
  ms?: number;
  result?: string;
  /** True once the final form has been written, so it is written once. */
  drawn: boolean;
}

const ICON_START = "⏺";
const ICON_OK = "✓";
const ICON_FAIL = "✗";

/** A width that leaves room for the icon, two spaces, and the status column. */
function columns(
  caps: Capabilities,
  name: string,
  summary: string,
  status: string,
): string {
  const left = `${ICON_START} ${name}  ${summary}`;
  const gap = Math.max(1, caps.width - left.length - status.length);
  return `${left}${" ".repeat(gap)}${status}`;
}

export interface ToolLineOptions {
  readonly caps: Capabilities;
  readonly now?: () => number;
}

/**
 * One tool's line, from the first `tool_start` to its finalized form. In-place
 * updates are used only while nothing else is mid-line, which is why the caller
 * has to tell the line manager that text was written.
 */
export class ToolLineManager {
  readonly #caps: Capabilities;
  readonly #now: () => number;
  readonly #lines = new Map<string, ToolLine>();
  /** The tool currently being updated in place, if any. */
  #active: ToolLine | undefined;

  constructor(options: ToolLineOptions) {
    this.#caps = options.caps;
    this.#now = options.now ?? Date.now;
  }

  get lines(): readonly ToolLine[] {
    return [...this.#lines.values()];
  }

  start(id: string, name: string, summary: string): void {
    const line: ToolLine = {
      id,
      name,
      summary,
      startedAt: this.#now(),
      done: false,
      ok: true,
      drawn: false,
    };
    this.#lines.set(id, line);
    this.#active = line;
  }

  update(id: string, preview?: string): void {
    const line = this.#lines.get(id);
    if (line === undefined || line.done) {
      return;
    }
    if (preview !== undefined && preview !== "") {
      line.result = preview;
    }
    this.#active = line;
  }

  end(id: string, ok: boolean, summary?: string, ms?: number): void {
    const line = this.#lines.get(id);
    if (line === undefined) {
      return;
    }
    line.done = true;
    line.ok = ok;
    line.ms = ms ?? Math.max(0, this.#now() - line.startedAt);
    if (summary !== undefined && summary !== "") {
      line.summary = `${line.summary} ${summary}`;
    }
    if (this.#active?.id === id) {
      this.#active = undefined;
    }
  }

  /** Marks a line as written, so the caller can track what it has drawn. */
  markDrawn(id: string): void {
    const line = this.#lines.get(id);
    if (line !== undefined) {
      line.drawn = true;
    }
  }

  /** Drops finished lines once they are off screen, so a long turn stays short. */
  trim(keep = 20): void {
    const finished = [...this.#lines.values()].filter((line) => line.done);
    for (const line of finished.slice(0, Math.max(0, finished.length - keep))) {
      this.#lines.delete(line.id);
    }
  }

  /** The one line to redraw in place, or undefined when there is nothing live. */
  pending(): { id: string; text: string } | undefined {
    const line = this.#active;
    if (line === undefined || line.done || !this.#caps.inPlace) {
      return undefined;
    }
    const elapsed = ((this.#now() - line.startedAt) / 1000).toFixed(1);
    return {
      id: line.id,
      text: columns(
        this.#caps,
        line.name,
        line.summary,
        paint(this.#caps, GREY, `${ICON_OK} ${elapsed}s`),
      ),
    };
  }

  /** The final form of a tool, for a terminal that cannot update in place. */
  render(line: ToolLine): string {
    const status = line.ok
      ? paint(this.#caps, GREEN, `${ICON_OK} ${formatMs(line.ms)}`)
      : paint(this.#caps, RED, `${ICON_FAIL} ${formatMs(line.ms)}`);
    const summary =
      line.result === undefined ? line.summary : `${line.summary}`;
    return columns(this.#caps, line.name, summary, status);
  }
}

export function formatMs(ms: number | undefined): string {
  if (ms === undefined) {
    return "";
  }
  return ms < 1000 ? `${String(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The rewrite prefix for an in-place update. */
export const IN_PLACE = CLEAR_LINE;

export interface SpinnerOptions {
  readonly caps: Capabilities;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly write: (text: string) => void;
  readonly erase: () => void;
  /**
   * Whether the current row is the spinner's to draw on. It is not, while a
   * streamed answer has the cursor part-way along a line: erasing a row that
   * holds answer text erases the answer.
   */
  readonly canPaint?: () => boolean;
}

/**
 * One bottom status line, erased before any other write. The renderer calls
 * `erase` before every text write, which is what keeps the spinner from
 * interleaving with a streamed answer (DESIGN §4.2.1).
 */
export class Spinner {
  readonly #caps: Capabilities;
  readonly #intervalMs: number;
  readonly #now: () => number;
  readonly #write: (text: string) => void;
  readonly #erase: () => void;
  readonly #canPaint: () => boolean;
  #timer: ReturnType<typeof setInterval> | undefined;
  #frame = 0;
  #label = "";
  #startedAt = 0;
  #drawn = false;

  constructor(options: SpinnerOptions) {
    this.#caps = options.caps;
    this.#intervalMs = options.intervalMs ?? 80;
    this.#now = options.now ?? Date.now;
    this.#write = options.write;
    this.#erase = options.erase;
    this.#canPaint = options.canPaint ?? ((): boolean => true);
  }

  get active(): boolean {
    return this.#timer !== undefined;
  }

  start(label: string): void {
    this.#label = label;
    this.#startedAt = this.#now();
    if (!this.#caps.spinner) {
      return;
    }
    this.#timer = setInterval(() => this.#draw(), this.#intervalMs);
    this.#timer.unref?.();
  }

  label2(next: string): void {
    this.#label = next;
  }

  #draw(): void {
    if (!this.#canPaint()) {
      // The row is not ours, so neither the erase nor the frame happens. The
      // frame count still moves on, so the spinner resumes where it left off.
      this.#frame += 1;
      this.#drawn = false;
      return;
    }
    const frame = SPINNER_FRAMES[this.#frame % SPINNER_FRAMES.length] ?? "";
    this.#frame += 1;
    const elapsed = ((this.#now() - this.#startedAt) / 1000).toFixed(1);
    this.#erase();
    this.#write(
      paint(
        this.#caps,
        CYAN,
        `${frame} ${this.#label} ${elapsed}s · esc to abort`,
      ),
    );
    this.#drawn = true;
  }

  /** Erases the line, whether or not one was ever drawn. */
  stop(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    if (this.#drawn) {
      this.#erase();
      this.#drawn = false;
    }
  }
}

export interface FooterFields {
  readonly time?: string;
  readonly tools?: number;
  readonly costUsd?: number;
  readonly contextPct?: number | null;
  readonly model?: string;
}

export type FooterField = "time" | "tools" | "cost" | "context" | "model";

/** The final `── 14.2s · 3 tools · $0.018 · ctx 22% · model` line. */
export function renderFooter(
  fields: FooterFields,
  order: readonly FooterField[],
  caps: Capabilities,
): string {
  const parts: string[] = [];
  for (const field of order) {
    const text = footerField(field, fields);
    if (text !== undefined) {
      parts.push(text);
    }
  }
  if (parts.length === 0) {
    return "";
  }
  return paint(caps, DIM, `── ${parts.join(" · ")}`);
}

function footerField(
  field: FooterField,
  fields: FooterFields,
): string | undefined {
  switch (field) {
    case "time":
      return fields.time;
    case "tools":
      return fields.tools === undefined
        ? undefined
        : `${String(fields.tools)} tools`;
    case "cost":
      return fields.costUsd === undefined
        ? undefined
        : `$${fields.costUsd.toFixed(3)}`;
    case "context":
      return fields.contextPct === undefined || fields.contextPct === null
        ? undefined
        : `ctx ${fields.contextPct.toFixed(0)}%`;
    case "model":
      return fields.model;
  }
}

/** A one-line notice: dim, on stderr, never interleaved with text. */
export function renderNotice(
  level: "info" | "warn" | "error",
  text: string,
  caps: Capabilities,
): string {
  const code = level === "error" ? RED : level === "warn" ? GREY : DIM;
  return paint(caps, code, text);
}
