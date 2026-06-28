// src/index.ts
//
// Pi extension 工厂。只做注册胶水——不含业务逻辑。
// 注册项：tool / command / messageRenderer / session 事件。

import type { ExtensionAPI, ExtensionContext, ResourcesDiscoverEvent, ResourcesDiscoverResult, SessionShutdownEvent, SessionStartEvent } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

import { registerSubagentsCommand } from "./commands/subagents.ts";
import { DiscoveryConfigLoader } from "./runtime/discovery-config.ts";
import { WorktreeManager } from "./runtime/worktree-manager.ts";
import {
  getModelConfigService,
  ModelConfigService,
  setModelConfigService,
} from "./runtime/model-config-service.ts";
import { maybeCleanupExpiredSessionFiles } from "./runtime/session-file-gc.ts";
import {
  getSubagentService,
  setSubagentService,
  SubagentService,
} from "./runtime/subagent-service.ts";
import { registerSubagentTool } from "./tools/subagent-tool.ts";
import { renderBgNotifyMessage } from "./tui/bg-notify-render.ts";

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
//   ║    1. modelService = getModelConfigService() ?? new ModelConfigService(...)║
//   ║    2. service = getSubagentService() ?? new SubagentService({cwd, modelService})║
//   ║    3. modelService.initModel({modelRegistry, sessionId, entries}) ║
//   ║    4. service.initSession({pi, sessionId})                        ║
//   ║    5. maybeCleanupExpiredSessionFiles(homeDir, cwd)                ║
//   ║                                                                    ║
//   ║  session_shutdown(event):                                          ║
//   ║    rt.dispose()                                                    ║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export default function subagentsExtension(pi: ExtensionAPI): void {
  registerSubagentsCommand(pi);
  registerSubagentTool(pi);
  pi.registerMessageRenderer("subagent-bg-notify", renderBgNotifyMessage);

  // 模块级缓存：主 session 的 sessionFile（fork source 解析用）。
  // session_start 时写入，SubagentService 读取。
  let cachedMainSessionFile: string | undefined;

  /** 获取缓存的主 session file（SubagentService 构造后调用）。 */
  function getCachedMainSessionFile(): string | undefined {
    return cachedMainSessionFile;
  }

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

    // 双 Service 装配：ModelConfigService（配置/模型域）+ SubagentService（执行/记录/通知域）
    const existingService = getSubagentService();
    const existingModelService = getModelConfigService();
    const modelService = existingModelService ?? new ModelConfigService({ agentDir, discoveryLoader });
    const service = existingService ?? new SubagentService({ cwd, modelService, getMainSessionFile: getCachedMainSessionFile });

    // 分别 init（两个域的生命周期独立）
    modelService.initModel({
      modelRegistry: ctx.modelRegistry,
      sessionId: ctx.sessionManager.getSessionId(),
      // 缓存主 agent model：renderCall 阶段 ToolRenderContext 不含 model（SDK 限制），
      // 缓存后 resolveModel 第三层能命中，标题行恢复显示 model（详见 model-config-service.ts）。
      ctxModel: ctx.model ?? undefined,
    });
    service.initSession({
      pi,
      sessionId: ctx.sessionManager.getSessionId(),
    });

    // 先注册 Service（让 execute 可用），再做 best-effort 清理。
    // 顺序很重要：清理若 throw 不能阻塞 service 注册，否则 getSubagentService() 永远返回 undefined。
    if (!existingService) {
      setModelConfigService(modelService);
      setSubagentService(service);
    }

    // 缓存主 session file（fork source 解析用）。
    cachedMainSessionFile = ctx.sessionManager.getSessionFile() ?? undefined;

    // best-effort 清理（GC），失败不应阻断 session——但额外兜底：
    // 万一仍抛错，catch 住防止 session_start 整体崩。
    try {
      maybeCleanupExpiredSessionFiles(agentDir, cwd);
    } catch (err) {
      // best-effort 清理失败，忽略——service 已注册，session 可用。记录但不阻断。
      void err; // 显式确认忽略：GC 清理失败不应阻断 session_start
      console.warn("[subagents] expired session file cleanup failed:", err);
    }

    // best-effort worktree 孤儿 reaper：扫描 pi-sub-* 孤儿 worktree 并清理。
    // 终态（.finalized/.cancelled）且无活 .alive 的孤儿会被删除。
    try {
      const wtm = new WorktreeManager();
      wtm.scan(cwd, agentDir);
    } catch (err) {
      // best-effort reaper 失败，忽略——不影响 session 启动。
      void err;
      console.warn("[subagents] worktree reaper scan failed:", err);
    }
  });

  // model_select：用户切换 model 时刷新缓存，保证后续 renderCall 显示新 model。
  // SDK 的 ModelSelectEvent 未从包入口 export，此处用最小结构类型（仅需 .model 字段）。
  // ponytail: 防御性检查——全局 Symbol 单例可能缓存旧版本实例（无 setCtxModel）
  pi.on("model_select", (event: { model: NonNullable<ExtensionContext["model"]> }, _ctx: ExtensionContext) => {
    const service = getModelConfigService();
    if (service && typeof service.setCtxModel === "function") {
      service.setCtxModel(event.model);
    }
  });

  pi.on("session_shutdown", (_event: SessionShutdownEvent, _ctx: ExtensionContext) => {
    getSubagentService()?.dispose();
  });
}
