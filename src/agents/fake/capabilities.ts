import type { Capabilities } from "../../core/agent-port.js";

export const FAKE_ID = "fake";

// pi-specific features stay off, so the fake never pretends to be a pi host.
export const FAKE_CAPABILITIES: Capabilities = {
  steer: false, // M4
  followUp: false, // M4
  abort: true,
  models: true,
  thinkingLevels: true,
  compact: true,
  slashCommands: true,
  skills: true,
  uiDialogs: true,
  contextSections: true,
  personasWithoutRespawn: true,
  handoffTui: false, // :tui hands off to pi
};
