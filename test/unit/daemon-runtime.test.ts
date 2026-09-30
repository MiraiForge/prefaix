import { afterEach, expect, it, vi } from "vitest";
import {
  DAEMON_NODE_FLAGS,
  prepareDaemonRuntime,
} from "../../src/cli/daemon-runtime.js";

afterEach(() => vi.restoreAllMocks());
function runtime(
  overrides: Partial<Parameters<typeof prepareDaemonRuntime>[0]> = {},
) {
  return {
    argv: ["/node", "/prefaix.js", "daemon", "--foreground"],
    execArgv: [],
    execPath: "/node",
    env: { PATH: "/bin", PRIVATE_KEY: "private" },
    platform: "darwin" as const,
    nodeVersion: "22.19.0",
    execve: vi.fn(),
    err: vi.fn(),
    ...overrides,
  };
}
it.each([undefined, "start", "--foreground"])(
  "re-execs daemon %s before resources exist",
  (subcommand) => {
    const options = runtime({
      argv: [
        "/node",
        "/prefaix.js",
        "daemon",
        ...(subcommand === undefined ? [] : [subcommand]),
      ],
    });
    expect(prepareDaemonRuntime(options)).toBeUndefined();
    expect(options.execve).toHaveBeenCalledWith(
      "/node",
      ["/node", ...DAEMON_NODE_FLAGS, ...options.argv.slice(1)],
      options.env,
    );
    expect(options.env).toEqual({ PATH: "/bin", PRIVATE_KEY: "private" });
  },
);
it.each([
  ["run"],
  ["doctor"],
  ["daemon", "status"],
  ["daemon", "stop"],
  ["--help"],
  [],
])("does not retune other commands %j", (...args) => {
  const options = runtime({ argv: ["/node", "/prefaix.js", ...args] });
  expect(prepareDaemonRuntime(options)).toBeUndefined();
  expect(options.execve).not.toHaveBeenCalled();
});
it("preserves existing Node args, CLI args, environment and avoids re-exec loops", () => {
  const options = runtime({
    execArgv: ["--enable-source-maps"],
    argv: ["/node", "/prefaix.js", "daemon", "start", "--foreground"],
  });
  prepareDaemonRuntime(options);
  expect(vi.mocked(options.execve).mock.calls[0]?.[1]).toEqual([
    "/node",
    ...DAEMON_NODE_FLAGS,
    "--enable-source-maps",
    ...options.argv.slice(1),
  ]);
  const next = runtime({
    execArgv: [...DAEMON_NODE_FLAGS, "--enable-source-maps"],
  });
  expect(prepareDaemonRuntime(next)).toBeUndefined();
  expect(next.execve).not.toHaveBeenCalled();
});
it("respects explicit runtime settings instead of replacing them", () => {
  for (const execArgv of [
    ["--no-jitless", "--max-semi-space-size", "8"],
    ["--jitless", "--max_semi_space_size=4"],
  ]) {
    const options = runtime({ execArgv });
    prepareDaemonRuntime(options);
    expect(options.execve).not.toHaveBeenCalled();
  }
  const options = runtime({ execArgv: ["--max-semi-space-size=2"] });
  prepareDaemonRuntime(options);
  expect(vi.mocked(options.execve).mock.calls[0]?.[1]).toEqual([
    "/node",
    "--jitless",
    "--max-semi-space-size=2",
    "/prefaix.js",
    "daemon",
    "--foreground",
  ]);
});
it.each(["22.18.0", "20.19.0", "invalid", "22"])(
  "reports unsupported Node %s clearly",
  (nodeVersion) => {
    const options = runtime({ nodeVersion });
    expect(prepareDaemonRuntime(options)).toBe(2);
    expect(options.execve).not.toHaveBeenCalled();
    expect(vi.mocked(options.err).mock.calls[0]?.[0]).toContain("Node 22.19");
  },
);
it.each(["22.19.0", "24.0.0", "26.7.0"])(
  "accepts supported Linux Node %s",
  (nodeVersion) => {
    const options = runtime({ nodeVersion, platform: "linux" });
    expect(prepareDaemonRuntime(options)).toBeUndefined();
    expect(options.execve).toHaveBeenCalledOnce();
  },
);
it.each(["win32", "freebsd"] as const)("rejects unsupported %s", (platform) => {
  const options = runtime({ platform });
  expect(prepareDaemonRuntime(options)).toBe(2);
});
it("rejects unsupported runtimes and unavailable execve", () => {
  expect(prepareDaemonRuntime(runtime({ bun: true }))).toBe(2);
  const { execve: _execve, ...options } = runtime();
  void _execve;
  expect(prepareDaemonRuntime(options)).toBe(2);
});
it("reports execve failure without exposing environment or exception values", () => {
  const options = runtime({
    execve: vi.fn(() => {
      throw new Error("PRIVATE_KEY=private");
    }),
  });
  expect(prepareDaemonRuntime(options)).toBe(3);
  expect(vi.mocked(options.err).mock.calls.flat().join("")).not.toContain(
    "private",
  );
});
it("supports the default process options without replacing a test process", () => {
  vi.spyOn(process, "argv", "get").mockReturnValue([
    "node",
    "prefaix",
    "doctor",
  ]);
  expect(prepareDaemonRuntime()).toBeUndefined();
});
it("uses current process arguments and reports a default runtime failure safely", () => {
  vi.spyOn(process, "argv", "get").mockReturnValue([
    "node",
    "prefaix",
    "daemon",
  ]);
  const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  vi.spyOn(process, "execve").mockImplementation(() => {
    throw new Error("private environment value");
  });
  expect(prepareDaemonRuntime()).toBe(3);
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("could not restart Node"),
  );
  expect(error).not.toHaveBeenCalledWith(expect.stringContaining("private"));
});
it("reports a default process without execve support", () => {
  vi.spyOn(process, "argv", "get").mockReturnValue([
    "node",
    "prefaix",
    "daemon",
  ]);
  const original = Object.getOwnPropertyDescriptor(process, "execve")!;
  Object.defineProperty(process, "execve", {
    value: undefined,
    configurable: true,
  });
  try {
    const error = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(prepareDaemonRuntime()).toBe(2);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("execve support"),
    );
  } finally {
    Object.defineProperty(process, "execve", original);
  }
});
