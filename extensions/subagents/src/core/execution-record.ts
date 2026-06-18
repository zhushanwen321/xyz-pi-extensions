// src/core/execution-record.ts
//
// 唯一执行状态对象 + 唯一创建/更新/完成/投影入口。
//
// 架构原则（见 data-model.md §1）：
//   - createRecord    唯一创建入口（model 创建时必填，消灭 poll 路径 model 丢失）
//   - updateFromEvent 唯一事件更新入口（消灭 eventLog 双构建 + sink reset bug）
//   - completeRecord  唯一完成入口（冻结状态）
//   - project/snapshot/toPersisted 唯一投影入口（三路径字段一致）
//
// Core 层叶子原语：仅依赖 types.ts。零 Pi / Runtime / TUI 依赖。

import type {
  AgentEvent,
  AgentResult,
  ExecutionMode,
  ExecutionRecord,
  PersistedAgentRecord,
  RecordSnapshot,
  SubagentToolDetails,
} from "../types.ts";

// ============================================================
// 常量（值经旧实现 + tests 验证）
// ============================================================

/** eventLog ring buffer 上限。超限移除最旧（while + shift）。 */
const MAX_EVENT_LOG_ENTRIES = 20;
/** text_delta 累积达此阈值推一条 text_output 条目，截断缓冲。 */
const TEXT_OUTPUT_CHUNK = 100;
/** thinking_delta 累积达此阈值推一条 thinking 条目，截断缓冲。 */
const THINKING_CHUNK = 100;
/** eventLog 条目 label 的最大长度（slice 截断，非省略号——保持列宽稳定）。 */
const EVENT_LOG_LABEL_MAX = 100;
/** turn_end 条目 label 的最大长度（取本 turn 累积文本前缀作摘要）。 */
const TURN_SUMMARY_MAX = 80;
/** ms → s 换算。elapsedSeconds 唯一计算点用。 */
const MS_PER_SECOND = 1000;

// ============================================================
// Label 提取（eventLog 构建的伴生逻辑，co-locate 于 Core）
// ============================================================

/**
 * 从 toolName + args 提取 eventLog label（人类可读）。
 *
 *   read/edit/write → "{tool} {basename}"（取 path 参数）
 *   bash            → "{tool} {command 首行}"（截断 + emoji 安全）
 *   web_search      → "{tool} {query}"
 *   web_fetch       → "{tool} {url}"
 *   其他 / 无 args   → 裸 toolName
 *
 * 纯函数（零依赖），由 appendEventLogEntry 在 tool_start/tool_end 时调用。
 * 历史上错放在 tui/format.ts，本层（Core）是唯一运行时调用方，已下沉归位。
 */
export function extractLabelFromArgs(toolName: string, args: unknown): string {
  //  见上方 docstring 的分派规则。args 形状未知需 duck-type guard。
  void toolName; void args;
  throw new Error("not implemented");
}

// ============================================================
// 创建（唯一入口）
// ============================================================

/**
 * 唯一创建入口。identity 字段（agent/model/thinkingLevel/mode/task）一次确定不可变。
 *
 * model 创建时必填——这是 poll 路径 model 丢失的架构修复
 * （旧实现 background record 运行时丢 model，poll 返回缺字段）。
 */
export function createRecord(
  id: string,
  identity: {
    agent: string;
    model: string;
    thinkingLevel?: string;
    mode: ExecutionMode;
    task: string;
    startedAt: number;
    controller?: AbortController;
  },
): ExecutionRecord {
  return {
    id,
    agent: identity.agent,
    model: identity.model,
    thinkingLevel: identity.thinkingLevel,
    mode: identity.mode,
    task: identity.task,
    startedAt: identity.startedAt,

    // 状态（实时更新）
    status: "running",
    eventLog: [],
    turns: 0,
    totalTokens: 0,

    // 完成（completeRecord 唯一写点）
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,

    // 控制（仅 background 持有 controller；sync 为 undefined）
    controller: identity.controller,

    // chunking 缓冲（跨事件持久——修复 background sink reset bug）
    _currentTurnText: "",
    _currentThinking: "",
  };
}

// ============================================================
// 事件更新（唯一更新点）
// ============================================================

