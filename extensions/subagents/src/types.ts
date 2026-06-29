// src/types.ts
//
// 跨层共享的核心类型契约。Core/Runtime/TUI 三层均可 import 本文件。
//
// 分层铁律：
//   - Core 不 import Runtime/TUI（零 Pi 依赖，可单测）
//   - Runtime 编排 Core，产出 Details/Record 给 TUI
//   - TUI 只读 Record/Details 快照，永不持有可变引用

import type { AgentConfig, ModelInfo, ModelRegistryLike, ResolvedModel } from "./core/model-resolver.ts";

// ============================================================
// 全局常量
// ============================================================

/**
 * 未显式指定 agent 时的兌底名。
 *
 * 必须是真实存在、可被 agentRegistry 发现的 agent（用户 agentDir 内置的通用 agent）。
 * Service 层（resolveIdentity）与 TUI 层（extractAgentName）共用此常量，保证
 * 「调用时显示的名」与「实际加载的 agent.md」一致。
 *
 * [HISTORICAL] 旧实现两处各硬编码：service 用 "default"（虚构名），format 用
 * "worker"（真实但不是兌底语义）。导致不传 agent 时，block 标题显示 worker，
 * 但实际执行兌底逻辑不一致。统一为 general-purpose 后名实相符。
 */
export const DEFAULT_AGENT_NAME = "general-purpose";

// ============================================================
// 执行状态机
// ============================================================

/** 唯一执行状态。所有路径（sync/bg/poll）共用。crashed 为进程崩溃终态（重建推断）。 */
export type ExecutionStatus = "running" | "done" | "failed" | "cancelled" | "crashed";

/** 执行模式。sync = 调用方 await；background = 调用方立即拿 handle 返回。 */
export type ExecutionMode = "sync" | "background";

// ============================================================
// Agent 事件流（Core → Record 的唯一更新驱动）
// ============================================================

/**
 * Pi session.subscribe 上报的事件。Runtime 把它喂给 updateFromEvent。
 *
 * 设计：AgentEvent 携带 updateFromEvent 收口进 record 所需的**全部数据**——
 * tool_end 带 result（供 turn.toolCalls 存完整 ToolCall），无需翻译层旁路累积。
 */
export type AgentEvent =
  | { type: "tool_start"; toolName: string; args?: unknown }
  | { type: "tool_end"; toolName: string; args?: unknown; result?: ToolCallResult; isError?: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "turn_end"; summary?: string }
  | { type: "message_end"; usage?: AgentUsage; error?: string }
  | { type: "compaction" }
  | { type: "error"; message: string };

/** token 用量（message_end 时由 Core 累加进 record.totalTokens）。 */
export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** 本 message 的成本（USD，来自 SDK usage.cost.total）。可选——无成本数据时缺省。 */
  cost?: number;
}

export interface AgentUsageTotal extends AgentUsage {
  /** 上述四项之和。投影时不再手工求和。 */
  total: number;
  /** 累计成本（USD，来自 SdkEvent.message.usage.cost.total 求和）。无成本数据时为 0。 */
  cost: number;
}

/**
 * eventLog 条目（getEventLog 派生产出的元素）。所有字段 readonly。
 *
 * text_output / thinking 类型已移除——它们是 100 字切片的碎片副产物，
 * 现在完整内容收口在 record.turns[] 里，eventLog 只承载离散语义事件
 * （tool 调用 / turn 边界 / error）。
 */
export interface AgentEventLogEntry {
  readonly type: "tool_start" | "tool_end" | "turn_end" | "error";
  readonly label: string;
  /** 事件发生的墙钟时间戳（Date.now()，ms）。由 getEventLog 从 turns[] 派生时记录。 */
  readonly ts: number;
  readonly status?: "running" | "done" | "failed";
}

// ============================================================
// Agent 结果（一次执行的 outcome）
// ============================================================

/**
 * SDK AgentSessionEvent 的最小可用子集（duck-typed，避免强耦合 SDK 类型）。
 * 由 session-runner 内部消费，驱动累积器和事件翻译。
 */
export type SdkEvent = {
  type: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
  message?: {
    usage?: AgentUsage & { cost?: { total: number } };
    stopReason?: string;
    errorMessage?: string;
  };
  assistantMessageEvent?: { type?: string; delta?: string };
  reason?: string;
};

