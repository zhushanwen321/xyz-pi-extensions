// code-skeleton/types.ts — ⑤骨架（#1 编译基石）
// 跨层共享类型契约。本骨架只含本轮新增/扩展的类型，验证签名自洽 + 接线。
// 完整 types.ts 见 extensions/subagents/src/types.ts（本骨架聚焦 fork/worktree 新增契约）。

// ============================================================
// 执行状态机（#2/D-006: crashed 新终态）
// ============================================================

/** 唯一执行状态。crashed 是 D-006 新增终态（kill -9/OOM/断电，启动期检测）。 */
export type ExecutionStatus = "running" | "done" | "failed" | "cancelled" | "crashed";

// ============================================================
// sidecar 数据类型（#4 WorktreeHandle / #13 AliveMarker）
// ============================================================

/**
 * Worktree 句柄 VO（#4）—— immutable。
 * create 时缓存 baseCommit，cleanup/collectPatch 复用。
 * Object.isFrozen 守卫不可变（AC-4.13）。
 */
export interface WorktreeHandle {
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
}

/** .alive sidecar 内容（#13）。startedAt 用于 24h 软超时兜底（D-021 pid 复用）。 */
export interface AliveMarker {
  pid: number;
  id: string;
  startedAt: number;
}

/** collectPatch 返回（D-020 合并自 PatchCollector）。failed=true 时调用方须跳过 cleanup（D-022）。 */
export interface PatchResult {
  patchFile: string | undefined;
  failed: boolean;
}

/** resolveSessionContext 输入（#3 SCR 纯函数）。 */
export interface ResolveInput {
  fork?: boolean;
  worktree?: boolean;
  cwd?: string;
  mainCwd: string;
  mainSessionFile?: string;
  parentForkDepth?: number;
}

/** resolveSessionContext 输出（#3）。 */
export interface SessionContext {
  shouldFork: boolean;
  forkSource: string | undefined;
  effectiveCwd: string;
  sessionDir: string;
}

/** fork 深度超限错误（D-007 depth ≤ 10）。 */
export class ForkDepthExceededError extends Error {
  constructor(public readonly depth: number) {
    super(`fork depth ${depth} exceeds limit 10 (D-007)`);
    this.name = "ForkDepthExceededError";
  }
}

/** 脏工作树错误（#4 clean tree 前置校验）。 */
export class DirtyWorktreeError extends Error {
  constructor(public readonly cwd: string) {
    super(`working tree not clean at ${cwd} (stash or commit first)`);
    this.name = "DirtyWorktreeError";
  }
}

// ============================================================
// SessionRunnerContext 扩展（#6/D-012③: 拆 cwd）
// ============================================================

/**
 * SessionRunner 的依赖注入容器。
 * D-012③: 现有 cwd 语义收窄为 effectiveCwd（子 agent 实际跑的目录），
 * 新增 mainCwd（sessionDir 编码 + fork source 用）+ mainSessionFile（fork source）。
 */
export interface SessionRunnerContext {
  /** 子 agent 实际运行目录（worktree 时=worktreePath，否则=mainCwd）。 */
  effectiveCwd: string;
  /** 主 agent cwd（sessionDir 编码用，D-004）。 */
  mainCwd: string;
  /** 主 agent session 文件（fork source，#9 缓存）。 */
  mainSessionFile: string | undefined;
  agentDir: string;
  sdk: SdkLike;
}

/** RunOptions 扩展（#6/#8: per-task fork/worktree 意图，CC-1）。 */
export interface RunOptions {
  fork?: boolean;
  worktree?: boolean;
  parentForkDepth?: number;
  task: string;
  signal?: AbortSignal;
}

/** ExecuteOptions 扩展（#8: per-task 意图，与 StartParam 对齐，CC-2）。 */
export interface ExecuteOptions {
  task: string;
  fork?: boolean;
  worktree?: boolean;
  cwd?: string;
  agent?: string;
}

// ============================================================
// ExecutionRecord 扩展（#4/#7: worktreeHandle 运行期载体，CC-3）
// ============================================================

/** 运行期状态对象（节选 fork/worktree 相关字段）。 */
export interface ExecutionRecord {
  readonly id: string;
  status: ExecutionStatus;
  sessionFile?: string;
  /** worktree 句柄——create 时回填，cleanup 后可清（CC-3）。 */
  worktreeHandle?: WorktreeHandle;
  controller?: AbortController;
}

// ============================================================
// SDK duck-typed 接口（D-016/D-018: forkFrom 静态 + createBranchedSession 实例）
// ============================================================

/**
 * Pi SDK 动态 import 的形状（getSdk 获取）。
 * D-016: SdkLike.SessionManager 加 forkFrom（静态）声明——沿用仓库鸭子类型（与 inMemory/create 同块）。
 * D-018: forkSession 优先 createBranchedSession（实例，体积更小），forkFrom 仅降级。
 */
export interface SdkLike {
  SessionManager: {
    inMemory(cwd?: string): unknown;
    create(cwd: string, sessionDir?: string): unknown;
    /** D-016/D-018 降级：静态 forkFrom（全量复制 source entries，session-manager.ts:1434）。 */
    forkFrom(sourcePath: string, cwd: string, sessionDir?: string): unknown;
    open(sessionFile: string): SessionManagerInstance;
  };
  createAgentSession: (opts: CreateAgentSessionArgs) => Promise<{ session: AgentSessionLike }>;
}

/**
 * SessionManager 实例端鸭子类型（D-016: createBranchedSession 实例方法声明）。
 * 注意：forkFrom 是静态（SdkLike.SessionManager 块），createBranchedSession 是实例（本块）——位置区别（R2 F-6）。
 */
export interface SessionManagerInstance {
  getSessionFile(): string | undefined;
  getSessionId(): string;
  appendCustomEntry(customType: string, data?: unknown): string;
  /** D-018 优先：实例方法，原地 mutate this.sessionId/sessionFile/fileEntries，返回新文件路径。 */
  createBranchedSession(leafId: string): string | undefined;
}

/** AgentSession 最小接口（节选）。 */
export interface AgentSessionLike {
  prompt(task: string): Promise<void>;
  subscribe(fn: (event: unknown) => void): () => void;
  dispose(): void;
  sessionId: string;
  readonly sessionManager: SessionManagerInstance;
}

/** createAgentSession 入参（节选）。 */
export interface CreateAgentSessionArgs {
  cwd: string;
  sessionManager: unknown;
}

// ============================================================
// 投影类型（#1/#12/D-023: externalInstance 独立字段，不污染 ExecutionStatus）
// ============================================================

/** /subagents list 展示单元（节选）。D-023: externalInstance 独立字段，status 仍 running。 */
export interface SubagentRecord {
  id: string;
  status: ExecutionStatus;
  /** D-023: 跨实例 running-elsewhere 投影标志（status 保持 running，不加 __external）。 */
  externalInstance?: boolean;
  sessionFile?: string;
  /** worktree 路径投影（只暴露 path）。 */
  worktreeHandle?: { path: string };
}
