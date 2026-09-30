import { describe, expect, it } from "vitest";
import { EventRing, TurnManager } from "../../src/daemon/turns.js";
import { PrefaixError } from "../../src/core/errors.js";
import type { AgentEvent } from "../../src/core/agent-port.js";

/** A valid conversation id, since the store and the pool key on the shape. */
function cid(n: number): string {
  return `c_0${String(n).padStart(25, "0")}`;
}

const delta = (text: string): AgentEvent => ({
  type: "text_delta",
  block: 0,
  text,
});

const SETTLED: AgentEvent = { type: "settled", stopReason: "stop" };

describe("the event ring", () => {
  it("numbers events from one, in order", () => {
    const ring = new EventRing();
    expect(ring.push(delta("a")).seq).toBe(1);
    expect(ring.push(delta("b")).seq).toBe(2);
    expect(ring.size).toBe(2);
    expect(ring.nextSeq).toBe(3);
  });

  it("replays from a sequence, inclusive", () => {
    const ring = new EventRing();
    for (const text of ["a", "b", "c"]) {
      ring.push(delta(text));
    }
    expect(ring.since(2).map((entry) => entry.event)).toEqual([
      delta("b"),
      delta("c"),
    ]);
    expect(ring.since(9)).toEqual([]);
  });

  it("drops the oldest entries once it is over its byte limit", () => {
    const ring = new EventRing(200);
    for (let at = 0; at < 40; at++) {
      ring.push(delta(`chunk-${String(at)}`));
    }
    expect(ring.size).toBeLessThan(40);
    // The oldest sequence still held is reported, so a client asking to replay
    // from further back can be told where to start instead of being handed a
    // stream with a hole in it.
    expect(ring.oldestSeq).toBeGreaterThan(1);
    expect(ring.since(1)[0]?.seq).toBe(ring.oldestSeq);
  });

  it("keeps the newest entry even when it alone is over the limit", () => {
    const ring = new EventRing(1);
    ring.push(delta("a"));
    ring.push(delta("b"));
    expect(ring.size).toBe(1);
    expect(ring.since(1)[0]?.event).toEqual(delta("b"));
  });

  it("finds the settle however far back it rolled", () => {
    const ring = new EventRing(200);
    ring.push(delta("a"));
    ring.push(SETTLED);
    for (let at = 0; at < 20; at++) {
      ring.push(delta(`after-${String(at)}`));
    }
    expect(ring.settled()?.event).toEqual(SETTLED);
    expect(ring.settledSeq).toBe(2);
  });

  it("has no settle while a turn is still running", () => {
    const ring = new EventRing();
    ring.push(delta("a"));
    expect(ring.settled()).toBeUndefined();
    expect(ring.oldestSeq).toBe(1);
  });
});

describe("the turn manager", () => {
  const options = { conversationId: cid(0), shellId: "1-1-a" };

  it("starts a turn with a signal and a ring", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    expect(turn.id).toMatch(/^t_/);
    expect(turn.owner).toBe("attached");
    expect(turn.finished).toBe(false);
    expect(turn.controller.signal.aborted).toBe(false);
    expect(manager.count).toBe(1);
    expect(manager.runningFor(options.conversationId)).toBe(turn);
  });

  it("refuses a second turn on the same conversation", () => {
    const manager = new TurnManager();
    manager.start(options);
    expect(() => manager.start(options)).toThrow(PrefaixError);
    try {
      manager.start(options);
    } catch (error) {
      expect((error as PrefaixError).code).toBe("CONVERSATION_BUSY");
    }
  });

  it("lets the conversation go once the turn finishes", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    manager.finish(turn, { turnId: turn.id, status: "stop" });
    expect(manager.count).toBe(0);
    expect(manager.start(options).id).not.toBe(turn.id);
  });

  it("ignores a second finish for the same turn", () => {
    const finished: string[] = [];
    const manager = new TurnManager({
      onFinish: (turn) => {
        finished.push(turn.id);
      },
    });
    const turn = manager.start(options);
    manager.finish(turn, { turnId: turn.id, status: "stop" });
    manager.finish(turn, { turnId: turn.id, status: "error" });
    expect(finished).toEqual([turn.id]);
    expect(turn.summary?.status).toBe("stop");
  });

  it("reports the disconnect policy in the refusal hint", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    turn.owner = "detached";
    try {
      manager.start(options);
      expect.unreachable();
    } catch (error) {
      expect((error as PrefaixError).hint).toContain(":attach");
    }
  });

  it("accumulates captured typeahead into one buffer", () => {
    const captured: string[] = [];
    const manager = new TurnManager({
      onBuffer: (_turn, text) => captured.push(text),
    });
    const turn = manager.start(options);
    manager.addBuffer(turn, "git status");
    manager.addBuffer(turn, "--short");
    manager.addBuffer(turn, "");
    expect(turn.buffer).toBe("git status --short");
    expect(captured).toEqual(["git status", "--short"]);
  });

  it("aborts on request", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    manager.abort(turn);
    expect(turn.controller.signal.aborted).toBe(true);
  });

  it("forgets a turn it no longer needs", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    expect(manager.forget(turn.id)).toBe(true);
    expect(manager.forget(turn.id)).toBe(false);
    expect(manager.get(turn.id)).toBeUndefined();
  });
});

