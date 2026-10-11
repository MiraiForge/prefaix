// The prefaix bridge extension, bundled to dist/pi-bridge.js and loaded by pi
// with `-e` (DESIGN §4.5.4, ADR 0004).
//
// It exists so per-turn shell context reaches the model as a system-prompt
// *section* rather than as part of the user's message. The visible user text
// stays byte-for-byte what the user typed, which is what makes a later `:tui`
// handoff into pi's own TUI read correctly.
//
// Ordinary context augmentation is best effort: missing readiness permits
// prepend fallback. Structured edits instead negotiate tool readiness and fail
// closed; tool-call guards stay armed even when pi reports a preflight error.
// This extension is a convenience boundary, not a sandbox for other extensions.

import { appendFileSync, writeFileSync } from "node:fs";
import { suggestGuideline } from "../../core/command-proposal.js";
import {
  PROPOSE_COMMAND,
  proposalTool,
  type ProposalTool,
} from "./command-proposal.js";
import {
  BRIDGE_VERSION,
  bridgeAppliedLog,
  bridgeReadyFile,
  readTurnContext,
  removeTurnContext,
  renderPersonaSection,
  renderShellContext,
  turnContextFile,
  type AppliedRecord,
} from "./bridge-context.js";

/** The env var the adapter sets to tell the bridge where turn files live. */
export const BRIDGE_DIR_ENV = "PREFAIX_BRIDGE_DIR";

/**
 * The part of pi's extension API this file uses. Declared structurally rather
 * than imported from pi, so the package keeps zero runtime dependencies on it
 * (DESIGN §4.5.2) and a pi upgrade cannot break the build.
 */
interface BridgePi {
  on(
    event: string,
    handler: (event: BridgeEvent) => unknown | Promise<unknown>,
  ): void;
  setActiveTools(tools: string[]): void;
  getActiveTools?(): string[];
  registerTool?(tool: ProposalTool): void;
}

interface BridgeEvent {
  type: string;
  /** The raw user prompt text, after expansion. */
  prompt?: string;
  toolName?: string;
  toolCallId?: string;
  systemPromptOptions?: {
    sections: Record<string, string>;
  };
}

function bridgeDir(): string | undefined {
  const dir = process.env[BRIDGE_DIR_ENV];
  return dir === undefined || dir === "" ? undefined : dir;
}

/**
 * Announces that the extension loaded. The adapter waits for this file before
 * trusting a turn context file, because an extension that failed to load would
 * leave context files unread and every turn silently context-free.
 */
