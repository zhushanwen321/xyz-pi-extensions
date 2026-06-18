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
//   ║    2. rt.initSession({ modelRegistry, pi, sessionId, entries })     ║
//   ║       ← reloadConfig + inject + revive + restore 封装于此           ║
//   ║    3. ctx.hasUI → ctx.ui.setWidget("subagents-progress", factory,  ║
//   ║                                          { placement:"belowEditor"})║
//   ║    4. maybeCleanupExpiredSessionFiles(homeDir, cwd)                ║
//   ║    5. pruneWorktrees(cwd)  ◄── 崩溃恢复兜底                        ║
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
    rt.initSession({
      modelRegistry: ctx.modelRegistry,
      pi,
      sessionId: ctx.sessionManager.getSessionId(),
      entries: ctx.sessionManager.getEntries() ?? [],
    });

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
