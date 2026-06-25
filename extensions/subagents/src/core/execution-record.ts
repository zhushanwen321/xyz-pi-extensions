// src/core/execution-record.ts
//
// 唯一执行状态对象 + 唯一创建/更新/完成/投影入口。
//
// 单源设计（2026-06 重构）：record.turns[].content 是 SDK message.content 的直接镜像
// （text/thinking/toolCall 同构 block）。eventLog / result 文本均从 content 派生——
// 不再有 currentActivity 独立出口（text/thinking 现在是 eventLog 条目，与 tool 同源）。
// 不再 delta 累积（源头每次给完整 message 快照，message_update 整体覆盖 content）。
//
//   createRecord    唯一创建入口（model 创建时必填，消灭 poll 路径 model 丢失）
//   updateFromEvent 唯一事件更新入口（message_update 覆盖 content，tool 按 id 关联）
//   completeRecord  唯一完成入口（冻结状态）
//   project/snapshot 唯一投影入口（两路径字段一致）
//
// Core 层叶子原语：仅依赖 types.ts。零 Pi / Runtime / TUI 依赖。

import type {
  AgentEvent,
  AgentEventLogEntry,
  AgentResult,
  AgentUsage,
  AgentUsageTotal,
  ExecutionMode,
  ExecutionRecord,
  RecordSnapshot,
  SubagentToolDetails,
  ToolCall,
  ToolCallResult,
  Turn,
  TurnContentBlock,
} from "../types.ts";

// ============================================================
// 常量
// ============================================================

/** currentActivity label 的前缀截断长度（与旧 ACTIVITY_LABEL_MAX 对齐）。 */
const ACTIVITY_LABEL_MAX = 60;
/** turn_end 派生条目 label 的最大长度（取本 turn 文本开头）。 */
const TURN_SUMMARY_MAX = 80;
/** tool label 的最大长度（command/query/url/basename 截断，保持 TUI 列宽稳定）。 */
const TOOL_LABEL_MAX = 100;
/** ms → s 换算。elapsedSeconds 唯一计算点用。 */
const MS_PER_SECOND = 1000;

// ============================================================
// Label 提取（eventLog 派生的伴生逻辑，co-locate 于 Core）
// ============================================================

/**
 * 从 toolName + args 提取 eventLog label（人类可读）。
 *
 *   read/edit/write → "{tool} {basename}"（取 path 参数）
 *   bash            → "{tool} {command 首行}"（截断）
 *   web_search      → "{tool} {query}"
 *   web_fetch       → "{tool} {url}"
 *   其他 / 无 args   → 裸 toolName
 *
 * 纯函数（零依赖），由 getEventLog 派生 tool 条目时调用。
 * 所有取自参数的字符串都经 truncateLabel 截断到 TOOL_LABEL_MAX——
 * 保持 TUI 列宽稳定（避免一条 10KB bash 命令撑爆 compact view）。
 */
export function extractLabelFromArgs(toolName: string, args: unknown): string {
  if (typeof args !== "object" || args === null) return toolName;
  const a = args as Record<string, unknown>;

  // 读/写/编辑类：取路径 basename（~/.pi/.../foo.ts → foo.ts）
  //   兼容 Pi tool 的多种路径参数名：path / file_path / filePath
  const pathLike = (a.path ?? a.file_path ?? a.filePath) as unknown;
  if (typeof pathLike === "string" && pathLike.length > 0) {
    const base = pathLike.split(/[\\/]/).pop() ?? pathLike;
    return `${toolName} ${truncateLabel(base)}`;
  }

  // bash：command 首行（截断）
  const cmd = a.command as unknown;
  if (typeof cmd === "string" && cmd.length > 0) {
    const firstLine = cmd.split("\n", 1)[0].trim();
    return `${toolName} ${truncateLabel(firstLine)}`;
  }

  // web_search：query
  const query = a.query as unknown;
  if (typeof query === "string" && query.length > 0) {
    return `${toolName} ${truncateLabel(query)}`;
  }

  // web_fetch：url
  const url = a.url as unknown;
  if (typeof url === "string" && url.length > 0) {
    return `${toolName} ${truncateLabel(url)}`;
  }

  return toolName;
}

/** 截断 label 到 maxLen（非省略号——保持列宽稳定，避免长命令/路径撑爆 TUI 列宽）。 */
function truncateLabel(label: string): string {
  return label.length > TOOL_LABEL_MAX ? label.slice(0, TOOL_LABEL_MAX) : label;
}

