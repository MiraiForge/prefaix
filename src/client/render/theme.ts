// What the terminal can do, and the codes to use when it can (DESIGN §4.2.1).
//
// The degrade rules are the contract: a non-TTY, `NO_COLOR`, or
// `PREFAIX_PLAIN=1` gives plain text, no spinner, and one line per tool event.
// A renderer that decides this per call is a renderer that forgets it once.

import type { ColorDepth } from "../../core/agent-port.js";

/** The escape byte, named so the source stays readable. */
export const ESC = "\u001b";

export interface Capabilities {
  readonly color: boolean;
  readonly spinner: boolean;
  readonly inPlace: boolean;
  readonly width: number;
  readonly colors: ColorDepth;
}

export const RESET = "\u001b[0m";
export const DIM = "\u001b[2m";
export const BOLD = "\u001b[1m";
export const ITALIC = "\u001b[3m";
export const RED = "\u001b[31m";
export const GREEN = "\u001b[32m";
export const YELLOW = "\u001b[33m";
export const BLUE = "\u001b[34m";
export const CYAN = "\u001b[36m";
export const GREY = "\u001b[90m";
export const CLEAR_LINE = `\r${ESC}[2K`;
export const HIDE_CURSOR = "\u001b[?25l";
export const SHOW_CURSOR = "\u001b[?25h";

export const SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
] as const;

export interface CapabilityOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTty?: boolean;
  readonly cols?: number;
  readonly colors?: ColorDepth;
}

/**
 * Whether this turn may draw anything but text. `NO_COLOR` wins over everything
 * except an explicit `PREFAIX_PLAIN`, and a non-TTY wins over both: there is no
 * point writing escape codes into a pipe.
 */
export function capabilities(options: CapabilityOptions): Capabilities {
  const env = options.env;
  const isTty = options.isTty ?? false;
  const plain = env["PREFAIX_PLAIN"] === "1";
  const noColor = env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "";
  const term = env["TERM"] ?? "";
  const dumb = term === "dumb";
  const color = isTty && !plain && !noColor && !dumb;
  return {
    color,
    // In-place updates need a terminal; a pipe gets one line per event.
    spinner: isTty && !plain && !dumb,
    inPlace: isTty && !plain && !dumb,
    width: Math.max(20, options.cols ?? 80),
    colors: isTty ? (options.colors ?? 16) : 0,
  };
}

/** Wraps `text` in `code` when the terminal can show it, and returns it bare otherwise. */
export function paint(caps: Capabilities, code: string, text: string): string {
  return caps.color ? `${code}${text}${RESET}` : text;
}
