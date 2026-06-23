/**
 * Tool Error Handler Hook
 *
 * Logs tool execution errors for debugging. Can be extended to handle
 * specific error patterns with contextual recovery.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Subset of `ToolExecutionEndEvent` fields used by this hook.
 * Local interface because the SDK's full event type is not re-exported
 * by the CI ambient type stubs in `shared/types/mariozechner/index.d.ts`.
 *
 * `result` 形如 `{ content: Array<{ type: "text", text: string }>, isError: boolean }`
 * （Pi 框架在 tool execute throw 时塞入 error content）。SDK 事件结构里没有独立
 * errorMessage 字段——错误文本只能从 result.content 里取。
 */
interface ToolExecutionEndLikeEvent {
  isError: boolean;
  toolName: string;
  toolCallId: string;
  result?: unknown;
}

/** ExtensionContext 的最小子集，仅声明 unified-hooks 内部用到的 ui 字段。 */
export interface HookContext {
  // headless / RPC 会话 ctx.ui 可能为 undefined（TUI 未初始化）。
  ui?: {
    // type 必须用 SDK 字面量联合，否则非法值（如 "warn"）会被 Pi 降级为 info 静默丢失。
    notify(msg: string, type?: "info" | "warning" | "error"): void;
  };
}

/**
 * 从 tool 执行结果里提取错误文本。
 *
 * Pi 框架在 tool execute 抛错时，构造 `{ content: [{ type: "text", text }] }`
 * 塞进 result.content[0].text。不同 tool / 框架版本可能格式略有差异，这里防御性
 * 取多种结构，取不到就返回 undefined（调用方降级，不阻断）。
 */
function extractErrorText(result: unknown): string | undefined {
  // 常见结构：{ content: [{ type: "text", text: "..." }] }
  const contentArr = getContentArray(result);
  if (contentArr) {
    for (const item of contentArr) {
      const text = getStringProperty(item, "text");
      if (text) return text;
    }
  }

  // 兜底：某些工具直接塞 { error: "..." }
  return getStringProperty(result, "error");
}

/** 若 result.content 是数组则返回它，否则 undefined。 */
function getContentArray(result: unknown): unknown[] | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const content = (result as Record<string, unknown>).content;
  return Array.isArray(content) ? content : undefined;
}

/** 类型守卫：返回 obj[key] 当它是非空 string，否则 undefined。 */
function getStringProperty(obj: unknown, key: string): string | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const val = (obj as Record<string, unknown>)[key];
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

export function setupToolErrorHandler(pi: ExtensionAPI): void {
  pi.on("tool_execution_end", async (event: unknown, ctx: HookContext) => {
    const e = event as ToolExecutionEndLikeEvent;
    if (!e.isError) return;

    // 提取错误文本：tool execute throw 时 Pi 把 error.message 塞进 result.content。
    // SDK 事件无 errorMessage 字段，只能从这里捞；拿不到也不阻断（降级到无详情）。
    const errorText = extractErrorText(e.result);
    const detail = errorText ? `: ${errorText}` : "";
    const msg = `[unified-hooks] ${e.toolName} error (callId=${e.toolCallId})${detail}`;

    // ctx.ui.notify 走 TUI 通知区，不越过 alternate screen 污染 input。
    // console.warn 会写 raw stderr，在 TUI 下泄漏到 input 区。
    // headless / RPC 会话 ctx.ui 可能为 undefined——降级到 console.warn 保证不 NPE。
    if (ctx.ui?.notify) {
      ctx.ui.notify(msg, "warning");
    } else {
      console.warn(msg);
    }
    // appendEntry 持久化到 session entries，供事后排查（无 UI、不泄漏）。
    // errorText 一起存上——事后排查能看到真实原因（如 "hub disposed"）。
    pi.appendEntry("unified-hooks:tool-error", {
      toolName: e.toolName,
      toolCallId: e.toolCallId,
      errorText: errorText ?? null,
    });
  });
}
