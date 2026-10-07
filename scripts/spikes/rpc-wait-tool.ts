// A deliberately side-effect-free tool for S1's mid-tool abort. Loading this
// extension does not request a model, start a timer, or expose shell/file tools.
import { setTimeout as delay } from "node:timers/promises";

export const WAIT_TOOL = "prefaix_s1_wait";
export const WAIT_STARTED = "S1_WAIT_STARTED";

interface WaitResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly details: undefined;
}

export interface WaitTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate?: (result: WaitResult) => void,
  ): Promise<WaitResult>;
}

// A minimal local subset of ExtensionAPI: no runtime dependency on pi. The
// JSON Schema is accepted by pi's tool validator, just like a TypeBox schema.
export interface WaitExtensionApi {
  registerTool(tool: WaitTool): void;
}

export default function registerWaitTool(pi: WaitExtensionApi): void {
  pi.registerTool({
    name: WAIT_TOOL,
    label: "S1 wait",
    description:
      "Wait for 30 seconds, reporting S1_WAIT_STARTED immediately. " +
      "Has no file, shell, network, or model side effects. Accepts no arguments.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_toolCallId, _params, signal, onUpdate) {
      signal?.throwIfAborted();
      onUpdate?.({
        content: [{ type: "text", text: WAIT_STARTED }],
        details: undefined,
      });
      await delay(30_000, undefined, signal === undefined ? {} : { signal });
      return {
        content: [{ type: "text", text: "S1_WAIT_COMPLETED" }],
        details: undefined,
      };
    },
  });
}
