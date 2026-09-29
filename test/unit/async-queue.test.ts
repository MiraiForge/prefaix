import { describe, expect, it } from "vitest";
import { createQueue } from "../../src/core/async-queue.js";

describe("async queue", () => {
  it("delivers values pushed before anyone waits", async () => {
    const queue = createQueue<number>();
    queue.push(1);
    queue.push(2);
    const seen: number[] = [];
    for await (const value of queue) {
      seen.push(value);
      if (seen.length === 2) {
        break;
      }
    }
    expect(seen).toEqual([1, 2]);
  });

  it("delivers a value pushed after a consumer is waiting", async () => {
    const queue = createQueue<string>();
    const next = queue[Symbol.asyncIterator]().next();
    queue.push("late");
    await expect(next).resolves.toEqual({ value: "late", done: false });
  });

  it("reports its size and whether it is closed", () => {
    const queue = createQueue<number>();
    expect(queue.size).toBe(0);
    expect(queue.closed).toBe(false);
    queue.push(1);
    expect(queue.size).toBe(1);
    queue.close();
    expect(queue.closed).toBe(true);
  });

  it("ends iteration after the buffer drains when closed", async () => {
    const queue = createQueue<number>();
    queue.push(1);
    queue.close();
    const seen: number[] = [];
    for await (const value of queue) {
      seen.push(value);
    }
    expect(seen).toEqual([1]);
  });

  it("ends iteration for a consumer already waiting when closed", async () => {
    const queue = createQueue<number>();
    const next = queue[Symbol.asyncIterator]().next();
    queue.close();
    await expect(next).resolves.toEqual({ value: undefined, done: true });
  });

  it("throws for a consumer already waiting when failed", async () => {
    const queue = createQueue<number>();
    const next = queue[Symbol.asyncIterator]().next();
    queue.fail(new Error("upstream died"));
    await expect(next).rejects.toThrow("upstream died");
  });

  it("delivers the buffer first, then throws", async () => {
    const queue = createQueue<number>();
    queue.push(1);
    queue.fail(new Error("upstream died"));
    const seen: number[] = [];
    let caught: unknown;
    try {
      for await (const value of queue) {
        seen.push(value);
      }
    } catch (error) {
      caught = error;
    }
    expect(seen).toEqual([1]);
    expect(caught).toBeInstanceOf(Error);
  });

  it("ignores a push after close, so a late writer cannot resurrect it", async () => {
    const queue = createQueue<number>();
    queue.close();
    queue.push(9);
    expect(queue.size).toBe(0);
    const seen: number[] = [];
    for await (const value of queue) {
      seen.push(value);
    }
    expect(seen).toEqual([]);
  });

  it("ignores a push after fail", () => {
    const queue = createQueue<number>();
    queue.fail(new Error("x"));
    queue.push(1);
    expect(queue.size).toBe(0);
  });

  it("keeps the first close and the first fail", async () => {
    const queue = createQueue<number>();
    queue.fail(new Error("first"));
    queue.fail(new Error("second"));
    queue.close();
    await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow("first");
  });

  it("ends iteration when the consumer returns early, and drops the buffer", async () => {
    const queue = createQueue<number>();
    queue.push(1);
    queue.push(2);
    const iterator = queue[Symbol.asyncIterator]();
    await iterator.next();
    await expect(iterator.return?.()).resolves.toEqual({
      value: undefined,
      done: true,
    });
    expect(queue.size).toBe(0);
  });
});
