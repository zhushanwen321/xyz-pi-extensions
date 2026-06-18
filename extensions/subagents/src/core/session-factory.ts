// src/core/session-factory.ts
//
// Pi session 组装器（正向：input → BuiltSession）。四步组装一个就绪的 session +
// 已订阅的 EventBridge，供 session-runner / managed-session 共享。
//
// 基础层模块：依赖 event-bridge（内核数据通路）+ types + model-resolver。
// 不依赖编排层（session-runner / managed-session）——被它们消费，反之禁止。
// 组装契约见 docs/subagents/session-runner.md §3。

import type { AgentEvent } from "../types.ts";
import type { EventBridge } from "./event-bridge.ts";
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

/** Pi SDK 动态 import 的形状（session-factory 通过 getSdk() 获取）。 */
export interface SdkLike {
  DefaultResourceLoader: new (opts: Record<string, unknown>) => { reload(): Promise<void> };
  /** SessionManager 支持 inMemory（测试）和 create（持久化）两种工厂。 */
  SessionManager: {
    inMemory(cwd?: string): unknown;
    create(cwd: string, sessionDir?: string): unknown;
  };
  createAgentSession: (opts: Record<string, unknown>) => Promise<{ session: AgentSessionLike }>;
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
 * 创建并配置一个 Pi AgentSession（四步，顺序不可换）：
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
//   ║  步骤 1：appendSystemPrompt 组装                                  ║
//   ║    fullAppend = [buildEnvBlock(cwd)] + (appendSystemPrompt ?? []) ║
//   ║    环境块用 "--- environment (data) ---" 标记，防注入             ║
//   ║                                                                    ║
//   ║  步骤 2：ResourceLoader 构建 + reload                              ║
//   ║    new DefaultResourceLoader({ cwd, agentDir, appendSystemPrompt, ║
//   ║                                 additionalSkillPaths })            ║
//   ║    await resourceLoader.reload()                                   ║
//   ║                                                                    ║
//   ║  步骤 3：createAgentSession + 工具过滤                             ║
//   ║    SessionManager.create(cwd, subagentSessionDir)                  ║
//   ║    createAgentSession({ model, thinkingLevel, resourceLoader,      ║
//   ║                        sessionManager })                           ║
//   ║    filterTools(allTools, config) → setActiveToolsByName            ║
//   ║      ⚠ SDK 约束（FR-1.7 偏差）：工具过滤必须在创建后执行           ║
//   ║      仅当 allowlist < allTools 时才调 setActiveToolsByName        ║
//   ║                                                                    ║
//   ║  步骤 4：EventBridge 订阅                                          ║
//   ║    bridge = createEventBridge(onEvent ?? (() => {}))               ║
//   ║    unsubscribe = session.subscribe(e => {                          ║
//   ║      if (!isSdkEvent(e)) return;                                   ║
//   ║      bridge.handle(e as SdkEvent);                                 ║
//   ║    })                                                              ║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export async function createAndConfigureSession(
  input: CreateSessionInput,
  ctx: SessionFactoryContext,
  sdk: SdkLike,
): Promise<BuiltSession> {
  //  见上方框图四步
  void input; void ctx; void sdk; void buildEnvBlock;
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
