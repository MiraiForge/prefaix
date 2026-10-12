import { shellRuntimeFiles, type PrefaixPaths } from "./paths.js";

let sequence = 0;
const writes = new Map<string, Promise<void>>();

/** The daemon and foreground publish the same data-only prompt cache. */
export async function writeShellStatus(
  paths: PrefaixPaths,
  shellId: string,
  text: string,
): Promise<void> {
  const { status } = shellRuntimeFiles(paths, shellId);
  const writing = (writes.get(status) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => writeStatus(paths, shellId, text));
  writes.set(status, writing);
  const clear = () => {
    if (writes.get(status) === writing) writes.delete(status);
  };
  void writing.then(clear, clear);
  return writing;
}

async function writeStatus(
  paths: PrefaixPaths,
  shellId: string,
  text: string,
): Promise<void> {
  const { mkdir, rename, unlink, writeFile } = await import("node:fs/promises");
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
