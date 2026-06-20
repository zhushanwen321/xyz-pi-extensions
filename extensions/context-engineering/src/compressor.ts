// compressor.ts — L0/L1/L2 compression engine with tool pairing validation

import type { BudgetConfig, ContextEngineeringConfig,L0Config, L1Config, L2Config, McConfig } from "./config.ts";
import type { FrozenFreshState } from "./frozen-fresh.ts";
import type { RecallStore } from "./recall-store.ts";

// Re-export types from types.ts for backward compatibility
export type {
  AgentMessage,
  AssistantMessage,
  BashExecutionMessage,
  BudgetStats,
  CompactionSummaryMessage,
  CompressionStats,
  ContextUsage,
  ImageContent,
  L0Stats,
  McStats,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  TurnBoundary,
  UserMessage,
} from "./types.ts";

// Import types for internal use
import type {
  AgentMessage,
  BudgetStats,
  CompressionStats,
  ContextUsage,
  L0Stats,
  McStats,
  TextContent,
  ThinkingContent,
  ToolResultMessage,
  TurnBoundary,
} from "./types.ts";

// chars→tokens 估算因子和 fallback 上下文窗口大小
const CHARS_PER_TOKEN = 4;
const DEFAULT_CONTEXT_WINDOW = 200_000;

// MC: 可被 Microcompact 清理的工具集
const COMPACTABLE_TOOLS = new Set([
  "read", "bash", "bash_background", "grep", "glob",
  "web_search", "web_fetch", "edit", "write",
]);

// ── Turn boundary detection ──

function findTurnBoundaries(messages: AgentMessage[]): TurnBoundary[] {
  if (messages.length === 0) return [];

  const boundaries: TurnBoundary[] = [];
  let turnStart = 0;

  for (let i = 1; i < messages.length; i++) {
    const role = messages[i].role;
    if (role === "user" || role === "bashExecution") {
      boundaries.push({
        startIndex: turnStart,
        endIndex: i,
        timestamp: messages[turnStart].timestamp,
      });
      turnStart = i;
    }
  }

  // 最后一个 turn
  boundaries.push({
    startIndex: turnStart,
    endIndex: messages.length,
    timestamp: messages[turnStart].timestamp,
  });

  return boundaries;
}

function isInProtectedTurn(
  msgIndex: number,
  boundaries: TurnBoundary[],
  protectCount: number,
): boolean {
  if (protectCount <= 0 || boundaries.length === 0) return false;
  const protectedStart = Math.max(0, boundaries.length - protectCount);
  for (let i = protectedStart; i < boundaries.length; i++) {
    if (msgIndex >= boundaries[i].startIndex && msgIndex < boundaries[i].endIndex) {
      return true;
    }
  }
  return false;
}

// ── Message field accessors ──

function getMessageTimestamp(msg: AgentMessage): number {
  return msg.timestamp;
}

export function getToolResultText(msg: ToolResultMessage): string {
  return msg.content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("");
}

// ── L0 replacement formatters ──

function expireToolResult(_originalText: string, id: string): string {
  return `[Tool result expired. ID: ${id}. Use recall_context(${id}) to retrieve the original content.]`;
}

function truncateBashOutput(
  output: string,
  maxChars: number,
  id: string,
): string {
  if (output.length <= maxChars) return output;
  // Tail retention: bash output is tail-heavy (errors, final results).
  // Mirrors Pi's truncateTail in bash-executor.ts.
  const tailChars = maxChars;
  return (
    `... [truncated. ID: ${id}. Use recall_context(${id}) to retrieve full output. Total: ${output.length} chars]\n\n` +
    output.slice(-tailChars)
  );
}

function expireThinking(): string {
  return "[thinking expired]";
}

// ── L1 condensation ──

const IMPORT_EXPORT_RE = /^(import|export)\s/;
const DEFINITION_RE = /(function|class|interface|type|const|let|var)\s+\w+/;

const FALLBACK_KEEP_RATIO = 0.4;
const MAX_CONDENSE_RATIO = 0.4;
const MS_PER_MINUTE = 60_000;

function fallbackTruncate(content: string): string {
  // Head retention: for non-code content (JSON, YAML, logs),
  // the beginning usually contains structure/headers.
  // Mirrors Pi's truncateHead for read tool output.
  const budget = Math.floor(content.length * FALLBACK_KEEP_RATIO);
  return (
    content.slice(0, budget) +
    "\n[... truncated for space]"
  );
}

