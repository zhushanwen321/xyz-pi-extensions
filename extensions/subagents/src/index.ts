// src/index.ts
//
// Pi extension 工厂。只做注册胶水——不含业务逻辑。
// 注册项：tool / command / messageRenderer / widget / session 事件。

import type { ExtensionAPI, ExtensionContext, ResourcesDiscoverEvent, ResourcesDiscoverResult, SessionShutdownEvent, SessionStartEvent } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

import { registerSubagentsCommand } from "./commands/subagents.ts";
import { DiscoveryConfigLoader } from "./runtime/discovery-config.ts";
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
//   ║                                          { placement:"aboveEditor"})║
//   ║    4. maybeCleanupExpiredSessionFiles(homeDir, cwd)                ║
//   ║                                                                    ║
//   ║  session_shutdown(event):                                          ║
//   ║    rt.dispose()                                                    ║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export default function subagentsExtension(pi: ExtensionAPI): void {
  registerSubagentsCommand(pi);
  registerSubagentTool(pi);
  pi.registerMessageRenderer("subagent-bg-notify", renderBgNotifyMessage);

  // discovery.json 契约加载器（进程级单例，跨 session 复用 mtime 缓存）。
  // 宿主启动 pi 前写入 <agentDir>/subagents/discovery.json 声明多 skill/agent 目录。
  // 详见 ADR-025。
  const discoveryLoader = new DiscoveryConfigLoader(getAgentDir());

  // resources_discover：把 discovery 的 skillDirs 注入主 session 的 resourceLoader。
  // 主 agent 的 skill 走此通道（pi 原生官方机制），子 session 的 skill 由 session-factory 另读。
  pi.on("resources_discover", (_event: ResourcesDiscoverEvent, _ctx: ExtensionContext): ResourcesDiscoverResult => {
    const discovery = discoveryLoader.load();
    return { skillPaths: discovery.skillDirs.length > 0 ? [...discovery.skillDirs] : undefined };
  });

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    const cwd = ctx.cwd;
    // agentDir 由 Pi 核心 getAgentDir() 决定（读 PI_CODING_AGENT_DIR，默认 ~/.pi/agent），
    // 与 Pi 主进程目录约定完全一致——宿主可经环境变量整体重定向配置/agent/skill 目录。
    const agentDir = getAgentDir();

    // 双 Hub 装配：ModelConfigHub（配置/模型域）+ SubagentHub（执行/记录/通知域）
    const existingHub = getHub();
    const existingModelHub = getModelConfigHub();
    const modelHub = existingModelHub ?? new ModelConfigHub({ agentDir, discoveryLoader });
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
        { placement: "aboveEditor" },
      );
    }

    // best-effort 清理（GC），失败不应阻断 session——但额外兜底：
    // 万一仍抛错，catch 住防止 session_start 整体崩。
    try {
      maybeCleanupExpiredSessionFiles(agentDir, cwd);
    } catch {
      // best-effort 清理失败，忽略——hub 已注册，session 可用
    }
  });

  pi.on("session_shutdown", (_event: SessionShutdownEvent) => {
    getHub()?.dispose();
  });
}
