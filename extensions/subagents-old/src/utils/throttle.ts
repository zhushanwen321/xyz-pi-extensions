// src/utils/throttle.ts
//
// 节流器：用于 subagent streaming 期间降低 onUpdate → requestRender 频率，
// 缓解 pi-tui doRender 无条件底部锚定导致用户无法滚动的问题。
//
// 设计：leading + trailing edge。
//   - leading：节流窗口内的首次调用立即执行（保证响应性）。
//   - trailing：窗口内若有后续调用，窗口结束时补执行最后一次（保证最终态同步）。
//   - flush()：强制立即执行 pending 的 trailing 调用——完成/失败/取消路径必须调用，
//     确保最终 block 状态一定渲染，不被节流吞掉。
//
// 与现有"seed-frame + 容忍静默期 spinner 冻结"的设计取舍一致：
// 用更低的刷新频率换取滚动体验。interval 默认 150ms（≈6/s），实测 streaming event
// 远高于此间隔，可把 ~60/s 的 requestRender 压到 ~6/s。

/** 节流后的调用句柄，附带 flush 强制同步。 */
export interface ThrottledFunction<A extends unknown[]> {
  (...args: A): void;
  /** 立即执行 pending 的 trailing 调用（若有）。完成/失败/取消路径必须调用。 */
  flush(): void;
}

/**
 * 创建 leading + trailing 节流器。
 *
 * @param fn       被节流的函数
 * @param interval 节流窗口（ms），默认 150
 */
export function createThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  interval = 150,
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
