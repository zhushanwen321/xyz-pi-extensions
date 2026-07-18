// src/execution/ui-request-queue.ts
//
// W3/W2: 子进程 extension_ui_request 的 FIFO 串行队列 + 转发处理。
//
// 从 session-runner.ts 提取（保持文件 < 1000 行）。职责单一：
//   - createUiRequestQueue：每个子进程一个队列，保证多个 UI 请求（ask_user 等）
//     FIFO 串行处理，防止并发询问用户导致交错。
//   - handleUiRequest：从 ExtensionUiRequest 构造 UiRequest → 调主 agent uiRequestHandler
//     → 按 UiResponse 形状回写 stdin。
//   - extractMethodFields：method-specific 字段类型安全复制。
//
// session-runner.runSpawn 在 stdout pump 中拿到 extension_ui_request 后调 enqueue 入队。

import type { ChildProcess } from "node:child_process";

import type { UiRequest } from "./dialog-queue.ts";
// 类型再导出：dialog-queue.ts 是 UiRequest/UiResponse/UiRequestHandler 的规范来源，
// 本模块再导出供测试 import（避免测试直接依赖 dialog-queue 内部实现）。
export type { UiRequest, UiRequestHandler, UiResponse } from "./dialog-queue.ts";
import { respond } from "./stdin-writer.ts";
import type { ExtensionUiRequest } from "./spawn-event-adapter.ts";
import type { SessionRunnerContext } from "./session-runner.ts";
import { parseChannel } from "./ui-channels.ts";

/**
 * 创建 UI 请求队列。返回 enqueue 函数，调用方将 extension_ui_request 入队。
 *
 * 多个 extension_ui_request 并发到达时，队列保证 FIFO 串行处理：
 * 前一个请求的 uiRequestHandler resolve 后，才将下一个请求发给主 agent UI。
 * 防止并发询问用户导致交错（用户同时看到多个问题）。
 *
 * 设计：队列是 runSpawn 生命周期内的闭包状态（非模块级），
 * 每个子进程实例独立队列，无跨 session 泄漏。
 *
 * @param child 子进程（stdin 写入 extension_ui_response）
 * @param ctx SessionRunnerContext（含 uiRequestHandler 回调）
 * @returns enqueue 函数：(id, request) => void，将请求入队并触发顺序处理
 */
export function createUiRequestQueue(
  child: ChildProcess,
  ctx: SessionRunnerContext,
): (id: string, request: ExtensionUiRequest) => void {
  // [R3] AbortController 取消 pending handler——子进程退出时队列不再阻塞
  const abortController = new AbortController();
  const queue: Array<{ id: string; request: ExtensionUiRequest; signal: AbortSignal }> = [];
  let processing = false;
  let closed = false;

  function processNext(): void {
    if (processing || queue.length === 0 || closed) return;
    processing = true;
    const { id, request, signal } = queue.shift()!;
    handleUiRequest(child, id, request, ctx, signal).finally(() => {
      processing = false;
      processNext();
    });
  }

  // [R3] 子进程退出时 abort 所有 pending handler，队列不再阻塞
  // [SR-4] 同步清理 L2 队列中该 child 的 pending dialog——child 在 dialog 等 L2 时退出，
  //   L2 里该项永不 settle → processing 永远 true → 所有其他子进程 dialog 永久阻塞（全局死锁）。
  //   pid 缺省（spawn 后极短窗口 child.pid 可能为 undefined）时跳过——此时该 child 还未在 L2
  //   注册过任何 dialog（handleUiRequest 构造 UiRequest 时用同样的 child.pid，pid undefined 时
  //   不填 _childPid，rejectChildDialogs 也匹配不到），无清理必要。
  const onClose = (): void => {
    closed = true;
    abortController.abort();
    queue.length = 0;
    if (child.pid !== undefined) {
      ctx.dialogQueue?.rejectChildDialogs({ pid: child.pid });
    }
  };
  child.on("close", onClose);
  child.on("error", onClose);

  return function enqueue(id: string, request: ExtensionUiRequest): void {
    if (closed) return;
    queue.push({ id, request, signal: abortController.signal });
    processNext();
  };
}

