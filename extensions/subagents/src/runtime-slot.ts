// 进程内单例：用 globalThis 持有，避免 jiti 因路径字符串不同加载多份模块导致单例分裂。
// 场景：workflow 扩展 import "@zhushanwen/pi-subagents" 与 subagents 扩展被 pi 直接加载，
// 若 jiti 缓存 key 用路径字符串（非 realpath），两份 runtime.ts 各持一个 _runtimeSlot，
// setRuntime 写 A、getRuntime 读 B(null)。globalThis 跨所有模块实例共享，彻底消除该问题。
//
// 从 runtime.ts 拆出（避免 runtime.ts 超 1000 行上限；与 persistence/bg-notifier.ts 同模式）。
// runtime.ts 通过 `export { setRuntime, getRuntime } from "./runtime-slot.ts"` 保持公共 API 不变。

import type { SubagentRuntime } from "./runtime.ts";

const RUNTIME_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.runtime");

type RuntimeSlot = { current?: SubagentRuntime };

function getSlot(): RuntimeSlot {
  if (!(globalThis as Record<symbol, unknown>)[RUNTIME_SLOT_KEY]) {
    (globalThis as Record<symbol, unknown>)[RUNTIME_SLOT_KEY] = { current: undefined };
  }
  return (globalThis as Record<symbol, RuntimeSlot>)[RUNTIME_SLOT_KEY];
}

export function setRuntime(rt: SubagentRuntime): void {
  getSlot().current = rt;
}

export function getRuntime(): SubagentRuntime | undefined {
  return getSlot().current;
}