function condenseToolResult(
  content: string,
  keepHeadLines: number,
  keepTailLines: number,
): string {
  const lines = content.split("\n");

  // 行数不足以分 head/middle/tail → 直接 fallback
  if (lines.length <= keepHeadLines + keepTailLines) {
    return fallbackTruncate(content);
  }

  const head = lines.slice(0, keepHeadLines);
  const tail = lines.slice(-keepTailLines);
  const middle = lines.slice(keepHeadLines, lines.length - keepTailLines);

  const keptMiddle: string[] = [];
  let omitCount = 0;

  for (const line of middle) {
    if (IMPORT_EXPORT_RE.test(line) || DEFINITION_RE.test(line)) {
      if (omitCount > 0) {
        keptMiddle.push(`[... ${omitCount} lines omitted]`);
        omitCount = 0;
      }
      keptMiddle.push(line);
    } else {
      omitCount++;
    }
  }
  if (omitCount > 0) {
    keptMiddle.push(`[... ${omitCount} lines omitted]`);
  }

  const result = [...head, ...keptMiddle, ...tail].join("\n");

  // 压缩不够 → fallback 截断
  if (result.length > content.length * MAX_CONDENSE_RATIO) {
    return fallbackTruncate(content);
  }

  return result;
}

// ── Tool pairing validation ──

export function validateToolPairing(messages: AgentMessage[]): boolean {
  const pendingToolCalls = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          pendingToolCalls.add(block.id);
        }
      }
    } else if (msg.role === "toolResult") {
      if (!pendingToolCalls.has(msg.toolCallId)) {
        return false;
      }
      pendingToolCalls.delete(msg.toolCallId);
    }
  }

  return pendingToolCalls.size === 0;
}

// ── Compact boundary detection ──

export function findCompactBoundary(messages: AgentMessage[]): number | null {
  let lastIdx: number | null = null;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "compactionSummary") {
      lastIdx = i;
    }
  }
  return lastIdx;
}

// ── Microcompact: time-based cleanup ──

export function processMicrocompact(
  messages: AgentMessage[],
  config: McConfig,
  store: RecallStore,
  now: number,
  compactBoundaryIdx: number | null,
): { messages: AgentMessage[]; stats: McStats } {
  if (!config.enabled) {
    return { messages, stats: { triggered: false, cleared: 0 } };
  }

  // 找最后一个 assistant 消息的 timestamp
  let lastAssistantTs = 0;
  for (const msg of messages) {
    if (msg.role === "assistant") {
      lastAssistantTs = Math.max(lastAssistantTs, msg.timestamp);
    }
  }

  // 间隔不够，不触发
  if (lastAssistantTs === 0 || now - lastAssistantTs <= config.gapThresholdMinutes * MS_PER_MINUTE) {
    return { messages, stats: { triggered: false, cleared: 0 } };
  }

  // 收集所有 compactable toolResult 索引
  const candidateIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "toolResult") continue;
    if (!COMPACTABLE_TOOLS.has(msg.toolName)) continue;
    // 已过期的不再处理
    const text = getToolResultText(msg);
    if (text.startsWith("[Tool result expired")) continue;
    // 只处理边界之后的
    if (compactBoundaryIdx != null && i <= compactBoundaryIdx) continue;
    candidateIdxs.push(i);
  }

  if (candidateIdxs.length <= config.keepRecent) {
    return { messages, stats: { triggered: true, cleared: 0 } };
  }

  // 保留最近 keepRecent 个，清理前面的
  const keepFrom = candidateIdxs.length - config.keepRecent;
  const toClear = candidateIdxs.slice(0, keepFrom);

  const result = [...messages];
  for (const idx of toClear) {
    const msg = result[idx] as ToolResultMessage;
    const originalText = getToolResultText(msg);
    const id = store.store(originalText, "mc-cleared");
    result[idx] = {
      ...msg,
      content: [{ type: "text" as const, text: `[Old tool result expired. ID: ${id}. Use recall_context(${id}) to retrieve the original content.]` }],
    };
  }

  return { messages: result, stats: { triggered: true, cleared: toClear.length } };
}

// ── Budget: tool result budget management ──

