import type { Capabilities } from "../../core/agent-port.js";

export const PI_ID = "pi";

export const PI_BASE_CAPABILITIES: Capabilities = {
  steer: true,
  followUp: true,
  abort: true,
  models: true,
  thinkingLevels: true,
  compact: true,
  slashCommands: true,
  skills: true,
  uiDialogs: true,
  handoffTui: true,
  // Both are only real when the bridge extension is in play: without it the
  // context block is prepended to the user's message and a persona change
  // needs a respawn. The bundle is resolved by the composition root, so an
  // adapter built without one is deliberately the fallback shape.
  contextSections: false,
  personasWithoutRespawn: false,
  commandProposals: false,
};

export interface BridgeOptions {
  readonly bridgePath?: string;
  readonly turnsDir?: string;
}

export function bridgeConfigured(options: BridgeOptions = {}): boolean {
  return (options.bridgePath ?? "") !== "" && (options.turnsDir ?? "") !== "";
}

export function piCapabilities(options: BridgeOptions = {}): Capabilities {
  return {
    ...PI_BASE_CAPABILITIES,
    ...(bridgeConfigured(options)
      ? {
          contextSections: true,
          personasWithoutRespawn: true,
          commandProposals: true,
        }
      : {}),
  };
}
