import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { run } from "../../src/client/run.js";
import { defaultConfig } from "../../src/core/config/schema.js";
import { resolvePaths } from "../../src/core/paths.js";
import { PROTOCOL_VERSION } from "../../src/core/protocol.js";

let home = "";
let server: Server | undefined;
afterEach(async () => {
  if (server !== undefined)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (home) rmSync(home, { force: true, recursive: true });
});
it.each(["refusal", "legacy-hello"] as const)(
  "rejects a v1 daemon's %s before commit/detach RPCs or raw mode",
  async (mode) => {
    home = mkdtempSync(join(tmpdir(), "pfx-upgrade-"));
    const paths = resolvePaths({
      home,
      env: { HOME: home, XDG_RUNTIME_DIR: join(home, "run") },
    });
    mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
    const received: { t: string; v?: number; op?: string }[] = [];
    server = createServer((connection) => {
      connection.setEncoding("utf8");
      let buffer = "";
      connection.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          const message = JSON.parse(line) as {
            t: string;
            v?: number;
            op?: string;
          };
          received.push(message);
          if (message.t !== "hello") continue; // v1 silently discards new operations.
          const response =
            mode === "refusal"
              ? {
                  t: "res",
                  id: "r0",
                  ok: false,
                  error: {
                    code: "PROTOCOL_MISMATCH",
                    message: "this daemon speaks protocol v1",
                    hint: "prefaix daemon stop",
                  },
                }
              : { t: "hello", v: 1, version: "0.0.0", pid: 1 };
          connection.write(JSON.stringify(response) + "\n");
        }
      });
    });
    await new Promise<void>((resolve) => server!.listen(paths.socket, resolve));
    const config = structuredClone(defaultConfig());
    config.agent.backend = "fake";
    for (const line of [":commit", ": normal turn", ":attach"]) {
      const output: string[] = [];
      const modes: boolean[] = [];
      expect(
        await run({
          argv: [
            "--shell",
            "bash",
            "--shell-id",
            "1-1-a",
            "--nonce",
            "n",
            "--directives",
            join(home, "directives"),
            "--cwd",
            home,
            "--conversation",
            "c_old",
            "--",
            line,
          ],
          config,
          paths,
          version: "0.0.0",
          env: { HOME: home },
          stdoutIsTty: false,
          out: (text) => output.push(text),
          err: (text) => output.push(text),
          tty: {
            setRawMode: (raw) => {
              modes.push(raw);
              return raw;
            },
            on: () => {},
            removeAllListeners: () => {},
          },
        }),
      ).toBe(3);
      expect(modes).toEqual([]);
      expect(output.join("")).toContain("protocol v1");
      expect(output.join("")).toContain("original CLI");
    }
    expect(PROTOCOL_VERSION).not.toBe(1);
    expect(received).toHaveLength(3);
    expect(
      received.every((m) => m.t === "hello" && m.v === PROTOCOL_VERSION),
    ).toBe(true);
  },
);