/**
 * 处理子进程发来的 extension_ui_request（ask_user 及其他 Pi UI method）。
 *
 * 流程：从 ExtensionUiRequest 构造 UiRequest（含 channel/channelPayload）
 *  → 调用主 agent uiRequestHandler → 按 UiResponse 形状回写 stdin。
 *
 * handler 未设置时不再静默忽略——console.warn 兜底（FR-9 可观测性），
 * W3 接入 SubagentService.notifyMissingHandler 的 appendEntry。
 *
 * @param child 子进程（stdin 写入响应）
 * @param id 请求 id（子进程用它关联 response）
 * @param request ExtensionUiRequest（method 平铺，从 enqueueUiRequest 传入）
 * @param ctx SessionRunnerContext（含 uiRequestHandler 回调）
 * @param signal abort signal（子进程退出时触发，取消正在等待的 handler）
 * @returns Promise（队列等待用：resolve 表示响应已写入 stdin 或已放弃）
 */
async function handleUiRequest(
  child: ChildProcess,
  id: string,
  request: ExtensionUiRequest,
  ctx: SessionRunnerContext,
  signal?: AbortSignal,
): Promise<void> {
  const handler = ctx.uiRequestHandler;
  if (!handler) {
    // 可观测性：handler 缺失不再静默（FR-9）
    // W2 阶段先 console.warn，W3 接入 SubagentService.notifyMissingHandler 的 appendEntry
    console.warn("[subagents] uiRequestHandler missing for request", id, "method:", request.method);
    return;
  }

  // 从 ExtensionUiRequest 构造 UiRequest（含 channel/channelPayload）
  const { channel, channelPayload } = parseChannel(request);
  // [SR-4] 填入 child.pid 作为内部元数据：L2 队列的 rejectChildDialogs 据此关联 child close
  //   清理。factory 层 enqueue 时读 req._childPid 传给 opts.child。pid undefined（spawn 后极短
  //   窗口）时不填——rejectChildDialogs 也匹配不到（onClose 同样用 child.pid 守卫），无副作用。
  const uiReq: UiRequest = {
    id,
    method: request.method,
    ...(child.pid !== undefined ? { _childPid: child.pid } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(channelPayload !== undefined ? { channelPayload } : {}),
    ...extractMethodFields(request),
  };

  try {
    const result = await handler(uiReq);
    // [R3] 子进程已退出，跳过写入
    if (signal?.aborted) return;
    respond(child, id, result, signal);
  } catch (err) {
    // [R3] 子进程已退出，跳过写入
    if (signal?.aborted) return;
    console.error("[subagents] uiRequestHandler threw:", err);
    respond(child, id, { cancelled: true }, signal);
  }
}

/** 从 ExtensionUiRequest 提取 method-specific 字段到 UiRequest（与 Pi rpc-types.ts 1:1）。
 *  按 method 变体类型安全地复制对应字段；缺失字段不复制（保持 UiRequest 可选）。 */
function extractMethodFields(req: ExtensionUiRequest): Partial<UiRequest> {
  const out: Partial<UiRequest> = {};
  if ("title" in req && typeof req.title === "string") out.title = req.title;
  if ("options" in req && Array.isArray(req.options)) out.options = req.options;
  if ("message" in req && typeof req.message === "string") out.message = req.message;
  if ("placeholder" in req && typeof req.placeholder === "string") out.placeholder = req.placeholder;
  if ("prefill" in req && typeof req.prefill === "string") out.prefill = req.prefill;
  if ("notifyType" in req && typeof req.notifyType === "string") out.notifyType = req.notifyType;
  if ("statusKey" in req && typeof req.statusKey === "string") out.statusKey = req.statusKey;
  if ("statusText" in req) out.statusText = req.statusText;
  if ("widgetKey" in req && typeof req.widgetKey === "string") out.widgetKey = req.widgetKey;
  if ("widgetLines" in req) out.widgetLines = req.widgetLines;
  if ("widgetPlacement" in req) out.widgetPlacement = req.widgetPlacement;
  if ("text" in req && typeof req.text === "string") out.text = req.text;
  if ("timeout" in req && typeof req.timeout === "number") out.timeout = req.timeout;
  return out;
}