function announce(dir: string, pid: number, commandProposals: boolean): void {
  try {
    writeFileSync(
      bridgeReadyFile(dir, pid),
      `${JSON.stringify({ version: BRIDGE_VERSION, pid, ...(commandProposals ? { commandProposals: true } : {}) })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // No ready file means the adapter uses the prepend fallback, which is a
    // supported outcome rather than a failure.
  }
}

function record(dir: string, pid: number, entry: AppliedRecord): void {
  try {
    appendFileSync(bridgeAppliedLog(dir, pid), `${JSON.stringify(entry)}\n`, {
      mode: 0o600,
    });
  } catch {
    // The log is evidence for tests, not part of the turn.
  }
}

function sameTools(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, at) => name === b[at]);
}

export function createBridge(pi: BridgePi, options: { pid?: number } = {}) {
  const pid = options.pid ?? process.pid;
  const dir = bridgeDir();
  // pi's own tool set before any persona narrowed it, captured at runtime so
  // leaving a persona can put it back rather than leaving the user stuck in
  // a read-only tool set.
  let defaultTools: string[] | undefined;
  // Only the last persona this child applied, so a repeat turn does not churn
  // pi's tool declarations for nothing.
  let appliedTools: string[] | undefined;
  let appliedPersona: string | undefined;

  let proposing = false;
  let proposalRegistered = false;
  let editPreviousTools: string[] | undefined;
  try {
    if (pi.registerTool !== undefined) {
      pi.registerTool(proposalTool(() => proposing));
      proposalRegistered = true;
    }
  } catch {
    // The ready file must not claim structured edits if registration failed.
  }
  if (dir !== undefined) announce(dir, pid, proposalRegistered);
  try {
    defaultTools = (pi.getActiveTools?.() ?? []).filter(
      (name) => name !== PROPOSE_COMMAND,
    );
  } catch {
    defaultTools = [];
  }

  // The factory's API can still be unbound. Native pi 1.0.4 returns []
  // there; session_start is the first reliable runtime baseline (S9).
  pi.on("session_start", () => {
    try {
      const active = pi.getActiveTools?.() ?? defaultTools ?? [];
      defaultTools = active.filter((name) => name !== PROPOSE_COMMAND);
      if (active.includes(PROPOSE_COMMAND))
        pi.setActiveTools([...defaultTools]);
    } catch {
      // Keep the best-effort load-time baseline if this API is unavailable.
    }
  });

  const restoreEdit = () => {
    proposing = false;
    if (editPreviousTools !== undefined) {
      pi.setActiveTools(editPreviousTools);
      editPreviousTools = undefined;
    }
  };
  pi.on("agent_settled", restoreEdit);
  pi.on("tool_call", (event) => {
    if (
      (proposing && event.toolName !== PROPOSE_COMMAND) ||
      (event.toolName === PROPOSE_COMMAND &&
        (!proposing || event.toolCallId?.includes("/")))
    )
      return {
        block: true,
        reason: "This tool is not available in this edit turn.",
      };
    return undefined;
  });

  pi.on("before_agent_start", (event: BridgeEvent) => {
    if (dir === undefined) {
      return;
    }
    const file = turnContextFile(dir, pid);
    const payload = readTurnContext(file);
    // Removed as soon as it has been read, so a context file never outlives the
    // turn it was written for (DESIGN §10).
    removeTurnContext(file);
    if (payload === undefined) {
      record(dir, pid, { prompt: event.prompt ?? "", section: false });
      return;
    }

    // Restoration can throw and pi continues after hook failures. Arm the
    // edit tool-call guard even in that case; never fall through to full tools.
    try {
      restoreEdit();
    } finally {
      proposing = payload.commandProposal === true;
    }
    const options_ = event.systemPromptOptions;
    if (options_ === undefined) {
      // pi did not hand over a mutable prompt, so there is nothing to patch.
      return;
    }
    options_.sections["prefaix"] = renderShellContext(payload.context);

    const persona = payload.persona;
    delete options_.sections["suggest"];
    if (proposing) {
      if (!proposalRegistered)
        throw new Error("structured command proposals are unavailable");
      editPreviousTools = [...(pi.getActiveTools?.() ?? defaultTools ?? [])];
      pi.setActiveTools([PROPOSE_COMMAND]);
      if (
        pi.getActiveTools !== undefined &&
        !sameTools(pi.getActiveTools(), [PROPOSE_COMMAND])
      )
        throw new Error("could not activate propose_command exclusively");
      delete options_.sections["persona"];
      options_.sections["suggest"] = suggestGuideline(
        payload.context.shell.kind,
      );
    } else if (persona !== undefined) {
      const guideline = renderPersonaSection(persona);
      if (guideline !== undefined) {
        options_.sections["persona"] = guideline;
      }
      // D9: a persona switches tools in place, so no respawn is needed.
      const tools = persona.tools ?? defaultTools ?? [];
      if (
        (persona.tools !== undefined || appliedPersona !== undefined) &&
        (appliedPersona !== persona.name ||
          !sameTools(tools, appliedTools ?? []))
      ) {
        try {
          pi.setActiveTools([...tools]);
          appliedTools = [...tools];
          appliedPersona = persona.name;
        } catch {
          // A backend that refuses the switch keeps the previous tool set,
          // which is still a working turn.
        }
      }
    } else if (appliedPersona !== undefined) {
      // Leaving a persona restores the tool set the child started with.
      try {
        const restore = defaultTools ?? [];
        pi.setActiveTools([...restore]);
        appliedTools = undefined;
        appliedPersona = undefined;
        delete options_.sections["persona"];
      } catch {
        // Same reasoning as above.
      }
    }

    record(dir, pid, {
      prompt: event.prompt ?? "",
      section: true,
      ...(persona === undefined ? {} : { persona: persona.name }),
    });
  });

  return { version: BRIDGE_VERSION };
}

export default function prefaixBridge(pi: BridgePi): void {
  createBridge(pi);
}
