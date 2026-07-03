// code-skeleton/runtime/execution/record-store.ts — ⑤骨架（#2/#12 修改）
// reconstructAll 四分支（D-006 三分支 + D-021 pid 探活扩展）。
// STATUS_PRIORITY 加 crashed=1。
// 所有分支经 markReconstructedStatus（AC-2.2 不裸赋值）。

import type { ExecutionStatus, ExecutionRecord, SubagentRecord } from "../../types.ts";
import { markReconstructedStatus } from "../../core/execution-record.ts";
import { readFinalized } from "./finalized-marker.ts";
import { readAliveMarker, isProcessAlive, ALIVE_SOFT_TIMEOUT_MS } from "./alive-store.ts";

/**
 * STATUS_PRIORITY（#2 ✎ 加 crashed=1）。
 * 值小排前：running < failed=crashed < cancelled < done。
 * crashed 同 failed 优先级（均异常终态，排前）。
 */
const STATUS_PRIORITY: Record<ExecutionStatus, number> = {
  running: 0,
  failed: 1,
  crashed: 1,
  cancelled: 2,
  done: 3,
};

/**
 * reconstructAll 四分支（#2 三分支 + #12 pid 探活扩展）。
 *
 * 四分支（D-006 + D-021）：
 *   1. .cancelled → cancelled
 *   2. .finalized → done|failed（按 recon.stopReason 推）
 *   3. .alive 存在 且 isProcessAlive 且 <24h → running + externalInstance=true（D-023）
 *   4. 都无 / .alive+死pid / >24h → crashed
 *
 * 全部经 markReconstructedStatus（不裸 .status=，AC-2.2/2.3）。
 *
 * 竞态/不变式：四分支非原子（磁盘 sidecar 读之间状态可能变）——接受（重建是 best-effort 快照）。
 * externalInstance（D-023）：分支3 标 true，status 保持 running（不污染 ExecutionStatus 联合类型）。
 */
export function reconstructAll(sessionsDir: string): SubagentRecord[] {
  // 骨架聚焦四分支逻辑接线，文件遍历简化为单文件示例（完整遍历见现有 record-store.ts）
  const results: SubagentRecord[] = [];
  const sessionFile = `${sessionsDir}/example.jsonl`; // 叶子 stub：实际遍历 readdirSync

  // 占位 record（实际从 session.jsonl 重建 recon）
  const record: ExecutionRecord = {
    id: "example",
    status: "running",
    sessionFile,
  };

  // 四分支检测（D-006 + D-021）
  const hasCancelled = false; // 叶子 stub：readCancelledTombstone(sessionFile)
  const hasFinalized = readFinalized(sessionFile);
  const alive = readAliveMarker(sessionFile);

  if (hasCancelled) {
    // 分支1：.cancelled → cancelled
    markReconstructedStatus(record, "cancelled");
  } else if (hasFinalized) {
    // 分支2：.finalized → done|failed（按 recon.stopReason 推，骨架标 done）
    markReconstructedStatus(record, "done");
  } else if (alive && isProcessAlive(alive.pid) && Date.now() - alive.startedAt < ALIVE_SOFT_TIMEOUT_MS) {
    // 分支3：.alive + 活pid + <24h → running + externalInstance（D-021/D-023）
    markReconstructedStatus(record, "running");
    results.push({ ...toSubagent(record), externalInstance: true });
    return results;
  } else {
    // 分支4：都无 / pid死 / >24h → crashed（D-006/D-021）
    markReconstructedStatus(record, "crashed");
  }

  results.push(toSubagent(record));
  return results;
}

/** ExecutionRecord → SubagentRecord 投影（节选）。 */
function toSubagent(r: ExecutionRecord): SubagentRecord {
  return {
    id: r.id,
    status: r.status,
    sessionFile: r.sessionFile,
  };
}
