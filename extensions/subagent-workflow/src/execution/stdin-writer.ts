// src/execution/stdin-writer.ts
//
// 向 rpc 子进程 stdin 写入命令的 helper 集合。
//
// pi --mode rpc 通过 stdin 的 JSON RpcCommand / RpcExtensionUIResponse 驱动：
//   - extension_ui_response（主进程回答子进程的 UI 请求，如 ask_user）
//   - prompt（驱动子进程开始处理 task）
// 两者共用 child.stdin.write + 背压检查，提取到此模块统一维护。

import type { ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";

import type { UiResponse } from "./dialog-queue.ts";

/**
 * 按 UiResponse 形状构造 Pi 原生 extension_ui_response 并写 stdin。
 *
 * SR-5：ack（fire-and-forget）不写 stdin——Pi 对 fire-and-forget method 不期待响应，
 * 写入会触发协议错配。其他三种 shape（value/confirmed/cancelled）按对应字段写。
 *
 * [R1] 背压检查：child.stdin.write 返回 false 时记 warn（不阻塞，内核缓冲会随后排空）。
 * [R2] 序列化在本函数内逐分支完成。JSON.stringify 可能抛错（out.value 含循环引用 /
 *     BigInt 等不可序列化结构），try/catch 降级为 cancelled——宁可取消单次 dialog 也不让
 *     父进程崩溃（UI 请求通道不应被脏数据拖垮）。
 *
 * @param child 子进程（stdin 写入响应）
 * @param id 请求 id（关联 response）
 * @param out UiResponse（{value}/{confirmed}/{cancelled}/{ack}）
 * @param signal abort signal（已 aborted 时跳过写入）
 */
export function respond(child: ChildProcess, id: string, out: UiResponse, signal?: AbortSignal): void {
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
  writeStdinLine(child, line, `ui response for request ${id}`);
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
 * @param child 子进程（stdin 写入 prompt 命令）
 * @param task 完整 task 文本（含 schema 指令）
 */
export function sendPromptCommand(child: ChildProcess, task: string): void {
  if (!child.stdin || child.stdin.destroyed) return;
  const command = JSON.stringify({
    id: crypto.randomUUID(),
    type: "prompt",
    message: task,
  });
  writeStdinLine(child, command, "prompt command");
}

/**
 * 向 rpc 子进程 stdin 写 get_state 命令，查询 sessionFile/sessionId。
 *
 * FR-4: RPC get_state 握手。当 stdout header 未携带 sessionFile 时，
 * 通过此命令向子进程查询当前 session 状态。子进程收到后返回
 * {type:"response", command:"get_state", success:true, data:{sessionFile, sessionId}}。
 *
 * @param child 子进程（stdin 写入 get_state 命令）
 * @returns 请求 id（用于匹配 response）
 */
export function sendGetStateCommand(child: ChildProcess): string {
  const id = crypto.randomUUID();
  const command = JSON.stringify({
    id,
    type: "get_state",
  });
  writeStdinLine(child, command, "get_state command");
  return id;
}

/**
 * 向子进程 stdin 写一行（自动补换行），带背压检查。
 *
 * [R1] write 返回 false 时记 warn（不阻塞，内核缓冲会随后排空）。
 * stdin 已关闭/销毁时跳过——respond 已检查 signal，sendPromptCommand 已检查 destroyed。
 *
 * @param child 子进程
 * @param line JSON 行（不含换行）
 * @param warnTag warn 日志的语义标记
 */
function writeStdinLine(child: ChildProcess, line: string, warnTag: string): void {
  if (!child.stdin || child.stdin.destroyed) return;
  const ok = child.stdin.write(line + "\n");
  if (!ok) console.warn(`[subagents] stdin backpressure on ${warnTag}`);
}
