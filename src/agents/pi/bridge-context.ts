// The per-turn context file the bridge extension reads (DESIGN §4.5.4, §7.1).
//
// This module is the single place that knows the shape and the prose, so the
// bridge (which patches a system-prompt section) and the adapter (which
// prepends the same text when the bridge did not load) can never disagree
// about what the model is told.
//
// The file is named after the child pid, so two warm children for the same
// conversation never read each other's context, and it is removed as soon as
// it has been read.

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { posix } from "node:path";
import type { PersonaSpec, ShellContext } from "../../core/agent-port.js";

export const BRIDGE_VERSION = 1;

/** What the adapter writes before a prompt and the bridge reads after it. */
export interface TurnContextFile {
  /** Bumped when the shape changes, so an old bridge fails loudly. */
  readonly version: number;
  readonly context: ShellContext;
  readonly persona?: PersonaSpec;
}

export function turnContextFile(dir: string, pid: number): string {
  return posix.join(dir, `${String(pid)}.json`);
}

/**
 * Proof of life for the bridge. The extension writes it while loading, and the
 * adapter waits for it after the child is ready: if it never appears, the
 * extension failed to load and the adapter falls back to prepending.
 */
export function bridgeReadyFile(dir: string, pid: number): string {
  return posix.join(dir, `${String(pid)}.ready`);
}

/** One line per patched turn, so a test can assert what the model was told. */
export function bridgeAppliedLog(dir: string, pid: number): string {
  return posix.join(dir, `${String(pid)}.applied.log`);
}

export interface AppliedRecord {
  /** The user text exactly as pi saw it, which must stay what was typed. */
  readonly prompt: string;
  /** Whether a `prefaix` section was patched into the system prompt. */
  readonly section: boolean;
  readonly persona?: string;
}

/**
 * The `prefaix` system-prompt section, about 150 tokens for a typical turn.
 * It is the only shell state the model is told: no secrets, no output.
 */
export function renderShellContext(context: ShellContext): string {
  const recent = context.recent
    .map(
      (entry, index) =>
        `  [${String(index)}] ${entry.cmd}${exitSuffix(entry.exit)}`,
    )
    .join("\n");
  return [
    "You are being used from the user's interactive shell via prefaix.",
    `Shell: ${context.shell.kind} ${context.shell.version} on ${context.os} · cwd: ${context.cwd}`,
    recent === "" ? "Recent commands: (none)" : `Recent commands:\n${recent}`,
    `Output is rendered as streaming markdown in a terminal (${String(context.term.cols)} cols). Keep answers concise; prefer showing commands over long prose.`,
  ].join("\n");
}

/** The section pi records for a persona, or undefined when there is none. */
export function renderPersonaSection(
  persona: PersonaSpec | undefined,
): string | undefined {
  if (persona === undefined) {
    return undefined;
  }
  const tools = persona.tools ?? [];
  return [
    `You are answering as the "${persona.name}" persona.`,
    persona.guideline ?? "",
    tools.length === 0
      ? ""
      : `Only these tools are available: ${tools.join(", ")}.`,
  ]
    .filter((line) => line !== "")
    .join(" ");
}

/**
 * The text the adapter prepends when the bridge is unavailable. The tags match
 * what pi wraps a named section in, so the model sees the same framing either
 * way and the fallback is a difference of transport, not of meaning.
 */
export function prependBlock(
  context: ShellContext,
  persona?: PersonaSpec,
): string {
  const parts = [`<prefaix>\n${renderShellContext(context)}\n</prefaix>`];
  const personaSection = renderPersonaSection(persona);
  if (personaSection !== undefined) {
    parts.push(`<persona>\n${personaSection}\n</persona>`);
  }
  return parts.join("\n");
}

function exitSuffix(exit: number | null): string {
  return exit === null ? "" : ` (exit ${String(exit)})`;
}

// Every function here runs inside pi's process, where a throw would be an
// extension_error on the wire. Each one therefore reports failure by returning
// undefined rather than propagating.

export function readTurnContext(file: string): TurnContextFile | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Partial<TurnContextFile>;
  if (record.version !== BRIDGE_VERSION || typeof record.context !== "object") {
    return undefined;
  }
  return record as TurnContextFile;
}

export function writeTurnContext(
  file: string,
  payload: TurnContextFile,
): boolean {
  try {
    // 0600: the file carries the user's shell state (DESIGN §10).
    writeFileSync(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function removeTurnContext(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    // Already gone, which is the state the caller wanted.
  }
}
