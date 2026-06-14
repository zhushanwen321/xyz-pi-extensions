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
   */
  read(): PersistedAgentRecord[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const records: PersistedAgentRecord[] = [];
      for (const line of raw.split(NEWLINE)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          records.push(JSON.parse(trimmed) as PersistedAgentRecord);
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
   * 返回最近 N 条记录（新→旧）。
   * /subagents list 默认只展示最近一部分。
   */
  recent(limit: number): PersistedAgentRecord[] {
    const all = this.read();
    return all.slice(-limit).reverse();
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
    // 概率性检查：每 10 次写检查一次，避免每次写都读全文件
    // （read 本身 O(n)，但只在 1/10 写时触发）
    const GC_CHECK_INTERVAL = 10;
    if (Math.floor(Math.random() * GC_CHECK_INTERVAL) !== 0) return;
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
  };
}

/** 截断预览文本 */
function truncatePreview(s: string): string {
  if (s.length <= PERSISTED_PREVIEW_MAX) return s;
  const ELLIPSIS_LEN = 3;
  return s.slice(0, PERSISTED_PREVIEW_MAX - ELLIPSIS_LEN) + "...";
}