/**
 * 从 AgentEvent 更新 record。
 *   - eventLog 追加（tool_start/tool_end/text_output/thinking/turn_end）
 *   - turns 累积（turn_end++）
 *   - totalTokens 累积（message_end.usage 求和）
 *   - chunking 缓冲跨事件持久（修复 background text/thinking 丢失）
 *
 *   ╔══════════════════════════════════════════════════════════════╗
 *   ║   record（唯一状态源）                                        ║
 *   ║      ▲                                                        ║
 *   ║      │ mutate（push/shift/累加）                              ║
 *   ║      │                                                        ║
 *   ║   updateFromEvent(record, event)   ◄── EventBridge 唯一调用   ║
 *   ╚══════════════════════════════════════════════════════════════╝
 *
 * 主控制流（switch 分派 + turns/tokens 累积）真实可执行；
 * eventLog 构建细节（含 chunking + label 提取 + ring buffer）下沉到
 * appendEventLogEntry 叶子。
 */
export function updateFromEvent(record: ExecutionRecord, event: AgentEvent): void {
  // 1. eventLog 构建（chunking 缓冲 + label 提取 + ring buffer，全部下沉叶子）
  appendEventLogEntry(record, event);

  // 2. turns 累积
  if (event.type === "turn_end") {
    record.turns += 1;
  }

  // 3. totalTokens 累积（input+output+cacheRead+cacheWrite 求和）
  if (event.type === "message_end" && event.usage) {
    record.totalTokens +=
      event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
  }
}

/**
 * eventLog 追加的核心逻辑（tool_start/tool_end/text_delta/thinking_delta/turn_end）。
 * 直接 mutate record.eventLog + record._currentTurnText/_currentThinking。
 *
 *   ╔══════════════════════════════════════════════════════════════╗
//   ║  text_delta:     _currentTurnText += delta                    ║
//   ║                   达 TEXT_OUTPUT_CHUNK → push text_output，    ║
//   ║                   截断缓冲（while 循环处理超长 delta）          ║
//   ║  thinking_delta: _currentThinking += delta                    ║
//   ║                   达 THINKING_CHUNK → push thinking，截断      ║
//   ║  tool_start:     extractLabelFromArgs → push {status:running} ║
//   ║  tool_end:       extractLabelFromArgs → push {status:done/    ║
//   ║                   failed（isError）}                           ║
//   ║  turn_end:       flush 残留 text/thinking 缓冲 + push turn_end ║
//   ║                   （label 取本 turn 文本前 TURN_SUMMARY_MAX）  ║
//   ║  最后：while (log.length > MAX_EVENT_LOG_ENTRIES) log.shift() ║
//   ╚══════════════════════════════════════════════════════════════╝
 *
 * label 用 EVENT_LOG_LABEL_MAX 截断（slice，非省略号——列宽稳定）。
 * 这是映射表（event.type → push 动作）+ 缓冲操作，按深化矩阵留叶子。
 */
function appendEventLogEntry(record: ExecutionRecord, event: AgentEvent): void {
  void record; void event; void extractLabelFromArgs;
  void MAX_EVENT_LOG_ENTRIES; void TEXT_OUTPUT_CHUNK; void THINKING_CHUNK;
  void EVENT_LOG_LABEL_MAX; void TURN_SUMMARY_MAX;
  throw new Error("not implemented");
}

// ============================================================
// 完成（唯一入口）
// ============================================================

/**
 * status 状态机的 CAS 互斥锁。仅当 `record.status === "running"` 时改为 target
 * 并返回 true，否则返回 false。**status 状态机本身就是互斥锁**——终态
 * （done/failed/cancelled）不可逆，check-then-set 在 JS 单线程事件循环里天然原子。
 *
 *   ╔══════════════════════════════════════════════════════════════╗
//   ║  用途：executor 的收尾竞争。cancelBackground 与 background   ║
//   ║  detached 完成回调都调 tryTransition 抢锁：                  ║
//   ║    抢到（true）  → 负责完整收尾（completeRecord+archive+      ║
//   ║                    history+notify）                          ║
//   ║    没抢到（false）→ status 已被另一方转走，闭嘴不做事         ║
//   ║                                                                ║
//   ║  这取代了早期的 _settled 字段方案——被锁的字段（status）自身  ║
//   ║  不可逆，不需要第二个标记。详见 execution-flow.md §4。         ║
//   ╚══════════════════════════════════════════════════════════════╝
 */
