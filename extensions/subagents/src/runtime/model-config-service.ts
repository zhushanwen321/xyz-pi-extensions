// src/runtime/model-config-service.ts
//
// 配置 + 模型解析领域 Service。"给定 agent 名 + 用户参数，用哪个模型？"
//
// 与 SubagentService（执行/记录/通知域）正交——本 Service 不碰 pool/store/notifier。
// 上游：SubagentService.execute 内部调 resolveModel；command/wizard 直接用（不经 SubagentService）。
// session_start 时经 initModel 注入 modelRegistry + 恢复 sessionState。

import { AgentRegistry, createPackageBuiltinRegistry } from "../core/agent-registry.ts";
import {
  type AgentConfig,
  inferCategory,
  type ModelRegistryLike,
  type ResolvedModel,
  resolveModelForAgent,
} from "../core/model-resolver.ts";
import type {
  SessionModelState,
  SubagentsGlobalConfig,
} from "../types.ts";
import {
  createSessionState,
  loadGlobalConfig,
  restoreSessionState,
  saveGlobalConfig as saveConfig,
} from "./config/config.ts";
import { DiscoveryConfigLoader } from "./discovery-config.ts";

// ============================================================
// 类型
// ============================================================

/** Service 构造参数（进程级，跨 session 不变）。 */
export interface ModelConfigServiceInit {
  agentDir: string;
  /**
   * 资源发现契约加载器（宿主声明的多 skill/agent 目录）。
   * undefined 时仅用 agentDir 单目录（默认行为，零破坏）。
   * 详见 ADR-025。
   */
  discoveryLoader?: DiscoveryConfigLoader;
}

/** session_start 注入参数（session 级，每次重建）。 */
export interface ModelServiceSessionInit {
  /** 模型注册表（鉴权 + 发现）。null 立即抛错（fail-fast）。 */
  modelRegistry: ModelRegistryLike | null;
  /** 当前 session ID。 */
  sessionId: string;
  /** session 历史条目（/resume /fork 时恢复 sessionState）。 */
  entries: ReadonlyArray<{ type: string; data?: unknown }>;
}

// ============================================================
// ModelConfigService
// ============================================================

/**
 * 配置 + 模型解析 Service。进程级单例。
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │  globalConfig（~/.pi/.../config.json）                │
 *   │  sessionState（内存，经 entries 持久化/恢复）          │
 *   │  agentRegistry（agent .md 发现 + frontmatter）         │
 *   │  modelRegistry（SDK 注入的可用模型）                    │
 *   │                                                      │
 *   │  resolveModel: agent → category → 5级fallback → 确认  │
 *   └──────────────────────────────────────────────────────┘
 */
export class ModelConfigService {
  private globalConfig: SubagentsGlobalConfig;
  private sessionState: SessionModelState;
  private readonly agentRegistry: AgentRegistry;
  private readonly agentRegistryDir: string;
  /** discovery 加载器（resources_discover 时重新读，喂主 agent skill）。 */
  private readonly discoveryLoader: DiscoveryConfigLoader | undefined;
  private modelRegistry: ModelRegistryLike | null = null;
  private _sessionId: string | undefined;

  /** 包内 builtin agent（agents/*.md，优先级最低，被用户覆盖）。 */
  private readonly builtinRegistry = createPackageBuiltinRegistry();

  constructor(init: ModelConfigServiceInit) {
    this.agentRegistryDir = init.agentDir;
    this.discoveryLoader = init.discoveryLoader;
    this.globalConfig = loadGlobalConfig(init.agentDir);
    this.sessionState = createSessionState();
    // agentDirs：discovery 声明的目录（靠前覆盖靠后），空则回退默认 agentDir 单目录
    const agentDirs = this.resolveAgentDirs();
    this.agentRegistry = new AgentRegistry(agentDirs);
    // 接通发现机制：扫描 agentDirs + 合并 builtin（此前从未调用，registry 永远为空）
    this.agentRegistry.discoverAll(this.builtinRegistry);
  }

  /**
   * 解析 agent 发现目录列表。
   * discovery.json 的 agentDirs 非空时用之（靠前覆盖靠后），否则回退 [agentDir] 默认。
   */
  private resolveAgentDirs(): string[] {
    const discovery = this.discoveryLoader?.load();
    if (discovery && discovery.agentDirs.length > 0) {
      return [...discovery.agentDirs];
    }
    return [this.agentRegistryDir];
  }

  // ── 生命周期（index.ts 调）──────────────────────────────

  /**
   * session_start 注入。封装 4 步固定时序：
   *   1. reloadGlobalConfig（复用时拿最新 config）
   *   2. injectModelRegistry（fail-fast：null 抛错）
   *   3. setSessionId
   *   4. restoreFromEntries（恢复 sessionState）
   */
  initModel(init: ModelServiceSessionInit): void {
    // 1. 重载配置 + 重扫 agent（hot-reload：用户可能新增/修改 agent .md）
    this.globalConfig = loadGlobalConfig(this.agentRegistryDir);
    this.agentRegistry.discoverAll(this.builtinRegistry);

    // 2. modelRegistry（fail-fast）
    if (init.modelRegistry === null) {
      throw new Error("modelRegistry is required but got null");
    }
    this.modelRegistry = init.modelRegistry;

    // 3. sessionId
    this._sessionId = init.sessionId;

    // 4. 恢复 sessionState
    Object.assign(this.sessionState, restoreSessionState(init.entries));
  }

