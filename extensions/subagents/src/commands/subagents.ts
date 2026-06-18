// src/commands/subagents.ts
//
// /subagents 命令。薄壳——参数解析 + 分发到 wizard / list。
//
// 解析优先级：
//   /subagents list [<id>]?  → list overlay（hasUI 必填）
//   /subagents               → 配置摘要通知
//   /subagents config [...]  → config wizard

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { getModelConfigHub } from "../runtime/model-config-hub.ts";
import { getHub } from "../runtime/subagent-hub.ts";
import { runConfigWizard } from "../tui/config-wizard.ts";
import { formatConfigSummary } from "../tui/format-helpers.ts";
import { createSubagentsView } from "../tui/list-view.ts";

/** 注册 /subagents 命令。 */
export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Subagents: /subagents [config [category] | list [<id>]]",
    handler: async (argsStr: string, ctx: ExtensionCommandContext) => {
      //  ── 流程（薄壳）──────────────────────────────────────────────
      //
      //   ╔══════════════════════════════════════════════════════════════╗
      //   ║  rt = getRuntime() —— 未初始化 notify + return                ║
      //   ║  args = argsStr.trim().split(/\s+/)                           ║
      //   ║                                                                ║
      //   ║  args[0] === "list":                                          ║
      //   ║    !ctx.hasUI → notify error + return                         ║
      //   ║    createSubagentsView(rt, ctx.ui.theme, ctx, args[1])         ║
      //   ║    return                                                      ║
      //   ║                                                                ║
      //   ║  args.length === 0 || args[0] !== "config":                    ║
      //   ║    notify(formatConfigSummary(rt.globalConfig, rt.sessionState))║
      //   ║    return                                                      ║
      //   ║                                                                ║
      //   ║  /subagents config [...] → runConfigWizard(...)                ║
      //   ╚══════════════════════════════════════════════════════════════╝
      void getHub; void getModelConfigHub; void runConfigWizard; void formatConfigSummary; void createSubagentsView; void argsStr; void ctx;
      throw new Error("not implemented");
    },
  });
}
