import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackend } from "../src/agents/registry.js";

// This probe never sends a prompt. It uses no session and disables extensions
// so a clean CI machine needs no model credentials or user configuration.
const root = mkdtempSync(join(tmpdir(), "pfx-pi-smoke-"));
const env = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME: root,
  PI_CODING_AGENT_DIR: join(root, "agent"),
};
const backend = createBackend("pi", {
  pi: {
    bin: process.env["PREFAIX_AGENT_PI_BIN"] ?? "pi",
    env,
    rpc: {
      args: [
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
      ],
    },
  },
});
try {
  const probe = await backend.probe();
  assert(probe.installed && probe.usable, "pi is unavailable");
  const session = await backend.open({ root, env });
  try {
    assert.equal((await session.state()).busy, false);
    assert(Array.isArray(await session.listModels()));
    assert(Array.isArray(await session.listThinkingLevels?.()));
    assert(Array.isArray(await session.listCommands?.()));
    await session.abort();
    console.log(`pi ${probe.version ?? "unknown"}: no-model RPC smoke passed.`);
  } finally {
    await session.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
