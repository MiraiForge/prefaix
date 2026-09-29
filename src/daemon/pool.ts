// The agent pool (DESIGN §4.3.4). One warm child per active conversation,
// bound to its root and env fingerprint, closed when idle, and respawned on the
// same native session when the shell's environment actually changes.
//
// Everything here is backend-independent: the pool knows AgentPort and nothing
// about pi. The adapter turns `native` back into a spawn plan.

import { PrefaixError, unsupported, messageOf } from "../core/errors.js";
import { envFingerprint } from "../context/env.js";
import type {
  AgentBackend,
  AgentSession,
  ModelInfo,
  OpenOptions,
  PersonaSpec,
} from "../core/agent-port.js";
import type { PrefaixConfig } from "../core/config/schema.js";

export interface PoolOptions {
  readonly backend: AgentBackend;
  readonly config: PrefaixConfig;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  readonly now?: () => number;
  /** Spare pre-warm; off in tests that count children. */
  readonly spare?: boolean;
}

export interface AcquireRequest {
  readonly conversationId: string;
  readonly root: string;
  readonly env: Record<string, string>;
  readonly title?: string;
  readonly model?: { provider: string; id: string };
  readonly thinking?: string;
  readonly persona?: PersonaSpec;
  readonly native?: { sessionFile?: string; sessionId?: string };
}

interface Binding {
  readonly conversationId: string;
  root: string;
  envHash: string;
  session: AgentSession;
  lastUsed: number;
  turns: number;
  persona: string | undefined;
  /** Recent crash timestamps, for the three-in-60s degraded rule. */
  crashes: number[];
  degraded: boolean;
}

export interface PoolStats {
  children: number;
  spare: number;
  degraded: readonly string[];
}

const CRASH_WINDOW_MS = 60_000;
const CRASH_LIMIT = 3;

export class AgentPool {
  readonly #backend: AgentBackend;
  readonly #config: PrefaixConfig;
  readonly #log:
    ((message: string, fields?: Record<string, unknown>) => void) | undefined;
  readonly #now: () => number;
  readonly #bindings = new Map<string, Binding>();
  #spare:
    | {
        root: string;
        env: Record<string, string>;
        envHash: string;
        promise: Promise<AgentSession>;
      }
    | undefined;

