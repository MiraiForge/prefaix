// Backend-independent ownership of warm children and the optional spare.
// Lifecycle mutations are serialized so opening and closing children reserve
// their slots until ownership can be transferred safely.

import { PrefaixError, unsupported, messageOf } from "../core/errors.js";
import { envFingerprint } from "../context/env.js";
import type {
  AgentBackend,
  AgentSession,
  ModelInfo,
  NativeRef,
  OpenOptions,
  PersonaSpec,
} from "../core/agent-port.js";
import type { PrefaixConfig } from "../core/config/schema.js";

export interface PoolOptions {
  readonly backend: AgentBackend;
  readonly config: PrefaixConfig;
  readonly log?: (message: string, fields?: Record<string, unknown>) => void;
  readonly now?: () => number;
  /** Includes turn startup and finalization, not just agent streaming. */
  readonly isBusy?: (conversationId: string) => boolean;
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
  /** Omitted keeps a warm binding's persona; null explicitly restores defaults. */
  readonly persona?: PersonaSpec | null;
  readonly native?: NativeRef;
}

interface Binding {
  readonly conversationId: string;
  readonly root: string;
  readonly envHash: string;
  readonly session: AgentSession;
  lastUsed: number;
  persona: PersonaSpec | undefined;
  crashes: number[];
  degraded: boolean;
  crashObserved: boolean;
  closed: boolean;
}

