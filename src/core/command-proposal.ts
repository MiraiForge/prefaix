import type { ShellKind } from "./agent-port.js";

/** Structured edit output, not executable code or model prose to scrape. */
export interface CommandProposal {
  command: string;
  explanation: string;
}

/**
 * A proposed command is opaque shell data: don't quote, evaluate, or trim it.
 * NUL cannot travel in directives and terminal controls aren't editable text.
 * Accept only own data fields so inherited values/accessors aren't proposals.
 */
export function parseCommandProposal(
  value: unknown,
): CommandProposal | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const command = Object.getOwnPropertyDescriptor(value, "command")
    ?.value as unknown;
  const explanation = Object.getOwnPropertyDescriptor(value, "explanation")
    ?.value as unknown;
  if (
    typeof command !== "string" ||
    command.trim() === "" ||
    Array.from(command).some((character) => {
      const code = character.charCodeAt(0);
      return (
        (code < 32 && code !== 9 && code !== 10) || (code >= 127 && code <= 159)
      );
    }) ||
    typeof explanation !== "string"
  )
    return undefined;
  return { command, explanation };
}

/** System guidance; the user's request remains a separate, literal prompt. */
export function suggestGuideline(shell: ShellKind): string {
  return [
    `Propose one command for the user's ${shell} shell.`,
    "Use that shell's syntax, not another shell's syntax.",
    "Call propose_command with the command and a concise explanation.",
    "Do not run the command, modify files, or return a command only as prose.",
    "The command will be placed in an editable buffer for the user to review.",
    "Only the user pressing Enter may execute it.",
  ].join("\n");
}
