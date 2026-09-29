// A single-consumer async queue. The pi transport, the daemon socket, and the
// client connection all need "push from a callback, iterate in a loop, end
// cleanly" without pulling in a dependency or hand-rolling the same buffer in
// three places.

export interface AsyncQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  /** Iteration ends once the buffered values are drained. */
  close(): void;
  /** Iteration throws on the next step, after the buffered values. */
  fail(error: unknown): void;
  readonly closed: boolean;
  readonly size: number;
}

export function createQueue<T>(): AsyncQueue<T> {
  const buffered: T[] = [];
  // A parked consumer has to see a failure as a throw, not as a clean end, or
  // an upstream error is swallowed and the caller believes the stream finished.
  const waiting: {
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
  }[] = [];
  let state: "open" | "closed" | "failed" = "open";
  let failure: unknown;

  return {
    push(value: T): void {
      if (state !== "open") {
        return;
      }
      const next = waiting.shift();
      if (next === undefined) {
        buffered.push(value);
        return;
      }
      next.resolve({ value, done: false });
    },
    close(): void {
      if (state !== "open") {
        return;
      }
      state = "closed";
      for (const next of waiting.splice(0)) {
        next.resolve({ value: undefined, done: true });
      }
    },
    fail(error: unknown): void {
      if (state !== "open") {
        return;
      }
      state = "failed";
      failure = error;
      for (const next of waiting.splice(0)) {
        next.reject(error);
      }
    },
    get closed(): boolean {
      return state !== "open";
    },
    get size(): number {
      return buffered.length;
    },
    [Symbol.asyncIterator](): AsyncIterator<T> {
      return {
        next(): Promise<IteratorResult<T>> {
          const value = buffered.shift();
          if (value !== undefined) {
            return Promise.resolve({ value, done: false });
          }
          if (state === "failed") {
            return Promise.reject(failure);
          }
          if (state === "closed") {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<T>>((resolve, reject) => {
            waiting.push({ resolve, reject });
          });
        },
        return(): Promise<IteratorResult<T>> {
          buffered.length = 0;
          for (const next of waiting.splice(0)) {
            next.resolve({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
