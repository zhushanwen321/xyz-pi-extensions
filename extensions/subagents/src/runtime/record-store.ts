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

import { snapshot } from "../core/execution-record.ts";
import type {
  ExecutionRecord,
  SubagentRecord,
} from "../types.ts";
import type { RecordSnapshot } from "../types.ts";
import type { HistoryStore } from "./history-store.ts";

/** store 变更监听器（返回取消订阅函数）。 */
export type ChangeListener = () => void;

/**
 * Record 容器。进程单例（随 SubagentRuntime 重建）。
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
  constructor(private readonly history: HistoryStore) {
    void snapshot;
    throw new Error("not implemented");
  }

  /** 注册新 record（live map）。触发 onChange。 */
  register(record: ExecutionRecord): void {
    //  1. live.set(record.id, record)
    //  2. notifyChange()
    void record;
    throw new Error("not implemented");
  }

  /**
   * 归档：live → completed/bg（按 mode）。sync 进 completed（5s linger 后移除），
   * background 进 bg map（活到被查询或 FIFO 淘汰）。
   */
  archive(record: ExecutionRecord): void {
    //  1. live.delete(record.id)
    //  2. record.mode==="background" ? bg.set : completed.set
    //  3. sync 模式 scheduleSyncExpire(id, 5000) → 5s 后从 completed 移除
    //  4. bg 模式 FIFO 淘汰（cap BG_MAX，绝不淘汰 running）
    //  5. notifyChange()
    void record;
    throw new Error("not implemented");
  }

  /** 按 id 查找（live/completed/bg 三内存源）。返回可变 record（仅 runtime 内部用）。 */
  getMutable(id: string): ExecutionRecord | undefined {
    //  live.get ?? completed.get ?? bg.get
    void id;
    throw new Error("not implemented");
  }

  /** 按 id 查找并返回只读快照（poll/TUI 用）。 */
  snapshot(id: string): RecordSnapshot | undefined {
    //  getMutable(id) → snapshot()
    void id;
    throw new Error("not implemented");
  }

  /** 列出所有 record 的只读快照（widget 计数、诊断用）。 */
  listRunning(): RecordSnapshot[] {
    //  live.values() → snapshot() each
    throw new Error("not implemented");
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
    //  1. history.recent(limit, sessionId) → historyRecords
    //  2. bg + completed + live → memoryRecords
    //  3. byId Map merge（内存源覆盖；cancelled 即使被覆盖也保留）
    //  4. sortRecords（status priority + startedAt desc）
    void limit; void sessionId;
    throw new Error("not implemented");
  }

  /** 订阅变更。返回取消订阅函数。 */
  onChange(listener: ChangeListener): () => void {
    //  listeners.add(listener); return () => listeners.delete(listener)
    void listener;
    throw new Error("not implemented");
  }

  /** 触发所有监听器（TUI widget/list requestRender）。 */
  notifyChange(): void {
    //  listeners.forEach(l => l())
    throw new Error("not implemented");
  }

  /** session 结束清理：清空所有定时器、丢弃 pending 通知。 */
  dispose(): void {
    //  clear 所有 linger timers + listeners
    throw new Error("not implemented");
  }

  /** /resume /fork /new 后复活（dispose 的逆操作）。 */
  revive(): void {
    //  _disposed = false
    throw new Error("not implemented");
  }
}
