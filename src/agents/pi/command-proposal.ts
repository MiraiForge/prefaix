import { parseCommandProposal } from "../../core/command-proposal.js";

export const PROPOSE_COMMAND = "propose_command";

export interface ProposalTool {
  name: string;
  label: string;
  description: string;
  exposure: "model-only";
  parameters: Record<PropertyKey, unknown>;
  execute(
    id: string,
    args: unknown,
    signal?: AbortSignal,
  ): {
    content: { type: "text"; text: string }[];
    details: { command: string; explanation: string };
    terminate: true;
  };
}

// Minimal TypeBox String/Object schemas, structurally vendored to keep the
// bridge independent of pi's installed package. v0 uses a symbol; v1 ~kind.
function schema(kind: string, fields: Record<string, unknown>) {
  return { ...fields, "~kind": kind, [Symbol.for("TypeBox.Kind")]: kind };
}

export function proposalTool(enabled: () => boolean): ProposalTool {
  return {
    name: PROPOSE_COMMAND,
    label: "Propose command",
    description: "Return one shell command for user review. Never executes it.",
    exposure: "model-only",
    parameters: schema("Object", {
      type: "object",
      required: ["command", "explanation"],
      properties: {
        command: schema("String", { type: "string" }),
        explanation: schema("String", { type: "string" }),
      },
      additionalProperties: false,
    }),
    execute(_id, args, signal) {
      if (!enabled() || signal?.aborted)
        throw new Error(
          "propose_command is only available in an active edit turn",
        );
      const proposal = parseCommandProposal(args);
      if (proposal === undefined)
        throw new Error(
          "propose_command requires a nonempty editable command and explanation",
        );
      return {
        content: [{ type: "text", text: proposal.explanation }],
        details: proposal,
        terminate: true,
      };
    },
  };
}
