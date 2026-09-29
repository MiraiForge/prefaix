// The contract suite's target for the scripted fake: each contract case maps to
// the fake scenario that plays it, and a gate replaces the fake's pacing so a
// test can stop the turn at an exact event.

import { createFakeAgent } from "../../src/agents/fake/adapter.js";
import type { ScenarioName } from "../../src/agents/fake/scenarios.js";
import type {
  AgentEvent,
  AgentSession,
  PromptInput,
  ShellContext,
} from "../../src/core/agent-port.js";
import type { ContractCase, ContractTarget, TurnRun } from "./suite.js";

const ROOT = "/contract";

const CONTEXT: ShellContext = {
  shell: { kind: "zsh", version: "5.9", shellId: "1-1-a", pid: 1 },
  cwd: ROOT,
  recent: [{ cmd: "git pull", exit: 0 }],
  os: "test",
  term: { cols: 100, rows: 30, colors: 256 },
};

function promptInput(text: string): PromptInput {
  return { text, context: CONTEXT };
}

// One step of the fake's pacing, held open until a test lets it through.
class Gate {
  #waiting: (() => void) | undefined;
  #isParked = false;
  #watchers: (() => void)[] = [];

  sleep = (): Promise<void> =>
    new Promise<void>((resolve) => {
      this.#waiting = resolve;
      this.#isParked = true;
      const pending = this.#watchers;
      this.#watchers = [];
      for (const watch of pending) {
        watch();
      }
    });

  release = (): void => {
    this.#isParked = false;
    const next = this.#waiting;
    this.#waiting = undefined;
    next?.();
  };

  parked = (): Promise<void> => {
    if (this.#isParked) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.#watchers.push(resolve));
  };
}

const SCRIPTS: Record<ContractCase, ScenarioName> = {
  stream: "hello",
  tools: "tools",
  dialog: "dialog",
  error: "error",
  retry: "retry",
  abortDuringTool: "tools",
  abortFromSignal: "long",
  abortFromMethod: "long",
};

class FakeRun implements TurnRun {
  readonly events: AgentEvent[] = [];
  readonly #controller = new AbortController();
  readonly #watchers = new Set<(event: AgentEvent) => void>();
  readonly #run: Promise<void>;

  constructor(
    readonly session: AgentSession,
    gate: Gate,
  ) {
    const run = (async () => {
      try {
        for await (const event of session.prompt(
          promptInput(": contract"),
          this.#controller.signal,
        )) {
          this.events.push(event);
          for (const watch of [...this.#watchers]) {
            watch(event);
          }
        }
      } finally {
        await session.close();
      }
    })();
    this.#run = run;

    // The fake waits on its tick between steps, so the gate is released each
    // time the turn parks. That is what makes stopping at an exact event
    // deterministic.
    void (async () => {
      for (;;) {
        const outcome = await Promise.race([
          gate.parked().then(() => "parked" as const),
          run.then(() => "done" as const),
        ]);
        if (outcome === "done") {
          return;
        }
        gate.release();
      }
    })();
  }

  get done(): Promise<void> {
    return this.#run;
  }

  async until(
    match: (event: AgentEvent) => boolean,
    what = "the expected event",
  ): Promise<void> {
    if (this.events.some(match)) {
      return;
    }
    const found = new Promise<void>((resolve) => {
      const watch = (event: AgentEvent): void => {
        if (!match(event)) {
          return;
        }
        this.#watchers.delete(watch);
        resolve();
      };
      this.#watchers.add(watch);
    });
    await Promise.race([
      found,
      this.#run.then(() => {
        throw new Error(`the turn ended before ${what} arrived`);
      }),
    ]);
  }

  async stop(via: "signal" | "method" | "both" = "both"): Promise<void> {
    if (via !== "method") {
      this.#controller.abort();
    }
    if (via !== "signal") {
      await this.session.abort();
    }
  }
}

export function fakeTarget(): ContractTarget {
  const agent = createFakeAgent();
  return {
    name: "fake",
    capabilities: agent.capabilities,
    probe: () => agent.probe(),
    open: () => agent.open({ root: ROOT, env: {} }),
    async start(caseName: ContractCase): Promise<TurnRun> {
      const gate = new Gate();
      const scripted = createFakeAgent({
        scenario: SCRIPTS[caseName],
        sleep: gate.sleep,
      });
      return new FakeRun(await scripted.open({ root: ROOT, env: {} }), gate);
    },
  };
}
