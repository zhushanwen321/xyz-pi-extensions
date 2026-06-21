// src/commands/subagents.ts
//
// /subagents 命令。薄壳——参数解析 + 分发到 wizard / list。
//
// 解析优先级：
//   /subagents list [<id>]?  → list overlay（hasUI 必填）
//   /subagents config [...]  → config wizard
//   /subagents               → 配置摘要通知

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { getModelConfigService } from "../runtime/model-config-service.ts";
import { getSubagentService } from "../runtime/subagent-service.ts";
import { runConfigWizard } from "../tui/config-wizard.ts";
import { formatConfigSummary } from "../tui/format-helpers.ts";
import { createSubagentsView } from "../tui/list-view.ts";

/** 注册 /subagents 命令。 */
export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Subagents: /subagents [config [category] | list [<id>]]",
    handler: async (argsStr: string, ctx: ExtensionCommandContext) => {
      //   ╔══════════════════════════════════════════════════════════════╗
      //   ║  modelService = getModelConfigService() —— 未初始化 notify + return ║
      //   ║  args = argsStr.trim().split(/\s+/)                           ║
      //   ║                                                                ║
      //   ║  args[0] === "list":                                          ║
      //   ║    !ctx.hasUI → notify error + return                         ║
      //   ║    service = getSubagentService() —— 未初始化 notify + return  ║
      //   ║    createSubagentsView(service, ctx.ui.theme, ctx, args[1])    ║
      //   ║    return                                                      ║
      //   ║                                                                ║
      //   ║  args[0] === "config":                                        ║
      //   ║    !ctx.hasUI → notify error + return                         ║
      //   ║    runConfigWizard(ctx.ui, args.slice(1), modelService)        ║
      //   ║    return                                                      ║
      //   ║                                                                ║
      //   ║  其他（无参数或未知）→ 配置摘要通知                            ║
      //   ╚══════════════════════════════════════════════════════════════╝
      const args = argsStr.trim().split(/\s+/).filter(Boolean);

      const modelService = getModelConfigService();
      if (!modelService) {
        ctx.ui.notify("subagents not initialized (session not started)", "error");
        return;
      }

      // ── /subagents list [<id>] ──
      if (args[0] === "list") {
        if (!ctx.hasUI) {
          ctx.ui.notify("/subagents list requires an interactive UI", "error");
          return;
        }
        const service = getSubagentService();
        if (!service) {
          ctx.ui.notify("subagents execution runtime not ready", "error");
          return;
        }
        await createSubagentsView(service, ctx.ui.theme, ctx, args[1]);
        return;
      }

      // ── /subagents config [...] ──
      if (args[0] === "config") {
        if (!ctx.hasUI) {
          ctx.ui.notify("/subagents config requires an interactive UI", "error");
          return;
        }
        await runConfigWizard(ctx.ui, args.slice(1), modelService);
        return;
      }

      // ── /subagents（无参数或未知）→ 摘要 ──
      const summary = formatConfigSummary(modelService.getGlobalConfig(), modelService.getSessionState());
      ctx.ui.notify(summary, "info");
    },
  });
}
