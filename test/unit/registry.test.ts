import { afterEach, expect, it, vi } from "vitest";
import { createFakeAgent } from "../../src/agents/fake/adapter.js";
import { createPiAdapter } from "../../src/agents/pi/adapter.js";
import { SCENARIOS } from "../../src/agents/fake/scenarios.js";
import { SCENARIO_NAMES } from "../../src/agents/fake/scenario-names.js";
import { createBackend } from "../../src/agents/registry.js";

afterEach(() => {
  vi.doUnmock("../../src/agents/fake/adapter.js");
  vi.doUnmock("../../src/agents/pi/adapter.js");
  vi.unstubAllEnvs();
  vi.resetModules();
});
it("loads only the selected adapter once when concurrent first callers need it", async () => {
  vi.resetModules();
  let fakeLoads = 0;
  let piLoads = 0;
  const factory = vi.fn(createFakeAgent);
  vi.doMock("../../src/agents/fake/adapter.js", () => {
    fakeLoads++;
    return { createFakeAgent: factory };
  });
  vi.doMock("../../src/agents/pi/adapter.js", () => {
    piLoads++;
    return { createPiAdapter };
  });
  const registry = await import("../../src/agents/registry.js");
  const backend = registry.createBackend("fake");
  expect(fakeLoads).toBe(0);
  expect(piLoads).toBe(0);
  await Promise.all([backend.probe(), backend.probe()]);
  expect(fakeLoads).toBe(1);
  expect(piLoads).toBe(0);
  expect(factory).toHaveBeenCalledOnce();
});
it("matches concrete capability metadata for every bridge configuration", () => {
  for (const pi of [
    {},
    { bridgePath: "/bridge.js" },
    { turnsDir: "/turns" },
    { bridgePath: "/bridge.js", turnsDir: "/turns" },
  ]) {
    expect(createBackend("pi", { pi }).capabilities).toEqual(
      createPiAdapter(pi).capabilities,
    );
  }
  const fake = { capabilities: { models: false, contextSections: false } };
  expect(createBackend("fake", { fake }).capabilities).toEqual(
    createFakeAgent(fake).capabilities,
  );
});
it("retains fake transcripts across close and resume through the lazy wrapper", async () => {
  const backend = createBackend("fake");
  const first = await backend.open({ root: "/", env: {} });
  await first.rename!("kept title");
  await first.close();
  const resumed = await backend.open({
    root: "/",
    env: {},
    resume: first.native,
  });
  expect((await resumed.state()).name).toBe("kept title");
  await resumed.close();
});
it("captures default fake selection before environment changes", async () => {
  vi.stubEnv("PREFAIX_FAKE_SCENARIO", "tools");
  const backend = createBackend("fake");
  vi.stubEnv("PREFAIX_FAKE_SCENARIO", "hello");
  expect((await backend.probe()).version).toBe("fake/tools");
});
it("preserves explicit fake and pi options across lazy creation", async () => {
  const fake = createBackend("fake", {
    fake: { env: { PREFAIX_FAKE_SCENARIO: "markdown" } },
  });
  expect((await fake.probe()).version).toBe("fake/markdown");
  const pi = createBackend("pi", {
    pi: { bin: "/definitely-missing/prefaix-pi", env: {} },
  });
  expect((await pi.probe()).installed).toBe(false);
});

it("keeps lightweight scenario metadata in sync with the fixtures", () => {
  expect(SCENARIO_NAMES).toEqual(Object.keys(SCENARIOS).sort());
});
