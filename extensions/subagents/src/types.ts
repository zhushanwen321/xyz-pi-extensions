// src/types.ts
//
// 注意：不从 @mariozechner/pi-coding-agent re-export Model/Usage。
// vitest mock stub（shared/types/mariozechner/index.d.ts）未导出这些类型，
// re-export 会导致 "Module has no exported member" 编译错误。
// 改为自定义最小结构（duck-typed），与 SDK 运行时对象兼容。

/**
 * 子 agent 不应继承的编排层 tool（防止无限嵌套）。
 * FR-6.2: 注入到 tool-filter 的排除逻辑中。
 */
export const EXCLUDED_TOOL_NAMES: readonly string[] = [
  "workflow_run",
  "workflow_pause",
  "workflow_abort",
  "workflow_lint",
  "subagent",
];

/** FR-1.2: eventLog ring buffer 上限（每 agent） */
export const MAX_EVENT_LOG_ENTRIES = 20;

/** FR-1.1b: turn 摘要最大字符数 */
export const TURN_SUMMARY_MAX = 80;

/** FR-3.0: _completedAgents Map 上限 */
export const COMPLETED_AGENTS_MAX = 50;

/** ADR-024 L1: history.jsonl 记录上限（FIFO 淘汰） */
export const HISTORY_MAX_RECORDS = 500;

/** ADR-024 L2: subagent session 文件 TTL（天数） */
export const SESSION_FILE_TTL_DAYS = 30;

/** ADR-024: taskPreview / resultPreview 最大字符数 */
export const PERSISTED_PREVIEW_MAX = 200;

/** FR-1.1b: text_output 切片阈值（累计字符数达此值产生一条 log entry） */
export const TEXT_OUTPUT_CHUNK = 100;
/** FR-1.1a: thinking 切片阈值（累计字符数达此值产生一条 log entry） */
export const THINKING_CHUNK = 100;
/** FR-1.1b: text_output / thinking label 最大字符数（切片后截断展示） */
export const EVENT_LOG_LABEL_MAX = 100;

// ============================================================
// FR-1.1: AgentEventLogEntry（事件日志条目）
// ============================================================

/**
 * 记录每条事件的可展示信息。与 AgentEvent 不同：
 * - ts 由 updateWidgetFromEvent 内 Date.now() 生成（AgentEvent 无此字段）
 * - label 已折叠为可展示字符串（toolName + args 摘要 / turn 文本摘要）
 */
export interface AgentEventLogEntry {
  readonly type: "tool_start" | "tool_end" | "turn_end" | "text_output" | "thinking";
  readonly label: string;
  readonly ts: number;
  readonly status?: "running" | "done" | "failed";
}

// ============================================================
// Model 最小接口（duck-typed，与 SDK Model<any> 运行时兼容）
// ============================================================
export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  contextWindow?: number;
}

// ============================================================
// FR-1.1.1: RunAgentOptions
// ============================================================
export interface RunAgentOptions {
  /** Task prompt — 发送给 agent 的任务描述 */
  task: string;
  /** Agent 名称（从 AgentRegistry 解析 systemPrompt、model 等） */
  agent?: string;
  /** 模型 "provider/modelId" 格式（覆盖配置链解析结果） */
  model?: string;
  /** Thinking level */
  thinkingLevel?: string;
  /** 最大 agent turns（超出时 soft limit + hard abort） */
  maxTurns?: number;
  /** Soft limit 后的 grace turns（默认 2） */
  graceTurns?: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
  /** Skill 路径（注入到 session 的 resourceLoader.additionalSkillPaths） */
  skillPath?: string;
  /** Structured-output schema（拼入 task prompt 末尾 + 追踪 structured-output tool 调用） */
  schema?: Record<string, unknown>;
  /** System prompt 追加内容（注入到 resourceLoader.appendSystemPrompt） */
  appendSystemPrompt?: string[];
  /** 事件回调 */
  onEvent?: (event: AgentEvent) => void;
  /** 并发池覆盖（不传则用全局 pool） */
  pool?: ConcurrencyPool;
  /** 优先级（0=最高，默认 Infinity=无优先级） */
  priority?: number;
  /** P1: 内部标志——跳过 widget 注册（background 调 runAgent 时用，避免双重记录） */
  _skipWidget?: boolean;
  /** Wave 2: 调用方预创建的 AgentExecutionState。传入时 runAgent 用它累积事件
   * （替代内部创建 widgetState），消灭 sync 路径 eventLog 双构建。
   * 调用方持有同一引用即可在 onUpdate 回调中读取最新状态。 */
  state?: import("./state/execution-state.ts").AgentExecutionState;
}

