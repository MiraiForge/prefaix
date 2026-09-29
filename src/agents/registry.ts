// The only module that knows the concrete adapters (DESIGN §4.4). Callers ask
// for a backend id from config (`agent.backend`, which PREFAIX_BACKEND also
// sets) and get an AgentBackend; nothing else imports an adapter directly.
//
// `createConfiguredBackend` is the composition point: it is where config, the
// runtime layout, and an adapter's own options meet, so a caller that only
// knows "prefaix, configured this way" never learns which backend it got.

import { PrefaixError } from "../core/errors.js";
import type { AgentBackend } from "../core/agent-port.js";
import type { BackendId, PrefaixConfig } from "../core/config/index.js";
import {
  FAKE_ID,
  createFakeAgent,
  type FakeAgentOptions,
} from "./fake/adapter.js";
import { SCENARIO_NAMES } from "./fake/scenarios.js";
import { PI_ID, createPiAdapter, type PiAdapterOptions } from "./pi/adapter.js";
import { resolveBridgeBundle } from "./pi/bridge-bundle.js";

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

export interface ConfiguredBackendOptions {
  readonly config: PrefaixConfig;
  /** Where per-turn context files live; the bridge reads them from there. */
  readonly turnsDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
}

/**
 * The backend the config asks for, with everything its adapter needs. A bundle
 * that is not on disk is not an error: the pi adapter falls back to prepending
 * the context block, which is the documented shape when the bridge is absent.
 */
export function createConfiguredBackend(
  options: ConfiguredBackendOptions,
): AgentBackend {
  const { config } = options;
  const bridgePath = resolveBridgeBundle();
  return createBackend(config.agent.backend, {
    ...(options.env === undefined ? {} : { env: options.env }),
    pi: {
      bin: config.agent.pi.bin,
      model: config.agent.pi.model,
      thinking: config.agent.pi.thinking,
      ...(options.turnsDir === undefined ? {} : { turnsDir: options.turnsDir }),
      ...(bridgePath === undefined ? {} : { bridgePath }),
      ...(options.log === undefined ? {} : { log: options.log }),
    },
  });
}

export { SCENARIO_NAMES };
export { FAKE_ID, PI_ID };
