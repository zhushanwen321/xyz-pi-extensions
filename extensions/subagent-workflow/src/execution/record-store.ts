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

import { getCurrentActivity, getDisplayItems, getEventLog, markReconstructedStatus, snapshot as toSnapshot } from "./execution-record.ts";
import { reconstructFromFile } from "./session-reconstructor.ts";
import type {
  ExecutionRecord,
  ExecutionStatus,
  RecordSnapshot,
  SubagentRecord,
} from "./types.ts";
import { isProcessAlive, readAliveMarker } from "./alive-store.ts";
import { readFinalized } from "./finalized-marker.ts";
import { readCancelledTombstone } from "./tombstone-store.ts";

// ============================================================
// 常量
// ============================================================

/** status → 排序优先级（值小排前）：running < failed < crashed < cancelled < done。 */
const STATUS_PRIORITY: Record<ExecutionStatus, number> = {
  running: 0,
  failed: 1,
  crashed: 1,
  cancelled: 2,
  done: 3,
};

/** .alive sidecar 的 24 小时软超时（超过此时间即使 pid 存活也判 crashed）。 */
const ALIVE_SOFT_TIMEOUT_MS = 86_400_000; // 24h in ms

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

  /**
   * abort 所有 running record 的 controller（background 子进程 SIGTERM）。
   *
   * 仅在 SubagentService.dispose（进程退出路径）调用。不做 CAS/tombstone——dispose
   * 是终局，状态机收尾无意义；目的是让 background 子进程的 AbortSignal 触发 →
   * runSpawn 的 signal listener → child.kill("SIGTERM")，防止主进程退出后子进程成孤儿。
   *
   * sync record 无 controller（undefined），跳过——sync 是阻塞调用，主进程不会先于
   * sync subagent 退出（除非 SIGKILL/崩溃，此时任何清理都无效）。
   *
   * 返回被 abort 的 record 数（诊断用）。
   */
  abortRunningControllers(): number {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.status === "running" && r.controller) {
        r.controller.abort();
        n++;
      }
    }
    return n;
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
   *   ║  3. session 过滤：只留 rootSessionId === rootSessionFilter 的       ║
   *   ║     record。rootSessionId 缺失（旧文件）的 record 一律排除        ║
   *   ║     （无法判定归属，隔离优先）。rootSessionFilter 为 undefined       ║
   *   ║     时不过滤（向后兼容）。                                          ║
   *   ║  4. statusFilter："running" → 只留 running（内存源）；            ║
   *   ║                   "all"（默认）→ 内存 + 磁盘                       ║
   *   ║  5. 排序：STATUS_PRIORITY + startedAt desc                        ║
   *   ║  6. slice(limit)                                                  ║
   *   ╚══════════════════════════════════════════════════════════════════╝
   *
   * statusFilter="running" 时仍先取够多再过滤（防 limit 截断把 running 滤没），
   * 与旧 listHandler 的防截断逻辑一致，下沉到此。
   *
   * session 隔离：同一 cwd 下多个 Pi session 共享 sessionsDir，靠 rootSessionId
   * 区分。内存与磁盘源都按 rootSessionFilter 过滤后再 merge/sort/slice。
   */
  collectRecords(
    limit: number,
    statusFilter: StatusFilter = "all",
    rootSessionFilter?: string,
  ): SubagentRecord[] {
    const byId = new Map<string, SubagentRecord>();

    // 1. 磁盘源（重建终态 record）。 reconstructAll 已按 rootSessionFilter 过滤。
    for (const rec of this.reconstructAll(rootSessionFilter)) {
      byId.set(rec.id, rec);
    }

    // 2. 内存源覆盖（running record 优先——它是活态，比磁盘重建更新鲜）。同样按 session 过滤。
    for (const r of this.records.values()) {
      if (rootSessionFilter !== undefined && r.rootSessionId !== rootSessionFilter) continue;
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
   * 四分支 sidecar 矩阵重建。
   *
   * 优先级：
   *   1. .cancelled → cancelled
   *   2. .finalized → done/failed（按 recon.stopReason 推）
   *   3. .alive + pid 存活 + 未超 24h → running, externalInstance=true
   *   4. 兜底 → crashed
   *
   * 所有分支经 markReconstructedStatus（不裸 .status=）。
   *
   * session 隔离：rootSessionFilter 非空时，只保留 rootSessionId 匹配的 record。
   * rootSessionId 缺失（旧文件，未带身份字段）一律排除（无法判定归属）。
   * 缓存以 undefined 过滤结果为基底，带 filter 时在基底上再筛（避免缓存碎片化）。
   */
  private reconstructAll(rootSessionFilter?: string): SubagentRecord[] {
    if (this.reconCache) {
      const all = [...this.reconCache.values()];
      if (rootSessionFilter === undefined) return all;
      return all.filter((r) => r.rootSessionId === rootSessionFilter);
    }

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

    const now = Date.now();

    for (const file of files) {
      const recon = reconstructFromFile(file);
      if (!recon) continue; // 文件缺失/损坏/缺 identity → 跳过。

      // 读取三个 sidecar（best-effort，不存在返回 falsy）。
      const tomb = readCancelledTombstone(file);
      const finalized = readFinalized(file);
      const alive = readAliveMarker(file);

      // 构造 base record（status/error/endedAt/externalInstance 后续按分支覆盖）。
      const rec: SubagentRecord = {
        id: recon.id,
        agent: recon.agent,
        slug: recon.slug,
        status: recon.status, // 临时值，各分支覆盖
        mode: recon.mode,
        startedAt: recon.startedAt,
        rootSessionId: recon.rootSessionId,
        parentRecordId: recon.parentRecordId,
        depth: recon.depth,
        endedAt: undefined,
        turns: recon.turnCount,
        totalTokens: recon.totalTokens,
        model: recon.model,
        thinkingLevel: recon.thinkingLevel,
        task: recon.task,
        // 磁盘重建是离线快照，无实时活动状态。
        currentActivity: undefined,
        // worktreeHandle 不从磁盘重建（session.jsonl 未持久化路径/分支）。
        // 已结束的 worktree record 的 checkout 已被 cleanup 回收，重建句柄无意义。
        // forkDepth 从 identity 重建（用于 TUI 深度标记），worktree 信息仅内存 running 时可见。
        eventLog: recon.eventLog,
        // [STEP3] displayItems 从重建的 turns[] 派生（getDisplayItems 参数放宽为
        // { turns }，ReconstructedRecord 满足）。终态 record 详情可看完整 text 输出。
        displayItems: getDisplayItems(recon),
        result: recon.result,
        error: recon.error,
        sessionFile: recon.sessionFile,
      };

      // ── 分支 1: .cancelled ──
      if (tomb) {
        markReconstructedStatus(rec, "cancelled");
        rec.error = "cancelled by user";
        rec.endedAt = tomb.endedAt;
      }
      // ── 分支 2: .finalized ──
      else if (finalized) {
        // done/failed 按 recon 推导的 stopReason（reconstructFromFile 已映射为 status）。
        const status: ExecutionStatus = recon.status === "failed" ? "failed" : "done";
        markReconstructedStatus(rec, status);
        // 用最后一条 entry 的时间戳作为 endedAt（避免重建后耗时随墙钟无限增长）。
        rec.endedAt = recon.endedAt;
      }
      // ── 分支 3: .alive + pid 存活 + 未超 24h 软超时 ──
      else if (
        alive !== undefined &&
        isProcessAlive(alive.pid) &&
        now - alive.startedAt < ALIVE_SOFT_TIMEOUT_MS
      ) {
        markReconstructedStatus(rec, "running");
        rec.externalInstance = alive;
      }
      // ── 分支 4: 兜底（都无 / .alive 但 pid 死 / 超 24h）──
      else {
        markReconstructedStatus(rec, "crashed");
        // crashed 以最后已知活动时间为准（pid 死亡时间未知，用最后 entry 时间近似）。
        rec.endedAt = recon.endedAt;
      }

      cache.set(file, rec);
    }

    this.reconCache = cache;
    // 带 filter 时在缓存上筛（上面已构造全量缓存，便于后续调用复用）。
    if (rootSessionFilter === undefined) return [...cache.values()];
    return [...cache.values()].filter((r) => r.rootSessionId === rootSessionFilter);
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
      slug: r.slug,
      startedAt: r.startedAt,
      rootSessionId: r.rootSessionId,
      parentRecordId: r.parentRecordId,
      depth: r.depth,
      endedAt: r.endedAt,
      turns: r.turnCount,
      totalTokens: r.totalTokens,
      model: r.model,
      thinkingLevel: r.thinkingLevel,
      task: r.task,
      currentActivity: getCurrentActivity(r),
      eventLog: getEventLog(r),
      displayItems: getDisplayItems(r),
      result: r.result,
      error: r.error,
      sessionFile: r.sessionFile,
    };
  }
}