// ============================================================
// FR-1.1.2: AgentResult
// ============================================================
/** Round 5 SUG#11: 重命名为 AgentToolCallEntry——subagents 内部 tool call 记录类型。
 *  与 workflow domain/state.ts 的 ToolCallEntry { name; input } 结构完全不同，
 *  同名易让维护者误以为可互换。保持内部 type alias 兼容已有调用方。 */
export type ToolCallEntry = AgentToolCallEntry;
export interface AgentToolCallEntry {
  toolName: string;
  /** 工具调用时的原始参数（来自 tool_execution_start.args），用于 UI 展示调用预览 */
  args?: unknown;
  result?: { content: Array<{ type: string; text?: string }>; details?: unknown };
  isError: boolean;
}

export interface AgentResult {
  text: string;
  /**
   * 结构化产物（artifacts）。
   *
   * 当调用方传入 `schema`（RunAgentOptions.schema / ManagedSession 不支持）且
   * agent 调用了 `structured-output` tool 时，此处是该 tool 返回的解析后 JSON
   * 对象（取自 tool 结果的 `details` 字段）；否则为 undefined。
   *
   * 给 AI / 调用方的使用指南：
   * - 传 `schema` 参数可约束子 agent 返回结构化 JSON（而非自由文本）。
   *   runAgent() 会把 schema 拼成 `MANDATORY: Structured Output Requirement`
   *   指令附在 task 末尾，并追踪 `structured-output` tool 调用。
   * - `parsedOutput` 就是子 agent 回传的 artifacts（如 `{issues:[...], summary}`、
   *   `{findings, recommendation}`、`{filesChanged, diffSummary}`）。
   * - 适合需要可编程消费结果的场景：代码审查报告、调研结论、diff 摘要、
   *   结构化决策记录。
   * - 不传 schema 时，使用 `text` 字段拿自由文本输出。
   * - 如果 agent 未调用 structured-output tool（忘记/不可用），parsedOutput
   *   为 undefined，应回退到 text。
   */
  parsedOutput?: unknown;
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId: string;
  /** ADR-024 L2: subagent session 文件绝对路径（持久化时存在） */
  sessionFile?: string;
  /**
   * V4: worktree 隔离执行的结果信息。
   * 当 agent 配置 isolation:"worktree" 且 worktree 中有变更（含 agent 自提交）时存在。
   * branch 为保留的分支名，用户可 `git merge <branch>` 合入。hasChanges=false 时 branch 为 undefined。
   */
  worktree?: { branch?: string; hasChanges: boolean };
  toolCalls: AgentToolCallEntry[];
}

// ============================================================
// Background fire-and-forget（参考 tintinweb/pi-subagents 的 wait:false）
// ============================================================
export type BackgroundStatusKind = "running" | "done" | "failed" | "cancelled";

/** startBackground() 立即返回的句柄（调用方可后续查询） */
export interface BackgroundHandle {
  readonly id: string;
  readonly status: BackgroundStatusKind;
}

/** getBackground() 返回的完整状态（含结果） */
export interface BackgroundStatus extends BackgroundHandle {
  /** 完成时的 AgentResult（status=done/failed 时存在） */
  result?: AgentResult;
  /** 失败原因（status=failed/cancelled 时存在） */
  error?: string;
  /** 启动时间（ms epoch） */
  startedAt: number;
  /** 结束时间（ms epoch，未结束时 undefined） */
  endedAt?: number;
  /** FR-3.0: 事件日志（widget 淺出后留存，供 /subagents list 详情使用） */
  eventLog?: AgentEventLogEntry[];
  /** FR-3.0a: agent 名（列表 "Agent" 列数据源） */
  agent?: string;
  /** live turn count（running 时累积，供 poll 路径展示） */
  turns?: number;
  /** live token count（running 时累积，供 poll 路径展示） */
  totalTokens?: number;
}

