// src/commands/subagents.ts
//
// /subagents 命令。薄壳——打开 list overlay（等同原 /subagents list [<id>]）。
//
// 解析：args[0] 直接作可选 <id>（聚焦该 record）。
// RPC 模式（xyz-agent GUI）：解析 cancel action 直接执行，不打开 TUI。

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { getSubagentService } from "../execution/subagent-service.ts";
import { parseSubagentRpcCommand } from "./command-actions.ts";
import { createSubagentsView } from "./list-view.ts";

/** 注册 /subagents 命令（= list overlay）。 */
export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Subagents: /subagents [<id>] | /subagents cancel <id>",
    handler: async (argsStr: string, ctx: ExtensionCommandContext) => {
      const service = getSubagentService();
      if (!service) {
        ctx.ui.notify("subagents execution runtime not ready (session not started)", "error");
        return;
      }

      // ── RPC 模式（xyz-agent GUI）：解析 action 直接执行，不打开 TUI ──
      // hasUI 在 TUI 和 RPC 都为 true，不能用于区分；用 ctx.mode === "rpc" 判定 GUI 通道。
      if (ctx.mode === "rpc") {
        const parsed = parseSubagentRpcCommand(argsStr);
        switch (parsed.action) {
          case "cancel": {
            try {
              const ok = service.cancel(parsed.recordId);
              ctx.ui.notify(
                ok ? `Cancelled subagent ${parsed.recordId}` : `Subagent ${parsed.recordId} not found or already finished`,
                ok ? "info" : "warning",
              );
            } catch (err) {
              // service.cancel 内部 assertReady 在 session_shutdown 并发 dispose 时会抛
              const msg = err instanceof Error ? err.message : String(err);
              ctx.ui.notify(`Failed to cancel subagent ${parsed.recordId}: ${msg}`, "warning");
            }
            return;
          }
          case "cancel-missing-id":
            ctx.ui.notify("Usage: /subagents cancel <id>", "warning");
            return;
          case "noop":
            // 无 action 或未知 action：GUI 端已屏蔽此 command 入口，此处兜底
            ctx.ui.notify("View subagents in the sidebar Agents tab", "info");
            return;
          default: {
            // exhaustiveness 断言：未来新增 action verb 忘加 case 时 tsc 报错
            const _exhaustive: never = parsed;
            throw new Error(`Unhandled subagent RPC action: ${String(_exhaustive)}`);
          }
        }
      }

      // ── print/json 模式（headless）：不可交互 ──
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/subagents requires interactive mode", "error");
        return;
      }

      // ── TUI 模式：打开 list overlay（原逻辑不变）──
      const args = argsStr.trim().split(/\s+/).filter(Boolean);
      await createSubagentsView(service, ctx.ui.theme, ctx, args[0]);
    },
  });
}