describe("what happens when the client goes away", () => {
  const options = { conversationId: cid(0), shellId: "1-1-a" };

  it("aborts the turn by default, which is the least surprise", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    expect(manager.release(turn, "close")).toBe(true);
    expect(turn.controller.signal.aborted).toBe(true);
    // Requesting abort does not finish the stream or its durable outcome.
    expect(manager.count).toBe(1);
    manager.finish(turn, { turnId: turn.id, status: "aborted" });
    expect(manager.count).toBe(0);
  });

  it("leaves the turn running when the turn asked to continue", () => {
    const manager = new TurnManager();
    const turn = manager.start({ ...options, onDisconnect: "continue" });
    expect(manager.release(turn, "close")).toBe(false);
    expect(turn.controller.signal.aborted).toBe(false);
    expect(turn.owner).toBe("detached");
  });

  it("leaves a detached turn alone", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    expect(manager.release(turn, "detach")).toBe(false);
    expect(turn.owner).toBe("detached");
    expect(turn.controller.signal.aborted).toBe(false);
  });

  it("does nothing to a turn that already finished", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    manager.finish(turn, { turnId: turn.id, status: "stop" });
    expect(manager.release(turn, "close")).toBe(false);
  });
});

describe("dialog answers", () => {
  const options = { conversationId: cid(0), shellId: "1-1-a" };

  it("accepts an answer to a dialog the turn asked for", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    manager.openDialog(turn, "u1");
    expect(manager.checkUiRespond(turn.id, "u1")).toBe(turn);
    expect(turn.answered.has("u1")).toBe(true);
  });

  it("refuses an answer to a dialog it never asked about", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    try {
      manager.checkUiRespond(turn.id, "u-nope");
      expect.unreachable();
    } catch (error) {
      expect((error as PrefaixError).code).toBe("USAGE");
    }
  });

  it("says a turn it does not hold is no longer running", () => {
    const manager = new TurnManager();
    try {
      manager.checkUiRespond("t_01J0000000000000000000000", "u1");
      expect.unreachable();
    } catch (error) {
      const failure = error as PrefaixError;
      expect(failure.message).toContain("is no longer running");
      expect(failure.hint).toContain("dialog has already closed");
    }
  });

  it("refuses an answer to a turn that has already finished", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    manager.openDialog(turn, "u1");
    manager.finish(turn, { turnId: turn.id, status: "stop" });
    expect(() => manager.checkUiRespond(turn.id, "u1")).toThrow(
      /no longer running/,
    );
  });

  it("drops a dialog from the open set once it has been answered", () => {
    const manager = new TurnManager();
    const turn = manager.start(options);
    manager.openDialog(turn, "u1");
    manager.closeDialog(turn, "u1");
    expect(turn.dialogs.size).toBe(0);
  });
});