export function processBudget(
  messages: AgentMessage[],
  config: BudgetConfig,
  store: RecallStore,
  ffState: FrozenFreshState,
  compactBoundaryIdx: number | null,
): { messages: AgentMessage[]; stats: BudgetStats } {
  if (!config.enabled) {
    return { messages, stats: { persisted: 0 } };
  }

  const result = [...messages];
  let persisted = 0;

  // 按 user 消息分段
  let groupStart = 0;
  for (let i = 0; i <= messages.length; i++) {
    const isGroupEnd = i === messages.length || messages[i].role === "user";
    if (!isGroupEnd) continue;

    // 处理 [groupStart, i) 范围内的 toolResult
    const freshEntries: { idx: number; toolCallId: string; chars: number }[] = [];
    let totalFreshChars = 0;

    for (let j = groupStart; j < i; j++) {
      const msg = messages[j];
      if (msg.role !== "toolResult") continue;
      if (compactBoundaryIdx != null && j < compactBoundaryIdx) continue;

      // frozen 的用 replacement 替换
      if (ffState.isFrozen(msg.toolCallId)) {
        const replacement = ffState.getReplacement(msg.toolCallId)!;
        result[j] = {
          ...msg,
          content: [{ type: "text" as const, text: replacement }],
        } as ToolResultMessage;
        continue;
      }

      const text = getToolResultText(msg);
      freshEntries.push({ idx: j, toolCallId: msg.toolCallId, chars: text.length });
      totalFreshChars += text.length;
    }

    // 超过预算 → 循环持久化最大 fresh toolResult 直到在预算内
    while (totalFreshChars > config.maxToolResultCharsPerMessage && freshEntries.length > 0) {
      let maxEntry = freshEntries[0];
      for (const entry of freshEntries) {
        if (entry.chars > maxEntry.chars) maxEntry = entry;
      }

      const msg = messages[maxEntry.idx] as ToolResultMessage;
      const text = getToolResultText(msg);
      const id = store.store(text, "budget-persisted");
      const replacement =
        `[Persisted output (ID: ${id}). Preview: ${text.slice(0, config.previewSize)}... Total: ${text.length} chars]`;
      ffState.markFrozen(maxEntry.toolCallId, replacement);
      result[maxEntry.idx] = {
        ...msg,
        content: [{ type: "text" as const, text: replacement }],
      } as ToolResultMessage;
      totalFreshChars -= maxEntry.chars;
      freshEntries.splice(freshEntries.indexOf(maxEntry), 1);
      persisted++;
      // Guard: if replacement would not reduce total size, stop to avoid over-persisting small results
      if (replacement.length >= maxEntry.chars) break;
      totalFreshChars += replacement.length;
    }

    groupStart = i;
  }

  return { messages: result, stats: { persisted } };
}

// ── Private helpers ──

function estimateMessageChars(msg: AgentMessage): number {
  switch (msg.role) {
    case "user": {
      if (typeof msg.content === "string") return msg.content.length;
      return msg.content
        .filter((c): c is TextContent => c.type === "text")
        .reduce((s, c) => s + c.text.length, 0);
    }
    case "assistant": {
      return msg.content.reduce((s, c) => {
        if (c.type === "text") return s + c.text.length;
        if (c.type === "thinking") return s + c.thinking.length;
        if (c.type === "toolCall") {
          return s + c.name.length + JSON.stringify(c.arguments).length;
        }
        return s;
      }, 0);
    }
    case "toolResult": {
      return msg.content.reduce((s, c) => {
        if (c.type === "text") return s + c.text.length;
        if (c.type === "image") return s + c.data.length;
        return s;
      }, 0);
    }
    case "bashExecution": {
      return msg.output.length;
    }
    default:
      return 0;
  }
}

function isToolResultExpired(msg: ToolResultMessage): boolean {
  return getToolResultText(msg).includes("[Tool result expired");
}

function isAlreadyProcessed(msg: ToolResultMessage): boolean {
  const text = getToolResultText(msg);
  return text.startsWith("[Tool result expired") ||
         text.startsWith("[Old tool result") ||
         text.startsWith("[Condensed") ||
         text.startsWith("[Persisted output");
}

// ── L0: 基础过期/截断/思考清理 ──

