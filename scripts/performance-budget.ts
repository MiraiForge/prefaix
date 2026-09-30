export const IDLE_RSS_LIMIT_BYTES = 60_000_000;

export interface IdleMemoryMeasurement {
  readonly stage: "fresh" | "post-use" | "post-burst";
  readonly rssMiB: number;
}

export interface IdleMemoryBudgetResult {
  readonly status: "passed" | "allowlisted" | "failed";
  readonly nodeMajor: number | null;
  readonly limitBytes: number;
  readonly limitMiB: number;
  readonly overBudget: readonly IdleMemoryMeasurement[];
  readonly exception: {
    readonly nodeMajor: 26;
    readonly scope: "daemon idle RSS";
    readonly reason: string;
  } | null;
}

export function assessIdleMemoryBudget(
  nodeVersion: string,
  measurements: readonly IdleMemoryMeasurement[],
): IdleMemoryBudgetResult {
  const match = /^v?(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.exec(nodeVersion);
  const nodeMajor = match === null ? null : Number(match[1]);
  const limitMiB = IDLE_RSS_LIMIT_BYTES / 1024 / 1024;
  for (const measurement of measurements) {
    if (!Number.isFinite(measurement.rssMiB) || measurement.rssMiB <= 0) {
      throw new Error(
        `Invalid daemon RSS measurement for ${measurement.stage}`,
      );
    }
  }
  const overBudget = measurements.filter(({ rssMiB }) => rssMiB >= limitMiB);
  // Allan explicitly approved the Node 26 idle-RSS exception. Every other
  // runtime and all timing/throughput budgets retain their existing gates.
  const allowlisted = nodeMajor === 26 && overBudget.length > 0;
  return {
    status:
      overBudget.length === 0
        ? "passed"
        : allowlisted
          ? "allowlisted"
          : "failed",
    nodeMajor,
    limitBytes: IDLE_RSS_LIMIT_BYTES,
    limitMiB,
    overBudget,
    exception: allowlisted
      ? {
          nodeMajor: 26,
          scope: "daemon idle RSS",
          reason: "Allan approved the Node 26 memory-budget exception.",
        }
      : null,
  };
}
