// src/runtime/execution/record-store.ts
//
// Record 的统一容器。内存只留 running record；终态从 session.jsonl 重建。
//
// 职责：
//   - 持有 running record（终态 record 在 archive 时立即从内存移除）
//   - onChange 订阅（TUI widget/list 据此重渲）
//   - collectRecords：内存(running) + 磁盘(sessions/*.jsonl 重建) 合并
//   - 提供 snapshot() 只读视图给 TUI（永不返回可变引用）

import * as fs from "node:fs";
import * as path from "node:path";

import { getEventLog, snapshot as toSnapshot } from "../../core/execution-record.ts";
import { reconstructFromFile } from "../../core/session-reconstructor.ts";
import type {
  ExecutionRecord,
  ExecutionStatus,
  RecordSnapshot,
  SubagentRecord,
} from "../../types.ts";
import { readCancelledTombstone } from "./tombstone-store.ts";

// ============================================================
// 常量
// ============================================================

/** status → 排序优先级（值小排前）：running < failed < cancelled < done。 */
const STATUS_PRIORITY: Record<ExecutionStatus, number> = {
  running: 0,
  failed: 1,
  cancelled: 2,
  done: 3,
};

/** store 变更监听器（返回取消订阅函数）。 */
export type ChangeListener = () => void;

/** status 过滤模式（collectRecords 的核心能力参数）。 */
export type StatusFilter = "running" | "all";

// ============================================================
// RecordStore
// ============================================================

/**
 * Record 容器。进程单例（随 SubagentService 重建）。
 *
 * 内存只留 running record——终态 record 在 archive 时立即移除，collectRecords
 * 读时从 sessions/*.jsonl 重建（reconstructFromFile）。重建结果有缓存，在
 * notifyChange 时失效（终态 record 不再变化，但新 finalize 触发重扫）。
 *
 * 任何 mutate → notifyChange()。
 */
export class RecordStore {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly listeners = new Set<ChangeListener>();
  private _disposed = false;

  /** 重建缓存：sessionFile → SubagentRecord。notifyChange 时失效。 */
  private reconCache: Map<string, SubagentRecord> | undefined;

  constructor(private readonly sessionsDir: string) {}

  /** 注册新 record。触发 onChange。 */
  register(record: ExecutionRecord): void {
    this.records.set(record.id, record);
    this.notifyChange();
  }

  /**
   * 归档：record 已被 completeRecord 设置了终态 status。
   * 立即从内存移除（终态 record 下次读时从 session.jsonl 重建）。
   * cancelled record 由调用方先写 tombstone（cancel 路径），此处只负责移除。
   */
  archive(record: ExecutionRecord): void {
    this.records.delete(record.id);
    this.notifyChange();
  }

  /** 按 id 查找。返回可变 record（仅 runtime 内部用）。 */
  getMutable(id: string): ExecutionRecord | undefined {
    return this.records.get(id);
  }

  /** 列出所有 running record 的只读快照（widget 计数、诊断用）。 */
  listRunning(): RecordSnapshot[] {
    return [...this.records.values()]
      .filter((r) => r.status === "running")
      .map((r) => toSnapshot(r));
  }

