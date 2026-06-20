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
 */
interface ToolExecutionEndLikeEvent {
  isError: boolean;
  toolName: string;
  toolCallId: string;
}

/** ExtensionContext 的最小子集，仅声明 unified-hooks 内部用到的 ui 字段。 */
export interface HookContext {
  // headless / RPC 会话 ctx.ui 可能为 undefined（TUI 未初始化）。
  ui?: {
    notify(msg: string, type?: string): void;
  };
}

export function setupToolErrorHandler(pi: ExtensionAPI): void {
  pi.on("tool_execution_end", async (event: unknown, ctx: HookContext) => {
    const e = event as ToolExecutionEndLikeEvent;
    if (!e.isError) return;
    const msg = `[unified-hooks] ${e.toolName} error (callId=${e.toolCallId})`;
    // ctx.ui.notify 走 TUI 通知区，不越过 alternate screen 污染 input。
    // console.warn 会写 raw stderr，在 TUI 下泄漏到 input 区。
    // headless / RPC 会话 ctx.ui 可能为 undefined——降级到 console.warn 保证不 NPE。
    if (ctx.ui?.notify) {
      ctx.ui.notify(msg, "warn");
    } else {
      console.warn(msg);
    }
    // appendEntry 持久化到 session entries，供事后排查（无 UI、不泄漏）。
    pi.appendEntry("unified-hooks:tool-error", {
      toolName: e.toolName,
      toolCallId: e.toolCallId,
    });
  });
}