  constructor(options: PoolOptions) {
    this.#backend = options.backend;
    this.#config = options.config;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    if (options.spare !== undefined) {
      this.#config = {
        ...options.config,
        pool: { ...options.config.pool, spare: options.spare },
      };
    }
  }

  get backend(): AgentBackend {
    return this.#backend;
  }

  stats(): PoolStats {
    return {
      children: this.#bindings.size,
      spare: this.#spare === undefined ? 0 : 1,
      degraded: [...this.#bindings.entries()]
        .filter(([, binding]) => binding.degraded)
        .map(([id]) => id),
    };
  }

  /**
   * The session for a conversation, spawning or respawning as the binding
   * requires. A respawn keeps the native session, so the transcript survives
   * an env change; a fresh conversation gets a new native id.
   */
  async acquire(request: AcquireRequest): Promise<AgentSession> {
    const envHash = envFingerprint(request.env);
    const existing = this.#bindings.get(request.conversationId);

    if (existing !== undefined) {
      const reopens = this.#needsRespawn(existing, request, envHash);
      if (!reopens) {
        existing.lastUsed = this.#now();
        if (
          request.persona !== undefined &&
          request.persona.name !== existing.persona
        ) {
          existing.persona = request.persona.name;
          // Without the bridge a persona is applied by the spawn arguments, so
          // switching one is a respawn rather than an in-place change.
          if (this.#backend.capabilities.personasWithoutRespawn) {
            await existing.session.setPersona?.(request.persona);
          } else {
            await this.#replace(existing, request, envHash);
            return existing.session;
          }
        }
        return existing.session;
      }
      await this.#replace(existing, request, envHash);
      return existing.session;
    }

    await this.#makeRoom();
    const binding = await this.#open(request, envHash);
    this.#bindings.set(request.conversationId, binding);
    // The spare exists to answer the next prompt, so this turn's own child is
    // the one that has just been used.
    this.#spare = undefined;
    return binding.session;
  }

  #needsRespawn(
    binding: Binding,
    request: AcquireRequest,
    envHash: string,
  ): boolean {
    if (binding.degraded) {
      return true;
    }
    if (binding.envHash !== envHash) {
      this.#log?.("env changed, respawning the agent child", {
        conversation: binding.conversationId,
      });
      return true;
    }
    if (binding.root !== request.root) {
      // The cwd policy is resolved by the turn manager, which passes the root
      // it actually wants; a different root is a different spawn.
      this.#log?.("root changed, respawning the agent child", {
        conversation: binding.conversationId,
        from: binding.root,
        to: request.root,
      });
      return true;
    }
    return false;
  }

  async #replace(
    binding: Binding,
    request: AcquireRequest,
    envHash: string,
  ): Promise<void> {
    const previous = binding.session;
    const opened = await this.#open(request, envHash, previous.native);
    binding.session = opened.session;
    binding.root = request.root;
    binding.envHash = envHash;
    binding.lastUsed = this.#now();
    binding.crashes = [];
    binding.degraded = false;
    binding.turns = 0;
    await previous.close().catch(() => undefined);
  }

  async #open(
    request: AcquireRequest,
    envHash: string,
    native?: { sessionFile?: string; sessionId?: string },
  ): Promise<Binding> {
    const openOptions: OpenOptions = {
      root: request.root,
      env: request.env,
      ...(native === undefined || Object.keys(native).length === 0
        ? {}
        : { resume: native }),
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
      ...(request.persona === undefined ? {} : { persona: request.persona }),
    };
    const session = await this.#backend.open(openOptions);
    return {
      conversationId: request.conversationId,
      root: request.root,
      envHash,
      session,
      lastUsed: this.#now(),
      turns: 0,
      persona: request.persona?.name,
      crashes: [],
      degraded: false,
    };
  }

  /**
   * Closes the least recently used child when the pool is at capacity. The
   * session lives on disk, so closing costs a respawn and nothing else.
   *
   * There is one binding per conversation, so a conversation asking for room
   * always has at most one child of its own to skip, and the pool can always
   * find a victim. It may be a conversation with a turn in flight, whose next
   * turn then pays the respawn; that is the price of a fixed ceiling, and it is
   * better than refusing the turn.
   */
  async #makeRoom(): Promise<void> {
    const max = Math.max(1, this.#config.pool.maxChildren);
    if (this.#bindings.size < max) {
      return;
    }
    const victim = [...this.#bindings.values()].sort(
      (a, b) => a.lastUsed - b.lastUsed,
    )[0];
    if (victim === undefined) {
      return;
    }
    this.#log?.("closing the least recently used agent child", {
      conversation: victim.conversationId,
    });
    this.#bindings.delete(victim.conversationId);
    await victim.session.close().catch(() => undefined);
  }

  /** Records a turn so the idle sweep has a reason to keep the child. */
  touch(conversationId: string): void {
    const binding = this.#bindings.get(conversationId);
    if (binding !== undefined) {
      binding.lastUsed = this.#now();
      binding.turns += 1;
    }
  }

  /**
   * A child that died mid-turn. Three crashes inside a minute mark the
   * conversation degraded, which the next spawn answers with a fresh child and
   * a `prefaix doctor` hint rather than an endless respawn loop.
   */
  noteCrash(conversationId: string): { degraded: boolean; recent: number } {
    const binding = this.#bindings.get(conversationId);
    if (binding === undefined) {
      return { degraded: false, recent: 0 };
    }
    const now = this.#now();
    binding.crashes = [
      ...binding.crashes.filter((at) => now - at < CRASH_WINDOW_MS),
      now,
    ];
    binding.degraded = binding.crashes.length >= CRASH_LIMIT;
    if (binding.degraded) {
      this.#log?.("conversation marked degraded after repeated crashes", {
        conversation: conversationId,
        crashes: binding.crashes.length,
      });
    }
    return { degraded: binding.degraded, recent: binding.crashes.length };
  }

  /** Closes children idle for longer than `pool.idle_minutes`. */
  async sweepIdle(): Promise<string[]> {
    const cutoff =
      this.#now() - Math.max(0, this.#config.pool.idleMinutes) * 60_000;
    const closed: string[] = [];
    for (const [id, binding] of [...this.#bindings]) {
      if (binding.lastUsed <= cutoff) {
        this.#bindings.delete(id);
        closed.push(id);
        await binding.session.close().catch(() => undefined);
      }
    }
    if (this.#spare !== undefined) {
      const spare = this.#spare;
      this.#spare = undefined;
      await spare.promise
        .then((session) => session.close())
        .catch(() => undefined);
    }
    return closed;
  }

  /**
   * Pre-warms one child for the most recent (root, env). A spare is adopted by
   * the next conversation that wants the same pair, which is the whole point:
   * it turns the next `:new` from a 0.8 s cold start into nothing.
   */
  warmSpare(root: string, env: Record<string, string>): void {
    if (!this.#config.pool.spare) {
      return;
    }
    const envHash = envFingerprint(env);
    if (this.#spare?.envHash === envHash && this.#spare.root === root) {
      return;
    }
    void this.#spare?.promise
      .then((session) => session.close())
      .catch(() => undefined);
    this.#spare = {
      root,
      env,
      envHash,
      promise: this.#backend.open({ root, env }).catch((cause: unknown) => {
        // A spare that cannot start is not a reason to fail the turn that
        // triggered it; the next turn spawns its own child anyway.
        this.#log?.("could not pre-warm a spare agent child", {
          cause: messageOf(cause),
        });
        throw cause;
      }),
    };
    // A rejected spare promise must not become an unhandled rejection.
    this.#spare.promise.catch(() => undefined);
  }

  /** Takes the spare when it matches, so a warm child is actually used. */
  async takeSpare(
    conversationId: string,
    root: string,
    env: Record<string, string>,
  ): Promise<void> {
    const spare = this.#spare;
    if (spare === undefined) {
      return;
    }
    const envHash = envFingerprint(env);
    if (spare.root !== root || spare.envHash !== envHash) {
      return;
    }
    this.#spare = undefined;
    const binding: Binding = {
      conversationId,
      root,
      envHash,
      session: await spare.promise,
      lastUsed: this.#now(),
      turns: 0,
      persona: undefined,
      crashes: [],
      degraded: false,
    };
    this.#bindings.set(conversationId, binding);
  }

  /** Closes and forgets one conversation's child. */
  async release(conversationId: string): Promise<void> {
    const binding = this.#bindings.get(conversationId);
    if (binding === undefined) {
      return;
    }
    this.#bindings.delete(conversationId);
    await binding.session.close().catch(() => undefined);
  }

  session(conversationId: string): AgentSession | undefined {
    return this.#bindings.get(conversationId)?.session;
  }

  async close(): Promise<void> {
    const bindings = [...this.#bindings.values()];
    this.#bindings.clear();
    const spare = this.#spare;
    this.#spare = undefined;
    await Promise.all(
      bindings.map((binding) => binding.session.close().catch(() => undefined)),
    );
    if (spare !== undefined) {
      await spare.promise
        .then((session) => session.close())
        .catch(() => undefined);
    }
  }

  // The port's optional capabilities become clear errors rather than crashes
  // (DESIGN §4.4). These are the checks the router and the CLI call before
  // reaching for a method that may not be there.

  require(capability: keyof AgentBackend["capabilities"]): void {
    if (this.#backend.capabilities[capability] !== true) {
      throw unsupported(this.#backend.id, String(capability));
    }
  }

  async models(conversationId: string): Promise<ModelInfo[]> {
    const session = this.#requireSession(conversationId);
    return session.listModels();
  }

  #requireSession(conversationId: string): AgentSession {
    const session = this.session(conversationId);
    if (session === undefined) {
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        `no warm agent for conversation ${JSON.stringify(conversationId)}`,
        { hint: "Run a `:` in that shell first, or use :new." },
      );
    }
    return session;
  }
}
