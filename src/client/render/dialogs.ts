// Inline dialogs for an agent that asks the user something (DESIGN §4.2.2).
//
// A dialog is answered on the terminal the turn already owns, so it is drawn
// inline rather than handed to fzf: one process, one tty, and no window over the
// user's terminal. An answer that is not a real choice is refused, so an agent
// cannot make the user run a command by sending them a select with one option.

import { messageOf } from "../../core/errors.js";
import { BOLD, DIM, GREY, paint, type Capabilities } from "./theme.js";
import type { UiRequestKind, UiResponse } from "../../core/agent-port.js";

export interface DialogRequest {
  readonly id: string;
  readonly kind: UiRequestKind;
  readonly title: string;
  readonly message?: string;
  readonly options?: readonly string[];
  readonly prefill?: string;
}

export interface DialogIo {
  readonly caps: Capabilities;
  /** Writes to stderr, which is where every chrome line goes. */
  readonly write: (text: string) => void;
  /** Reads one line of input; the caller supplies the raw-mode reader. */
  readonly readLine: (prompt: string) => Promise<string>;
  /** Reads one keypress, for the arrow-key list. */
  readonly readKey: () => Promise<{ name: string; text: string }>;
  readonly erase: () => void;
}

/** A dialog that cannot be answered safely, and why. */
export class DialogRefused extends Error {
  override readonly name = "DialogRefused";
}

export interface SelectChoice {
  readonly index: number;
  readonly value: string;
}

/** How many options a select may offer before it stops being a select. */
export const MAX_SELECT_OPTIONS = 20;

export function validate(request: DialogRequest): void {
  if (request.kind === "select") {
    const options = request.options ?? [];
    if (options.length === 0) {
      throw new DialogRefused(
        "a select arrived with no options to choose from",
      );
    }
    if (options.length > MAX_SELECT_OPTIONS) {
      // A list this long is a picker, not a question, and rendering it inline
      // would bury the turn it came from.
      throw new DialogRefused(
        `a select offered ${String(options.length)} options, more than the ${String(MAX_SELECT_OPTIONS)} an inline list can show`,
      );
    }
  }
  if (request.kind === "editor") {
    throw new DialogRefused(
      "the agent asked for an editor, which this build answers as cancelled",
    );
  }
}

/** Renders the list, with the current choice marked. */
export function renderSelect(
  request: DialogRequest,
  selected: number,
  caps: Capabilities,
): string {
  const lines: string[] = [];
  if (request.title !== "") {
    lines.push(paint(caps, BOLD, request.title));
  }
  if (request.message !== undefined && request.message !== "") {
    lines.push(paint(caps, GREY, request.message));
  }
  for (const [index, option] of (request.options ?? []).entries()) {
    const marker = index === selected ? "❯" : " ";
    const text = `${marker} ${option}`;
    lines.push(index === selected ? paint(caps, BOLD, text) : text);
  }
  lines.push(
    paint(caps, DIM, "↑/↓ to choose · enter to accept · esc to cancel"),
  );
  return lines.join("\n");
}

const UP = "up";
const DOWN = "down";
const ENTER = "enter";

/** The arrow-key list. Esc cancels, which is the answer an agent can handle. */
export async function runSelect(
  request: DialogRequest,
  io: DialogIo,
): Promise<UiResponse> {
  validate(request);
  const options = request.options ?? [];
  let selected = 0;
  for (;;) {
    io.erase();
    io.write(`${renderSelect(request, selected, io.caps)}\n`);
    const key = await io.readKey();
    if (key.name === "esc" || key.name === "ctrl-c") {
      return { cancelled: true };
    }
    if (key.name === UP) {
      selected = (selected - 1 + options.length) % options.length;
      continue;
    }
    if (key.name === DOWN) {
      selected = (selected + 1) % options.length;
      continue;
    }
    if (key.name === ENTER) {
      return { value: options[selected] ?? options[0] ?? "" };
    }
  }
}

export async function runConfirm(
  request: DialogRequest,
  io: DialogIo,
): Promise<UiResponse> {
  const question = [request.title, request.message]
    .filter((part) => part !== undefined && part !== "")
    .join(" — ");
  const answer = (await io.readLine(`${question} [y/N] `)).trim().toLowerCase();
  return { confirmed: answer === "y" || answer === "yes" };
}

export async function runInput(
  request: DialogRequest,
  io: DialogIo,
): Promise<UiResponse> {
  const prompt = `${request.title}${request.prefill === undefined ? "" : ` [${request.prefill}]`} `;
  const answer = await io.readLine(prompt);
  if (answer.trim() === "" && request.prefill !== undefined) {
    return { value: request.prefill };
  }
  return { value: answer };
}

/**
 * Answers one dialog. A refused dialog answers `cancelled` rather than hanging
 * the turn: the agent has its own timeout, and a turn that waits forever for a
 * question nobody can see is worse than one that proceeds without an answer.
 */
export async function runDialog(
  request: DialogRequest,
  io: DialogIo,
): Promise<UiResponse> {
  try {
    validate(request);
  } catch (cause) {
    io.erase();
    io.write(paint(io.caps, GREY, `${messageOf(cause)}\n`));
    return { cancelled: true };
  }
  switch (request.kind) {
    case "select":
      return runSelect(request, io);
    case "confirm":
      return runConfirm(request, io);
    case "input":
      return runInput(request, io);
    case "editor":
      return { cancelled: true };
  }
}