function processL0(
  messages: AgentMessage[],
  config: L0Config,
  store: RecallStore,
  now: number,
  turnBoundaries: TurnBoundary[],
): { messages: AgentMessage[]; stats: L0Stats } {
  const stats: L0Stats = { expired: 0, truncated: 0, thinkingCleared: 0 };
  const result: AgentMessage[] = [];

  // 预计算：每个位置之后是否有 user 消息
  const hasUserAfter = new Array<boolean>(messages.length).fill(false);
  let seenUser = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    hasUserAfter[i] = seenUser;
    if (messages[i].role === "user") seenUser = true;
  }

  // keepRecent: 收集所有 compactable toolResult 索引，保留最近 N 个
  const keepRecentProtected = new Set<number>();
  if (config.keepRecent > 0) {
    const compactableIdxs: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "toolResult") {
        compactableIdxs.push(i);
      }
    }
    const keepFrom = Math.max(0, compactableIdxs.length - config.keepRecent);
    for (let i = keepFrom; i < compactableIdxs.length; i++) {
      keepRecentProtected.add(compactableIdxs[i]);
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "toolResult") {
      const age = now - msg.timestamp;
      const expired = age > config.expireMinutes * MS_PER_MINUTE;
      const turnProtected = isInProtectedTurn(i, turnBoundaries, config.protectRecentTurns);
      const recentProtected = keepRecentProtected.has(i);

      if (expired && !turnProtected && !recentProtected && !isAlreadyProcessed(msg)) {
        const originalText = getToolResultText(msg);
        const id = store.store(originalText, "l0-expired");
        const expiredText = expireToolResult(originalText, id);
        result.push({
          ...msg,
          content: [{ type: "text" as const, text: expiredText }],
        });
        stats.expired++;
      } else {
        result.push(msg);
      }
    } else if (msg.role === "bashExecution") {
      if (msg.output.length > config.bashTruncateChars) {
        const id = store.store(msg.output, "l0-truncated");
        const truncatedOutput = truncateBashOutput(msg.output, config.bashTruncateChars, id);
        result.push({ ...msg, output: truncatedOutput });
        stats.truncated++;
      } else {
        result.push(msg);
      }
    } else if (msg.role === "assistant") {
      const age = now - msg.timestamp;
      const thinkingExpired = age > config.thinkingExpireMinutes * MS_PER_MINUTE;

      if (thinkingExpired && !hasUserAfter[i]) {
        const hasThinking = msg.content.some((c) => c.type === "thinking");
        if (hasThinking) {
          const newContent = msg.content.map((c) =>
            c.type === "thinking"
              ? ({ ...c, thinking: expireThinking() } as ThinkingContent)
              : c,
          );
          result.push({ ...msg, content: newContent });
          stats.thinkingCleared++;
          continue;
        }
      }
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  return { messages: result, stats };
}

// ── L1: 结构化摘要 ──

function processL1(
  messages: AgentMessage[],
  config: L1Config,
  store: RecallStore,
  turnBoundaries: TurnBoundary[],
  compactBoundaryIdx: number | null,
): { messages: AgentMessage[]; stats: { condensed: number } } {
  const stats = { condensed: 0 };
  const result: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "toolResult") {
      if (isToolResultExpired(msg) || isAlreadyProcessed(msg)) {
        result.push(msg);
        continue;
      }

      // Compact boundary: 边界前的消息不处理
      if (compactBoundaryIdx !== null && i < compactBoundaryIdx) {
        result.push(msg);
        continue;
      }

      // Protected turn check
      if (isInProtectedTurn(i, turnBoundaries, config.protectRecentTurns)) {
        result.push(msg);
        continue;
      }

      const text = getToolResultText(msg);
      if (text.length > config.summaryThresholdChars) {
        const summary = condenseToolResult(text, config.keepHeadLines, config.keepTailLines);
        const id = store.store(text, "l1-condensed");
        const condensedText = `[Condensed (ID: ${id}): ${summary}]`;
        result.push({
          ...msg,
          content: [{ type: "text" as const, text: condensedText }],
        });
        stats.condensed++;
      } else {
        result.push(msg);
      }
    } else {
      result.push(msg);
    }
  }

  return { messages: result, stats };
}

// ── L2: 紧急压缩 ──

