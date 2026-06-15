// src/persistence/history-store.ts
//
// ADR-024 L1: 执行记录全局持久化。
//
// 存储格式：history.jsonl，append-only，每行一个 PersistedAgentRecord（JSON）。
// 目录布局：~/.pi/agent/subagents/<encoded-cwd>/history.jsonl
// 与主 session（~/.pi/agent/sessions/<encoded-cwd>/）物理隔离。
//
// GC 策略：超过 HISTORY_MAX_RECORDS 时重写文件，保留最近 N 条（FIFO）。

import * as fs from "node:fs";
import * as path from "node:path";

import { getHistoryFilePath } from "../config/config-path.ts";
import {
  HISTORY_MAX_RECORDS,
  PERSISTED_PREVIEW_MAX,
  type PersistedAgentRecord,
} from "../types.ts";

/** JSONL 行分隔符 */
const NEWLINE = "\n";

/**
 * HistoryStore — 按 (homeDir, cwd) 隔离的执行记录存储。
 *
 * 一个实例对应一个项目目录。runtime 在 session_start 时为当前 cwd
 * 创建一个实例，所有 sync/background agent 完成时调用 append()。
 */
export class HistoryStore {
  private readonly filePath: string;
  private readonly dir: string;
  /** 写串行化，防止并发 append 导致行交错 */
  private writeChain: Promise<void> = Promise.resolve();
  /** 写计数器：每 N 次写检查一次 GC（确定性触发，替代原 Math.random 概率） */
  private writesSinceLastGc = 0;

  constructor(homeDir: string, cwd: string) {
    this.filePath = getHistoryFilePath(homeDir, cwd);
    this.dir = path.dirname(this.filePath);
  }

  /**
   * 追加一条执行记录。线程安全（串行化写）。
   * 失败不抛出（持久化是 best-effort，不应阻断主流程）。
   */
  append(record: PersistedAgentRecord): Promise<void> {
    const doAppend = (): Promise<void> =>
      new Promise((resolve) => {
        try {
          fs.mkdirSync(this.dir, { recursive: true });
          const line = JSON.stringify(record) + NEWLINE;
          fs.appendFileSync(this.filePath, line, "utf-8");
          // 惰性 GC：每 N 次写入检查一次（避免每次写都 stat）
          this.maybeGc();
          resolve();
        } catch {
          // best-effort：失败静默（已通过 details 暴露给 UI）
          resolve();
        }
      });
    this.writeChain = this.writeChain.then(doAppend, doAppend);
    return this.writeChain;
  }