  /**
   * 合并内存(running) + 磁盘(sessions/*.jsonl 重建) → SubagentRecord[]。
   *
   *   ╔══════════════════════════════════════════════════════════════════╗
   *   ║  1. 磁盘源：扫 sessionsDir 的 .jsonl，逐个 reconstructFromFile   ║
   *   ║     （命中缓存则跳过读文件）。cancelled tombstone override status ║
   *   ║  2. 内存源覆盖（同 id 内存优先——running record 更新鲜）          ║
   *   ║  3. statusFilter："running" → 只留 running（内存源）；            ║
   *   ║                   "all"（默认）→ 内存 + 磁盘                       ║
   *   ║  4. 排序：STATUS_PRIORITY + startedAt desc                        ║
   *   ║  5. slice(limit)                                                  ║
   *   ╚══════════════════════════════════════════════════════════════════╝
   *
   * statusFilter="running" 时仍先取够多再过滤（防 limit 截断把 running 滤没），
   * 与旧 listHandler 的防截断逻辑一致，下沉到此。
   */
  collectRecords(limit: number, statusFilter: StatusFilter = "all"): SubagentRecord[] {
    const byId = new Map<string, SubagentRecord>();

    // 1. 磁盘源（重建终态 record）。
    for (const rec of this.reconstructAll()) {
      byId.set(rec.id, rec);
    }

    // 2. 内存源覆盖（running record 优先——它是活态，比磁盘重建更新鲜）。
    for (const r of this.records.values()) {
      byId.set(r.id, RecordStore.recordToSubagent(r));
    }

    // 3. statusFilter。
    let result = [...byId.values()];
    if (statusFilter === "running") {
      result = result.filter((r) => r.status === "running");
    }

    // 4-5. 排序 + slice。
    return result
      .sort(RecordStore.compareRecords)
      .slice(0, limit);
  }

  /** 订阅变更。返回取消订阅函数。 */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 触发所有监听器（TUI widget/list requestRender）。dispose 后短路。同时失效重建缓存。 */
  notifyChange(): void {
    if (this._disposed) return;
    this.reconCache = undefined; // 失效缓存（新 finalize 可能产出新 session.jsonl）。
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** session 结束清理。 */
  dispose(): void {
    this._disposed = true;
    this.listeners.clear();
  }

  /** /resume /fork /new 后复活（dispose 的逆操作）。 */
  revive(): void {
    this._disposed = false;
  }

  // ── 内部 ──────────────────────────────────────────────────

  /**
   * 扫 sessionsDir 的 .jsonl 文件，逐个重建 SubagentRecord。
   * 结果缓存（reconCache），notifyChange 时失效。
   * best-effort：目录不存在/读失败 → 空数组（不抛）。
   */
  private reconstructAll(): SubagentRecord[] {
    if (this.reconCache) return [...this.reconCache.values()];

    const cache = new Map<string, SubagentRecord>();
    let files: string[];
    try {
      files = fs.readdirSync(this.sessionsDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(this.sessionsDir, f));
    } catch {
      this.reconCache = cache;
      return [];
    }

    for (const file of files) {
      const recon = reconstructFromFile(file);
      if (!recon) continue; // 文件缺失/损坏/缺 identity → 跳过。

      // cancelled tombstone override（session.jsonl 被 abort 截断，状态靠 sidecar 标记）。
      const tomb = readCancelledTombstone(file);
      const status: ExecutionStatus = tomb ? "cancelled" : recon.status;
      const error = tomb ? "cancelled by user" : recon.error;
      const endedAt = tomb ? tomb.endedAt : undefined;

      const rec: SubagentRecord = {
        id: recon.id,
        agent: recon.agent,
        status,
        mode: recon.mode,
        startedAt: recon.startedAt,
        endedAt,
        turns: recon.turnCount,
        totalTokens: recon.totalTokens,
        model: recon.model,
        thinkingLevel: recon.thinkingLevel,
        eventLog: recon.eventLog,
        result: recon.result,
        error,
        sessionFile: recon.sessionFile,
      };
      cache.set(file, rec);
    }

    this.reconCache = cache;
    return [...cache.values()];
  }

  /** 排序比较器：status priority（running<failed<cancelled<done）+ startedAt desc。 */
  private static compareRecords(a: SubagentRecord, b: SubagentRecord): number {
    const pdiff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    if (pdiff !== 0) return pdiff;
    return b.startedAt - a.startedAt; // 新→旧
  }

  /** ExecutionRecord → SubagentRecord（内存源投影）。 */
  private static recordToSubagent(r: ExecutionRecord): SubagentRecord {
    return {
      id: r.id,
      agent: r.agent,
      status: r.status,
      mode: r.mode,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      turns: r.turnCount,
      totalTokens: r.totalTokens,
      model: r.model,
      thinkingLevel: r.thinkingLevel,
      eventLog: getEventLog(r),
      result: r.result,
      error: r.error,
      sessionFile: r.sessionFile,
    };
  }
}