/**
 * Background 选项。继承 RunAgentOptions（task/agent/model 等），
 * 额外支持完成回调。后台任务用独立的 AbortController（可用 signal 覆盖）。
 */
export interface BackgroundOptions extends RunAgentOptions {
  /** 任务完成（成功/失败/取消）时回调。与 pi.events 'subagents:bg:done' 二选一或都有 */
  onComplete?: (status: BackgroundStatus) => void;
  /** FR-2.5: 执行中事件回流（使对话流 block 实时刷新）。
   * Wave 1: 回流完整的 SubagentToolDetails（由 executionStateToDetails 投影），
   * 消灭 tool 层手工构造 details 的 6 个构造点之一。 */
  onUpdate?: (details: import("./tui/subagent-render.ts").SubagentToolDetails) => void;
}

// ============================================================
// ADR-024: PersistedAgentRecord（L1 history.jsonl 行格式）
// ============================================================

/**
 * history.jsonl 单行记录。统一 sync + background 两路写入。
 * 不含完整 messages（那在 L2 session 文件中），只存索引 + 预览。
 */
export interface PersistedAgentRecord {
  readonly id: string;
  readonly agent: string;
  status: "done" | "failed" | "cancelled";
  /** 执行模式 */
  mode: "sync" | "background";
  /** 任务短预览（截断至 PERSISTED_PREVIEW_MAX） */
  taskPreview: string;
  startedAt: number;
  endedAt?: number;
  turns?: number;
  totalTokens?: number;
  error?: string;
  /** 结果文本预览（截断） */
  resultPreview?: string;
  /** L2 关联：subagent session 文件名（basename，不含目录） */
  sessionFile?: string;
  /** 执行时 cwd（跨项目历史区分） */
  cwd: string;
}

// ============================================================
// FR-3.0: CompletedAgentRecord（sync agent 归档记录）
// ============================================================

/**
 * 已完成的 sync agent 归档记录。widget linger 淡出前从 WidgetAgentState 转移。
 * 留存上限 COMPLETED_AGENTS_MAX（FIFO 淘汰最旧）。
 */
export interface CompletedAgentRecord {
  readonly id: string;
  readonly agent: string;
  status: "done" | "failed" | "cancelled";
  eventLog: AgentEventLogEntry[];
  turns?: number;
  totalTokens?: number;
  result?: AgentResult;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

// ============================================================
// FR-8.2: AgentEvent（subagents 对外统一事件 union）
// ============================================================
export type AgentEventType =
  | "tool_start"
  | "tool_end"
  | "text_delta"
  | "thinking_delta"
  | "turn_end"
  | "message_end"
  | "compaction"
  | "error";

export type AgentEvent =
  | { type: "tool_start"; toolName: string; args?: unknown }
  | { type: "tool_end"; toolName: string; result?: AgentToolCallEntry["result"]; isError: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "turn_end" }
  | { type: "message_end"; usage: AgentResult["usage"] }
  | { type: "compaction" }
  | { type: "error"; error: string };

// ============================================================
// FR-1.2: ManagedSession
// ============================================================
export interface ManagedSession {
  prompt(task: string, options?: { maxTurns?: number; signal?: AbortSignal }): Promise<AgentResult>;
  steer(message: string): void;
  abort(): void;
  dispose(): void;
  readonly sessionId: string;
  readonly alive: boolean;
}

export interface ManagedSessionOptions {
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  onEvent?: (event: AgentEvent) => void;
}

// ============================================================
// FR-2: Agent 配置（frontmatter + builtin）
// ============================================================
export type AgentSource = "project" | "user" | "package" | "local" | "builtin";

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  /** frontmatter 中的 model 字段（"provider/modelId" 格式），可选 */
  model?: string;
  /** 候选模型列表，fallback 链用 */
  modelCandidates?: string[];
  description?: string;
  /** builtin tool 策略：undefined=全部，[]=无，string[]=白名单 */
  builtinTools?: string[];
  /** extension tool 策略：true=全部，false=无，string[]=白名单 */
  extensions?: boolean | string[];
  /** 明确排除的 tool 名 */
  excludeTools?: string[];
  /** skills 列表 */
  skills?: string[];
  /** category（推断用） */
  category?: string;
  /** ext: 选择器：精细控制扩展工具暴露（ext:foo 或 ext:foo/bar） */
  extSelectors?: ExtSelectors;
  /** 隔离模式：undefined=原地运行，"worktree"=git worktree 副本 */
  isolation?: "worktree";
  /** FR-O2.1: 该 agent 默认用 background 执行（LLM 未显式传 wait 时生效）。默认 false */
  defaultBackground?: boolean;
  source: AgentSource;
  filePath?: string;
}

