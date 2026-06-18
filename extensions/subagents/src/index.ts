// src/index.ts
//
// Pi extension 工厂。只做注册胶水——不含业务逻辑。
// 注册项：tool / command / messageRenderer / widget / session 事件。

import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@mariozechner/pi-coding-agent";

import { registerSubagentsCommand } from "./commands/subagents.ts";
import { cleanupOrphanedWorktreeDirs, pruneWorktrees } from "./core/worktree.ts";
import {
  getModelConfigHub,
  ModelConfigHub,
  setModelConfigHub,
} from "./runtime/model-config-hub.ts";
import { maybeCleanupExpiredSessionFiles } from "./runtime/session-file-gc.ts";
import {
  getHub,
  setHub,
  SubagentHub,
} from "./runtime/subagent-hub.ts";
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
//   ║    1. modelHub = getModelConfigHub() ?? new ModelConfigHub(...)    ║
//   ║    2. hub = getHub() ?? new SubagentHub({cwd, modelHub})           ║
//   ║    3. modelHub.initModel({modelRegistry, sessionId, entries})     ║
//   ║    4. hub.initSession({pi, sessionId})                            ║
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

    // 双 Hub 装配：ModelConfigHub（配置/模型域）+ SubagentHub（执行/记录/通知域）
    const existingHub = getHub();
    const existingModelHub = getModelConfigHub();
    const modelHub = existingModelHub ?? new ModelConfigHub({ homeDir, agentDir });
    const hub = existingHub ?? new SubagentHub({ cwd, modelHub });

    // 分别 init（两个域的生命周期独立）
    modelHub.initModel({
      modelRegistry: ctx.modelRegistry,
      sessionId: ctx.sessionManager.getSessionId(),
      entries: ctx.sessionManager.getEntries() ?? [],
    });
    hub.initSession({
      pi,
      sessionId: ctx.sessionManager.getSessionId(),
    });

    // 先注册 Hub（让 execute 可用），再做 best-effort 清理。
    // 顺序很重要：清理若 throw 不能阻塞 hub 注册，否则 getHub() 永远返回 undefined。
    if (!existingHub) {
      setModelConfigHub(modelHub);
      setHub(hub);
    }

    if (ctx.hasUI) {
      ctx.ui.setWidget(
        "subagents-progress",
        (tui: { requestRender(): void }, theme: ThemeLike) =>
          new SubagentsProgressWidget(hub, theme, tui),
        { placement: "belowEditor" },
      );
    }

    // best-effort 清理（崩溃恢复 / GC），失败不应阻断 session——但额外兜底：
    // 万一仍抛错，catch 住防止 session_start 整体崩。
    try {
      maybeCleanupExpiredSessionFiles(homeDir, cwd);
      pruneWorktrees(cwd);
    } catch {
      // best-effort 清理失败，忽略——hub 已注册，session 可用
    }
  });

  pi.on("session_shutdown", (_event: SessionShutdownEvent) => {
    getHub()?.dispose();
    cleanupOrphanedWorktreeDirs();
  });
}
