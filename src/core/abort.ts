// Aborting is a race, not a poll. A turn has to end promptly on Esc even when
// the backend has gone quiet, and a shutdown has to stop waiting on a promise
// nothing will settle.

/** Resolves when the signal aborts, or immediately if it already has. */
export function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export const ABORTED: unique symbol = Symbol("aborted");

/**
 * Races an operation against an abort. Returns `ABORTED` rather than throwing,
 * because an abort is a normal end for a turn and not a failure.
 */
export async function raceAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED> {
  const aborted: Promise<typeof ABORTED> = whenAborted(signal).then(
    () => ABORTED,
  );
  return Promise.race([operation, aborted]);
}
