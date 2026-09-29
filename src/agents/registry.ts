// The only module that knows the concrete adapters (DESIGN §4.4). Callers ask
// for a backend id from config (`agent.backend`, which PREFAIX_BACKEND also
// sets) and get an AgentBackend; nothing else imports an adapter directly.

import { PrefaixError } from "../core/errors.js";
import type { AgentBackend } from "../core/agent-port.js";
import type { BackendId } from "../core/config/index.js";
import {
  FAKE_ID,
  createFakeAgent,
  type FakeAgentOptions,
} from "./fake/adapter.js";
import { SCENARIO_NAMES } from "./fake/scenarios.js";
import { PI_ID, createPiAdapter, type PiAdapterOptions } from "./pi/adapter.js";

export interface BackendOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fake?: FakeAgentOptions;
  readonly pi?: PiAdapterOptions;
}

type BackendFactory = (options: BackendOptions) => AgentBackend;

const FACTORIES: Readonly<Record<string, BackendFactory>> = {
  [FAKE_ID]: (options) =>
    createFakeAgent({
      ...options.fake,
      ...(options.env === undefined ? {} : { env: options.env }),
    }),
  [PI_ID]: (options) => createPiAdapter({ ...options.pi }),
};

export const BACKEND_IDS: readonly BackendId[] = [FAKE_ID, PI_ID];

export function isBackendId(value: string): value is BackendId {
  return Object.hasOwn(FACTORIES, value);
}

export function createBackend(
  id: string,
  options: BackendOptions = {},
): AgentBackend {
  const factory = FACTORIES[id];
  if (factory === undefined) {
    throw new PrefaixError(
      "AGENT_UNAVAILABLE",
      `No agent backend named ${JSON.stringify(id)}`,
      {
        hint: `Set agent.backend or PREFAIX_BACKEND to: ${BACKEND_IDS.join(", ")}`,
      },
    );
  }
  return factory(options);
}

export { SCENARIO_NAMES };
export { FAKE_ID, PI_ID };