/** tool 调用结果（tool_execution_end 时累积，含 structured-output 的 details）。 */
export interface ToolCallResult {
  content?: unknown[];
  details?: unknown;
}

/**
 * tool 调用（导出的纯净数据形状，不含内部状态）。
 *
 *   tool_start 到达但 tool_end 未到时，调用为进行中；一旦 tool_end 到达，
 *   result/isError 填充完成。对外投影（AgentResult.toolCalls / getAllToolCalls）
 *   一律返回此类型——**不泄漏 running/done/failed 内部状态机**。
 *
 * 进行中状态由 execution-record 内部的 `InternalToolCall`（= ToolCall + _status）承载，
 * 只存在于 record.turns[].toolCalls，跨边界导出时由 getAllToolCalls strip _status。
 */
export interface ToolCall {
  toolName: string;
  args?: unknown;
  result?: ToolCallResult;
  isError?: boolean;
}

/**
 * 内部 ToolCall：在 ToolCall 基础上追加 _status 进行中状态标记与 startedTs 时间戳。
 *
 *   running = tool_start 已收到但 tool_end 未到；
 *   done/failed = tool_end 已到。
 *
 * 仅存在于 ExecutionRecord.turns[].toolCalls（Core 内部可变状态）。
 * 跨边界导出（getAllToolCalls → AgentResult.toolCalls / 持久化）由 getAllToolCalls
 * 映射回 ToolCall（丢弃 _status / startedTs），保证导出形状清洁。
 */
export interface InternalToolCall extends ToolCall {
  _status: "running" | "done" | "failed";
  /** tool_start 到达时的墙钟时间戳（Date.now()，ms）。getEventLog 派生 tool 条目 ts 用。 */
  startedTs: number;
}

/**
 * 一个 turn 的完整内容（ExecutionRecord.turns[] 的元素）。
 *
 * 收口设计：text/thinking 流式累积**完整内容**（非 100 字切片），
 * toolCalls 存完整 ToolCall（含 result + _status 内部状态）。turn_end 到达后 closed=true，
 * 下次 text/thinking/tool 时开新 turn。
 *
 * eventLog / currentActivity / result 均从 turns[] 派生，不再独立存储。
 */
export interface Turn {
  /** 本 turn assistant 正文（text_delta 流式累积，完整）。 */
  text: string;
  /** 本 turn 推理（thinking_delta 流式累积，完整）。 */
  thinking: string;
  /** 本 turn 工具调用（InternalToolCall：含完整 result + _status 进行中标记）。 */
  toolCalls: InternalToolCall[];
  /** 本 turn message_end 的 token 增量（聚合得 totalUsage）。 */
  usageDelta?: AgentUsage;
  /** turn_end 是否已到达。false=正在进行；true=已闭合，下次内容开新 turn。 */
  closed: boolean;
  /** turn_end 到达时的墙钟时间戳（Date.now()，ms）。getEventLog 派生 turn_end 条目 ts 用。 */
  closedTs?: number;
}

/** 一次 session 执行的完整结果。collectResult 产出，写入 Record.outcome。 */
export interface AgentResult {
  text: string;
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId: string;
  toolCalls: ToolCall[];
  usage?: AgentUsageTotal;
  /** /resume /fork 可恢复的 session 文件名（不含目录）。 */
  sessionFile?: string;
  /** schema 模式下，structured-output tool 的 result.details（已通过 schema 校验）。 */
  parsedOutput?: unknown;
}

// ============================================================
// ExecutionRecord —— 唯一状态对象（Core 拥有，Runtime 引用）
// ============================================================

/**
 * 所有执行路径的唯一状态源。
 *
 * 收口设计：一次执行的完整内容（text/thinking/toolCalls/usage）按 turn 收口在
 * `turns: Turn[]` 里。eventLog / currentActivity / result 文本均从 turns[] 派生
 * （getEventLog / getCurrentActivity / getFullText），不再独立存储切片或缓冲。
 *
 * 生命周期：createRecord() 创建 → updateFromEvent() 实时更新（累积进 turns）→
 *           completeRecord() 冻结 → archive 立即移出内存（读时从 session.jsonl 重建）。
 *
 * TUI 永远拿 RecordSnapshot（.slice() 快照），不直接持此可变对象。
 */
/**
 * worktree handle 值对象。Fork 模式下每个子 agent 持有独立 worktree。
 * Object.freeze 守卫保证不可变。
 */
