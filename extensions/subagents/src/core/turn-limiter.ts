// src/core/turn-limiter.ts
//
// soft/hard turn 限制器。maxTurns 到达 → steer 提醒收尾；
// graceTurns 后仍不结束 → abort。

/** turn limiter 配置。 */
export interface TurnLimiterOptions {
  maxTurns: number;
  graceTurns: number;
  steer: (msg: string) => void;
  abort: () => void;
}

/**
 * soft/hard turn 限制。
 *
//   ╔══════════════════════════════════════════════════════════╗
//   ║  onTurnEnd(currentTurns):                                 ║
//   ║    if (currentTurns === maxTurns)       → steer("wrap up") ║
//   ║    if (currentTurns >= maxTurns + graceTurns) → abort()   ║
//   ╚══════════════════════════════════════════════════════════╝
 *
 * maxTurns=0 表示不限（直接 return）。
 */
export interface TurnLimiter {
  /** 每次 turn_end 调用。 */
  onTurnEnd(currentTurns: number): void;
}

/** 工厂函数。 */
export function createTurnLimiter(opts: TurnLimiterOptions): TurnLimiter {
  //  内部计数已 steer/abort 过的次数（避免重复 steer）
  void opts;
  throw new Error("not implemented");
}
