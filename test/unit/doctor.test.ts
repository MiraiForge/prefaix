import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBackend } from "../../src/agents/registry.js";
import { createFakeAgent } from "../../src/agents/fake/adapter.js";
import type {
  AgentBackend,
  AgentSession,
  ProbeResult,
} from "../../src/core/agent-port.js";
import {
  collectDoctorChecks,
  formatDoctorChecks,
  runDoctor,
  type DoctorOptions,
} from "../../src/cli/doctor.js";
import { resolvePaths } from "../../src/core/paths.js";

vi.mock("../../src/agents/registry.js", () => ({ createBackend: vi.fn() }));
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => home,
}));
let home: string;
let backend: AgentBackend;
let session: AgentSession;
let options: DoctorOptions;
let servers: Server[];
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "pfx-doc-"));
  servers = [];
  const env = {
    HOME: home,
    PATH: home,
    SHELL: "/bin/zsh",
    PREFAIX_PLUGIN_LOADED: "1",
  };
  const fake = createFakeAgent();
  session = await fake.open({ root: home, env });
  backend = {
    id: "pi",
    capabilities: fake.capabilities,
    probe: vi.fn(async () => ({
      installed: true,
      usable: true,
      version: "0.87.1",
    })),
    open: vi.fn(async () => session),
  };
  vi.mocked(createBackend).mockReturnValue(backend);
  options = {
    env,
    home,
    paths: resolvePaths({ env, home }),
    shellVersion: "5.9",
    platform: "darwin",
    backend,
  };
  writeFileSync(join(home, "pbcopy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
});
afterEach(async () => {
  await session.close();
  await Promise.all(
    servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
function probe(result: ProbeResult): void {
  vi.mocked(backend.probe).mockResolvedValue(result);
}
async function snapshot(
  id: string,
  replacement: Partial<DoctorOptions> = {},
): Promise<void> {
  const check = (
    await collectDoctorChecks({ ...options, ...replacement })
  ).filter((check) => check.id === id);
  expect(check).toHaveLength(1);
  expect(formatDoctorChecks(check)).toMatchSnapshot();
}

it("reports every healthy check and never prompts the backend", async () => {
  const prompt = vi.spyOn(session, "prompt");
  const abort = vi.spyOn(session, "abort");
  const close = vi.spyOn(session, "close");
  const checks = await collectDoctorChecks(options);
  expect(checks.map((check) => check.id)).toEqual([
    "config",
    "pi",
    "pi-version",
    "pi-rpc",
    "shell",
    "plugin",
    "forge",
    "ble",
    "runtime",
    "socket",
    "clipboard",
  ]);
  expect(checks.every((check) => check.status === "ok")).toBe(true);
  expect(prompt).not.toHaveBeenCalled();
  expect(abort).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(formatDoctorChecks(checks)).toMatchSnapshot();
});
it("constructs an isolated no-model backend at the composition point", async () => {
  const { backend: _backend, ...rest } = options;
  void _backend;
  await collectDoctorChecks(rest);
  expect(createBackend).toHaveBeenCalledWith("pi", {
    pi: {
      bin: "pi",
      env: options.env,
      requestTimeoutMs: 3000,
      readyTimeoutMs: 5000,
      rpc: {
        args: [
          "--mode",
          "rpc",
          "--no-session",
          "--no-extensions",
          "--no-skills",
        ],
      },
    },
  });
});
it("reports missing pi", async () => {
  probe({ installed: false, usable: false });
  await snapshot("pi");
  expect(backend.open).not.toHaveBeenCalled();
});
it("hides probe exceptions", async () => {
  vi.mocked(backend.probe).mockRejectedValue(new Error("SECRET"));
  await snapshot("pi");
});
it.each([undefined, "nonsense SECRET", "0.87.0", "0.86.100", "0.0.9"])(
  "reports unsupported pi %j",
  async (version) => {
    probe({
      installed: true,
      usable: true,
      ...(version === undefined ? {} : { version }),
    });
    await snapshot("pi-version");
    await snapshot("pi-rpc");
    expect(backend.open).not.toHaveBeenCalled();
  },
);
it.each(["0.87.2", "0.88.0", "1.0.0", "pi v0.87.1"])(
  "accepts pi %s",
  async (version) => {
    probe({ installed: true, usable: true, version });
    expect(
      (await collectDoctorChecks(options)).find(
        (check) => check.id === "pi-version",
      )?.status,
    ).toBe("ok");
  },
);
it("reports an unusable installation", async () => {
  probe({
    installed: true,
    usable: false,
    version: "0.87.1",
    problem: "SECRET",
    hint: "SECRET",
  });
  await snapshot("pi-rpc");
});
it("reports a failed RPC handshake without child errors", async () => {
  vi.mocked(backend.open).mockRejectedValue(new Error("SECRET"));
  await snapshot("pi-rpc");
});
it("closes a failed no-model session", async () => {
  vi.spyOn(session, "listModels").mockRejectedValue(new Error("SECRET"));
  const close = vi.spyOn(session, "close");
  await snapshot("pi-rpc");
  expect(close).toHaveBeenCalledOnce();
});
it("reports shutdown failure", async () => {
  vi.spyOn(session, "close").mockRejectedValueOnce(new Error("SECRET"));
  await snapshot("pi-rpc");
});
it("allows a backend without optional listCommands", async () => {
  const { listCommands: _commands, ...rest } = session;
  void _commands;
  vi.mocked(backend.open).mockResolvedValue({
    ...rest,
    native: session.native,
    state: session.state.bind(session),
    listModels: session.listModels.bind(session),
    abort: session.abort.bind(session),
    close: session.close.bind(session),
  } as AgentSession);
  expect(
    (await collectDoctorChecks(options)).find((check) => check.id === "pi-rpc")
      ?.status,
  ).toBe("ok");
});
it("reports invalid config without including values or source text", async () => {
  const paths = options.paths!;
  mkdirSync(paths.configDir, { recursive: true });
  writeFileSync(paths.configFile, '[agent]\nbackend = "CONFIG_SECRET"\n');
  await snapshot("config", {
    env: { ...options.env, PREFAIX_PREFIX: "ENV_SECRET" },
  });
  const output = formatDoctorChecks(
    await collectDoctorChecks({
      ...options,
      env: { ...options.env, PREFAIX_PREFIX: "ENV_SECRET" },
    }),
  );
  expect(output).not.toMatch(/CONFIG_SECRET|ENV_SECRET/);
});
it("reports an unreadable config file", async () => {
  const paths = options.paths!;
  mkdirSync(paths.configFile, { recursive: true });
  await snapshot("config");
});
it("reports an unresolved runtime layout", async () => {
  const checks = await collectDoctorChecks({ home: "relative", env: {} });
  expect(formatDoctorChecks(checks)).toMatchSnapshot();
});
it("reports an unidentified shell", async () => {
  await snapshot("shell", { env: {} });
});
it.each(["zsh", "fish", "bash"] as const)(
  "reports unsupported %s",
  async (shell) => {
    await snapshot("shell", { shell, shellVersion: "1.0" });
  },
);
it("reports bash 3.2 degraded support", async () => {
  await snapshot("shell", { shell: "bash", shellVersion: "3.2.57" });
});
it.each([
  ["zsh", "5.8"],
  ["fish", "3.6.0"],
  ["fish", "4.0"],
  ["bash", "4.4"],
  ["bash", "5.2.0"],
] as const)("accepts %s %s", async (shell, shellVersion) => {
  expect(
    (await collectDoctorChecks({ ...options, shell, shellVersion })).find(
      (check) => check.id === "shell",
    )?.status,
  ).toBe("ok");
});
it("handles shell command errors without outputting their error", async () => {
  const { shellVersion: _version, ...rest } = options;
  void _version;
  const checks = await collectDoctorChecks({
    ...rest,
    command: async () => {
      throw new Error("SECRET");
    },
  });
  expect(
    formatDoctorChecks(checks.filter((check) => check.id === "shell")),
  ).toMatchSnapshot();
});
it("runs a bounded shell version probe and discards stderr", async () => {
  const { shellVersion: _version, ...rest } = options;
  void _version;
  writeFileSync(
    join(home, "zsh"),
    '#!/bin/sh\nprintf "zsh 5.9\\n"\nprintf "SECRET" >&2\n',
    { mode: 0o755 },
  );
  const isolated = { ...rest, env: { ...rest.env, SHELL: join(home, "zsh") } };
  expect(
    (await collectDoctorChecks(isolated)).find((check) => check.id === "shell")
      ?.status,
  ).toBe("ok");
  rmSync(join(home, "zsh"));
  expect(
    (await collectDoctorChecks(isolated)).find((check) => check.id === "shell")
      ?.status,
  ).toBe("error");
});
it("reports an unloaded plugin", async () => {
  await snapshot("plugin", { pluginLoaded: false });
});
it("accepts explicit plugin and shell context", async () => {
  const checks = await collectDoctorChecks({
    ...options,
    env: {},
    shell: "fish",
    shellVersion: "4.0.0",
    pluginLoaded: true,
  });
  expect(checks.find((check) => check.id === "plugin")?.status).toBe("ok");
});
it("reports rc read failures", async () => {
  mkdirSync(join(home, ".zshrc"));
  await snapshot("rc");
});
it.each([
  "eval $(forge init zsh)",
  "source /path/pi-zsh-plugin/plugin.zsh",
  "plugins=(git forge)",
])("detects Forge initialization %s", async (line) => {
  writeFileSync(join(home, ".zshrc"), line);
  await snapshot("forge");
});
it("detects loaded Forge using the plugin marker", async () => {
  await snapshot("forge", {
    env: { ...options.env, PREFAIX_FORGE_CONFLICT: "1" },
  });
});
it.each([
  'eval "$(forge zsh plugin)"',
  'eval "$(forge bash plugin)"',
  "forge fish plugin | source",
  "source /path/forge.fish",
])("detects the documented Forge plugin form %s", async (line) => {
  writeFileSync(join(home, ".zshrc"), line);
  expect(
    (await collectDoctorChecks(options)).find((check) => check.id === "forge")
      ?.status,
  ).toBe("error");
});
it("detects ble.sh initialization", async () => {
  writeFileSync(join(home, ".zshrc"), "source /config/ble.sh\n");
  await snapshot("ble");
});
it("detects loaded ble.sh using the plugin marker", async () => {
  await snapshot("ble", { env: { ...options.env, PREFAIX_BLE_CONFLICT: "1" } });
});
it("ignores commented-out conflicting init lines", async () => {
  writeFileSync(
    join(home, ".zshrc"),
    "# source /config/ble.sh\n# eval $(forge init zsh)\n",
  );
  expect(
    (await collectDoctorChecks(options))
      .filter((check) => ["forge", "ble"].includes(check.id))
      .every((check) => check.status === "ok"),
  ).toBe(true);
});
it("reports unsafe runtime permissions", async () => {
  mkdirSync(options.paths!.runtimeDir, { recursive: true, mode: 0o755 });
  await snapshot("runtime");
});
it("reports wrong runtime ownership", async () => {
  mkdirSync(options.paths!.runtimeDir, { recursive: true, mode: 0o700 });
  await snapshot("runtime", { uid: -2 });
});
it("reports a runtime symlink", async () => {
  const path = join(home, "unsafe");
  symlinkSync(home, path);
  await snapshot("runtime", { paths: { ...options.paths!, runtimeDir: path } });
});
it("reports an uninspectable runtime path", async () => {
  const path = join(home, "file");
  writeFileSync(path, "");
  await snapshot("runtime", {
    paths: { ...options.paths!, runtimeDir: join(path, "child") },
  });
});
it("reports an unsafe socket", async () => {
  mkdirSync(options.paths!.runtimeDir, { recursive: true, mode: 0o700 });
  writeFileSync(options.paths!.socket, "", { mode: 0o600 });
  await snapshot("socket");
});
it("reports an uninspectable socket path", async () => {
  const path = join(home, "file");
  writeFileSync(path, "");
  await snapshot("socket", {
    paths: { ...options.paths!, socket: join(path, "child") },
  });
});
it("accepts actual private runtime and Unix socket permissions", async () => {
  const paths = options.paths!;
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(paths.socket, resolve));
  chmodSync(paths.socket, 0o600);
  const checks = await collectDoctorChecks(options);
  expect(
    checks
      .filter((check) => ["runtime", "socket"].includes(check.id))
      .every((check) => check.status === "ok"),
  ).toBe(true);
});
it("reports a missing clipboard tool", async () => {
  rmSync(join(home, "pbcopy"));
  await snapshot("clipboard");
});
it("does not mistake a directory for a clipboard executable", async () => {
  rmSync(join(home, "pbcopy"));
  mkdirSync(join(home, "pbcopy"));
  await snapshot("clipboard");
});
it("recognizes executable clipboard symlinks", async () => {
  writeFileSync(join(home, "copy-bin"), "", { mode: 0o700 });
  rmSync(join(home, "pbcopy"));
  symlinkSync(join(home, "copy-bin"), join(home, "pbcopy"));
  expect(
    (await collectDoctorChecks(options)).find(
      (check) => check.id === "clipboard",
    )?.status,
  ).toBe("ok");
});
it.each([
  ["wl-copy", { WAYLAND_DISPLAY: "SECRET" }],
  ["xclip", { DISPLAY: "SECRET" }],
] as const)(
  "finds %s on Linux without printing display values",
  async (bin, env) => {
    writeFileSync(join(home, bin), "", { mode: 0o700 });
    const checks = await collectDoctorChecks({
      ...options,
      platform: "linux",
      env: { ...options.env, ...env },
    });
    expect(checks.find((check) => check.id === "clipboard")?.status).toBe("ok");
    expect(formatDoctorChecks(checks)).not.toContain("SECRET");
  },
);
it("does not report unsupported xsel as an available clipboard tool", async () => {
  rmSync(join(home, "pbcopy"));
  writeFileSync(join(home, "xsel"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const checks = await collectDoctorChecks({
    ...options,
    platform: "linux",
    env: { ...options.env, DISPLAY: ":1" },
  });
  const clipboard = checks.find((check) => check.id === "clipboard");
  expect(clipboard?.status).toBe("warn");
  expect(clipboard?.fix).toContain("xclip on X11");
  expect(clipboard?.fix).not.toContain("xsel");
});
it("reports no clipboard for a headless Linux session", async () => {
  await snapshot("clipboard", { platform: "linux" });
});
it("does not search an empty PATH segment", async () => {
  await snapshot("clipboard", { env: { ...options.env, PATH: ":" } });
});
it("returns an error for failed checks and zero for warnings", async () => {
  const out: string[] = [];
  expect(await runDoctor({ ...options, out: (text) => out.push(text) })).toBe(
    0,
  );
  expect(
    await runDoctor({ ...options, pluginLoaded: false, out: () => {} }),
  ).toBe(0);
  probe({ installed: false, usable: false });
  expect(await runDoctor({ ...options, out: (text) => out.push(text) })).toBe(
    1,
  );
  expect(out.join("")).toContain("✗");
});
it("supports default options while remaining isolated from the host", async () => {
  vi.stubEnv("HOME", home);
  vi.stubEnv("PATH", home);
  vi.stubEnv("SHELL", join(home, "zsh"));
  vi.stubEnv("PREFAIX_SHELL", "zsh");
  vi.stubEnv("PREFAIX_PLUGIN_LOADED", "1");
  vi.stubEnv("XDG_CONFIG_HOME", join(home, "config"));
  vi.stubEnv("XDG_STATE_HOME", join(home, "state"));
  vi.stubEnv("XDG_RUNTIME_DIR", join(home, "run"));
  const write = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  expect(await runDoctor()).toBe(1); // zsh is intentionally absent from the isolated PATH.
  expect(write).toHaveBeenCalled();
});
it("reads config only and leaves it untouched", async () => {
  const file = options.paths!.configFile;
  mkdirSync(options.paths!.configDir, { recursive: true });
  const text = '[agent.pi]\nbin = "custom-pi"\n';
  writeFileSync(file, text);
  const { backend: _backend, ...rest } = options;
  void _backend;
  await collectDoctorChecks(rest);
  expect(vi.mocked(createBackend).mock.calls.at(-1)?.[1]?.pi?.bin).toBe(
    "custom-pi",
  );
  expect(readFileSync(file, "utf8")).toBe(text);
});

it("uses the loaded shell version rather than another installation on PATH", async () => {
  const checks = await collectDoctorChecks({
    backend,
    env: {
      PREFAIX_SHELL: "bash",
      PREFAIX_SHELL_VERSION: "3.2.57",
      PREFAIX_PLUGIN_LOADED: "1",
      OMITTED: undefined,
    },
  });
  expect(checks.find((check) => check.id === "shell")?.status).toBe("warn");
});
it("probes the requested shell when SHELL names another shell", async () => {
  const command = vi.fn().mockResolvedValue("fish 4.0");
  await collectDoctorChecks({
    backend,
    home,
    env: { SHELL: "/bin/zsh" },
    shell: "fish",
    command,
  });
  expect(command).toHaveBeenCalledWith("fish", ["--version"], {
    SHELL: "/bin/zsh",
  });
});