export interface WorktreeHandle {
  /** checkout 目录（子 agent 工作目录，tmpdir 下）。 */
  readonly path: string;
  readonly branch: string;
  readonly baseCommit: string;
  /** 主仓库根目录（cleanup/scan 需要，不再靠路径反推）。 */
  readonly mainCwd: string;
}

/** alive marker：子进程存活标记，用于心跳检测和 crash 推断。 */
export interface AliveMarker {
  readonly pid: number;
  readonly id: string;
  readonly startedAt: number;
}

/** git diff patch 结果。 */
export interface PatchResult {
  readonly patchFile: string;
  readonly failed: boolean;
  /** patch 是否实际写入 patchFile。true=diff 非空且写盘成功；false=空 diff 或写失败。
   *  调用方据此回填 record.patchFile，避免悬空路径（`git apply` 不存在的文件）。 */
  readonly written: boolean;
}

/** resolveAgentIdentity 的入参。 */
export interface ResolveInput {
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
}

/** session-runner 闭包捕获的上下文。 */
export interface SessionContext {
  readonly agentDir: string;
  readonly mainCwd: string;
  readonly sessionDir: string;
  readonly mainSessionFile: string;
}

/** resolveSessionContext 纯函数的入参（#3 SessionContextResolver）。 */
export interface SessionResolveInput {
  fork?: boolean;
  cwd?: string;
  mainCwd: string;
  mainSessionFile?: string;
  parentForkDepth?: number;
  /** agent 配置目录（getSubagentSessionDir 需要）。 */
  agentDir: string;
  /** worktree checkout 路径（来自 WorktreeHandle.path，作为 effectiveCwd）。 */
  worktreePath?: string;
}

/** resolveSessionContext 纯函数的返回值。 */
export interface ResolvedSessionContext {
  readonly shouldFork: boolean;
  readonly forkSource: string | undefined;
  readonly effectiveCwd: string;
  readonly sessionDir: string;
}

/** fork depth 超限错误。 */
export class ForkDepthExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForkDepthExceededError";
  }
}

/** worktree 有未提交变更错误。 */
export class DirtyWorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirtyWorktreeError";
  }
}

export interface ExecutionRecord {
  /** 唯一 ID（sync: "run-N"，bg: "bg-N-xxx"）。 */
  readonly id: string;

  // ── 身份（创建时确定，不可变）──
  readonly agent: string;
  readonly model: string;
  readonly thinkingLevel: string | undefined;
  readonly mode: ExecutionMode;
  readonly task: string;
  readonly startedAt: number;
  /** 创建该 subagent 的主 Pi session ID（session 隔离过滤用）。 */
  readonly parentSessionId: string | undefined;

  // ── 状态（实时更新）──
  status: ExecutionStatus;
  /** 完整执行内容，按 turn 组织。createRecord 初始化为 [空 turn]。 */
  turns: Turn[];
  /** turn 计数（= turns.filter(closed).length，冗余存储供投影直接读）。 */
  turnCount: number;
  totalTokens: number;
  /** 运行期最近一次 error 事件的消息（getEventLog 派生 error 条目用）。 */
  lastError: string | undefined;

  // ── 完成 ──
  endedAt: number | undefined;
  result: string | undefined;
  error: string | undefined;
  /** 完整 AgentResult（含 usage/toolCalls，完成时填）。 */
  agentResult: AgentResult | undefined;

  /** session jsonl 文件名。session 创建成功后由 session-runner.run() 回填（窗口期内 undefined）。 */
  sessionFile?: string;

  /** [MF#3] fork+worktree 模式下子 agent 改动的 patch 文件路径（worktree 外，供调用方应用）。 */
  patchFile?: string;

  /** fork 模式下的 worktree handle（可选）。 */
  worktreeHandle?: WorktreeHandle;

  // ── 控制（仅 background 持有）──
  controller: AbortController | undefined;
}

// ============================================================
// Runtime → TUI 的投影契约
// ============================================================

/**
 * Tool 返回的 details（内层扁平结构）。
 * 由 project(record) 唯一产出——sync/bg 两路径字段一致。
 * 含 mode + sessionFile（供外层 SubagentToolResult 分组 + spinner 判断）。
 *
 * 分层（spec FR-3）：此为**内层**，不感知 action/外层分组。
 * 外层 SubagentToolResult 由 adapter 包裹产出（加 action/subagentId/sessionFile + 分组）。
 */