/**
 * 累加两个 AgentUsage（field-wise）。prev 为空时返回 next 的拷贝。
 * 供 message_end 把 usage 增量并入 turn.usageDelta。
 */
function addUsage(prev: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  if (prev === undefined) {
    return {
      input: next.input ?? 0,
      output: next.output ?? 0,
      cacheRead: next.cacheRead ?? 0,
      cacheWrite: next.cacheWrite ?? 0,
      cost: next.cost,
    };
  }
  return {
    input: (prev.input ?? 0) + (next.input ?? 0),
    output: (prev.output ?? 0) + (next.output ?? 0),
    cacheRead: (prev.cacheRead ?? 0) + (next.cacheRead ?? 0),
    cacheWrite: (prev.cacheWrite ?? 0) + (next.cacheWrite ?? 0),
    cost: (prev.cost ?? 0) + (next.cost ?? 0),
  };
}

// ============================================================
// 创建（唯一入口）
// ============================================================

/** 创建一个空 turn（content 空，未闭合）。 */
function emptyTurn(): Turn {
  return { content: [], usageDelta: undefined, closed: false };
}

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
    // turns[] 初始化为 [空 turn]——第一个 turn 从创建即存在，
    // updateFromEvent 直接往 turns[last] 累积，无需「无 turn」分支判断。
    turns: [emptyTurn()],
    turnCount: 0,
    totalTokens: 0,
    lastError: undefined,

    // 完成（completeRecord 唯一写点）
    endedAt: undefined,
    result: undefined,
    error: undefined,
    agentResult: undefined,

    // 控制（仅 background 持有 controller；sync 为 undefined）
    controller: identity.controller,
  };
}

// ============================================================
// 事件更新（唯一更新点）
// ============================================================

/**
 * 取当前正在进行（未 closed）的 turn；若全部 closed 则开新 turn。
 * 保证调用后返回的 turn 一定 closed===false，可安全累积内容。
 */
function currentTurn(record: ExecutionRecord): Turn {
  const last = record.turns[record.turns.length - 1];
  if (last !== undefined && !last.closed) return last;
  const fresh = emptyTurn();
  record.turns.push(fresh);
  return fresh;
}

/**
 * 在 record.turns[] 范围内倒序找仍 running 的 toolCall block（按 id 精确匹配，兜底按名）。
 *
 * 单源设计：toolCall 现在是 turn.content 的元素（不再是独立 toolCalls 数组）。
 * id 精确关联 tool_execution_end（SDK tool_execution_*.toolCallId === ToolCall.id），
 * 比旧按名匹配更健壮（同名 tool 无歧义）。兜底按名：SDK 极端情况下 id 缺失时仍能配对。
 *
 * 扫描所有 turn（非仅当前 turn）——SDK 在 turn_end 后仍可能补发滞后的 tool_end，
 * 仅扫当前 turn 会漏配对。返回 [turn, blockIndex]；未找到返回 undefined。
 */
function findRunningToolCallBlock(
  record: ExecutionRecord,
  toolCallId: string | undefined,
  toolName: string,
): readonly [Turn, number] | undefined {
  for (let t = record.turns.length - 1; t >= 0; t--) {
    const turn = record.turns[t];
    if (turn === undefined) continue;
    for (let i = turn.content.length - 1; i >= 0; i--) {
      const block = turn.content[i];
      if (block?.type !== "toolCall" || block._status !== "running") continue;
      // 优先 id 精确匹配；id 缺失时兜底按 name
      if ((toolCallId !== undefined && block.id === toolCallId) ||
          (toolCallId === undefined && block.name === toolName)) {
        return [turn, i] as const;
      }
    }
  }
  return undefined;
}

/**
 * 从 AgentEvent 更新 record。所有数据收口进 record.turns[].content。
 *   - message_update：用 SDK message.content 快照整体覆盖 currentTurn().content
 *     （text/thinking 直接来自快照，无需 delta 累积——单源设计的核心）
 *   - tool_start：往 currentTurn().content 追加 running 的 toolCall block（带 id + startedTs）。
 *     注意：message_update 的快照可能已含同名 toolCall 骨架，但缺 _status/result；
 *     tool_start 的 running block 与快照 block 按 id 去重（避免重复行）。
 *   - tool_end：跨 turn 按 id 找 running toolCall block，补全 result/isError/_status
 *     （兜底按名）。匹配失败则 push 已完成 block（防数据丢失）。
 *   - turn_end：闭合当前 turn，记 closedTs（真实墙钟，供 getEventLog）；
 *     正常闭合清 lastError（瞬态 error 恢复后不应误判 success=false）
 *   - message_end：usage 增量存进末 turn.usageDelta（直接写末 turn，不开新 turn）；
 *     totalTokens 累加
 *   - error：存 record.lastError（getEventLog 派生 error 条目用）
 *
 * 唯一写点——session-runner 闭包不再旁路累积，collectResult 从 record 读。
 *
 * 穷尽性：switch 覆盖 AgentEvent 全部 variant；default 的 `never` 断言保证
 * 新增 variant 时编译期报错（而非静默 no-op）。
 */
