import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function executable(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  for (const directory of (env["PATH"] ?? "").split(delimiter)) {
    if (directory === "") continue;
    const path = join(directory, name);
    try {
      accessSync(path, constants.X_OK);
      return path;
    } catch {
      /* Try the next PATH entry. */
    }
  }
  return undefined;
}

/** Terminal controls are never data in picker labels or shell prompt hints. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex -- terminal controls are the forbidden data here.
  return text.replaceAll(/[\u0000-\u001f\u007f-\u009f]/gu, " ");
}
