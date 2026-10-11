import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { PrefaixError } from "../core/errors.js";

export interface StagedDiff {
  text: string;
  hash: string;
  truncated: boolean;
}

const DIFF_ARGS = [
  "--no-pager",
  "diff",
  "--cached",
  "--no-ext-diff",
  "--no-textconv",
  "--binary",
  "--no-color",
  "--",
];

/** Stream and hash the whole index diff, retaining at most the configured cap. */
export function stagedDiff(
  cwd: string,
  env: Record<string, string>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<StagedDiff> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", DIFF_ARGS, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      ...(signal === undefined ? {} : { signal }),
    });
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let bytes = 0;
    let kept = 0;
    let error = "";
    child.stdout.on("data", (chunk: Buffer) => {
      hash.update(chunk);
      bytes += chunk.length;
      const take = Math.min(chunk.length, Math.max(0, maxBytes - kept));
      if (take > 0) {
        chunks.push(chunk.subarray(0, take));
        kept += take;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      error = (error + chunk.toString("utf8")).slice(0, 2048);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new PrefaixError(
            "USAGE",
            `cannot read staged diff: ${error.trim() || "git failed or timed out"}`,
          ),
        );
      } else if (bytes === 0) {
        reject(
          new PrefaixError(
            "USAGE",
            "no staged changes; stage files with git add before :commit",
          ),
        );
      } else {
        // Drop an incomplete final UTF-8 character rather than exceed the cap.
        const decoder = new TextDecoder("utf-8", { fatal: false });
        resolve({
          text: decoder.decode(Buffer.concat(chunks), { stream: bytes > kept }),
          hash: hash.digest("hex"),
          truncated: bytes > kept,
        });
      }
    });
  });
}

/** Explicit --run executes argv, never the model's shell command. */
export async function runCommit(
  cwd: string,
  env: Record<string, string>,
  message: string,
  expectedHash: string,
  signal: AbortSignal,
  out: (text: string) => void,
): Promise<void> {
  const current = await stagedDiff(cwd, env, 0, signal);
  if (current.hash !== expectedHash)
    throw new PrefaixError(
      "USAGE",
      "staged changes changed while drafting; run :commit again",
    );
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["commit", "-m", message], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (text: string) => out(text));
    child.stderr.on("data", (text: string) => out(text));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new PrefaixError(
            "AGENT_ERROR",
            "git commit failed; staged changes were not automatically retried",
          ),
        );
    });
  });
}
