// src/execution/ui-request-handler-factory.ts
//
// UI 请求 handler 工厂（透传 + 排队总控）。
//
// 按 ctx.mode（ExtensionMode）创建合适的 UiRequestHandler，让 SubagentService 持有后
// 经 session-runner 透传给子进程的 extension_ui_request。本模块是「handler 注入链路」的
// 组装点：把 channel registry（业务路由）+ dialog queue（L2 跨子进程串行）+ mode 分流
//（TUI/GUI/headless）粘合成一个 handler。
//
// 设计依据（.fix-plans/00-master-summary.md）：
//   - §一冲突 2「透传矩阵」：
//       TUI  dialog 透传 + L2 排队；fire-and-forget 不透传（回 ack，不影响 TUI 输入交互）
//       GUI  全透传；dialog 走 L2 排队，fire-and-forget 直接转发
//       headless  不注入（返回 undefined）
//   - §一冲突 3「L2 队列接入点」：dialog 类进 dialogQueue.enqueue 串行
//   - §二 2.7「handler 工厂 + 透传/排队总控」：createUiRequestHandlerForMode 完整实现
//
// SR-3：调用方（index.ts session_start）无论 new 还是 existing SubagentService 都必须调
//   setUiRequestHandler——/resume /fork 复用 existingService 时旧 handler 可能已失效。

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import { DialogGlobalQueue, type UiRequest, type UiRequestHandler, type UiResponse } from "./dialog-queue.ts";
import { type HostMode, resolveHostMode } from "./host-mode.ts";
import type { UiChannelRegistry } from "./ui-channels.ts";
import { isDialogMethod } from "./ui-interaction-model.ts";

/** 按 ctx.mode 创建 UI 请求 handler（透传 + 排队总控）。
 *
 *  透传矩阵（§一冲突 2）：
 *    - headless（json/print/undefined）：返回 undefined（不注入任何 UI handler）
 *    - TUI：dialog 透传 + L2 排队；fire-and-forget 回 ack 不透传（不影响 TUI 输入交互）
 *    - GUI（rpc）：全透传；dialog 走 L2 排队，fire-and-forget 直接转发
 *
 *  业务路由（§一冲突 2 维度 2）：
 *    - channel 命中 registry（ask_user/gui_widget）→ 走注册的 channel handler
 *    - 无 channel 的 dialog → defaultDialogForward（调主 agent ctx.ui.select/confirm/...）
 *
 *  SR-3：调用方（index.ts session_start）无论 new 还是 existing SubagentService 都必须调
 *  setUiRequestHandler。headless 下本函数返回 undefined，调用方应据此走不注入路径。
 *
 *  @param ctx Pi ExtensionContext（读 ctx.mode 分流）
 *  @param registry channel 注册表（业务路由；W3 当前为空，ask-user 扩展 Stage 4a 注册）
 *  @param dialogQueue L2 跨子进程全局 dialog 串行队列
 *  @returns UiRequestHandler（tui/gui）；headless 返回 undefined */
export function createUiRequestHandlerForMode(
  ctx: ExtensionContext,
  registry: UiChannelRegistry,
  dialogQueue: DialogGlobalQueue,
): UiRequestHandler | undefined {
  const hostMode = resolveHostMode(ctx.mode);
  if (hostMode === "headless") return undefined;

  const realHandler = createRealHandler(ctx, hostMode, registry);

  return async (req: UiRequest): Promise<UiResponse> => {
    // 维度 1：TUI 下 fire-and-forget 不透传（回 ack，不写 stdin——由 session-runner respond 处理）
    if (hostMode === "tui" && !isDialogMethod(req.method)) {
      return { ack: true };
    }
    // L2 全局队列：dialog 类必须串行（争输入焦点）。fire-and-forget（GUI 下）直接转发。
    // [SR-4] 透传 req._childPid（session-runner 从 child.pid 填入）给 enqueue——
    //   L2 据此关联 child close 时的 rejectChildDialogs 批量 reject（防全局死锁）。
    if (isDialogMethod(req.method)) {
      return dialogQueue.enqueue(req, realHandler, {
        child: req._childPid !== undefined ? { pid: req._childPid } : undefined,
      });
    }
    // GUI 下 fire-and-forget 直接转发
    return realHandler(req);
  };
}

/** 创建实际处理请求的 handler（channel 路由 + 默认转发）。
 *  - channel 命中 registry（ask_user）→ channel handler（结果经 coerceUiResponse 形变）
 *  - 无 channel 的 dialog → defaultDialogForward（主 agent ctx.ui.*） */
