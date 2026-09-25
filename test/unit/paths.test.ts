import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import { PrefaixError } from "../../src/core/errors.js";
import {
  conversationFile,
  fitsSunPath,
  resolvePaths,
  shellHintsFile,
  shellRuntimeFiles,
} from "../../src/core/paths.js";

const SOCKET_SUFFIX = "/.local/state/prefaix/run/daemon.sock";

// A macOS-style home whose default socket path is exactly `bytes` long.
function homeForSocketBytes(bytes: number): string {
  const prefix = "/Users/";
  return prefix + "u".repeat(bytes - prefix.length - SOCKET_SUFFIX.length);
}

describe("resolvePaths", () => {
  it("uses the XDG defaults under HOME on macOS", () => {
    expect(
      resolvePaths({
        platform: "darwin",
        env: {},
        home: "/Users/allan",
        uid: 501,
      }),
    ).toEqual({
      configDir: "/Users/allan/.config/prefaix",
      configFile: "/Users/allan/.config/prefaix/config.toml",
      stateDir: "/Users/allan/.local/state/prefaix",
      conversationsDir: "/Users/allan/.local/state/prefaix/conversations",
      shellHintsDir: "/Users/allan/.local/state/prefaix/shells",
      logsDir: "/Users/allan/.local/state/prefaix/logs",
      daemonLog: "/Users/allan/.local/state/prefaix/logs/daemon.log",
      runtimeDir: "/Users/allan/.local/state/prefaix/run",
      runtimeFallback: false,
      socket: "/Users/allan/.local/state/prefaix/run/daemon.sock",
      lock: "/Users/allan/.local/state/prefaix/run/daemon.lock",
      shellsDir: "/Users/allan/.local/state/prefaix/run/shells",
      turnsDir: "/Users/allan/.local/state/prefaix/run/turns",
      cacheDir: "/Users/allan/.cache/prefaix",
    });
  });

  it("honors every XDG variable on a systemd Linux session", () => {
    expect(
      resolvePaths({
        platform: "linux",
        env: {
          XDG_CONFIG_HOME: "/home/ada/.cfg",
          XDG_STATE_HOME: "/home/ada/.st",
          XDG_CACHE_HOME: "/var/cache/ada",
          XDG_RUNTIME_DIR: "/run/user/1000",
        },
        home: "/home/ada",
        uid: 1000,
      }),
    ).toEqual({
      configDir: "/home/ada/.cfg/prefaix",
      configFile: "/home/ada/.cfg/prefaix/config.toml",
      stateDir: "/home/ada/.st/prefaix",
      conversationsDir: "/home/ada/.st/prefaix/conversations",
      shellHintsDir: "/home/ada/.st/prefaix/shells",
      logsDir: "/home/ada/.st/prefaix/logs",
      daemonLog: "/home/ada/.st/prefaix/logs/daemon.log",
      runtimeDir: "/run/user/1000/prefaix",
      runtimeFallback: false,
      socket: "/run/user/1000/prefaix/daemon.sock",
      lock: "/run/user/1000/prefaix/daemon.lock",
      shellsDir: "/run/user/1000/prefaix/shells",
      turnsDir: "/run/user/1000/prefaix/turns",
      cacheDir: "/var/cache/ada/prefaix",
    });
  });

  it("keeps the runtime dir under the XDG state dir without XDG_RUNTIME_DIR", () => {
    const paths = resolvePaths({
      platform: "linux",
      env: { XDG_STATE_HOME: "/srv/state" },
      home: "/home/ada",
      uid: 1000,
    });
    expect(paths.runtimeDir).toBe("/srv/state/prefaix/run");
    expect(paths.socket).toBe("/srv/state/prefaix/run/daemon.sock");
  });

  it("ignores empty and relative XDG values, as the spec requires", () => {
    const paths = resolvePaths({
      platform: "linux",
      env: {
        XDG_CONFIG_HOME: "relative/config",
        XDG_STATE_HOME: "",
        XDG_CACHE_HOME: "./cache",
        XDG_RUNTIME_DIR: "run/user/1000",
      },
      home: "/home/ada",
      uid: 1000,
    });
    expect(paths.configDir).toBe("/home/ada/.config/prefaix");
    expect(paths.stateDir).toBe("/home/ada/.local/state/prefaix");
    expect(paths.cacheDir).toBe("/home/ada/.cache/prefaix");
    expect(paths.runtimeDir).toBe("/home/ada/.local/state/prefaix/run");
  });

  it.each([
    ["darwin", 103, false],
    ["darwin", 104, true],
    ["linux", 107, false],
    ["linux", 108, true],
    ["freebsd", 103, false],
    ["freebsd", 104, true],
  ] as const)(
    "on %s, a %i-byte socket path falls back to /tmp: %s",
    (platform, bytes, fallback) => {
      const home = homeForSocketBytes(bytes);
      const paths = resolvePaths({ platform, env: {}, home, uid: 501 });
      expect(Buffer.byteLength(home + SOCKET_SUFFIX)).toBe(bytes);
      expect(paths.runtimeFallback).toBe(fallback);
      expect(paths.socket).toBe(
        fallback ? "/tmp/prefaix-501/daemon.sock" : home + SOCKET_SUFFIX,
      );
    },
  );

  it("moves the whole runtime dir, but not state, to the fallback", () => {
    const home = homeForSocketBytes(200);
    const paths = resolvePaths({
      platform: "darwin",
      env: {},
      home,
      uid: 501,
    });
    expect(paths).toMatchObject({
      runtimeDir: "/tmp/prefaix-501",
      runtimeFallback: true,
      socket: "/tmp/prefaix-501/daemon.sock",
      lock: "/tmp/prefaix-501/daemon.lock",
      shellsDir: "/tmp/prefaix-501/shells",
      turnsDir: "/tmp/prefaix-501/turns",
      stateDir: `${home}/.local/state/prefaix`,
    });
  });

  it("measures sun_path in UTF-8 bytes, not characters", () => {
    const runtime = `/run/user/${"é".repeat(40)}`;
    const socket = `${runtime}/prefaix/daemon.sock`;
    expect(socket.length).toBeLessThan(107);
    expect(fitsSunPath(socket, "linux")).toBe(false);
    const paths = resolvePaths({
      platform: "linux",
      env: { XDG_RUNTIME_DIR: runtime },
      home: "/home/ada",
      uid: 1000,
    });
    expect(paths.socket).toBe("/tmp/prefaix-1000/daemon.sock");
  });

  it("rejects a relative home when a default needs it", () => {
    expect(() =>
      resolvePaths({ platform: "linux", env: {}, home: "ada", uid: 1 }),
    ).toThrow(PrefaixError);
  });

  it("does not consult home when every XDG variable is set", () => {
    const paths = resolvePaths({
      platform: "linux",
      env: {
        XDG_CONFIG_HOME: "/c",
        XDG_STATE_HOME: "/s",
        XDG_CACHE_HOME: "/k",
        XDG_RUNTIME_DIR: "/r",
      },
      home: "",
      uid: 1,
    });
    expect(paths.socket).toBe("/r/prefaix/daemon.sock");
  });

  it("returns absolute paths for the current process", () => {
    const paths = resolvePaths();
    for (const [key, value] of Object.entries(paths)) {
      if (typeof value === "string") {
        expect(posix.isAbsolute(value), key).toBe(true);
      }
    }
  });
});

