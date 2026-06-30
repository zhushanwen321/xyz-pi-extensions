// src/runtime/model-config-service.ts
//
// 配置 + 模型解析领域 Service。"给定 agent 名 + 用户参数 + 主 agent 模型，用哪个模型？"
//
// 与 SubagentService（执行/记录/通知域）正交——本 Service 不碰 pool/store/notifier。
// 上游：SubagentService.execute 内部调 resolveModel。
// session_start 时经 initModel 注入 modelRegistry。

import { AgentRegistry, createPackageBuiltinRegistry } from "../core/agent-registry.ts";
import {
  type AgentConfig,
  type ModelInfo,
  type ModelRegistryLike,
  type ResolvedModel,
  resolveModel,
} from "../core/model-resolver.ts";
import type { SubagentsGlobalConfig } from "../types.ts";
import {
  loadGlobalConfig,
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
   * 详见 ADR-028。
   */
  discoveryLoader?: DiscoveryConfigLoader;
}

/** session_start 注入参数（session 级，每次重建）。 */
export interface ModelServiceSessionInit {
  /** 模型注册表（鉴权 + 发现）。null 立即抛错（fail-fast）。 */
  modelRegistry: ModelRegistryLike | null;
  /** 当前 session ID。 */
  sessionId: string;
  /**
   * 主 agent 当前 model（session_start 时注入，model_select 时刷新）。
   *
   * renderCall 阶段的 ToolRenderContext 不含 model 字段（SDK 限制），无法直接拿到
   * 主 agent model。缓存后 renderCall 的 resolveModel 能命中第三层（ctxModel），
   * 让标题行恢复显示 model——即使未显式传 model 也能展示默认 model。
   *
   * [HISTORICAL] 99f20da1e 引入三层 fallback 后，renderCall 因拿不到 ctxModel
   * 而 resolveModel 拗错→降级不显示 model。此缓存修复该降级。
   */
  ctxModel?: ModelInfo;
}

// ============================================================
// ModelConfigService
// ============================================================

/**
 * 配置 + 模型解析 Service。进程级单例。
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │  globalConfig（~/.pi/.../config.json，仅 maxConcurrent）│
 *   │  agentRegistry（agent .md 发现 + frontmatter）         │
 *   │  modelRegistry（SDK 注入的可用模型）                    │
 *   │                                                      │
 *   │  resolveModel: override → agentConfig → 主 agent model │
 *   └──────────────────────────────────────────────────────┘
 */
export class ModelConfigService {
  private globalConfig: SubagentsGlobalConfig;
  private readonly agentRegistry: AgentRegistry;
  private readonly agentRegistryDir: string;
  /** discovery 加载器（resources_discover 时重新读，喂主 agent skill）。 */
  private readonly discoveryLoader: DiscoveryConfigLoader | undefined;
  private modelRegistry: ModelRegistryLike | null = null;
  private _sessionId: string | undefined;
  /** 主 agent 当前 model 缓存（session_start 注入，model_select 刷新）。 */
  private _ctxModel: ModelInfo | undefined;

  /** 包内 builtin agent（agents/*.md，优先级最低，被用户覆盖）。 */
  private readonly builtinRegistry = createPackageBuiltinRegistry();

  constructor(init: ModelConfigServiceInit) {
    this.agentRegistryDir = init.agentDir;
    this.discoveryLoader = init.discoveryLoader;
    this.globalConfig = loadGlobalConfig(init.agentDir);
    // agentDirs：discovery 声明的目录（靠前覆盖靠后），空则回退默认 agentDir 单目录
    const agentDirs = this.resolveAgentDirs();
    this.agentRegistry = new AgentRegistry(agentDirs);
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
   * session_start 注入。封装 3 步固定时序：
   *   1. reloadGlobalConfig（复用时拿最新 config）
   *   2. injectModelRegistry（fail-fast：null 抛错）
   *   3. setSessionId
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

    // 3. sessionId + ctxModel 缓存（model_select 后续调 setCtxModel 刷新）
    this._sessionId = init.sessionId;
    this._ctxModel = init.ctxModel;
  }

  /**
   * 刷新主 agent model 缓存。model_select 事件时调用。
   * renderCall 的 resolveModel 读此缓存以显示标题行 model。
   */
  setCtxModel(model: ModelInfo | undefined): void {
    this._ctxModel = model;
  }

  // ── 模型解析（SubagentService.execute 内部调）──────────────

  /**
   * 解析 agent 的模型（三层：override → agentConfig → 主 agent model）。
   *
   * @param agentName     agent 名（查 agentConfig.model override）
   * @param override      调用方显式 override（最高优先级）
   * @param ctxModel      主 agent 当前模型（兜底，直接透传）
   */
  resolveModel(
    agentName: string,
    override?: { model?: string; thinkingLevel?: string },
    ctxModel?: ModelInfo,
  ): ResolvedModel {
    this.assertReady();
    const agentConfig = this.agentRegistry.get(agentName);
    // ctxModel 优先用显式传入（execute 路径），其次用 session 缓存（renderCall 路径）
    return resolveModel(agentConfig, this.modelRegistry!, override, ctxModel ?? this._ctxModel);
  }

  /** 查询 agent 配置（SubagentService 内部判定 defaultBackground 用）。 */
  getAgentConfig(name?: string): AgentConfig | undefined {
    return name ? this.agentRegistry.get(name) : undefined;
  }

  // ── 配置读取（subagent-service 调）────────────────────────

  /** 全局配置深拷贝（调用方拿到副本，改不影响 Service 内部）。 */
  getGlobalConfig(): SubagentsGlobalConfig {
    return structuredClone(this.globalConfig);
  }

  /** 内部：session id 缓存（initModel 注入；当前无消费者，保留供未来 session 作用域需求）。 */
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /** agent 配置目录（SubagentService 构造 store/SessionRunnerContext 时读）。 */
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
  // globalThis 无 symbol 索引签名，但运行时支持 symbol 键——用 Reflect 安全读写，
  // 避免双重断言。ModelServiceSlot 是运行时保证的固定形状（同文件唯一写入点）。
  let slot = Reflect.get(globalThis, MODEL_SERVICE_SLOT_KEY) as ModelServiceSlot | undefined;
  if (!slot) {
    slot = { current: null };
    Reflect.set(globalThis, MODEL_SERVICE_SLOT_KEY, slot);
  }
  return slot;
}

/** 获取进程单例。session_start 前为 null。 */
export function getModelConfigService(): ModelConfigService | null {
  return getModelServiceSlot().current;
}

/** 设置进程单例（session_start 首次创建时）。 */
export function setModelConfigService(service: ModelConfigService): void {
  getModelServiceSlot().current = service;
}