  /**
   * 读取所有记录（按写入顺序，旧→新）。
   * 文件不存在或损坏返回空数组。损坏的行跳过（不抛出）。
   *
   * @param sessionId 可选 session 过滤——仅返回匹配 sessionId 的记录。
   *                  undefined 时不过滤（兼容场景：GC 等需要全量读取）。
   */
  read(sessionId?: string): PersistedAgentRecord[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const records: PersistedAgentRecord[] = [];
      for (const line of raw.split(NEWLINE)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          // Round 5 SUG#6: lightweight runtime guard——避免「JSON 合法但结构错误」
          // 的行（旧版本字段缺失/类型漂移）以错误形状进入下游 recent() 去重逻辑，
          // r.id 可能 undefined 导致 dedup Map key 异常。
          const parsed: unknown = JSON.parse(trimmed);
          if (!isValidPersistedRecord(parsed)) continue;
          if (sessionId !== undefined && (parsed as PersistedAgentRecord).sessionId !== sessionId) continue;
          records.push(parsed);
        } catch {
          // 单行损坏跳过，保留可用行
        }
      }
      return records;
    } catch {
      return [];
    }
  }

  /**
   * 返回最近 N 条记录（新→旧），按 id 去重。
   *
   * FR-O1.6: cancelBackground 写一条 "cancelled"，runAgent 的 abort catch 会再写一条
   * "failed"（同 id）。去重规则：同 id 取最新 endedAt 的记录；endedAt 相同时 cancelled
   * 优先于 failed（cancelBackground 先设 status，保留用户意图）。
   *
   * @param sessionId 可选 session 过滤——仅返回匹配 sessionId 的记录。
   */
  recent(limit: number, sessionId?: string): PersistedAgentRecord[] {
    const all = this.read(sessionId);
    // 同 id 去重：从旧→新遍历，last-writer-wins（新记录覆盖旧记录）。
    // endedAt 相同时 cancelled 优先（用 status 权重辅助排序）。
    const statusWeight: Record<string, number> = { cancelled: 2, failed: 1 };
    const deduped = new Map<string, PersistedAgentRecord>();
    for (const r of all) {
      const existing = deduped.get(r.id);
      if (!existing) {
        deduped.set(r.id, r);
        continue;
      }
      const rEnd = r.endedAt ?? 0;
      const exEnd = existing.endedAt ?? 0;
      if (rEnd > exEnd || (rEnd === exEnd && (statusWeight[r.status] ?? 0) > (statusWeight[existing.status] ?? 0))) {
        deduped.set(r.id, r);
      }
    }
    const list = [...deduped.values()];
    // 按 endedAt 降序（新→旧）；endedAt 相同时按 startedAt 降序（更晚开始 = 更新）
    list.sort((a, b) => {
      const endDiff = (b.endedAt ?? 0) - (a.endedAt ?? 0);
      if (endDiff !== 0) return endDiff;
      return (b.startedAt ?? 0) - (a.startedAt ?? 0);
    });
    // P3: limit<=0 返回空数组（直觉语义），limit 为正数才切片
    if (limit <= 0) return [];
    return list.slice(0, limit);
  }

  /**
   * 强制执行 GC（测试用）。生产路径走 maybeGc 概率触发。
   * 超 HISTORY_MAX_RECORDS 时重写文件保留最近 N 条。
   */
  forceGc(): void {
    let records: PersistedAgentRecord[];
    try {
      records = this.read();
    } catch {
      return;
    }
    if (records.length <= HISTORY_MAX_RECORDS) return;

    const keep = records.slice(records.length - HISTORY_MAX_RECORDS);
    try {
      const content = keep.map((r) => JSON.stringify(r)).join(NEWLINE) + NEWLINE;
      const tempPath = this.filePath + ".gc." + process.pid;
      fs.writeFileSync(tempPath, content, "utf-8");
      fs.renameSync(tempPath, this.filePath);
    } catch {
      // GC 失败不影响 append 已成功的数据
    }
  }

  /** 惰性 GC：超 HISTORY_MAX_RECORDS 时重写保留最近 N 条 */
  private maybeGc(): void {
    // 确定性触发：每 N 次写检查一次。原 Math.random 概率方案在低频长 session
    // 场景下会积累超限记录很久才 GC，测试也难以断言。
    const GC_CHECK_INTERVAL = 10;
    this.writesSinceLastGc++;
    if (this.writesSinceLastGc < GC_CHECK_INTERVAL) return;
    this.writesSinceLastGc = 0;
    this.forceGc();
  }
}

/**
 * 从 AgentResult 构造 PersistedAgentRecord。
 * 预览字段截断至 PERSISTED_PREVIEW_MAX。
 */
export function buildPersistedRecord(args: {
  id: string;
  agent: string;
  status: PersistedAgentRecord["status"];
  mode: PersistedAgentRecord["mode"];
  task: string;
  startedAt: number;
  endedAt?: number;
  turns?: number;
  totalTokens?: number;
  error?: string;
  resultText?: string;
  sessionFile?: string;
  cwd: string;
  sessionId?: string;
}): PersistedAgentRecord {
  return {
    id: args.id,
    agent: args.agent,
    status: args.status,
    mode: args.mode,
    taskPreview: truncatePreview(args.task),
    startedAt: args.startedAt,
    endedAt: args.endedAt,
    turns: args.turns,
    totalTokens: args.totalTokens,
    error: args.error ? truncatePreview(args.error) : undefined,
    resultPreview: args.resultText ? truncatePreview(args.resultText) : undefined,
    sessionFile: args.sessionFile,
    cwd: args.cwd,
    sessionId: args.sessionId,
  };
}

/** 截断预览文本 */
function truncatePreview(s: string): string {
  if (s.length <= PERSISTED_PREVIEW_MAX) return s;
  const ELLIPSIS_LEN = 3;
  return s.slice(0, PERSISTED_PREVIEW_MAX - ELLIPSIS_LEN) + "...";
}

/** Round 5 SUG#6: 校验 PersistedAgentRecord 最小结构。返回 false 时调用方跳过该行。 */
function isValidPersistedRecord(value: unknown): value is PersistedAgentRecord {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== "string" || !r.id) return false;
  if (typeof r.agent !== "string") return false;
  if (r.status !== "done" && r.status !== "failed" && r.status !== "cancelled") return false;
  if (r.mode !== "sync" && r.mode !== "background") return false;
  if (typeof r.startedAt !== "number") return false;
  if (typeof r.cwd !== "string") return false;
  return true;
}