describe("id-scoped paths", () => {
  const paths = resolvePaths({
    platform: "linux",
    env: { XDG_RUNTIME_DIR: "/run/user/1000" },
    home: "/home/ada",
    uid: 1000,
  });

  it("places conversation records in the state dir", () => {
    expect(conversationFile(paths, "c_01ARYZ6S41TSV4RRFFQ69G5FAV")).toBe(
      "/home/ada/.local/state/prefaix/conversations/c_01ARYZ6S41TSV4RRFFQ69G5FAV.json",
    );
  });

  it("places shell hints in state and directives/status in runtime", () => {
    const shellId = "4242-1758800000-a1B2c3";
    expect(shellHintsFile(paths, shellId)).toBe(
      `/home/ada/.local/state/prefaix/shells/${shellId}.json`,
    );
    expect(shellRuntimeFiles(paths, shellId)).toEqual({
      dir: `/run/user/1000/prefaix/shells/${shellId}`,
      directives: `/run/user/1000/prefaix/shells/${shellId}/directives`,
      status: `/run/user/1000/prefaix/shells/${shellId}/status`,
    });
  });

  it.each(["../../etc/passwd", "c_../x", "", "c_01arYZ6S41TSV4RRFFQ69G5FAV"])(
    "rejects conversation id %j",
    (id) => {
      expect(() => conversationFile(paths, id)).toThrow(/Invalid conversation/);
    },
  );

  it.each(["..", "1-2-../x", "1-2-a/b", "0-1-a", "12--x", ""])(
    "rejects shell id %j",
    (shellId) => {
      expect(() => shellHintsFile(paths, shellId)).toThrow(/Invalid shell id/);
      expect(() => shellRuntimeFiles(paths, shellId)).toThrow(
        /Invalid shell id/,
      );
    },
  );
});
