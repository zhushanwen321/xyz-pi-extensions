// src/execution/channel-registry-access.ts
//
// Channel registry 的公开访问入口（跨扩展 API）。
//
// ask-user 等扩展通过本模块注册 channel handler，让 subagent 子进程的 UI 请求
// 能透传到主进程渲染。与 index.ts 的 getOrCreateChannelRegistry 共享同一
// globalThis[Symbol.for] 单例——无论从哪个模块访问，拿到的是同一个 registry 实例。
//
// 设计：本模块是 stable public API。内部实现（UiChannelRegistry 的存储结构）
// 可能演进，但 getOrCreateChannelRegistry + register/resolve/list 契约稳定。
// 跨扩展消费者（ask-user）只依赖本模块的导出，不依赖 index.ts 内部。

import { createUiChannelRegistry, type UiChannelRegistry, type ChannelHandler } from "./ui-channels.ts";

/** 进程级 channel registry 的 globalThis key（Symbol.for 跨模块共享）。
 *  与 index.ts 的 CHANNEL_REGISTRY_KEY 完全相同——两边用同一字符串确保拿到同一实例。 */
export const CHANNEL_REGISTRY_KEY = Symbol.for("@zhushanwen/pi-subagents.channelRegistry");

/** 获取或创建进程级 channel registry 单例。
 *
 *  跨扩展共享：subagent-workflow 的 index.ts session_start 和 ask-user 的
 *  session_start 都调本函数，拿到的是同一个 registry 实例（Symbol.for 保证）。
 *  扩展加载顺序无关——谁先执行谁创建，后执行者 Reflect.get 拿到已存在的实例。
 *
 *  @returns 进程级 UiChannelRegistry 单例（永不返回 undefined——不存在时自动创建）
 **/
export function getOrCreateChannelRegistry(): UiChannelRegistry {
  let registry = Reflect.get(globalThis, CHANNEL_REGISTRY_KEY) as UiChannelRegistry | undefined;
  if (!registry) {
    registry = createUiChannelRegistry();
    Reflect.set(globalThis, CHANNEL_REGISTRY_KEY, registry);
  }
  return registry;
}

export type { UiChannelRegistry, ChannelHandler };
