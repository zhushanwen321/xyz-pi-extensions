// src/core/turn-limiter.ts
const WRAP_UP_MESSAGE = [
  "You have reached your turn limit. Wrap up now:",
  "1. Summarize what you have completed (with evidence: file paths, command output).",
  "2. List what remains undone and why.",
  "3. State the single most important next step for whoever continues.",
  "Do NOT claim the task is complete if any part remains unfinished.",
].join(" ");

/**
 * FR-1.4: Soft turn limit + hard abort 状态机。
 * - turn 达到 maxTurns 时调用 steer(WRAP_UP_MESSAGE)
 * - 再经过 graceTurns 后调用 abort()
 * - maxTurns <= 0 时禁用
 */
export function createTurnLimiter(opts: {
  maxTurns: number;
  graceTurns: number;
  steer: (message: string) => void;
  abort: () => void;
}) {
  let steered = false;
  let aborted = false;
  const limit = opts.maxTurns > 0 ? opts.maxTurns : Infinity;
  const grace = opts.graceTurns > 0 ? opts.graceTurns : 0;

  function onTurnEnd(turn: number): void {
    if (aborted || !isFinite(limit)) return;
    if (!steered && turn >= limit) {
      steered = true;
      opts.steer(WRAP_UP_MESSAGE);
    }
    if (steered && turn >= limit + grace) {
      aborted = true;
      opts.abort();
    }
  }

  return { onTurnEnd, get didSteer() { return steered; }, get didAbort() { return aborted; } };
}