export interface SubagentToolDetails {
  status: ExecutionStatus;
  mode: ExecutionMode;
  agent: string;
  model: string;
  thinkingLevel: string | undefined;
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;
  eventLog: AgentEventLogEntry[];
  result?: string;
  error?: string;
  /** running 时的当前活动行（tool/thinking/text 优先级）。 */
  currentActivity?: { type: "tool" | "text" | "thinking"; label: string };
  /** schema 模式下，structured-output tool 的 result.details（对齐 workflow agent-pool）。 */
  parsedOutput?: unknown;
  /** session jsonl 文件名（不含目录）。窗口期内可能 undefined（session 尚未创建成功）。 */
  sessionFile?: string;
  /** [MF#3] fork+worktree 模式下子 agent 改动的 patch 文件路径（worktree 外，供调用方应用）。 */
  patchFile?: string;
}

// ============================================================
// Runtime 公共 API 的入参/出参
// ============================================================

/** session-runner 内部上下文（扩展 effectiveCwd/mainCwd/mainSessionFile）。 */
/** session-runner.run() 的入参选项。 */
export interface RunOptions {
  /** 是否使用 fork 模式（创建 worktree 隔离）。 */
  fork?: boolean;
  /** 指定 worktree handle（fork 模式下由外部提供）。 */
  worktree?: WorktreeHandle;
  /** 父级 fork depth（用于深度限制检查）。 */
  parentForkDepth?: number;
}

/** Hub.execute 的入参（sync/bg 共用）。mode 由 Hub 内部判定，不暴露给调用方。 */
export interface ExecuteOptions {
  task: string;
  agent?: string;
  /**
   * 执行模式意图（不直接指定 mode）：
   *   false → background（用户显式要求异步）
   *   true → sync（用户显式要求同步）
   *   undefined → Hub 按 agentConfig.defaultBackground 判定
   * Hub 内部据此 + agent 配置解析出最终 ExecutionMode。
   */
  wait?: boolean;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
  /** sync 模式来自 Pi tool 框架；background 模式 hub 忽略，自建 controller。 */
  signal?: AbortSignal;
  /** 主 agent 当前模型（模型解析第三层兼底）。execute 调用方从 ctx.model 传入。 */
  ctxModel?: ModelInfo;
  /** live 状态回流（对话流 block 实时刷新）。 */
  onUpdate?: (details: SubagentToolDetails) => void;
  /** background 完成回调（sync 不调）。 */
  onComplete?: (record: RecordSnapshot) => void;
  /** fork 模式：创建 worktree 隔离执行。 */
  fork?: boolean;
  /** fork 模式：worktree 隔离（true=创建新 worktree，WorktreeHandle=使用已有）。 */
  worktree?: boolean | WorktreeHandle;
  /** fork 模式：覆盖执行 cwd（默认 mainCwd）。 */
  cwd?: string;
  /** 父级 fork depth（用于深度限制检查，D-007 MAX_FORK_DEPTH=10）。 */
  parentForkDepth?: number;
}

/**
 * execute 返回值。
 *   sync:    { mode:"sync", record, details } —— 调用方 await，record 已 settled。
 *            record 是只读快照（持久化用），details 是 TUI 渲染投影（含 elapsedSeconds/currentActivity/mode/sessionFile）。
 *   background: { mode:"background", subagentId, sessionFile, details } —— 立即返回。
 *            subagentId 供后续 cancel/list 用；sessionFile 窗口期可能 undefined。
 */
export type ExecutionHandle =
  | { mode: "sync"; record: RecordSnapshot; details: SubagentToolDetails }
  | { mode: "background"; subagentId: string; sessionFile: string | undefined; details: SubagentToolDetails };

// ============================================================
// tool action 出参（外层分组，adapter 产出）
// ============================================================

/** list 的 item 结构（8 字段）。 */
export interface SubagentListItem {
  subagentId: string;
  agent: string;
  status: ExecutionStatus;
  mode: ExecutionMode;
  /** 运行秒数（running 态实时计算，终态 endedAt-startedAt）。 */
  duration: number;
  model: string;
  totalTokens: number;
  /** session jsonl 文件名（窗口期内可能 undefined）。 */
  sessionFile?: string;
}