/**
 * ext: 工具选择器（参考 tintinweb agent-runner parseExtSelectors）。
 * extNames = 允许的扩展名集合；narrowing = 扩展名 → 只暴露的 tool 名集合。
 * 例：ext:foo → extNames={foo}; ext:foo/bar → extNames={foo}, narrowing={foo:{bar}}
 */
export interface ExtSelectors {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
}

// ============================================================
// FR-3 / FR-4.1: 配置合并 + 模型解析结果
// ============================================================
export interface ResolvedModel {
  /** Model 对象（已通过 modelRegistry.find 验证可用） */
  model: ModelInfo;
  /** thinkingLevel 字符串（已通过 model.thinkingLevelMap 验证） */
  thinkingLevel?: string;
  /** 解析来源（调试/日志用） */
  source: "param" | "per-agent" | "per-category" | "category-default" | "agent-default" | "global-fallback" | "env";
}

// ============================================================
// FR-4.5: Category
// ============================================================
export interface CategoryDefinition {
  label: string;
  model: string;
  thinkingLevel?: string;
}

// ============================================================
// FR-4.6: 全局配置
// ============================================================
export interface SubagentsGlobalConfig {
  version: number;
  yoloByDefault: boolean;
  maxConcurrent: number;
  categories: Record<string, CategoryDefinition>;
  agentCategoryOverrides: Record<string, string>;
  fallback: { model: string; thinkingLevel?: string };
}

// ============================================================
// FR-4.7: 会话模型状态
// ============================================================
export interface SessionModelState {
  yoloMode: boolean;
  perAgent: Record<string, { model: string; thinkingLevel?: string }>;
  perCategory: Record<string, { model: string; thinkingLevel?: string }>;
}

// ============================================================
// FR-5: Fork
// ============================================================
export interface ForkOptions {
  maxExchanges?: number;
  maxTokens?: number;
}

export interface ForkResult {
  /** 拼接好的父对话文本（已按截断策略处理） */
  context: string;
  /** 实际提取的轮数 */
  exchangeCount: number;
  /** 是否因 token 限制截断 */
  truncated: boolean;
}

// ============================================================
// FR-6: Tool 过滤
// ============================================================
export interface ToolInfo {
  name: string;
}

export interface ToolFilterConfig {
  builtinTools?: string[];
  extensions?: boolean | string[];
  excludeTools?: string[];
  /** ext: 选择器（精细控制扩展工具暴露）。有值时扩展工具变为 opt-in allowlist */
  extSelectors?: ExtSelectors;
}

export interface ToolFilterResult {
  /** 允许的 tool allowlist（传给 createAgentSession.tools） */
  allowedTools: string[] | undefined;
  /** 被排除的 tool 名（日志用） */
  excludedTools: string[];
}

// ============================================================
// FR-7: 并发池（接口定义，实现在 pool/concurrency-pool.ts）
// ============================================================
export interface ConcurrencyPool {
  acquire(priority?: number): Promise<void>;
  release(): void;
  readonly activeCount: number;
  readonly queueLength: number;
  readonly maxConcurrent: number;
}

// ============================================================
// FR-14.7: Hooks（v1 预留接口）
// ============================================================
export interface SubagentHooks {
  beforeRun?: (opts: RunAgentOptions) => RunAgentOptions | Promise<RunAgentOptions>;
  afterRun?: (result: AgentResult, opts: RunAgentOptions) => void;
  onError?: (error: Error, opts: RunAgentOptions) => void;
}
