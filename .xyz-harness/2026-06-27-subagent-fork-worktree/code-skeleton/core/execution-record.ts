// code-skeleton/core/execution-record.ts — ⑤骨架（#2 修改）
// 状态机 + 重建收口。crashed 终态 + markReconstructedStatus。
// D-010: crashed 是新终态（不经运行期 tryTransition，仅重建推断）。
// M3/AC-2.2: markReconstructedStatus 收口——重建专用，跳过 CAS，不裸 .status=。

import type { ExecutionStatus, ExecutionRecord } from "../types.ts";

/** tryTransition target 加 crashed（D-010）。运行期 CAS 转换（重建态不走此）。 */
const VALID_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
  running: ["done", "failed", "cancelled", "crashed"],
  done: [], // 终态不可逆
  failed: [],
  cancelled: [],
  crashed: [], // 终态不可逆
};

/**
 * 运行期 CAS 状态转换（现有 tryTransition，target 加 crashed）。
 * crashed 实际不经此（重建推断态）——但 target 类型须含 crashed 供类型完整。
 */
export function tryTransition(record: ExecutionRecord, target: ExecutionStatus): boolean {
  const allowed = VALID_TRANSITIONS[record.status];
  if (!allowed.includes(target)) return false;
  record.status = target; // 运行期合法写点（CAS 收口）
  return true;
}

/**
 * markReconstructedStatus（#2 NEW 重建收口）。
 * 重建专用——跳过 CAS（重建态无内存 running record 可竞争），直接赋值。
 * AC-2.2/2.3: 这是 record-store 重建路径 status 的唯一写点（静态扫描禁 execution-record 外的 .status= 裸赋值）。
 *
 * 数据流：record-store.reconstructAll 四分支 → markReconstructedStatus（每分支调）
 * 不变式：仅重建路径用此；运行期转换走 tryTransition（CAS）。
 */
export function markReconstructedStatus(record: ExecutionRecord, status: ExecutionStatus): void {
  // 重建专用收口：不 CAS（死进程无竞争），但集中此方法保证 status 写点单一可审计
  record.status = status;
}
