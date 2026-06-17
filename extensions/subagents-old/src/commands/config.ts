// src/commands/config.ts
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

import { getRuntime } from "../runtime.ts";
import { runConfigWizard } from "../tui/config-wizard.ts";
import { formatConfigSummary } from "../tui/format.ts";
import { createSubagentsView } from "../tui/subagents-view.ts";

/** FR-4.8.1: 注册 /subagents 命令 */
export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Subagents 配置: /subagents [config [category] | list [<id>]]",
    handler: async (argsStr: string, ctx: ExtensionCommandContext) => {
      const rt = getRuntime();
      if (!rt) {
        ctx.ui.notify("Subagents runtime 未初始化", "error");
        return;
      }

      const args = argsStr.trim().split(/\s+/).filter(Boolean);

      // FR-3.1: list 子命令（解析优先级最高）
      if (args[0] === "list") {
        if (!ctx.hasUI) {
          ctx.ui.notify("/subagents list requires interactive mode", "error");
          return;
        }
        const directId = args[1];
        try {
          await createSubagentsView(rt, ctx.ui.theme, ctx, directId);
        } catch (err) {
          ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        }
        return;
      }

      // /subagents（无参数）→ 显示摘要
      if (args.length === 0 || (args.length === 1 && args[0] !== "config")) {
        ctx.ui.notify(formatConfigSummary(rt.globalConfig, rt.sessionState.yoloMode));
        return;
      }

      // /subagents config [category]
      const wizardArgs = args.slice(1); // 去掉 "config"
      await runConfigWizard(
        {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          notify: (msg) => ctx.ui.notify(msg),
        },
        wizardArgs,
        rt.globalConfig,
        process.env.HOME || process.env.USERPROFILE || ctx.cwd,
        ctx.modelRegistry,
        {
          // 真实 YOLO 切换：调 runtime.toggleYolo()（mutate sessionState + persist via appendEntry）
          onToggleYolo: () => rt.toggleYolo(),
        },
      );
    },
  });
}
