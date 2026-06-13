// src/commands/config.ts
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { getRuntime } from "../runtime.ts";
import { formatConfigSummary } from "../tui/format.ts";
import { runConfigWizard } from "../tui/config-wizard.ts";

/** FR-4.8.1: 注册 /subagents 命令 */
export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Subagents 配置: /subagents [config [category]]",
    handler: async (argsStr: string, ctx: ExtensionCommandContext) => {
      const rt = getRuntime();
      if (!rt) { ctx.ui.notify("Subagents runtime 未初始化", "error"); return; }

      const args = argsStr.trim().split(/\s+/).filter(Boolean);

      // /subagents（无参数）→ 显示摘要
      if (args.length === 0 || (args.length === 1 && args[0] !== "config")) {
        ctx.ui.notify(formatConfigSummary(rt.globalConfig, rt.sessionState.yoloMode));
        return;
      }

      // /subagents config [category]
      const wizardArgs = args.slice(1);
      await runConfigWizard(
        {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          notify: (msg) => ctx.ui.notify(msg),
        },
        wizardArgs,
        rt.globalConfig,
        process.env.HOME || process.env.USERPROFILE || ctx.cwd,
        ctx.modelRegistry as never,
      );
    },
  });
}
