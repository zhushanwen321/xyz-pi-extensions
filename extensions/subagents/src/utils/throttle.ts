// src/utils/throttle.ts
//
// 节流器：用于 subagent streaming 期间降低 onChange → requestRender 频率，
// 缓解 Pi 差分渲染引擎在高频重渲 + 多行 input 下的行号漂移（拖影）。
//
// 设计：leading + trailing edge。
//   - leading：节流窗口内的首次调用立即执行（保证响应性）。
//   - trailing：窗口内若有后续调用，窗口结束时补执行最后一次（保证最终态同步）。
//   - flush()：强制立即执行 pending 的 trailing 调用——dispose / 完成 / 失败 / 取消路径
//     必须调用，确保最终状态一定渲染，不被节流吞掉。
//
// 对照 dev guide §ba1c80327 P1b（background onEvent 每 token 触发 requestRender →
// 节流到固定刷新率）、§8160a5d13（streaming delta 触发 onUpdate → viewport snap-back）。

/** 节流后的调用句柄，附带 flush 强制同步。 */
export interface ThrottledFunction<A extends unknown[]> {
  (...args: A): void;
  /** 立即执行 pending 的 trailing 调用（若有）。dispose / 终态路径必须调用。 */
  flush(): void;
}

/** 默认节流窗口（ms）。≈6/s，实测 streaming event 远高于此间隔。 */
const DEFAULT_INTERVAL_MS = 150;

/**
 * 创建 leading + trailing 节流器。
 *
 * @param fn       被节流的函数
 * @param interval 节流窗口（ms），默认 DEFAULT_INTERVAL_MS
 */
export function createThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  interval = DEFAULT_INTERVAL_MS,
): ThrottledFunction<A> {
  let lastInvoke = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let trailingArgs: A | undefined;

  const invoke = (args: A): void => {
    lastInvoke = Date.now();
    trailingArgs = undefined;
    fn(...args);
  };

  const throttled = (...args: A): void => {
    trailingArgs = args;
    const now = Date.now();
    const remaining = interval - (now - lastInvoke);
    if (remaining <= 0) {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      invoke(args);
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (trailingArgs) invoke(trailingArgs);
    }, remaining);
  };

  throttled.flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (trailingArgs) {
      invoke(trailingArgs);
    }
  };

  return throttled;
}
