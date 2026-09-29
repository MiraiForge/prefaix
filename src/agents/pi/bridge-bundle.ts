// Where the bundled bridge extension lives (DESIGN §4.5.4). The adapter is
// created in three shapes — from `dist/prefaix.js` in a normal install, from
// `src/` under a test runner, and from a one-file bundle — so the bundle is
// looked up next to this module and next to the repo's `dist`, and the caller
// degrades to the prepend fallback when neither exists.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const BRIDGE_BUNDLE_NAME = "pi-bridge.js";

/** Candidate locations, most specific first. */
export const BRIDGE_CANDIDATES: readonly string[] = [
  fileURLToPath(new URL(`./${BRIDGE_BUNDLE_NAME}`, import.meta.url)),
  fileURLToPath(
    new URL(`../../../dist/${BRIDGE_BUNDLE_NAME}`, import.meta.url),
  ),
];

export function resolveBridgeBundle(
  options: { readonly exists?: (file: string) => boolean } = {},
): string | undefined {
  const exists = options.exists ?? existsSync;
  return BRIDGE_CANDIDATES.find((file) => exists(file));
}