export function tryTransition(
  record: ExecutionRecord,
  target: "done" | "failed" | "cancelled",
): boolean {
  if (record.status !== "running") return false;
  record.status = target;
  return true;
}

/**
 * 唯一完成入口。冻结状态（写 endedAt/agentResult/result/error）。
 * 不修改 turns/totalTokens——已由 updateFromEvent 累积，completeRecord 只读不重置。
 *
 * ⚠ 前置条件：调用方必须先通过 tryTransition 抢到锁（status 已被 CAS 设为 target）。
 * completeRecord 本身不重复判定 status——它是抢锁之后的"写结果"步骤，
 * 状态机互斥由 tryTransition 单点负责。
 */
export function completeRecord(
  record: ExecutionRecord,
  result: AgentResult,
  status: "done" | "failed" | "cancelled",
): void {
  record.status = status;
  record.endedAt = Date.now();
  record.agentResult = result;
  record.result = result.text;
  record.error = result.error;
}

// ============================================================
// 投影（唯一 → Details / Snapshot / Persisted）
// ============================================================

/**
 * 投影到 SubagentToolDetails。elapsedSeconds 唯一计算点（Math.floor）。
 * eventLog 必须 .slice() 快照——record.eventLog 是被 push/shift mutate 的可变数组。
 */
export function project(record: ExecutionRecord): SubagentToolDetails {
  return {
    status: record.status,
    agent: record.agent,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    turns: record.turns,
    totalTokens: record.totalTokens,
    elapsedSeconds: computeElapsedSeconds(record),
    eventLog: record.eventLog.slice(),
    result: record.result,
    error: record.error,
    // running 时的当前活动行（tool > thinking > text 优先级）——下沉叶子
    currentActivity: record.status === "running" ? computeCurrentActivity(record) : undefined,
  };
}

/**
 * 投影到只读快照（TUI list / poll 消费）。
 * 浅拷贝 eventLog，字段标 readonly 阻止 TUI 回写。
 */
export function snapshot(record: ExecutionRecord): RecordSnapshot {
  return {
    id: record.id,
    agent: record.agent,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    mode: record.mode,
    task: record.task,
    status: record.status,
    eventLog: record.eventLog.slice(),
    turns: record.turns,
    totalTokens: record.totalTokens,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    result: record.result,
    error: record.error,
  };
}

/**
 * 投影到 PersistedAgentRecord（history.jsonl 一行）。预览字段截断。
 */
export function toPersisted(
  record: ExecutionRecord,
  cwd: string,
  sessionId?: string,
): PersistedAgentRecord {
  return {
    id: record.id,
    agent: record.agent,
    status: record.status,
    mode: record.mode,
    taskPreview: truncatePreview(record.task),
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    turns: record.turns,
    totalTokens: record.totalTokens,
    error: record.error,
    resultPreview: record.result ? truncatePreview(record.result) : undefined,
    sessionFile: record.agentResult?.sessionFile,
    cwd,
    sessionId,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
  };
}

// ============================================================
// 投影内部 helper
// ============================================================

/** elapsedSeconds 唯一计算点。endedAt 缺失（running 中）用 Date.now()。 */
function computeElapsedSeconds(record: ExecutionRecord): number {
  const end = record.endedAt ?? Date.now();
  return Math.floor((end - record.startedAt) / MS_PER_SECOND);
}

/**
 * running 时的当前活动行（tool > thinking > text 优先级）。
 * 按优先级倒序扫 eventLog：最近的 tool_start（running 中）> 正在 thinking > 正在 text。
 */
function computeCurrentActivity(
  record: ExecutionRecord,
): { type: "tool" | "text" | "thinking"; label: string } | undefined {
  //  1. 倒序找 status==="running" 的 tool_start → {type:"tool", label}
  //  2. _currentThinking 非空 → {type:"thinking", label: 前 N 字}
  //  3. _currentTurnText 非空 → {type:"text", label: 前 N 字}
  //  4. 全无 → undefined
  void record;
  throw new Error("not implemented");
}

/** 持久化预览截断（task/result 长文本截到单行可读长度）。 */
function truncatePreview(text: string): string {
  //  text.length > PREVIEW_MAX ? text.slice(0, PREVIEW_MAX) : text
  void text;
  throw new Error("not implemented");
}
