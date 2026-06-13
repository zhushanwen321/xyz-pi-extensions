// src/__tests__/turn-limiter.test.ts
import { describe, it, expect, vi } from "vitest";
import { createTurnLimiter } from "../core/turn-limiter.ts";

describe("createTurnLimiter", () => {
  it("does nothing before maxTurns", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 3, graceTurns: 2, steer, abort });
    limiter.onTurnEnd(1);
    limiter.onTurnEnd(2);
    expect(steer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("steers on maxTurns and aborts after graceTurns", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 3, graceTurns: 2, steer, abort });
    limiter.onTurnEnd(3); // 达到 maxTurns → steer
    expect(steer).toHaveBeenCalledWith("Wrap up your work now. Provide a final summary.");
    expect(abort).not.toHaveBeenCalled();
    limiter.onTurnEnd(4); // grace turn 1
    expect(abort).not.toHaveBeenCalled();
    limiter.onTurnEnd(5); // grace turn 2 → abort
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("disables when maxTurns is 0 or undefined", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 0, graceTurns: 2, steer, abort });
    limiter.onTurnEnd(100);
    expect(steer).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it("steers only once", () => {
    const steer = vi.fn();
    const abort = vi.fn();
    const limiter = createTurnLimiter({ maxTurns: 2, graceTurns: 3, steer, abort });
    limiter.onTurnEnd(2);
    limiter.onTurnEnd(3);
    expect(steer).toHaveBeenCalledTimes(1);
  });
});
