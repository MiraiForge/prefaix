// pi 1.0.4 restores the session header cwd even when launched elsewhere (S3).
import { open, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { PrefaixError } from "../../core/errors.js";
import { asRecord } from "./types.js";

export async function assertResumeRoot(
  file: string | undefined,
  root: string,
): Promise<void> {
  if (file === undefined || file === "") return;
  const handle = await open(file, "r").catch((cause: unknown) => {
    // Let pi report an absent file, preserving its native resume diagnostics.
    if (asRecord(cause)?.["code"] === "ENOENT") return undefined;
    throw new PrefaixError(
      "AGENT_ERROR",
      "Cannot verify the pi session directory.",
      { cause },
    );
  });
  if (handle === undefined) return;
  let header: string;
  try {
    const buffer = Buffer.alloc(65_536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    header =
      buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
  } finally {
    await handle.close();
  }
  let cwd: unknown;
  try {
    cwd = asRecord(JSON.parse(header))?.["cwd"];
  } catch {
    /* Refuse unknown roots below. */
  }
  if (typeof cwd !== "string" || cwd === "") {
    throw new PrefaixError(
      "AGENT_ERROR",
      "Cannot verify the pi session directory from its header.",
    );
  }
  const canonical = async (path: string) =>
    realpath(path).catch(() => resolve(path));
  if ((await canonical(cwd)) !== (await canonical(root))) {
    throw new PrefaixError(
      "UNSUPPORTED",
      "This pi backend restores the original session directory and cannot follow a conversation into another root.",
      {
        hint: 'Use workspace.cwd_policy = "split", or stay in the original conversation root.',
      },
    );
  }
}