function processL2(
  messages: AgentMessage[],
  config: L2Config,
  store: RecallStore,
  contextUsage: ContextUsage | undefined,
  turnBoundaries: TurnBoundary[],
  compactBoundaryIdx: number | null,
): { messages: AgentMessage[]; stats: { triggered: boolean } } {
  // 计算上下文使用率
  let usagePercent: number;
  if (contextUsage && contextUsage.percent != null) {
    usagePercent = contextUsage.percent;
  } else {
    let totalChars = 0;
    for (const msg of messages) {
      totalChars += estimateMessageChars(msg);
    }
    usagePercent = (totalChars / CHARS_PER_TOKEN) / DEFAULT_CONTEXT_WINDOW;
  }

  if (usagePercent < config.emergencyThreshold) {
    return { messages, stats: { triggered: false } };
  }

  // L2 emergency: force-expire toolResults outside protected turns when context usage is critical.
  // `triggered` means "at least one toolResult was force-expired", not "usage threshold was crossed".
  // This distinguishes "L2 activated but had nothing to expire" from "L2 didn't activate".

  const result: AgentMessage[] = [];
  let anyForceExpired = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Compact boundary: 边界前的消息不处理
    if (compactBoundaryIdx !== null && i < compactBoundaryIdx) {
      result.push(msg);
      continue;
    }

    if (
      msg.role === "toolResult" &&
      !isToolResultExpired(msg) &&
      !isAlreadyProcessed(msg) &&
      !isInProtectedTurn(i, turnBoundaries, config.protectRecentTurns)
    ) {
      const originalText = getToolResultText(msg);
      const id = store.store(originalText, "l2-emergency");
      const expiredText = expireToolResult(originalText, id);
      result.push({
        ...msg,
        content: [{ type: "text" as const, text: expiredText }],
      });
      anyForceExpired = true;
    } else {
      result.push(msg);
    }
  }

  return { messages: result, stats: { triggered: anyForceExpired } };
}

// ── 主入口 ──

export function compressContext(
  messages: AgentMessage[],
  config: ContextEngineeringConfig,
  store: RecallStore,
  contextUsage: ContextUsage | undefined,
  ffState: FrozenFreshState,
): { messages: AgentMessage[]; stats: CompressionStats } {
  const zeroStats: CompressionStats = {
    l0Expired: 0,
    l0Truncated: 0,
    l0ThinkingCleared: 0,
    l1Condensed: 0,
    l2Triggered: false,
    validationFailed: false,
    mcTriggered: false,
    mcCleared: 0,
    budgetPersisted: 0,
  };

  if (!config.enabled) {
    return { messages, stats: zeroStats };
  }

  const now = Date.now();
  const boundaries = findTurnBoundaries(messages);
  const compactBoundaryIdx = findCompactBoundary(messages);

  const stats: CompressionStats = { ...zeroStats };
  let current = messages;

  // MC (Microcompact)
  if (config.mc.enabled) {
    const mc = processMicrocompact(current, config.mc, store, now, compactBoundaryIdx);
    current = mc.messages;
    stats.mcTriggered = mc.stats.triggered;
    stats.mcCleared = mc.stats.cleared;
  }

  // Budget (ffState 由调用方持有，保证跨 turn 冻结状态持久化)
  if (config.budget.enabled) {
    const budget = processBudget(current, config.budget, store, ffState, compactBoundaryIdx);
    current = budget.messages;
    stats.budgetPersisted = budget.stats.persisted;
  }

  // L0
  if (config.l0.enabled) {
    const l0 = processL0(current, config.l0, store, now, boundaries);
    current = l0.messages;
    stats.l0Expired = l0.stats.expired;
    stats.l0Truncated = l0.stats.truncated;
    stats.l0ThinkingCleared = l0.stats.thinkingCleared;
  }

  // L1
  if (config.l1.enabled) {
    const l1 = processL1(current, config.l1, store, boundaries, compactBoundaryIdx);
    current = l1.messages;
    stats.l1Condensed = l1.stats.condensed;
  }

  // L2
  if (config.l2.enabled) {
    const l2 = processL2(current, config.l2, store, contextUsage, boundaries, compactBoundaryIdx);
    current = l2.messages;
    stats.l2Triggered = l2.stats.triggered;
  }

  // 配对校验
  if (!validateToolPairing(current)) {
    return { messages, stats: { ...stats, validationFailed: true } };
  }

  return { messages: current, stats };
}