export function updateFromEvent(record: ExecutionRecord, event: AgentEvent): void {
  switch (event.type) {
    // ── message_update：SDK message.content 快照整体覆盖 currentTurn.content ──
    // 单源核心：text/thinking/toolCall 同构 block 来自完整快照，不再 delta 累积。
    // toolCall block 的 _status/result 由独立的 tool_start/tool_end 事件维护——
    // 快照覆盖时保留已有 toolCall block 的 _status/result（按 id 合并），避免丢失运行态。
    case "message_update": {
      const turn = currentTurn(record);
      // 收集现有 toolCall block 的运行态（按 id），供快照覆盖后回填 _status/result
      const existingToolState = new Map<string, { _status: "running" | "done" | "failed"; result?: ToolCallResult; isError?: boolean; startedTs: number }>();
      for (const b of turn.content) {
        if (b.type === "toolCall") {
          existingToolState.set(b.id, { _status: b._status, result: b.result, isError: b.isError, startedTs: b.startedTs });
        }
      }
      turn.content = event.content.map((block) => {
        if (block.type === "text") return { type: "text" as const, text: block.text };
        if (block.type === "thinking") return { type: "thinking" as const, thinking: block.thinking };
        // toolCall：回填已有运行态（_status/result/startedTs），缺失则默认 running
        const existing = existingToolState.get(block.id);
        return {
          type: "toolCall" as const,
          id: block.id,
          name: block.name,
          arguments: block.arguments,
          _status: existing?._status ?? "running",
          result: existing?.result,
          isError: existing?.isError ?? false,
          startedTs: existing?.startedTs ?? Date.now(),
        };
      });
      return;
    }

    // ── tool_start：往 content 追加 running 的 toolCall block（带 id + startedTs）──
    case "tool_start": {
      // 先按 id 查现有 content 是否已有同 toolCall（message_update 快照已含骨架）——
      // 有则只补 startedTs（若缺），无则追加。避免重复 block。
      const turn = currentTurn(record);
      const existing = turn.content.find(
        (b): b is Extract<TurnContentBlock, { type: "toolCall" }> =>
          b.type === "toolCall" && b.id === event.toolCallId,
      );
      if (existing) {
        if (existing.startedTs === 0) existing.startedTs = Date.now();
        existing._status = "running";
        return;
      }
      turn.content.push({
        type: "toolCall",
        id: event.toolCallId,
        name: event.toolName,
        arguments: event.args,
        result: undefined,
        isError: false,
        _status: "running",
        startedTs: Date.now(),
      });
      return;
    }

    // ── tool_end：跨 turn 按 id 找 running toolCall block，补全 result/isError/_status ──
    case "tool_end": {
      const matched = findRunningToolCallBlock(record, event.toolCallId, event.toolName);
      if (matched !== undefined) {
        const [turn, i] = matched;
        const block = turn.content[i];
        if (block?.type === "toolCall") {
          block.arguments = event.args ?? block.arguments;
          block.result = event.result;
          block.isError = event.isError ?? false;
          block._status = event.isError ? "failed" : "done";
        }
        return;
      }
      // 匹配失败（SDK 发了 tool_end 但无对应 tool_start/content block，如外部注入的工具）：
      // 直接 push 一个已完成的 toolCall block，避免数据丢失。
      currentTurn(record).content.push({
        type: "toolCall",
        id: event.toolCallId,
        name: event.toolName,
        arguments: event.args,
        result: event.result,
        isError: event.isError ?? false,
        _status: event.isError ? "failed" : "done",
        startedTs: Date.now(),
      });
      return;
    }

    // ── turn_end：闭合当前 turn，记 closedTs，turnCount++，清 lastError ──
    case "turn_end": {
      const turn = currentTurn(record);
      turn.closed = true;
      turn.closedTs = Date.now();
      record.turnCount += 1;
      // turn 正常闭合意味着本段执行成功——清掉运行期可能记录的瞬态 error，
      // 避免瞬态 error 恢复后 session-runner 仍据 lastError 误判 success=false。
      // （若 turn_end 后 message_end 报 error，会在 message_end 分支重新写回 lastError。）
      record.lastError = undefined;
      return;
    }

    // ── message_end：usage 增量累加进 currentTurn().usageDelta，totalTokens 累加 ──
    //
    // usageDelta 按 message_end **累加**（非覆盖）——同一 turn 内若多次 message_end
    // 到达（或 turn_end 后的滞后 message_end 落到 currentTurn 开的新 turn），
    // 累加保证不丢 usage。getTotalUsage 扁平求和所有 turn，归属 turn 的精确性
    // 不影响最终 total（无消费方读单 turn usage）。
    case "message_end": {
      if (event.usage) {
        const turn = currentTurn(record);
        turn.usageDelta = addUsage(turn.usageDelta, event.usage);
        // totalTokens 累加四项之和（保留旧语义，投影直接读）
        record.totalTokens +=
          (event.usage.input ?? 0) + (event.usage.output ?? 0) +
          (event.usage.cacheRead ?? 0) + (event.usage.cacheWrite ?? 0);
      }
      // message_end 的 error（stopReason=error）也记进 lastError
      if (event.error) {
        record.lastError = event.error;
      }
      return;
    }

    // ── error：存 record.lastError（getEventLog 派生 error 条目）──
    case "error": {
      record.lastError = event.message;
      return;
    }

    // ── compaction：不产生数据（不变）──
    case "compaction": {
      return;
    }

    default: {
      // 穷尽性检查：新增 AgentEvent variant 时编译期报错
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

// ============================================================
// 派生视图（从 turns[] 推导，不存储）
// ============================================================

/**
 * 从 turns[] 派生有序事件序列（eventLog）。
 *
 * 每个 turn 产出：tool_start/tool_end 对（按 toolCalls 顺序）+ turn_end。
 * 若有 lastError，末尾追加 error 条目。
 *
 *   [turn1{toolCalls:[A,B]}, turn2{toolCalls:[C]}] + lastError
 *     → [tool_start A, tool_end A, tool_start B, tool_end B, turn_end,
 *        tool_start C, tool_end C, turn_end, error]
 *
 * ts 为真实墙钟时间戳：tool 条目用 tc.startedTs，turn_end 用 turn.closedTs。
 * （旧实现派生时 ts += 1 是合成值，无法表达真实时序——现已改为存真实时间戳。）
 *
 * 纯函数：每次调用重新生成，不缓存。消费方按需调（投影时用）。
 */
export function getEventLog(record: ExecutionRecord): AgentEventLogEntry[] {
  const log: AgentEventLogEntry[] = [];
  for (let ti = 0; ti < record.turns.length; ti++) {
    const turn = record.turns[ti]!;
    const isLastTurn = ti === record.turns.length - 1;
    const turnText = turn.content.filter((b): b is Extract<TurnContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text).join("");
    for (const block of turn.content) {
      if (block.type === "toolCall") {
        const label = extractLabelFromArgs(block.name, block.arguments);
        const ts = block.startedTs;
        log.push({ type: "tool_start", label, ts, status: "running" });
        if (block._status !== "running") {
          log.push({ type: "tool_end", label, ts, status: block._status });
        }
      }
    }
    // thinking/text 条目：仅最后一个未闭合 turn（running 态的实时进度）派生，
    // 闭合的 turn 不重复展示历史 thinking/text（避免 eventLog 膨胀；用户在 list/detail
    // 看完整内容用 result 文本）。这也是 single-source 后 text/thinking 可见性的关键——
    // 它们和 tool 一样进 eventLog，经节流刷新显示。
    if (isLastTurn && !turn.closed && record.status === "running") {
      // 倒序取末尾 block（最新活动）：toolCall running 优先已有 tool 条目，
      // 这里补 thinking/text（若无 running tool 在末尾）
      const lastNonTool = [...turn.content].reverse().find((b) => b.type !== "toolCall");
      if (lastNonTool?.type === "thinking" && lastNonTool.thinking) {
        log.push({
          type: "thinking",
          label: lastNonTool.thinking.slice(0, ACTIVITY_LABEL_MAX),
          ts: Date.now(),
        });
      } else if (lastNonTool?.type === "text" && lastNonTool.text) {
        log.push({
          type: "text",
          label: lastNonTool.text.slice(0, ACTIVITY_LABEL_MAX),
          ts: Date.now(),
        });
      }
    }
    if (turn.closed) {
      const summary = turnText.length > 0
        ? (turnText.length > TURN_SUMMARY_MAX ? turnText.slice(0, TURN_SUMMARY_MAX) : turnText)
        : "turn";
      log.push({ type: "turn_end", label: summary, ts: turn.closedTs ?? record.startedAt });
    }
  }
  if (record.lastError) {
    log.push({ type: "error", label: record.lastError, ts: Date.now() });
  }
  return log;
}

/**
 * 聚合所有 turn 的 text 为完整文本（替代旧 collectResponseText）。
 *
 * 单一数据源：text 完全来自 record.turns[].content 的 text block（SDK message 快照）。
 * 多 turn 用空行分隔（每个 turn 是一段独立的 assistant 输出）。
 */
export function getFullText(record: ExecutionRecord): string {
  return record.turns
    .map((t) =>
      t.content
        .filter((b): b is Extract<TurnContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join(""),
    )
    .filter((text) => text.length > 0)
    .join("\n\n");
}

/**
 * 聚合所有 turn 的 toolCall block（扁平化），并 strip 内部字段。
 * 供 collectResult / schema enforcement 读，替代旧闭包 toolCalls 旁路。
 *
 * 返回 ToolCall[]（不含 _status / startedTs）——跨边界导出形状清洁，
 * 避免内部状态机字段泄漏到 AgentResult.toolCalls / 持久化层。
 */
export function getAllToolCalls(record: ExecutionRecord): ToolCall[] {
  return record.turns.flatMap((t) =>
    t.content
      .filter((b): b is Extract<TurnContentBlock, { type: "toolCall" }> => b.type === "toolCall")
      .map((b) => ({
        toolName: b.name,
        args: b.arguments,
        result: b.result,
        isError: b.isError,
      })),
  );
}

/**
 * 聚合所有 turn 的 usageDelta 为完整 usage（含 total + cost）。
 * 全零则返回 undefined（与旧 toUsageTotal 语义一致）。
 *
 * cost 来自 SdkEvent.message.usage.cost.total（message_end 时透传到 usageDelta）。
 * 旧 toUsageTotal/session-runner 累积 cost；本重构保留该行为。
 */
export function getTotalUsage(record: ExecutionRecord): AgentUsageTotal | undefined {
  let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0;
  for (const turn of record.turns) {
    const u = turn.usageDelta;
    if (u) {
      input += u.input ?? 0;
      output += u.output ?? 0;
      cacheRead += u.cacheRead ?? 0;
      cacheWrite += u.cacheWrite ?? 0;
      cost += u.cost ?? 0;
    }
  }
  const total = input + output + cacheRead + cacheWrite;
  if (total === 0) return undefined;
  return { input, output, cacheRead, cacheWrite, total, cost };
}

// ============================================================
// 完成（唯一入口）
// ============================================================

/**
 * status 状态机的 CAS 互斥锁。仅当 `record.status === "running"` 时改为 target
 * 并返回 true，否则返回 false。**status 状态机本身就是互斥锁**——终态
 * （done/failed/cancelled）不可逆，check-then-set 在 JS 单线程事件循环里天然原子。
 *
 * 用途：executor 的收尾竞争。cancelBackground 与 background detached 完成回调
 * 都调 tryTransition 抢锁：抢到负责完整收尾，没抢到闭嘴不做事。
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

/** elapsedSeconds 唯一计算点（共享 helper，消除三处发散）。endedAt 缺失用 Date.now()。 */
export function computeElapsedSeconds(record: { startedAt: number; endedAt?: number }): number {
  const end = record.endedAt ?? Date.now();
  return Math.floor((end - record.startedAt) / MS_PER_SECOND);
}

/**
 * 投影到 SubagentToolDetails。elapsedSeconds/eventLog 均现算派生。
 * 单源设计：eventLog 已含 thinking/text 条目（不再有 currentActivity 独立出口）。
 */
export function project(record: ExecutionRecord): SubagentToolDetails {
  return {
    status: record.status,
    mode: record.mode,
    agent: record.agent,
    model: record.model,
    thinkingLevel: record.thinkingLevel,
    turns: record.turnCount,
    totalTokens: record.totalTokens,
    elapsedSeconds: computeElapsedSeconds(record),
    eventLog: getEventLog(record),
    result: record.result,
    error: record.error,
    parsedOutput: record.agentResult?.parsedOutput,
    sessionFile: record.sessionFile,
  };
}

/**
 * 投影到只读快照（TUI list / poll 消费）。
 * 浅拷贝 turns[]，字段标 readonly 阻止 TUI 回写。
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
    turns: record.turnCount,
    totalTokens: record.totalTokens,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    result: record.result,
    error: record.error,
    sessionFile: record.sessionFile,
  };
}