interface Spare {
  readonly root: string;
  readonly envHash: string;
  readonly lastUsed: number;
  session: AgentSession | undefined;
  closed: boolean;
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
  readonly #isBusy: (conversationId: string) => boolean;
  readonly #bindings = new Map<string, Binding>();
  #spare: Spare | undefined;
  #opening = 0;
  #pending: Promise<unknown> | undefined;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: PoolOptions) {
    this.#backend = options.backend;
    this.#config =
      options.spare === undefined
        ? options.config
        : {
            ...options.config,
            pool: { ...options.config.pool, spare: options.spare },
          };
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#isBusy = options.isBusy ?? (() => false);
  }

  get backend(): AgentBackend {
    return this.#backend;
  }

  stats(): PoolStats {
    return {
      children:
        [...this.#bindings.values()].filter((binding) => !binding.closed)
          .length + this.#opening,
      spare: this.#spare === undefined ? 0 : 1,
      degraded: [...this.#bindings.values()]
        .filter((binding) => binding.degraded)
        .map((binding) => binding.conversationId),
    };
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const work =
      this.#pending === undefined
        ? operation()
        : this.#pending.catch(() => undefined).then(operation);
    const result = work.finally(() => {
      if (this.#pending === result) {
        this.#pending = undefined;
      }
    });
    this.#pending = result;
    return result;
  }

  #assertOpen(): void {
    if (this.#closing) {
      throw new PrefaixError("AGENT_UNAVAILABLE", "agent pool is closing");
    }
  }

  /** A replacement always resumes the existing native transcript. */
  acquire(request: AcquireRequest): Promise<AgentSession> {
    return this.#mutate(async () => {
      this.#assertOpen();
      const envHash = envFingerprint(request.env);
      const existing = this.#bindings.get(request.conversationId);
      if (existing !== undefined) {
        if (request.persona === undefined && existing.persona !== undefined)
          request = { ...request, persona: existing.persona };
        this.#pruneCrashes(existing);
        if (
          !existing.closed &&
          existing.session.isAlive === false &&
          !existing.crashObserved
        ) {
          this.noteCrash(request.conversationId);
        }
        const respawn =
          existing.closed ||
          existing.crashObserved ||
          existing.session.isAlive === false ||
          existing.envHash !== envHash ||
          existing.root !== request.root;
        const personaChanged =
          request.persona !== undefined &&
          JSON.stringify(request.persona ?? undefined) !==
            JSON.stringify(existing.persona);
        if (
          respawn ||
          (personaChanged && !this.#backend.capabilities.personasWithoutRespawn)
        ) {
          const native = { ...existing.session.native };
          await this.#closeBinding(existing);
          // Other bindings and the spare may now occupy a formerly dead slot.
          await this.#makeRoom();
          return (await this.#open(request, envHash, native, existing)).session;
        }
        if (personaChanged) {
          if (existing.session.setPersona === undefined) {
            throw unsupported(this.#backend.id, "personasWithoutRespawn");
          }
          try {
            await existing.session.setPersona(request.persona ?? undefined);
          } catch (cause) {
            // A configured bridge can fail to load for just this child. Keep
            // the native transcript, but apply tools safely at spawn instead.
            if (
              !(cause instanceof PrefaixError) ||
              cause.code !== "UNSUPPORTED"
            )
              throw cause;
            const native = { ...existing.session.native };
            await this.#closeBinding(existing);
            await this.#makeRoom();
            return (await this.#open(request, envHash, native, existing))
              .session;
          }
          existing.persona = request.persona ?? undefined;
        }
        existing.lastUsed = this.#now();
        this.#assertOpen();
        return existing.session;
      }

      const adopted = await this.#adoptSpare(request, envHash);
      if (adopted !== undefined) {
        return adopted;
      }
      await this.#closeSpare();
      await this.#makeRoom();
      return (await this.#open(request, envHash)).session;
    });
  }

  async #open(
    request: AcquireRequest,
    envHash: string,
    native: NativeRef | undefined = request.native,
    previous?: Binding,
  ): Promise<Binding> {
    this.#assertOpen();
    const openOptions: OpenOptions = {
      root: request.root,
      env: request.env,
      ...(native === undefined || Object.keys(native).length === 0
        ? {}
        : { resume: native }),
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
      ...(request.persona == null ? {} : { persona: request.persona }),
    };
    this.#opening += 1;
    try {
      const session = await this.#backend.open(openOptions);
      const binding: Binding = {
        conversationId: request.conversationId,
        root: request.root,
        envHash,
        session,
        lastUsed: this.#now(),
        persona: request.persona ?? undefined,
        crashes: previous?.crashes ?? [],
        degraded: previous?.degraded ?? false,
        crashObserved: false,
        closed: false,
      };
      this.#bindings.set(request.conversationId, binding);
      // Shutdown may have started while the backend was opening. The new
      // binding stays owned so queued shutdown closes it before completing.
      this.#assertOpen();
      return binding;
    } finally {
      this.#opening -= 1;
    }
  }

  async #makeRoom(): Promise<void> {
    const max = Math.max(1, this.#config.pool.maxChildren);
    if (this.stats().children + this.stats().spare < max) {
      return;
    }
    await this.#closeSpare();
    if (this.stats().children < max) {
      return;
    }
    const victim = [...this.#bindings.values()]
      .filter(
        (binding) => !binding.closed && !this.#isBusy(binding.conversationId),
      )
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (victim === undefined) {
      throw new PrefaixError(
        "CONVERSATION_BUSY",
        "all agent child slots are occupied by active conversations",
        { hint: "Wait for a running turn to finish, then try again." },
      );
    }
    this.#log?.("closing the least recently used idle agent child", {
      conversation: victim.conversationId,
    });
    await this.#closeBinding(victim);
    this.#bindings.delete(victim.conversationId);
  }

  /** Failed closure retains ownership unless the backend confirms exit. */
  async #closeSession(owner: {
    session: AgentSession;
    closed: boolean;
  }): Promise<void> {
    if (owner.closed) {
      return;
    }
    try {
      await owner.session.close();
    } catch (cause) {
      if (owner.session.isAlive !== false) {
        throw new PrefaixError(
          "AGENT_UNAVAILABLE",
          "agent child could not be closed",
          { cause },
        );
      }
    }
    if (owner.session.isAlive === true) {
      throw new PrefaixError(
        "AGENT_UNAVAILABLE",
        "agent child is still alive after closing",
      );
    }
    owner.closed = true;
  }

  #closeBinding(binding: Binding): Promise<void> {
    return this.#closeSession(binding);
  }

  async #closeSpare(): Promise<void> {
    const spare = this.#spare;
    if (spare === undefined) {
      return;
    }
    if (spare.session !== undefined) {
      const owner = { session: spare.session, closed: spare.closed };
      await this.#closeSession(owner);
      spare.closed = owner.closed;
    }
    this.#spare = undefined;
  }

  touch(conversationId: string): void {
    const binding = this.#bindings.get(conversationId);
    if (binding !== undefined) {
      binding.lastUsed = this.#now();
    }
  }

  #pruneCrashes(binding: Binding): void {
    const now = this.#now();
    binding.crashes = binding.crashes.filter(
      (at) => now - at < CRASH_WINDOW_MS,
    );
    binding.degraded = binding.crashes.length >= CRASH_LIMIT;
  }

  /** Record once when a transport failure is observed; never retry its prompt. */
  noteCrash(conversationId: string): { degraded: boolean; recent: number } {
    const binding = this.#bindings.get(conversationId);
    if (binding === undefined) {
      return { degraded: false, recent: 0 };
    }
    this.#pruneCrashes(binding);
    binding.crashes.push(this.#now());
    binding.crashObserved = true;
    binding.degraded = binding.crashes.length >= CRASH_LIMIT;
    if (binding.degraded) {
      this.#log?.("conversation marked degraded after repeated crashes", {
        conversation: conversationId,
        crashes: binding.crashes.length,
      });
    }
    return { degraded: binding.degraded, recent: binding.crashes.length };
  }

  /** Busy includes startup/finalization, so neither can be swept as idle. */
  sweepIdle(): Promise<string[]> {
    return this.#mutate(async () => {
      const idleMs = Math.max(0, this.#config.pool.idleMinutes) * 60_000;
      if (!Number.isFinite(idleMs)) {
        return [];
      }
      const cutoff = this.#now() - idleMs;
      const closed: string[] = [];
      for (const [id, binding] of this.#bindings) {
        if (binding.lastUsed <= cutoff && !this.#isBusy(id)) {
          await this.#closeBinding(binding);
          this.#bindings.delete(id);
          closed.push(id);
        }
      }
      if (this.#spare !== undefined && this.#spare.lastUsed <= cutoff) {
        await this.#closeSpare();
      }
      return closed;
    });
  }

  /** Prewarming uses only a free slot; it never evicts a conversation. */
  warmSpare(root: string, env: Record<string, string>): void {
    if (!this.#config.pool.spare || this.#closing) {
      return;
    }
    void this.#mutate(async () => {
      if (this.#closing) {
        return;
      }
      const envHash = envFingerprint(env);
      if (
        this.#spare?.envHash === envHash &&
        this.#spare.root === root &&
        this.#spare.session?.isAlive !== false
      ) {
        return;
      }
      if (this.#spare !== undefined) {
        await this.#closeSpare();
      }
      if (
        this.#closing ||
        this.stats().children >= Math.max(1, this.#config.pool.maxChildren)
      ) {
        return;
      }
      const spare: Spare = {
        root,
        envHash,
        lastUsed: this.#now(),
        session: undefined,
        closed: false,
      };
      this.#spare = spare;
      try {
        spare.session = await this.#backend.open({ root, env });
      } catch (cause) {
        this.#spare = undefined;
        this.#log?.("could not pre-warm a spare agent child", {
          cause: messageOf(cause),
        });
      }
    }).catch((cause: unknown) => {
      this.#log?.("could not pre-warm a spare agent child", {
        cause: messageOf(cause),
      });
    });
  }

  async #adoptSpare(
    request: AcquireRequest,
    envHash: string,
  ): Promise<AgentSession | undefined> {
    const spare = this.#spare;
    const session = spare?.session;
    if (
      spare === undefined ||
      session === undefined ||
      session.isAlive === false ||
      spare.root !== request.root ||
      spare.envHash !== envHash ||
      (request.native !== undefined &&
        Object.keys(request.native).length > 0) ||
      (request.title !== undefined && session.rename === undefined) ||
      (request.thinking !== undefined && session.setThinking === undefined) ||
      // A persona-bearing request gets its own child so the runtime bridge
      // probe and spawn-time fallback are verified before any prompt.
      request.persona != null
    ) {
      return undefined;
    }
    try {
      if (request.title !== undefined) await session.rename!(request.title);
      if (request.model !== undefined) await session.setModel(request.model);
      if (request.thinking !== undefined)
        await session.setThinking!(request.thinking);
    } catch (cause) {
      await this.#closeSpare();
      throw cause;
    }
    this.#assertOpen();
    this.#bindings.set(request.conversationId, {
      conversationId: request.conversationId,
      root: request.root,
      envHash,
      session,
      lastUsed: this.#now(),
      persona: request.persona ?? undefined,
      crashes: [],
      degraded: false,
      crashObserved: false,
      closed: false,
    });
    this.#spare = undefined;
    return session;
  }

  /** Compatibility entry point for callers explicitly adopting a fresh spare. */
  takeSpare(
    conversationId: string,
    root: string,
    env: Record<string, string>,
  ): Promise<void> {
    return this.#mutate(async () => {
      this.#assertOpen();
      if (!this.#bindings.has(conversationId)) {
        await this.#adoptSpare(
          { conversationId, root, env },
          envFingerprint(env),
        );
      }
    });
  }

  release(conversationId: string): Promise<void> {
    return this.#mutate(async () => {
      const binding = this.#bindings.get(conversationId);
      if (binding !== undefined) {
        await this.#closeBinding(binding);
        this.#bindings.delete(conversationId);
      }
    });
  }

  session(conversationId: string): AgentSession | undefined {
    const binding = this.#bindings.get(conversationId);
    return binding === undefined ||
      binding.closed ||
      binding.session.isAlive === false
      ? undefined
      : binding.session;
  }

  close(): Promise<void> {
    this.#closing = true;
    if (this.#closePromise === undefined) {
      const closing = this.#mutate(async () => {
        const failures: unknown[] = [];
        for (const [id, binding] of this.#bindings) {
          try {
            await this.#closeBinding(binding);
            this.#bindings.delete(id);
          } catch (cause) {
            failures.push(cause);
          }
        }
        try {
          await this.#closeSpare();
        } catch (cause) {
          failures.push(cause);
        }
        if (failures.length > 0) {
          throw failures[0];
        }
      });
      this.#closePromise = closing;
      void closing.catch(() => {
        if (this.#closePromise === closing) {
          this.#closePromise = undefined;
        }
      });
    }
    return this.#closePromise;
  }

  require(capability: keyof AgentBackend["capabilities"]): void {
    if (this.#backend.capabilities[capability] !== true) {
      throw unsupported(this.#backend.id, String(capability));
    }
  }

  async models(conversationId: string): Promise<ModelInfo[]> {
    const session = this.session(conversationId);
    if (session === undefined) {
      throw new PrefaixError(
        "CONVERSATION_NOT_FOUND",
        `no warm agent for conversation ${JSON.stringify(conversationId)}`,
        { hint: "Run a `:` in that shell first, or use :new." },
      );
    }
    return session.listModels();
  }
}
