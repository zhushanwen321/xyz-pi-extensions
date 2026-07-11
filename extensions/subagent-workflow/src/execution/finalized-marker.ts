// src/runtime/execution/finalized-marker.ts
//
// Finalized 状态的 sidecar 持久化。
//
// 背景：subagent 执行完成（done/failed）后，session.jsonl 的最终写入可能因进程
// 异常终止而丢失。`.finalized` sidecar 标记该 session 已正常结束，collectRecords
// 重建时可用它区分「正常结束但文件截断」与「执行中断」。
//
// 设计：对称 cancelled sidecar（tombstone-store.ts）。`.finalized` 为空文件，
// 存在性即信号（done/failed 的细分仍靠 recon.stopReason 推断）。与 `.cancelled`
// 互斥——一个 session 要么 finalized 要么 cancelled，不可能两者兼有。
//
// best-effort：写 IO 错静默，不阻断主流程。

import * as fs from "node:fs";

// ============================================================
// 公开函数
// ============================================================

/**
 * 在 session.jsonl 旁写 `.finalized` sidecar（空文件）。
 * best-effort：任何 I/O 错误静默（finalize 标记是次要信号，status 已在内存 record 上设好）。
 *
 * 与 `.cancelled` 互斥（BC-4）：写前删除 `.cancelled`（如存在），确保不会两者共存。
 */
export function writeFinalized(sessionFile: string): void {
  try {
    // BC-4 互斥：清理可能存在的 .cancelled。force:true 静默 ENOENT——
    // 未 cancel 过的 session（done/failed/aborted）本就无 .cancelled，属正常路径。
    // 此前用 unlinkSync+bestEffort 记 console.debug，取消嵌套链条时每层 ENOENT 刷屏。
    fs.rmSync(`${sessionFile}.cancelled`, { force: true });
    fs.writeFileSync(`${sessionFile}.finalized`, "", "utf-8");
  } catch (_e) {
    void _e; // 静默：写失败不阻断 finalize 主流程。
  }
}

/**
 * 读 session.jsonl 旁的 `.finalized` sidecar。
 * 返回 true：sidecar 存在（内容不校验，存在性即信号）。
 * 返回 false：sidecar 不存在 / 读取失败。
 */
export function readFinalized(sessionFile: string): boolean {
  try {
    fs.accessSync(`${sessionFile}.finalized`);
    return true;
  } catch {
    return false;
  }
}