function createRealHandler(
  ctx: ExtensionContext,
  _hostMode: HostMode,
  registry: UiChannelRegistry,
): UiRequestHandler {
  return async (req: UiRequest): Promise<UiResponse> => {
    // 维度 2：channel 业务路由。channel handler 签名是 (unknown)=>Promise<unknown>
    //（ui-channels.ts 定义，避免循环依赖），此处经 coerceUiResponse 形变为 UiResponse。
    const channelHandler = registry.resolve(req.channel ?? "");
    if (channelHandler) {
      const raw = await channelHandler(req);
      return coerceUiResponse(raw, req.id);
    }

    // 无 channel 的 dialog → 默认转发到主 agent ctx.ui.*
    return defaultDialogForward(req, ctx);
  };
}

/** channel handler 返回值（unknown）形变为 UiResponse。
 *  channel handler 由扩展注册（如 ask-user 扩展返回 {value}/{confirmed}/{cancelled}），
 *  但 ChannelHandler 类型签名用 unknown（协议层避免循环依赖）。本函数做运行时收窄：
 *    - 已是合法 UiResponse shape → 原样返回
 *    - 形状不匹配 → 降级 {cancelled:true}（保守，不阻塞队列） */
function coerceUiResponse(raw: unknown, reqId: string): UiResponse {
  if (typeof raw !== "object" || raw === null) {
    console.warn("[subagents] channel handler returned non-object, coercing to cancelled (req=", reqId, ")");
    return { cancelled: true };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.value === "string") return { value: obj.value };
  if (typeof obj.confirmed === "boolean") return { confirmed: obj.confirmed };
  if (obj.cancelled === true) return { cancelled: true };
  if (obj.ack === true) return { ack: true };
  console.warn("[subagents] channel handler returned unrecognized shape, coercing to cancelled (req=", reqId, ")");
  return { cancelled: true };
}

/** 无 channel 的 dialog 默认转发：调主 agent 的 ctx.ui.select/confirm/input/editor。
 *  ask_user channel 未注册时（ask-user 扩展未安装）也会落到这里——
 *  select 请求转发为普通 select（title 可能含 marker，主 agent 会忽略或当普通 select 渲染）。
 *
 *  实现依据（SDK ExtensionUIContext 真实签名，read from
 *  @mariozechner/pi-coding-agent dist/core/extensions/types.d.ts）：
 *    select(title: string, options: string[], opts?): Promise<string | undefined>
 *    confirm(title: string, message: string, opts?): Promise<boolean>
 *    input(title: string, placeholder?: string, opts?): Promise<string | undefined>
 *    editor(title: string, prefill?: string): Promise<string | undefined>
 *  注意：SDK 是位置参数（非对象参数）；返回 undefined 表示用户取消。
 *
 *  Stage 4 风险点：TUI 下 ask_user channel 未注册时，select 会以普通列表渲染
 *  （title 可能含 marker）。channel 注册后由 createRealHandler 优先走 channel handler，
 *  不进这里。editor 不可用/抛错时降级 cancelled + warn，不卡队列。 */
async function defaultDialogForward(
  req: UiRequest,
  ctx: ExtensionContext,
): Promise<UiResponse> {
  const ui = ctx.ui;
  switch (req.method) {
    case "select": {
      const selected = await ui.select(req.title ?? "", req.options ?? []);
      return selected === undefined ? { cancelled: true } : { value: selected };
    }
    case "confirm": {
      // SDK confirm 必传 message（req.message 缺失时降级空串，不报错阻塞）
      const confirmed = await ui.confirm(req.title ?? "", req.message ?? "");
      return { confirmed };
    }
    case "input": {
      const text = await ui.input(req.title ?? "", req.placeholder);
      return text === undefined ? { cancelled: true } : { value: text };
    }
    case "editor": {
      // SDK editor 必填，但部分 host 运行时未实现——try/catch 降级 cancelled + warn（不卡队列）。
      // 不用 typeof 守卫：editor 在类型上必填，typeof 检查会被 TS2367 拒（条件永假）。
      try {
        const text = await ui.editor(req.title ?? "", req.prefill);
        return text === undefined ? { cancelled: true } : { value: text };
      } catch (err) {
        console.warn(
          "[subagents] ctx.ui.editor unavailable/threw, returning cancelled for",
          req.id,
          err,
        );
        return { cancelled: true };
      }
    }
    default: {
      // 未知 dialog method（非 select/confirm/input/editor）——保守 cancelled 不阻塞子进程
      console.warn(
        "[subagents] defaultDialogForward: unknown dialog method",
        req.method,
        "for",
        req.id,
      );
      return { cancelled: true };
    }
  }
}