  // ── 模型解析（SubagentService.execute 内部调）──────────────

  /**
   * 解析 agent 的模型（纯解析）。
   *
   * D-1：取消首次确认拦截——categoryConfirmed 默认 true，本方法直接解析不再阻塞。
   * 用户改 category 模型走 /subagents config（写 globalConfig）。
   */
  resolveModel(
    agentName: string,
    override?: { model?: string; thinkingLevel?: string },
  ): ResolvedModel {
    this.assertReady();
    const agentConfig = this.agentRegistry.get(agentName);
    const category = inferCategory(
      agentName,
      agentConfig,
      this.globalConfig.agentCategoryOverrides,
      "general",
    );
    return this.doResolve(agentName, agentConfig, category, override);
  }

  /** 查询 agent 配置（SubagentService 内部判定 defaultBackground + resolveIdentity 用）。 */
  getAgentConfig(name?: string): AgentConfig | undefined {
    return name ? this.agentRegistry.get(name) : undefined;
  }

  // ── 配置读写（command/wizard 调）────────────────────────

  /** 全局配置深拷贝（调用方拿到副本，改不影响 Service 内部）。 */
  getGlobalConfig(): SubagentsGlobalConfig {
    return structuredClone(this.globalConfig);
  }

  /** session 状态深拷贝。 */
  getSessionState(): SessionModelState {
    return structuredClone(this.sessionState);
  }

  /** 更新全局配置 + 落盘（config-wizard 改完调）。 */
  async saveGlobalConfig(config: SubagentsGlobalConfig): Promise<void> {
    this.globalConfig = config;
    await saveConfig(this.agentRegistryDir, config);
  }

  /** 翻转 YOLO 模式。返回翻转后的新值。 */
  toggleYolo(): boolean {
    this.sessionState.yoloMode = !this.sessionState.yoloMode;
    return this.sessionState.yoloMode;
  }

  /** 内部：用于 SubagentService 经 session id 过滤 history（只读访问 sessionId）。 */
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /** agent 配置目录（SubagentService 构造 history/store/SessionRunnerContext 时读）。 */
  getAgentDir(): string {
    return this.agentRegistryDir;
  }

  /**
   * discovery.json 声明的 skill 目录（供 SubagentService 注入子 session）。
   * 每次调用重新读 loader（mtime 缓存），支持宿主运行时修改 discovery.json 后下次生效。
   */
  getDiscoverySkillDirs(): string[] {
    const discovery = this.discoveryLoader?.load();
    return discovery ? [...discovery.skillDirs] : [];
  }

  /** modelRegistry（SubagentService 构造 factoryCtx 时读）。已注入保证非 null。 */
  getModelRegistry(): ModelRegistryLike {
    if (this.modelRegistry === null) {
      throw new Error("modelRegistry not injected (initModel not called?)");
    }
    return this.modelRegistry;
  }

  // ── 内部 ────────────────────────────────────────────────

  /** 实际的 5 级 fallback 解析（不含确认逻辑）。 */
  private doResolve(
    agentName: string,
    agentConfig: AgentConfig | undefined,
    category: string,
    override?: { model?: string; thinkingLevel?: string },
  ): ResolvedModel {
    return resolveModelForAgent({
      agentName,
      agentConfig,
      category,
      globalConfig: this.globalConfig,
      sessionState: this.sessionState,
      modelRegistry: this.modelRegistry!,
      paramOverride: override,
    });
  }

  /** 校验 modelRegistry 已注入。 */
  private assertReady(): void {
    if (this.modelRegistry === null) {
      throw new Error("modelRegistry not injected (initModel not called?)");
    }
  }
}

// ============================================================
// 进程单例访问器
// ============================================================

// 用 globalThis[Symbol.for] 持有进程单例，避免 jiti 因路径字符串不同加载多份模块
// 导致单例分裂（详见 docs/standards.md §7.5）。
const MODEL_SERVICE_SLOT_KEY = Symbol.for("@zhushanwen/pi-subagents.model-service");

type ModelServiceSlot = { current: ModelConfigService | null };

function getModelServiceSlot(): ModelServiceSlot {
  const record = globalThis as unknown as Record<symbol, unknown>;
  if (!record[MODEL_SERVICE_SLOT_KEY]) record[MODEL_SERVICE_SLOT_KEY] = { current: null };
  return record[MODEL_SERVICE_SLOT_KEY] as ModelServiceSlot;
}

/** 获取进程单例。session_start 前为 null。 */
export function getModelConfigService(): ModelConfigService | null {
  return getModelServiceSlot().current;
}

/** 设置进程单例（session_start 首次创建时）。 */
export function setModelConfigService(service: ModelConfigService): void {
  getModelServiceSlot().current = service;
}