/**
 * sync 执行的内层响应（挂在 SubagentToolResult.syncResponse）。
 *
 * 与 SubagentToolDetails 字段完全一致——liftSync 现为恒等投影（字段零搬运）。
 * 与 SubagentToolDetails 的唯一区别：mode 收窄为字面量 "sync"（sync 路径投影时
 * 必为 "sync"），让 TS 在 adapter 层静态保证 syncResponse 只能来自 sync 路径。
 * 结构兼容 SubagentToolDetails（mode 是其子类型），故 liftSync 可直接 return。
 */
export interface SyncResponse extends SubagentToolDetails {
  mode: "sync";
}

/** background 启动的内层响应（挂在 SubagentToolResult.bgResponse）。 */
export interface BgResponse {
  status: "running";
  mode: "background";
  /** 启动提示文案（"detached, will notify on completion"）。 */
  message: string;
}

/** list 的内层响应（挂在 SubagentToolResult.listResponse）。 */
export interface ListResponse {
  /** items 中 status==="running" 的计数（受 limit 截断如实反映，非全局总数）。 */
  running: number;
  items: SubagentListItem[];
}

/** cancel 的内层响应（挂在 SubagentToolResult.cancelResponse）。 */
export interface CancelResponse {
  cancelled: true;
}

/**
 * Tool 外层出参（renderResult + LLM content JSON 同源）。
 * adapter 唯一产出：领域对象（sync/bg/list/cancel 四选一）+ action/subagentId/sessionFile。
 *
 *   - sync 完成 → syncResponse（最外层 subagentId/sessionFile 有值）
 *   - background 启动 → bgResponse（subagentId 有值；sessionFile 窗口期可能 undefined）
 *   - list → listResponse（最外层 subagentId/sessionFile 为 null，sessionFile 在各 item 内）
 *   - cancel → cancelResponse（subagentId 有值；sessionFile 无意义，可为 null）
 */
/**
 * tool 出参（discriminated union）。action 作为主鉴别字段；
 * action:"start" 分 sync/bg 两个成员（靠 syncResponse / bgResponse 字段区分）。
 * 防止 action↔response 错配（如 {action:"start", listResponse}）——TS 编译期拒绝。
 * sync 成员 subagentId 可 null（streaming 期未知，终态由 adapter 填）。
 */
export type SubagentToolResult =
  | { action: "start"; subagentId: string | null; sessionFile: string | null; syncResponse: SyncResponse }
  | { action: "start"; subagentId: string | null; sessionFile: string | null; bgResponse: BgResponse }
  | { action: "list"; subagentId: null; sessionFile: null; listResponse: ListResponse }
  | { action: "cancel"; subagentId: string; sessionFile: null; cancelResponse: CancelResponse };

// ============================================================
// TUI list 视图的合并 record（4 源 merge 后的形状）
// ============================================================

/** /subagents list 左列展示单元。来自内存(running) 或 session.jsonl 重建(终态)。 */
export interface SubagentRecord {
  id: string;
  agent: string;
  status: ExecutionStatus;
  mode: ExecutionMode;
  startedAt: number;
  /** 创建该 subagent 的主 Pi session ID（session 隔离过滤用）。 */
  parentSessionId: string | undefined;
  endedAt: number | undefined;
  turns: number;
  totalTokens: number;
  model: string;
  thinkingLevel: string | undefined;
  eventLog: AgentEventLogEntry[];
  result?: string;
  error?: string;
  sessionFile?: string;
  /** [MF#3] fork+worktree 模式下子 agent 改动的 patch 文件路径（worktree 外，供调用方应用）。 */
  patchFile?: string;
  /** 外部 Pi 实例（进程隔离模式下由外部启动的子进程）。 */
  externalInstance?: AliveMarker;
  /** fork 模式下的 worktree handle。 */
  worktreeHandle?: WorktreeHandle;
}

// ============================================================
// 配置（global + session）
// ============================================================

/**
 * 全局配置（~/.pi/agent/subagents/config.json）。
 *
 * 模型解析已退化为「主 agent model 优先，仅 override 时查 registry」——
 * 不再有 category/fallback/yolo 字段。config.json 只保留 maxConcurrent
 * （pool 大小）。旧 config.json 中的 categories/fallback 等字段读取时忽略。
 */
export interface SubagentsGlobalConfig {
  version: number;
  maxConcurrent: number;
}

/**
 * 资源发现契约（<agentDir>/subagents/discovery.json）。
 * 宿主（如 xyz-agent GUI）启动 pi 前写入，subagents 在 session_start 与 resources_discover 时读取。
 * 文件缺失/字段缺失时各数组视为空，走默认行为（零破坏）。详见 ADR-025。
 */
