// src/index.ts
//
// Pi extension 工厂。只做注册胶水——不含业务逻辑。
// 注册项：tool / command / messageRenderer / widget / session 事件。

import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@mariozechner/pi-coding-agent";

import { registerSubagentsCommand } from "./commands/subagents.ts";
import { cleanupOrphanedWorktreeDirs, pruneWorktrees } from "./core/worktree.ts";
import { getRuntime, setRuntime, SubagentRuntime } from "./runtime/runtime.ts";
import { maybeCleanupExpiredSessionFiles } from "./runtime/session-file-gc.ts";
import { registerSubagentTool } from "./tools/subagent-tool.ts";
import { renderBgNotifyMessage } from "./tui/bg-notify-render.ts";
import type { ThemeLike } from "./tui/format.ts";
import { SubagentsProgressWidget } from "./tui/progress-widget.ts";

/**
 * FR-10.2: Pi extension 工厂。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
//   ║  注册（进程级，一次）:                                             ║
//   ║    registerSubagentsCommand(pi)  → /subagents                      ║
//   ║    registerSubagentTool(pi)      → subagent tool                   ║
//   ║    pi.registerMessageRenderer("subagent-bg-notify", renderBgNotify)║
//   ║                                                                    ║
//   ║  session_start(event, ctx):                                        ║
//   ║    1. existing = getRuntime() ?? new SubagentRuntime({cwd,homeDir,agentDir})║
//   ║    2. existing ? rt.reloadGlobalConfig() : setRuntime(rt)          ║
//   ║    3. rt.injectModelRegistry(ctx.modelRegistry)                    ║
//   ║    4. rt.injectPi(pi) + rt.setSessionId(ctx.sessionManager.getSessionId())║
//   ║    5. rt.revive()  （/resume /fork 后复活 dispose 状态）           ║
//   ║    6. ctx.hasUI → ctx.ui.setWidget("subagents-progress", factory,  ║
//   ║                                          { placement:"belowEditor"})║
//   ║    7. rt.restoreFromEntries(ctx.sessionManager.getEntries())       ║
//   ║    8. maybeCleanupExpiredSessionFiles(homeDir, cwd)                ║
//   ║    9. pruneWorktrees(cwd)  ◄── 崩溃恢复兜底                        ║
//   ║                                                                    ║
//   ║  session_shutdown(event):                                          ║
//   ║    rt.dispose() + cleanupOrphanedWorktreeDirs()                    ║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export default function subagentsExtension(pi: ExtensionAPI): void {
  registerSubagentsCommand(pi);
  registerSubagentTool(pi);
  pi.registerMessageRenderer("subagent-bg-notify", renderBgNotifyMessage);

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const cwd = ctx.cwd;
    const homeDir = process.env.HOME || process.env.USERPROFILE || cwd;
    const agentDir = path.join(homeDir, ".pi", "agent");

    const existing = getRuntime();
    const rt = existing ?? new SubagentRuntime({ cwd, homeDir, agentDir });
    if (existing) rt.reloadGlobalConfig();
    rt.injectModelRegistry(ctx.modelRegistry);
    rt.injectPi(pi);
    rt.setSessionId(ctx.sessionManager.getSessionId());
    rt.revive();
    rt.restoreFromEntries(ctx.sessionManager.getEntries() ?? []);

    if (ctx.hasUI) {
      ctx.ui.setWidget(
        "subagents-progress",
        (tui: { requestRender(): void }, theme: ThemeLike) =>
          new SubagentsProgressWidget(rt, theme, tui),
        { placement: "belowEditor" },
      );
    }

    maybeCleanupExpiredSessionFiles(homeDir, cwd);
    pruneWorktrees(cwd);

    if (!existing) setRuntime(rt);
  });

  pi.on("session_shutdown", (_event: SessionShutdownEvent) => {
    getRuntime()?.dispose();
    cleanupOrphanedWorktreeDirs();
  });
}
