import { describe, expect, it } from "vitest";
import {
  assessIdleMemoryBudget,
  IDLE_RSS_LIMIT_BYTES,
  type IdleMemoryMeasurement,
} from "../../scripts/performance-budget.js";

const limitMiB = IDLE_RSS_LIMIT_BYTES / 1024 / 1024;
const measured: readonly IdleMemoryMeasurement[] = [
  { stage: "fresh", rssMiB: 56.53 },
  { stage: "post-use", rssMiB: 60 },
  { stage: "post-burst", rssMiB: 60.47 },
];

describe("idle-memory budget policy", () => {
  it("reports Node 26's approved overrun without discarding measurements", () => {
    expect(assessIdleMemoryBudget("v26.7.0", measured)).toMatchObject({
      status: "allowlisted",
      nodeMajor: 26,
      limitBytes: 60_000_000,
      overBudget: measured.slice(1),
      exception: { nodeMajor: 26, scope: "daemon idle RSS" },
    });
  });

  it.each([
    "v22.19.0",
    "v24.21.0",
    "v27.0.0",
    "v126.7.0",
    "unknown",
    "26.invalid",
  ])("keeps the original byte budget enforced on %s", (version) => {
    expect(assessIdleMemoryBudget(version, measured)).toMatchObject({
      status: "failed",
      limitBytes: 60_000_000,
      exception: null,
    });
  });

  it("requires strictly less than 60 MB on runtimes without an exception", () => {
    expect(
      assessIdleMemoryBudget("v24.21.0", [{ stage: "fresh", rssMiB: limitMiB }])
        .status,
    ).toBe("failed");
    expect(
      assessIdleMemoryBudget("v24.21.0", [
        { stage: "fresh", rssMiB: limitMiB - 0.001 },
      ]).status,
    ).toBe("passed");
  });

  it("reports an actual pass when Node 26 meets the original budget", () => {
    expect(
      assessIdleMemoryBudget("v26.7.0", [{ stage: "fresh", rssMiB: 50 }]),
    ).toMatchObject({ status: "passed", overBudget: [], exception: null });
  });

  it.each([NaN, Infinity, 0, -1])(
    "does not allowlist invalid RSS %s",
    (rssMiB) => {
      expect(() =>
        assessIdleMemoryBudget("v26.7.0", [{ stage: "fresh", rssMiB }]),
      ).toThrow("Invalid daemon RSS measurement");
    },
  );
});
