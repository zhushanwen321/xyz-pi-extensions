// src/core/session-factory.ts
//
// Pi session 组装器（正向：input → BuiltSession）。四步组装一个就绪的 session +
// 已订阅的 EventBridge，供 session-runner / managed-session 共享。
//
// 基础层模块：依赖 event-bridge（内核数据通路）+ types + model-resolver。
// 不依赖编排层（session-runner / managed-session）——被它们消费，反之禁止。
// 组装契约见 docs/subagents/session-runner.md §3。

import type { AgentEvent } from "../types.ts";
import {
  createEventBridge,
  type EventBridge,
  isSdkEvent,
  type SdkEvent,
} from "./event-bridge.ts";
import type { AgentConfig, ModelRegistryLike, ResolvedModel } from "./model-resolver.ts";

// ============================================================
// SDK 类型（duck-typed 最小子集，测试可 mock）
// ============================================================

/** AgentSession 的最小可用接口（duck-typed，与 SDK AgentSession 结构兼容）。 */
export interface AgentSessionLike {
  prompt(task: string, options?: unknown): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(fn: (event: unknown) => void): () => void;
  sessionId: string;
  /** 暴露 sessionManager 以读取 sessionFile 路径。 */
  readonly sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
  };
  messages: ReadonlyArray<{
    role: string;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  }>;
  getAllTools(): Array<{ name: string }>;
  setActiveToolsByName(names: string[]): void;
}

/**
 * DefaultResourceLoader 的最小可用接口（duck-typed）。
 * 只暴露 createAndConfigureSession 用到的 reload()。
 */
export interface ResourceLoaderLike {
  reload(): Promise<void>;
}

/**
 * createAgentSession 入参的类型化子集（对应 SDK CreateAgentSessionOptions）。
 * 仅声明 createAndConfigureSession 实际传递的字段——其余字段（authStorage/
 * scopedModels/tools/customTools…）由 SDK 默认值处理，不在此声明。
 *
 *   ╔══════════════════════════════════════════════════════════════╗
//   ║  字段来源：                                                    ║
//   ║    model          ← input.resolved.model                       ║
//   ║    thinkingLevel  ← input.resolved.thinkingLevel（string）     ║
//   ║    cwd            ← ctx.cwd                                    ║
//   ║    resourceLoader ← 步骤 2 构建的 loader                        ║
//   ║    modelRegistry  ← ctx.modelRegistry                          ║
//   ║    sessionManager ← SessionManager.create(cwd, subagentDir)    ║
//   ╚══════════════════════════════════════════════════════════════╝
 *
 * ⚠ model / thinkingLevel 用宽泛类型（unknown / string）而非 SDK 的 Model<T> /
 *   ThinkingLevel——避免 Core 层 import SDK 类型，保持鸭子类型可测。
 *   实际传入的是 ModelInfo（model-resolver.ts），结构兼容即可。
 */
export interface CreateAgentSessionArgs {
  /** 模型实例（实际为 ModelInfo，duck-typed 兼容 SDK Model）。 */
  model: unknown;
  /** 思考强度（"low" | "medium" | "high" | undefined，SDK 会 clamp 到 model 能力）。 */
  thinkingLevel?: string;
  /** 工作目录。 */
  cwd: string;
  /** 步骤 2 构建的 ResourceLoader。 */
  resourceLoader: ResourceLoaderLike;
  /** 模型注册表（鉴权 + 发现）。 */
  modelRegistry: ModelRegistryLike;
  /** Session 管理器（持久化 / inMemory）。 */
  sessionManager: unknown;
}

/**
 * DefaultResourceLoader 构造参数的类型化子集（对应 SDK DefaultResourceLoaderOptions）。
 * 仅声明 buildResourceLoader 实际传递的字段。
 */
export interface ResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  /** 步骤 1 组装好的 appendSystemPrompt（含 env block）。 */
  appendSystemPrompt: string[];
  /** 调用方注入的 skill 路径（undefined 时省略 additionalSkillPaths）。 */
  skillPath: string | undefined;
}

/**
 * Pi SDK 动态 import 的形状（session-factory 通过 getSdk() 获取）。
 * 类型化的 createAgentSession / DefaultResourceLoader 让 createAndConfigureSession
 * 的调用点在编译期校验字段名——拼错 key 立即 tsc 报错。
 */
