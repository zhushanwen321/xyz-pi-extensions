// src/runtime/history-store.ts
//
// 跨 session 执行记录持久化。
//   存储格式：history.jsonl，append-only，每行一个 PersistedAgentRecord。
//   目录布局：<agentDir>/subagents/<encoded-cwd>/history.jsonl
//   （agentDir 默认 ~/.pi/agent，可被 PI_CODING_AGENT_DIR 重定向）
//   GC：超 HISTORY_MAX 时重写保留最近 N 条（每 GC_CHECK_INTERVAL 次写检查）。

import * as fs from "node:fs";
import * as path from "node:path";

import type { PersistedAgentRecord } from "../types.ts";

// ============================================================
// 常量
// ============================================================

/** GC 上限（超过则重写保留最近 N 条）。 */
const HISTORY_MAX = 500;

/** GC 检查间隔（每 N 次写触发一次 forceGc）。 */
const GC_CHECK_INTERVAL = 10;

// ============================================================
// 路径
// ============================================================

/**
 * 计算 history 文件路径（<agentDir>/subagents/<encoded-cwd>/history.jsonl）。
 * encoded-cwd 与 session-factory 的 encodeCwd 逻辑一致（复用 Pi SDK 编码约定）。
 */
export function getHistoryFilePath(agentDir: string, cwd: string): string {
  const encoded = encodeCwd(cwd);
  return path.join(agentDir, "subagents", encoded, "history.jsonl");
}

/**
 * cwd → 安全目录名。复用 Pi SDK getDefaultSessionDir 的编码逻辑：
 * 去开头单个分隔符，全量替换剩余分隔符/冒号为 `-`，首尾补 `--`。
 * 例：`/Users/x/proj` → `--Users-x-proj--`。
 */
function encodeCwd(cwd: string): string {
  return "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";
}

// ============================================================
// 结构校验
// ============================================================

const VALID_STATUS = new Set(["running", "done", "failed", "cancelled"]);
const VALID_MODE = new Set(["sync", "background"]);

/** 校验 PersistedAgentRecord 最小结构（防旧版本字段漂移污染下游）。 */
export function isValidPersistedRecord(value: unknown): value is PersistedAgentRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.agent === "string" &&
    typeof v.status === "string" && VALID_STATUS.has(v.status) &&
    typeof v.mode === "string" && VALID_MODE.has(v.mode) &&
    typeof v.startedAt === "number" &&
    typeof v.cwd === "string"
  );
}

// ============================================================
// HistoryStore
// ============================================================

/**
 * 按 (agentDir, cwd) 隔离的执行记录存储。
 *
 *   ╔════════════════════════════════════════════════════════════════╗
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
  private readonly filePath: string;

  constructor(
    private readonly agentDir: string,
    private readonly cwd: string,
  ) {
    this.filePath = getHistoryFilePath(agentDir, cwd);
  }

  /** 追加一条记录（串行化防并发交错，best-effort 失败静默）。 */
  append(record: PersistedAgentRecord): Promise<void> {
    this.writeChain = this.writeChain
      .then(() => this.doAppend(record))
      .catch(() => {
        // best-effort：写入失败不阻断主流程（执行已完成，history 只是日志）
      });
    return this.writeChain;
  }

  /** 实际写入 + 惰性 GC。 */
  private doAppend(record: PersistedAgentRecord): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
    } catch {
      // 目录创建/写入失败 → 静默（best-effort）
      return;
    }
    this.maybeGc();
  }

  /** 读取全部（旧→新）。损坏行跳过。sessionId 过滤。 */
  read(sessionId?: string): PersistedAgentRecord[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf-8");
    } catch {
      return []; // 文件不存在 → 空
    }
    const records: PersistedAgentRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (isValidPersistedRecord(parsed)) {
          if (!sessionId || parsed.sessionId === sessionId) {
            records.push(parsed);
          }
        }
      } catch (_err) {
        // 有意吞掉：损坏行跳过（不阻断后续行解析）
        void _err;
      }
    }
    return records;
  }

  /** 最近 N 条（新→旧），同 id 去重（last-writer-wins，cancelled 优先）。 */
  recent(limit: number, sessionId?: string): PersistedAgentRecord[] {
    const all = this.read(sessionId);
    // 同 id 去重：后写覆盖前写；endedAt 相同时 cancelled 优先
    const byId = new Map<string, PersistedAgentRecord>();
    for (const r of all) {
      const existing = byId.get(r.id);
      if (!existing) {
        byId.set(r.id, r);
        continue;
      }
      // last-writer-wins，但 endedAt 相同时 cancelled 优先
      const sameEndedAt =
        (existing.endedAt ?? 0) === (r.endedAt ?? 0);
      if (sameEndedAt && existing.status !== "cancelled" && r.status === "cancelled") {
        byId.set(r.id, r);
      } else {
        byId.set(r.id, r); // 后写覆盖
      }
    }
    // 排序：endedAt desc（running 用 startedAt 兜底）+ startedAt desc
    return [...byId.values()]
      .sort((a, b) => {
        const aEnd = a.endedAt ?? a.startedAt;
        const bEnd = b.endedAt ?? b.startedAt;
        if (bEnd !== aEnd) return bEnd - aEnd;
        return b.startedAt - a.startedAt;
      })
      .slice(0, limit);
  }

  /** 强制 GC（测试用）。重写文件保留最近 HISTORY_MAX 条。 */
  forceGc(): void {
    const all = this.read();
    if (all.length <= HISTORY_MAX) return;
    const keep = all.slice(all.length - HISTORY_MAX); // 保留最新 N 条
    try {
      const tempPath = `${this.filePath}.tmp.${process.pid}`;
      const content = keep.map((r) => JSON.stringify(r)).join("\n") + "\n";
      fs.writeFileSync(tempPath, content, "utf-8");
      fs.renameSync(tempPath, this.filePath);
    } catch (_err) {
      // 有意吞掉：GC 失败不影响 append 主流程（下次 GC 重试）
      void _err;
    }
  }

  /** 惰性 GC（每 GC_CHECK_INTERVAL 次写触发一次）。 */
  private maybeGc(): void {
    this.writesSinceLastGc += 1;
    if (this.writesSinceLastGc >= GC_CHECK_INTERVAL) {
      this.writesSinceLastGc = 0;
      this.forceGc();
    }
  }
}
