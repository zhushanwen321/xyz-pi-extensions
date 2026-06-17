// src/runtime/history-store.ts
//
// 跨 session 执行记录持久化。
//   存储格式：history.jsonl，append-only，每行一个 PersistedAgentRecord。
//   目录布局：~/.pi/agent/subagents/<encoded-cwd>/history.jsonl
//   GC：超 HISTORY_MAX 时重写保留最近 N 条（每 10 次写检查）。

import * as fs from "node:fs";

import type { PersistedAgentRecord } from "../types.ts";

/** GC 上限。 */

/** GC 检查间隔（每 N 次写检查一次）。 */


/**
 * 按 (homeDir, cwd) 隔离的执行记录存储。
 *
//   ╔════════════════════════════════════════════════════════════════╗
//   ║  append(record):                                                 ║
//   ║    1. 串行化（writeChain，防并发行交错）                          ║
//   ║    2. fs.appendFileSync(filePath, JSON + "\n")                   ║
//   ║    3. maybeGc()：writesSinceLastGc++ 达阈值则 forceGc             ║
//   ║    4. best-effort：失败静默（不阻断主流程）                       ║
//   ║                                                                  ║
//   ║  recent(limit, sessionId?):                                      ║
//   ║    1. read(sessionId) 过滤                                        ║
//   ║    2. 同 id 去重：last-writer-wins；endedAt 相同 cancelled 优先   ║
//   ║       （cancel 先写 cancelled，runAgent catch 再写 failed）       ║
//   ║    3. endedAt desc + startedAt desc 排序                         ║
//   ║    4. slice(limit)                                               ║
//   ╚════════════════════════════════════════════════════════════════╝
 */
export class HistoryStore {
  private writeChain: Promise<void> = Promise.resolve();
  private writesSinceLastGc = 0;

  constructor(
    private readonly homeDir: string,
    private readonly cwd: string,
  ) {
    //  filePath = ~/.pi/agent/subagents/<encoded-cwd>/history.jsonl
    void fs;
    throw new Error("not implemented");
  }

  /** 追加一条记录（线程安全，best-effort）。 */
  append(record: PersistedAgentRecord): Promise<void> {
    //  writeChain.then(doAppend) —— 见框图
    void record;
    throw new Error("not implemented");
  }

  /** 读取全部（旧→新）。损坏行跳过。sessionId 过滤。 */
  read(sessionId?: string): PersistedAgentRecord[] {
    //  readFileSync → split("\n") → JSON.parse + 结构校验 → filter(sessionId)
    void sessionId;
    throw new Error("not implemented");
  }

  /** 最近 N 条（新→旧），同 id 去重。 */
  recent(limit: number, sessionId?: string): PersistedAgentRecord[] {
    //  见框图：去重 + 排序 + slice
    void limit; void sessionId;
    throw new Error("not implemented");
  }

  /** 强制 GC（测试用）。重写文件保留最近 N 条。 */
  forceGc(): void {
    //  read() → slice(尾部 HISTORY_MAX) → 写临时文件 → rename
    throw new Error("not implemented");
  }

  /** 惰性 GC（每 GC_CHECK_INTERVAL 次写触发一次）。 */
  private maybeGc(): void {
    //  writesSinceLastGc++; 达阈值 → forceGc + reset
    throw new Error("not implemented");
  }
}

/** 校验 PersistedAgentRecord 最小结构（防旧版本字段漂移污染下游）。 */
export function isValidPersistedRecord(value: unknown): value is PersistedAgentRecord {
  void value;
  //  id/agent/status/mode/startedAt/cwd 类型 + status/mode 枚举校验
  throw new Error("not implemented");
}

/** 计算 history 文件路径（~/.pi/agent/subagents/<encoded-cwd>/history.jsonl）。 */
export function getHistoryFilePath(homeDir: string, cwd: string): string {
  //  encoded = cwd 替换路径分隔符为 "-"；path.join(homeDir, ".pi/agent/subagents", encoded, "history.jsonl")
  void homeDir; void cwd;
  throw new Error("not implemented");
}
