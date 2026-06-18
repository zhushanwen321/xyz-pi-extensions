// src/runtime/record-store.ts
//
// Record 的统一容器。替代旧实现中散落在 runtime 的 _runningAgents /
// _completedAgents / _bgRecords 三个独立 Map。
//
// 职责：
//   - 持有 live（running）/ completed（linger）/ bg（detached）三组内存 record
//   - onChange 订阅（TUI widget/list 据此重渲）
//   - 与 history-store 协作：completed 后写入持久化，list 时 merge 四源
//   - 提供 snapshot() 只读视图给 TUI（永不返回可变引用）

import { snapshot as toSnapshot } from "../core/execution-record.ts";
import type {
  ExecutionMode,
  ExecutionRecord,
  ExecutionStatus,
  RecordSnapshot,
  SubagentRecord,
} from "../types.ts";
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
 * Record 容器。进程单例（随 SubagentHub 重建）。
 *
 *   ╔══════════════════════════════════════════════════════════════════╗
//   ║  ┌─────────────┐  ┌──────────────┐  ┌──────────────┐             ║
//   ║  │ live Map    │  │ completed Map│  │ bg Map       │             ║
//   ║  │ (running)   │  │ (linger 5s)  │  │ (detached)   │             ║
//   ║  └─────┬───────┘  └──────┬───────┘  └──────┬───────┘             ║
//   ║        │ 完成时迁移        │ TTL 到期移除    │ 被 poll/淘汰读取    ║
//   ║        └────────┬─────────┴────────────┬────┘                    ║
//   ║                 ▼                      ▼                         ║
//   ║          listRecords()           history.recent()                ║
//   ║                 └──────── merge ───────┘                         ║
//   ║                          │                                       ║
//   ║                          ▼                                       ║
//   ║              SubagentRecord[]（/subagents list 消费）            ║
//   ║                                                                  ║
//   ║  任何 mutate（register/archive/expire/cancel）→ notifyChange()   ║
//   ╚══════════════════════════════════════════════════════════════════╝
 */
export class RecordStore {
  private readonly live = new Map<string, ExecutionRecord>();
  private readonly completed = new Map<string, ExecutionRecord>();
  private readonly bg = new Map<string, ExecutionRecord>();
  private readonly listeners = new Set<ChangeListener>();
  /** sync linger 定时器（key=record id）。 */
  private readonly lingerTimers = new Map<string, NodeJS.Timeout>();
  private _disposed = false;

  constructor(private readonly history: HistoryStore) {}

  /** 注册新 record（live map）。触发 onChange。 */
  register(record: ExecutionRecord): void {
    this.live.set(record.id, record);
    this.notifyChange();
  }

  /**
   * 归档：live → completed/bg（按 mode）。sync 进 completed（5s linger 后移除），
   * background 进 bg map（活到被查询或 FIFO 淘汰）。
   */
  archive(record: ExecutionRecord): void {
    this.live.delete(record.id);
    if (record.mode === "background") {
      this.bg.set(record.id, record);
      this.enforceBgFifo();
    } else {
      this.completed.set(record.id, record);
      this.scheduleSyncExpire(record.id);
    }
    this.notifyChange();
  }

  /** 按 id 查找（live/completed/bg 三内存源）。返回可变 record（仅 runtime 内部用）。 */
  getMutable(id: string): ExecutionRecord | undefined {
    return this.live.get(id) ?? this.completed.get(id) ?? this.bg.get(id);
  }

  /** 按 id 查找并返回只读快照（poll/TUI 用）。 */
  snapshot(id: string): RecordSnapshot | undefined {
    const record = this.getMutable(id);
    return record ? toSnapshot(record) : undefined;
  }

  /** 列出所有 running record 的只读快照（widget 计数、诊断用）。 */
  listRunning(): RecordSnapshot[] {
    return [...this.live.values()].map((r) => toSnapshot(r));
  }

  /**
   * 合并四源 → SubagentRecord[]（/subagents list 消费）。
   *   - history（跨 session jsonl，按 sessionId 过滤）
   *   - bg（当前 session detached）
   *   - completed（当前 session linger）
   *   - live（当前 session running）
   * 合并规则：内存源覆盖 history；cancelled 状态优先保留（用户意图）。
   * 排序：status priority（running<failed<cancelled<done）+ startedAt desc。
   */
  collectRecords(limit: number, sessionId?: string): SubagentRecord[] {
    // 1. history 基底（跨 session，按 sessionId 过滤）
    const byId = new Map<string, SubagentRecord>();
    for (const h of this.history.recent(limit, sessionId)) {
      byId.set(h.id, RecordStore.persistedToSubagent(h));
    }
    // 2. 内存源覆盖（bg + completed + live，当前 session）
    const memorySources = [
      ...this.bg.values(),
      ...this.completed.values(),
      ...this.live.values(),
    ];
    for (const r of memorySources) {
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
    for (const timer of this.lingerTimers.values()) {
      clearTimeout(timer);
    }
    this.lingerTimers.clear();
    this.listeners.clear();
  }

  /** /resume /fork /new 后复活（dispose 的逆操作）。 */
  revive(): void {
    this._disposed = false;
  }

  // ── 内部 ──────────────────────────────────────────────────

  /** sync completed record 的 linger 定时器：到期后从 completed 移除。 */
  private scheduleSyncExpire(id: string): void {
    const timer = setTimeout(() => {
      this.lingerTimers.delete(id);
      // 仅当仍为非 running 终态时移除（避免竞态）
      const record = this.completed.get(id);
      if (record && record.status !== "running") {
        this.completed.delete(id);
        this.notifyChange();
      }
    }, SYNC_LINGER_MS);
    this.lingerTimers.set(id, timer);
  }

  /** bg FIFO 淘汰：超 BG_FIFO_MAX 时移除最旧的非 running record。 */
  private enforceBgFifo(): void {
    while (this.bg.size > BG_FIFO_MAX) {
      // 找最旧的非 running（绝不淘汰 running）
      let oldestId: string | undefined;
      let oldestTs = Infinity;
      for (const [id, record] of this.bg) {
        if (record.status === "running") continue;
        if (record.startedAt < oldestTs) {
          oldestTs = record.startedAt;
          oldestId = id;
        }
      }
      if (oldestId) {
        this.bg.delete(oldestId);
      } else {
        break; // 全是 running，无法淘汰
      }
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
      sessionFile: r.agentResult?.sessionFile,
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
