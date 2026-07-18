// src/execution/channel-registry-access.ts
//
// Channel registry 的访问入口（本扩展内部用 + 契约文档化导出）。
//
// ask-user 等扩展通过本模块注册 channel handler，让 subagent 子进程的 UI 请求
// 能透传到主进程渲染。与 index.ts 的 getOrCreateChannelRegistry 共享同一
// globalThis[Symbol.for] 单例——无论从哪个模块访问，拿到的是同一个 registry 实例。
//
// 设计说明（契约文档化）：本模块导出 getOrCreateChannelRegistry / UiChannelRegistry /
// ChannelHandler 是契约文档化目的——声明 registry 的公开形状。跨扩展实际握手并不
// import 本模块，而是各自直接读写
// globalThis[Symbol.for("@zhushanwen/pi-subagents.channelRegistry")]，拿到结构兼容
// 本接口形状（UiChannelRegistry）的同一实例。Symbol.for 跨 jiti 多实例共享是握手能
// 成立的根本机制；本导出仅用于类型契约与单扩展内部调用，不保证被跨包 import。

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
