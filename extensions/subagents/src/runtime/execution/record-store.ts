// src/runtime/execution/record-store.ts
//
// Record 的统一容器。单 Map + 按 status/mode 过滤。
//
// 职责：
//   - 持有所有内存 record（单 Map，按 status/mode 过滤替代物理分区）
//   - onChange 订阅（TUI widget/list 据此重渲）
//   - 与 history-store 协作：completed 后写入持久化，list 时 merge 四源
//   - 提供 snapshot() 只读视图给 TUI（永不返回可变引用）

import { snapshot as toSnapshot } from "../../core/execution-record.ts";
import type {
  ExecutionMode,
  ExecutionRecord,
  ExecutionStatus,
  RecordSnapshot,
  SubagentRecord,
} from "../../types.ts";
import type { HistoryStore } from "./history-store.ts";

// ============================================================
// 常量
// ============================================================

/** sync completed record 在内存的 linger 时长（ms）。过期后从 completed map 移除。 */
const SYNC_LINGER_MS = 5000;

/** background record 的 FIFO 上限（绝不淘汰 running）。 */
const BG_FIFO_MAX = 50;

/** status → 排序优先级（值小排前）：running < failed < cancelled < done。 */
const STATUS_PRIORITY: Record<ExecutionStatus, number> = {
  running: 0,
  failed: 1,
  cancelled: 2,
  done: 3,
};

/** store 变更监听器（返回取消订阅函数）。 */
export type ChangeListener = () => void;

// ============================================================
// RecordStore
// ============================================================

/**
 * Record 容器。进程单例（随 SubagentService 重建）。
 *
 * 单 Map 架构：所有 record 存在一个 Map 中，按 status/mode 过滤。
 * 终态 record 通过 TTL 定时器自动清理（sync 5s linger，bg FIFO）。
 * 任何 mutate → notifyChange()。
 */
export class RecordStore {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly listeners = new Set<ChangeListener>();
  /** 定时器（key=record id，用于 sync linger 和 bg TTL 清理）。 */
  private readonly expireTimers = new Map<string, NodeJS.Timeout>();
  private _disposed = false;

  constructor(private readonly history: HistoryStore) {}

  /** 注册新 record。触发 onChange。 */
  register(record: ExecutionRecord): void {
    this.records.set(record.id, record);
    this.notifyChange();
  }

  /**
   * 归档：record 已被 completeRecord 设置了终态 status，不迁移 Map。
   * sync 启动 5s linger 定时器，到期后从 records 移除。
   * bg 直接保留（活到被查询或 FIFO 淘汰）。
   */
  archive(record: ExecutionRecord): void {
    if (record.mode === "background") {
      this.enforceBgFifo();
    } else {
      this.scheduleSyncExpire(record.id);
    }
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
   * 合并内存 + history → SubagentRecord[]（/subagents list 消费）。
   *   - history（跨 session jsonl，按 sessionId 过滤）
   *   - memory（当前 session，所有 mode/status）
   * 合并规则：内存源覆盖 history；cancelled 状态优先保留（用户意图）。
   * 排序：status priority（running<failed<cancelled<done）+ startedAt desc。
   */
  collectRecords(limit: number, sessionId?: string): SubagentRecord[] {
    // 1. history 基底（跨 session，按 sessionId 过滤）
    const byId = new Map<string, SubagentRecord>();
    for (const h of this.history.recent(limit, sessionId)) {
      byId.set(h.id, RecordStore.persistedToSubagent(h));
    }
    // 2. 内存源覆盖（单 Map，当前 session）
    for (const r of this.records.values()) {
      const existing = byId.get(r.id);
      // cancelled 状态优先保留（用户意图，即使被内存覆盖）
      if (existing?.status === "cancelled" && r.status !== "cancelled") {
        continue;
      }
      byId.set(r.id, RecordStore.recordToSubagent(r));
    }
    // 3. 排序 + slice
    return [...byId.values()]
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

  /** 触发所有监听器（TUI widget/list requestRender）。dispose 后短路。 */
  notifyChange(): void {
    if (this._disposed) return;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** session 结束清理：清空所有定时器、丢弃 pending 通知。 */
  dispose(): void {
    this._disposed = true;
    for (const timer of this.expireTimers.values()) {
      clearTimeout(timer);
    }
    this.expireTimers.clear();
    this.listeners.clear();
  }

  /** /resume /fork /new 后复活（dispose 的逆操作）。 */
  revive(): void {
    this._disposed = false;
  }

  // ── 内部 ──────────────────────────────────────────────────

  /** sync record 的 linger 定时器：到期后从 records 移除。 */
  private scheduleSyncExpire(id: string): void {
    // 防御：dispose 后不再 re-arm
    if (this._disposed) return;
    const timer = setTimeout(() => {
      this.expireTimers.delete(id);
      if (this._disposed) return;
      // 仅当仍为终态时移除（避免竞态）
      const record = this.records.get(id);
      if (record && record.status !== "running") {
        this.records.delete(id);
        this.notifyChange();
      }
    }, SYNC_LINGER_MS);
    this.expireTimers.set(id, timer);
  }

  /** bg FIFO 淘汰：超 BG_FIFO_MAX 时移除最旧的非 running 终态 bg record。 */
  private enforceBgFifo(): void {
    // 计算 bg mode 的终态 record
    const bgTerminal: Array<{ id: string; startedAt: number }> = [];
    for (const [id, r] of this.records) {
      if (r.mode === "background" && r.status !== "running") {
        bgTerminal.push({ id, startedAt: r.startedAt });
      }
    }
    if (bgTerminal.length <= BG_FIFO_MAX) return;
    // 按 startedAt 升序，淘汰最旧的
    bgTerminal.sort((a, b) => a.startedAt - b.startedAt);
    const toRemove = bgTerminal.length - BG_FIFO_MAX;
    for (let i = 0; i < toRemove; i++) {
      this.records.delete(bgTerminal[i].id);
    }
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
      turns: r.turns,
      totalTokens: r.totalTokens,
      model: r.model,
      thinkingLevel: r.thinkingLevel,
      eventLog: r.eventLog.slice(),
      result: r.result,
      error: r.error,
      // sessionFile 由 record.sessionFile 提供（规范源，见 session-runner）。
      sessionFile: r.sessionFile,
    };
  }

  /** PersistedAgentRecord → SubagentRecord（history 源投影）。 */
  private static persistedToSubagent(p: {
    id: string;
    agent: string;
    status: ExecutionStatus;
    mode: ExecutionMode;
    startedAt: number;
    endedAt?: number;
    turns?: number;
    totalTokens?: number;
    model?: string;
    thinkingLevel?: string;
    resultPreview?: string;
    error?: string;
    sessionFile?: string;
  }): SubagentRecord {
    return {
      id: p.id,
      agent: p.agent,
      status: p.status,
      mode: p.mode,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      turns: p.turns ?? 0,
      totalTokens: p.totalTokens ?? 0,
      model: p.model ?? "",
      thinkingLevel: p.thinkingLevel,
      eventLog: [],
      result: p.resultPreview,
      error: p.error,
      sessionFile: p.sessionFile,
    };
  }
}