export interface DiscoveryConfig {
  version: number;
  /** skill 目录列表（靠前覆盖靠后）。空数组 = 不额外注入，走默认。 */
  skillDirs: string[];
  /** agent .md 目录列表（靠前覆盖靠后）。空数组 = 走默认 getAgentDir()。 */
  agentDirs: string[];
}

// ============================================================
// 只读快照（TUI 消费，永不 mutate）
// ============================================================

/**
 * Record 的只读视图。store.snapshot() 返回。
 * TUI 拿到此类型，保证不会回写 Core 状态。
 *
 * 不含 eventLog——snapshot 的消费点（cancel 判 mode/status、hasRunning 判 mode、
 * toNotifyRecord 取 result/error）均不读 eventLog。需要 eventLog 的场景用 project()
 * 投影的 SubagentToolDetails。需要完整内容用 record.turns[]（Core 内部）。
 */
export interface RecordSnapshot {
  readonly id: string;
  readonly agent: string;
  readonly model: string;
  readonly thinkingLevel: string | undefined;
  readonly mode: ExecutionMode;
  readonly task: string;
  readonly status: ExecutionStatus;
  readonly turns: number;
  readonly totalTokens: number;
  readonly startedAt: number;
  readonly endedAt: number | undefined;
  readonly result: string | undefined;
  readonly error: string | undefined;
  readonly sessionFile: string | undefined;
}

// Re-export 用于 ExecuteOptions 的 agent/model 契约
// ============================================================
// SDK duck-typed 接口（测试可 mock，session-runner 消费）
// ============================================================

/** AgentSession 的最小可用接口（duck-typed，与 SDK AgentSession 结构兼容）。 */
export interface AgentSessionLike {
  prompt(task: string, options?: unknown): Promise<void>;
  steer(message: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(fn: (event: unknown) => void): () => void;
  sessionId: string;
  readonly sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
    /** 写 custom entry（subagent-identity 持久化用）。SDK SessionManager.appendCustomEntry 的 duck-type。 */
    appendCustomEntry(customType: string, data?: unknown): string;
  };
  messages: ReadonlyArray<{
    role: string;
    content?: ReadonlyArray<{ type: string; text?: string }>;
  }>;
  getAllTools(): Array<{ name: string }>;
  setActiveToolsByName(names: string[]): void;
}

/** DefaultResourceLoader 的最小可用接口（duck-typed）。 */
export interface ResourceLoaderLike {
  reload(): Promise<void>;
}

/** createAgentSession 入参的类型化子集（对应 SDK CreateAgentSessionOptions）。 */
export interface CreateAgentSessionArgs {
  model: unknown;
  thinkingLevel?: string;
  cwd: string;
  resourceLoader: ResourceLoaderLike;
  modelRegistry: ModelRegistryLike;
  sessionManager: unknown;
}

/** DefaultResourceLoader 构造参数的类型化子集。 */
export interface ResourceLoaderOptions {
  cwd: string;
  agentDir: string;
  appendSystemPrompt: string[];
  additionalSkillPaths?: string[];
}

/** SessionManager 实例的最小接口（duck-typed，fork 路径消费 SDK 静态方法的返回值）。 */
export interface SessionManagerLike {
  getLeafId(): string | null;
  createBranchedSession(leafId: string): string | undefined;
  getSessionFile(): string | undefined;
  getSessionId(): string;
}

/** Pi SDK 动态 import 的形状（getSdk() 获取）。 */
export interface SdkLike {
  DefaultResourceLoader: new (opts: ResourceLoaderOptions) => ResourceLoaderLike;
  SessionManager: {
    inMemory(cwd?: string): SessionManagerLike;
    create(cwd: string, sessionDir?: string): SessionManagerLike;
    open(sessionFile: string, sessionDir?: string, cwdOverride?: string): SessionManagerLike;
    /** [MF#1] fork 静态方法：从源 session 文件 fork 到目标 cwd，返回 SessionManager。 */
    forkFrom(sourcePath: string, targetCwd: string, sessionDir?: string): SessionManagerLike;
  };
  createAgentSession: (opts: CreateAgentSessionArgs) => Promise<{ session: AgentSessionLike }>;
}

export type { AgentConfig, ResolvedModel };
export type { ModelRegistryLike };
