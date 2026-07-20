// src/execution/stdin-writer.ts
//
// 向 rpc 子进程 stdin 写入命令的 helper 集合。
//
// pi --mode rpc 通过 stdin 的 JSON RpcCommand / RpcExtensionUIResponse 驱动：
//   - extension_ui_response（主进程回答子进程的 UI 请求，如 ask_user）
//   - prompt（驱动子进程开始处理 task）
//   - get_state（握手期查询子进程 session 状态）
//
// 三者共用 ChildRpcChannel.write（自动补换行 + 通道存活判断 + 写入降级），
// 提取到此模块统一维护协议形状与序列化逻辑。ChildRpcChannel 由调用方（session-runner）
// 构造并传入，是 stdin 写入维度的单一真相源（详见 rpc-channel.ts）。

import * as crypto from "node:crypto";

import type { UiResponse } from "./dialog-queue.ts";
import type { ChildRpcChannel } from "./rpc-channel.ts";

/**
 * 按 UiResponse 形状构造 Pi 原生 extension_ui_response 并写 stdin。
 *
 * SR-5：ack（fire-and-forget）不写 stdin——Pi 对 fire-and-forget method 不期待响应，
 * 写入会触发协议错配。其他三种 shape（value/confirmed/cancelled）按对应字段写。
 *
 * [R2] 序列化在本函数内逐分支完成。JSON.stringify 可能抛错（out.value 含循环引用 /
 *     BigInt 等不可序列化结构），try/catch 降级为 cancelled——宁可取消单次 dialog 也不让
 *     父进程崩溃（UI 请求通道不应被脏数据拖垮）。
 *
 * 写入失败（通道已断/EPIPE）由 channel.write 返回 false 静默处理，不再抛错。
 *
 * @param channel RPC 写入通道（封装 child.stdin 写入 + 存活判断）
 * @param id 请求 id（关联 response）
 * @param out UiResponse（{value}/{confirmed}/{cancelled}/{ack}）
 * @param signal abort signal（已 aborted 时跳过写入）
 */
export function respond(
  channel: ChildRpcChannel,
  id: string,
  out: UiResponse,
  signal?: AbortSignal,
): void {
  if (signal?.aborted) return;
  let line: string | undefined;
  try {
    if ("value" in out) line = JSON.stringify({ type: "extension_ui_response", id, value: out.value });
    else if ("confirmed" in out) line = JSON.stringify({ type: "extension_ui_response", id, confirmed: out.confirmed });
    else if ("cancelled" in out) line = JSON.stringify({ type: "extension_ui_response", id, cancelled: true });
  } catch (err) {
    // [R2] out.value 含循环引用/BigInt 等不可序列化结构——降级 cancelled，避免父进程崩溃。
    console.warn(`[subagents] JSON.stringify failed for ui response ${id}, degrading to cancelled:`, err);
    line = JSON.stringify({ type: "extension_ui_response", id, cancelled: true });
  }
  // ack: fire-and-forget，不写 stdin（SR-5）
  if (line === undefined) return;
  channel.write(line);
}

/**
 * spawn 后向 rpc 子进程 stdin 写 prompt 命令，驱动 agent 开始处理 task。
 *
 * pi 的 runRpcMode 只通过 stdin RpcCommand 驱动——positional task arg / -p flag
 * 在 rpc mode 下被 resolveAppMode 无视。必须在 spawn 后主动喂 prompt 命令，
 * 否则子进程阻塞等 stdin、永不进入推理（totalTokens 恒 0）。
 *
 * 时机：spawn 后立即写。stdin 是 pipe，内核缓冲保证数据不丢；
 * pi 在 await rebindSession() 后才挂 stdin reader（rpc-mode.ts:778-781），
 * reader 处理 prompt 时 session 已就绪。
 *
 * 通道已断/写失败由 channel.write 静默处理（返回 false），不抛错。
 *
 * @param channel RPC 写入通道（封装 child.stdin 写入 + 存活判断）
 * @param task 完整 task 文本（含 schema 指令）
 */
export function sendPromptCommand(channel: ChildRpcChannel, task: string): void {
  const command = JSON.stringify({
    id: crypto.randomUUID(),
    type: "prompt",
    message: task,
  });
  channel.write(command);
}

/**
 * 向 rpc 子进程 stdin 写 get_state 命令，查询 sessionFile/sessionId。
 *
 * FR-4: RPC get_state 握手。当 stdout header 未携带 sessionFile 时，
 * 通过此命令向子进程查询当前 session 状态。子进程收到后返回
 * {type:"response", command:"get_state", success:true, data:{sessionFile, sessionId}}。
 *
 * 通道已断/写失败由 channel.write 静默处理（返回 false），不抛错。调用方仍拿到 id
 * 用于匹配 response（即使写入失败，response 永不到达，由握手超时兜底）。
 *
 * @param channel RPC 写入通道（封装 child.stdin 写入 + 存活判断）
 * @returns 请求 id（用于匹配 response）
 */
export function sendGetStateCommand(channel: ChildRpcChannel): string {
  const id = crypto.randomUUID();
  const command = JSON.stringify({
    id,
    type: "get_state",
  });
  channel.write(command);
  return id;
}
