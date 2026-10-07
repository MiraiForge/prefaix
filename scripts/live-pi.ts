// Shared by opt-in development adapter probes. No prompt is sent here.
import {
  createPiAdapter,
  type PiAdapterOptions,
  type PiSession,
} from "../src/agents/pi/adapter.js";
import type { OpenOptions } from "../src/core/agent-port.js";
import { assertLiveAllowed, LiveGuardError, type Env } from "./live-guard.js";

/** Guard, pin BOTH launch flags, and verify pi's actual state before prompting. */
export async function openLivePi(
  options: OpenOptions,
  config: PiAdapterOptions = {},
  env: Env = process.env,
): Promise<PiSession> {
  const live = assertLiveAllowed(env);
  const prefix = `${live.provider}/`;
  if (!live.model.startsWith(prefix) || live.model.length === prefix.length) {
    throw new LiveGuardError(
      "The guarded model must name the exact guarded provider.",
    );
  }
  const model = {
    provider: live.provider,
    id: live.model.slice(prefix.length),
  };
  if (
    options.model !== undefined &&
    (options.model.provider !== model.provider || options.model.id !== model.id)
  ) {
    throw new LiveGuardError(
      "The requested model differs from the guarded selection.",
    );
  }
  const session = (await createPiAdapter({
    ...config,
    provider: live.provider,
    model: live.model,
  }).open({ ...options, model })) as PiSession;
  try {
    const state = await session.state();
    if (
      state.model?.provider !== model.provider ||
      state.model.id !== model.id
    ) {
      throw new LiveGuardError(
        "pi did not select the exact guarded provider and model. Refusing to prompt.",
      );
    }
    return session;
  } catch (cause) {
    await session.close().catch(() => undefined);
    throw cause;
  }
}