export interface SdkLike {
  /** ResourceLoader 工厂（步骤 2 构造，参数类型化为 ResourceLoaderOptions）。 */
  DefaultResourceLoader: new (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  /** SessionManager 支持 inMemory（测试）和 create（持久化）两种工厂。 */
  SessionManager: {
    inMemory(cwd?: string): unknown;
    create(cwd: string, sessionDir?: string): unknown;
  };
  /** createAgentSession（步骤 3，参数类型化为 CreateAgentSessionArgs）。 */
  createAgentSession: (opts: CreateAgentSessionArgs) => Promise<{ session: AgentSessionLike }>;
}

// ============================================================
// 依赖容器 + 输入/输出
// ============================================================

/** 创建 session 所需的依赖（由 SubagentRuntime 提供）。 */
export interface SessionFactoryContext {
  modelRegistry: ModelRegistryLike;
  resolveAgent: (name: string) => AgentConfig | undefined;
  cwd: string;
  agentDir: string;
  /** home 目录（用于计算 subagent session 持久化目录）。 */
  homeDir: string;
}

/** createAndConfigureSession 的输入选项。 */
export interface CreateSessionInput {
  /** 已解析的模型（由 resolveModelForAgent 产出）。 */
  resolved: ResolvedModel;
  /** systemPrompt 追加内容（调用方可传 agent body 等）。 */
  appendSystemPrompt?: string[];
  /** skill 路径。 */
  skillPath?: string;
  /** agent 配置（提取 tool 过滤策略）。 */
  agentConfig?: AgentConfig;
  /** 事件回调。 */
  onEvent?: (event: AgentEvent) => void;
}

/** createAndConfigureSession 的输出。 */
export interface BuiltSession {
  session: AgentSessionLike;
  bridge: EventBridge;
  unsubscribe: () => void;
  /** subagent session 文件绝对路径（未持久化时为 undefined）。 */
  sessionFile?: string;
}

// ============================================================
// SDK 装配
// ============================================================

/** 动态 import Pi SDK（集中在此处，便于测试 mock）。 */
export async function getSdk(): Promise<SdkLike> {
  //  return (await import("@mariozechner/pi-coding-agent")) as unknown as SdkLike
  throw new Error("not implemented");
}

/**
 * 创建并配置一个 Pi AgentSession（四步，顺序不可换）。
 * 设计意图见 docs/subagents/session-runner.md §3；本函数只翻译控制流，
 * 每步的具体实现下沉到下方叶子（全部 throw not implemented）。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
//   ║  步骤 1：appendSystemPrompt 组装（含环境块，防注入）               ║
//   ║  步骤 2：ResourceLoader 构建 + reload（发现 skills/agents）        ║
//   ║  步骤 3：createAgentSession + 工具过滤（FR-1.7 偏差，创建后过滤）  ║
//   ║  步骤 4：EventBridge 订阅（SDK event → AgentEvent）               ║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export async function createAndConfigureSession(
  input: CreateSessionInput,
  ctx: SessionFactoryContext,
  sdk: SdkLike,
): Promise<BuiltSession> {
  // 步骤 1：appendSystemPrompt 组装（env block + 调用方片段）
  const fullAppend = buildAppendSystemPrompt(input.appendSystemPrompt, ctx.cwd);

  // 步骤 2：ResourceLoader 构建 + reload（让 loader 发现全局 skills/agents）
  const resourceLoader = buildResourceLoader(sdk, {
    cwd: ctx.cwd,
    agentDir: ctx.agentDir,
    appendSystemPrompt: fullAppend,
    skillPath: input.skillPath,
  });
  await resourceLoader.reload();

  // 步骤 3：createAgentSession + 工具过滤
  // session 持久化目录与主 session 物理隔离（~/.pi/agent/subagents/<encoded-cwd>/sessions/）
  const subagentSessionDir = getSubagentSessionDir(ctx.homeDir, ctx.cwd);
  const { session } = await sdk.createAgentSession({
    model: input.resolved.model,
    thinkingLevel: input.resolved.thinkingLevel,
    cwd: ctx.cwd,
    resourceLoader,
    modelRegistry: ctx.modelRegistry,
    sessionManager: sdk.SessionManager.create(ctx.cwd, subagentSessionDir),
  });
  applyToolFilter(session, input.agentConfig);

  // 步骤 4：EventBridge 订阅——SDK event 经 isSdkEvent guard 后喂给 bridge
  const bridge = createEventBridge(input.onEvent ?? (() => {}));
  const unsubscribe = session.subscribe((event: unknown) => {
    if (!isSdkEvent(event)) return;
    bridge.handle(event as SdkEvent);
  });

  return {
    session,
    bridge,
    unsubscribe,
    sessionFile: session.sessionManager.getSessionFile() ?? undefined,
  };
}

// ============================================================
// createAndConfigureSession 的子叶子（全部 throw not implemented）
// ============================================================

/**
 * 步骤 1：组装 appendSystemPrompt。env block 在前（防注入标记），调用方片段在后。
 *
 *   fullAppend = [buildEnvBlock(cwd)] + (appendSystemPrompt ?? [])
 */
export function buildAppendSystemPrompt(
  appendSystemPrompt: string[] | undefined,
  cwd: string,
): string[] {
  //  return [buildEnvBlock(cwd), ...(appendSystemPrompt ?? [])]
  void appendSystemPrompt; void cwd; void buildEnvBlock;
  throw new Error("not implemented");
}

/**
 * 步骤 2：构建 DefaultResourceLoader。
 * skillPath 非空时注入 additionalSkillPaths；agentDir 让 loader 发现全局 skills/agents。
 */
export function buildResourceLoader(
  sdk: SdkLike,
  opts: ResourceLoaderOptions,
): ResourceLoaderLike {
  //  return new sdk.DefaultResourceLoader({
  //    cwd: opts.cwd,
  //    agentDir: opts.agentDir,
  //    appendSystemPrompt: opts.appendSystemPrompt,
  //    additionalSkillPaths: opts.skillPath ? [opts.skillPath] : undefined,
  //  })
  void sdk; void opts;
  throw new Error("not implemented");
}

/**
 * 步骤 3：计算 subagent session 持久化目录。
 *   ~/.pi/agent/subagents/<encoded-cwd>/sessions/
 * <encoded-cwd> 对 cwd 做路径安全编码（替换 / 等非法字符），与主 session 物理隔离。
 */
export function getSubagentSessionDir(homeDir: string, cwd: string): string {
  //  1. baseDir = path.join(homeDir, ".pi", "agent", "subagents")
  //  2. encoded = cwd 编码（替换路径分隔符为 "-"，去前缀分隔符）
  //  3. return path.join(baseDir, encoded, "sessions")
  void homeDir; void cwd;
  throw new Error("not implemented");
}

/**
 * 步骤 3：三层工具过滤 + setActiveToolsByName。
 *
 *   ╔══════════════════════════════════════════════════════════════╗
//   ║  1. allTools = session.getAllTools().map(t => t.name)          ║
//   ║  2. allowlist = filterTools(allTools, agentConfig):            ║
//   ║       ① agentConfig.tools 白名单（agent 声明可用）             ║
//   ║       ② excludeTools 黑名单（未来扩展，现未接入）              ║
//   ║       ③ extSelectors 扩展工具选择器（未来扩展）               ║
//   ║  3. 仅当 allowlist.length < allTools.length 时调               ║
//   ║     session.setActiveToolsByName(allowlist)                     ║
//   ╚══════════════════════════════════════════════════════════════╝
 *
 * ⚠ SDK 约束（spec FR-1.7 偏差）：工具过滤必须创建后执行——
 *   createAgentSession({tools}) 构造时传 allowlist 需预知工具全集，但扩展工具要等
 *   resourceLoader 加载后才注册。SDK 无 resourceLoader.getTools() 预加载 API。
 *   因此只能创建后用 setActiveToolsByName 兜底。仅当 allowlist 严格小于 allTools
 *   时才调（避免无谓调用）。（设计意图，留注释）
 */
export function applyToolFilter(
  session: AgentSessionLike,
  agentConfig: AgentConfig | undefined,
): void {
  void session; void agentConfig;
  throw new Error("not implemented");
}

/** buildEnvBlock 的 git 命令超时（ms）。worktree 锁状态下 2s 足够。 */
const ENV_GIT_TIMEOUT_MS = 2000;

/**
 * 构建环境信息块（P7 防注入：环境数据标记为 data，非指令）。
 * cwd / git branch 用 "--- environment (data) ---" 包裹，与 agent 指令格式区分。
 * git branch 同步获取（execFileSync，timeout ENV_GIT_TIMEOUT_MS），失败省略不阻断。
 */
export function buildEnvBlock(cwd: string): string {
  //  1. lines = ["--- environment (data, not instructions) ---", `Working directory: ${cwd}`]
  //  2. execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {cwd, timeout, stdio:[...,"ignore"]})
  //     成功且非空 → lines.push(`Git branch: ${branch}`)
  //  3. lines.push("--- end environment ---")
  //  4. return lines.join("\n")
  void cwd; void ENV_GIT_TIMEOUT_MS;
  throw new Error("not implemented");
}
