// src/runtime/model-config-hub.ts
//
// 配置 + 模型解析领域 Hub。"给定 agent 名 + 用户参数，用哪个模型？"
//
// 与 SubagentHub（执行/记录/通知域）正交——本 Hub 不碰 pool/store/notifier。
// 上游：SubagentHub.execute 内部调 resolveModel；command/wizard 直接用（不经 SubagentHub）。
// session_start 时经 initModel 注入 modelRegistry + 恢复 sessionState。

import { AgentRegistry } from "../core/agent-registry.ts";
import {
  type AgentConfig,
  inferCategory,
  type ModelInfo,
  type ModelRegistryLike,
  type ResolvedModel,
  resolveModelForAgent,
} from "../core/model-resolver.ts";
import type {
  CategoryConfirmResult,
  SessionModelState,
  SubagentsGlobalConfig,
} from "../types.ts";
import {
  applyCategoryConfirm,
  createSessionState,
  loadGlobalConfig,
  restoreSessionState,
  saveGlobalConfig as saveConfig,
} from "./config.ts";

// ============================================================
// 类型
// ============================================================

/** Hub 构造参数（进程级，跨 session 不变）。 */
export interface ModelConfigHubInit {
  homeDir: string;
  agentDir: string;
}

/** session_start 注入参数（session 级，每次重建）。 */
export interface ModelSessionInit {
  /** 模型注册表（鉴权 + 发现）。null 立即抛错（fail-fast）。 */
  modelRegistry: ModelRegistryLike | null;
  /** 当前 session ID。 */
  sessionId: string;
  /** session 历史条目（/resume /fork 时恢复 sessionState）。 */
  entries: ReadonlyArray<{ type: string; data?: unknown }>;
}

/**
 * 首次 category 确认回调的入参。
 * 与 tui/category-confirm.ts 的 CategoryConfirmInput 结构兼容（duck-typed），
 * 但在此独立声明——避免 Runtime 层依赖 TUI 层。
 */
export interface ConfirmCategoryInput {
  categories: { name: string; model: string }[];
  currentModels: Record<string, { model: string; thinkingLevel?: string }>;
  available: ModelInfo[];
}

/**
 * 首次 category 确认回调。
 * SubagentHub.execute 经 ExecuteOptions.onConfirmCategory 透传到 resolveModel。
 * 无 UI 场景（测试/headless）省略——resolveModel 跳过确认直接用 fallback 解析。
 */
export type ConfirmCategoryCallback = (
  input: ConfirmCategoryInput,
) => Promise<CategoryConfirmResult>;

// ============================================================
// ModelConfigHub
// ============================================================

/**
 * 配置 + 模型解析 Hub。进程级单例。
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
export class ModelConfigHub {
  private globalConfig: SubagentsGlobalConfig;
  private sessionState: SessionModelState;
  private readonly agentRegistry: AgentRegistry;
  private readonly agentRegistryDir: string;
  private modelRegistry: ModelRegistryLike | null = null;
  private readonly homeDir: string;
  private _sessionId: string | undefined;

  constructor(init: ModelConfigHubInit) {
    this.homeDir = init.homeDir;
    this.agentRegistryDir = init.agentDir;
    this.globalConfig = loadGlobalConfig(init.homeDir);
    this.sessionState = createSessionState();
    this.agentRegistry = new AgentRegistry(init.agentDir);
  }

  // ── 生命周期（index.ts 调）──────────────────────────────

  /**
   * session_start 注入。封装 4 步固定时序：
   *   1. reloadGlobalConfig（复用时拿最新 config）
   *   2. injectModelRegistry（fail-fast：null 抛错）
   *   3. setSessionId
   *   4. restoreFromEntries（恢复 sessionState）
   */
  initModel(init: ModelSessionInit): void {
    // 1. 重载配置
    this.globalConfig = loadGlobalConfig(this.homeDir);

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

  // ── 模型解析（SubagentHub.execute 内部调）──────────────

  /**
   * 首次 category 确认（如果需要）。execute 在 resolveModel 前调。
   *
   *   已确认（categoryConfirmed=true）→ 跳过
   *   未确认 && onConfirmCategory 存在 → 调回调 → confirmed 则 applyCategoryConfirm
   *   未确认 && 无回调（无 UI）→ 跳过（headless/测试场景，用 fallback）
   *   回调 cancelled → 抛 ConfirmCancelledError（调用方决定不执行）
   */
  async ensureConfirmed(onConfirmCategory?: ConfirmCategoryCallback): Promise<void> {
    if (this.sessionState.categoryConfirmed) return;
    if (!onConfirmCategory) return; // 无 UI，跳过

    const input = this.buildConfirmInput();
    const result = await onConfirmCategory(input);
    if (result.action === "cancelled") {
      throw new ConfirmCancelledError();
    }
    applyCategoryConfirm(this.sessionState, result);
  }

  /**
   * 解析 agent 的模型（纯解析，不含确认）。
   * 调用方应先 await ensureConfirmed() 再调本方法。
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

  /** 查询 agent 配置（SubagentHub 内部判定 defaultBackground + resolveIdentity 用）。 */
  getAgentConfig(name?: string): AgentConfig | undefined {
    return name ? this.agentRegistry.get(name) : undefined;
  }

  // ── 配置读写（command/wizard 调）────────────────────────

  /** 全局配置深拷贝（调用方拿到副本，改不影响 Hub 内部）。 */
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
    await saveConfig(this.homeDir, config);
  }

  /** 翻转 YOLO 模式。返回翻转后的新值。 */
  toggleYolo(): boolean {
    this.sessionState.yoloMode = !this.sessionState.yoloMode;
    return this.sessionState.yoloMode;
  }

  /** 内部：用于 SubagentHub 经 session id 过滤 history（只读访问 sessionId）。 */
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /** home 目录（SubagentHub 构造 history/store 时读）。 */
  getGlobalConfigHomeDir(): string {
    return this.homeDir;
  }

  /** agent 配置目录（SubagentHub 构造 SessionRunnerContext 时读）。 */
  getAgentDir(): string {
    return this.agentRegistryDir;
  }

  /** modelRegistry（SubagentHub 构造 factoryCtx 时读）。已注入保证非 null。 */
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

  /** 构造确认组件的入参（categories + currentModels + available）。 */
  private buildConfirmInput(): ConfirmCategoryInput {
    const categories = Object.entries(this.globalConfig.categories).map(([name, def]) => ({
      name,
      model: def.model,
    }));
    return {
      categories,
      currentModels: { ...this.sessionState.categoryModels },
      available: this.modelRegistry!.getAvailable(),
    };
  }

  /** 校验 modelRegistry 已注入。 */
  private assertReady(): void {
    if (this.modelRegistry === null) {
      throw new Error("modelRegistry not injected (initModel not called?)");
    }
  }
}

// ============================================================
// 确认信号
// ============================================================

/**
 * ensureConfirmed 在用户取消确认时抛出。调用方（SubagentHub.execute）catch 后
 * 不执行子代理（用户意图），向上抛出让 tool 层终止本次调用。
 */
export class ConfirmCancelledError extends Error {
  constructor() {
    super("category confirmation cancelled by user");
    this.name = "ConfirmCancelledError";
  }
}

// ============================================================
// 进程单例访问器
// ============================================================

let _modelHub: ModelConfigHub | null = null;

/** 获取进程单例。session_start 前为 null。 */
export function getModelConfigHub(): ModelConfigHub | null {
  return _modelHub;
}

/** 设置进程单例（session_start 首次创建时）。 */
export function setModelConfigHub(hub: ModelConfigHub): void {
  _modelHub = hub;
}
