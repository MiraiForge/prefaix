import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { shellRuntimeFiles, type PrefaixPaths } from "./paths.js";

let sequence = 0;

/** The daemon and foreground publish the same data-only prompt cache. */
export async function writeShellStatus(
  paths: PrefaixPaths,
  shellId: string,
  text: string,
): Promise<void> {
  const { dir, status } = shellRuntimeFiles(paths, shellId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${status}.${String(process.pid)}.${String(sequence++)}.tmp`;
  try {
    await writeFile(temp, `${text}\n`, { mode: 0o600, flag: "wx" });
    await rename(temp, status);
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}
