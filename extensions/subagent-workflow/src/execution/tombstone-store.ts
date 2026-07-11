// src/runtime/execution/tombstone-store.ts
//
// Cancelled 状态的 sidecar 持久化。
//
// 背景：用户 cancel background subagent 时 session.abort() → prompt() reject →
// session.jsonl 被中途截断（无最终 assistant message，无 stopReason 标记）。所以
// cancelled 状态无法从 session.jsonl 可靠检测。本模块在 session.jsonl 旁写一个
// `.cancelled` sidecar 文件（单行 JSON），collectRecords 重建时读它 override status。
//
// 设计：单条 cancelled = 单 sidecar，无全局 index 可损坏，无并发问题，被现有
// session-file-gc 的目录扫描自然清理（GC 已扩展为也清理 .cancelled）。YAGNI 更重方案。

import * as fs from "node:fs";

// ============================================================
// 类型
// ============================================================

/** Tombstone 内容（单行 JSON）。 */
export interface CancelledTombstone {
  id: string;
  status: "cancelled";
  agent: string;
  startedAt: number;
  endedAt: number;
}

// ============================================================
// 公开函数
// ============================================================

/**
 * 在 session.jsonl 旁写 cancelled tombstone。
 * best-effort：任何 I/O 错误静默（cancel 已成功，持久化是次要的——内存 record 即将被
 * archive 淘汰，下次读靠 tombstone 标记 cancelled）。
 */
export function writeCancelledTombstone(sessionFile: string, meta: CancelledTombstone): void {
  try {
    const tombstonePath = `${sessionFile}.cancelled`;
    fs.writeFileSync(tombstonePath, `${JSON.stringify(meta)}\n`, "utf-8");
  } catch (_e) {
    void _e; // 静默：写失败不阻断 cancel 主流程（status 已在内存 record 上设好）。
  }
}

/**
 * 读 session.jsonl 旁的 cancelled tombstone。
 * 返回 undefined：sidecar 不存在 / 损坏 / 解析失败。
 */
export function readCancelledTombstone(sessionFile: string): CancelledTombstone | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`${sessionFile}.cancelled`, "utf-8");
  } catch {
    return undefined; // sidecar 不存在（正常——非 cancelled record 无 sidecar）。
  }
  try {
    const parsed = JSON.parse(raw) as Partial<CancelledTombstone>;
    if (
      typeof parsed.id === "string" &&
      parsed.status === "cancelled" &&
      typeof parsed.agent === "string" &&
      typeof parsed.startedAt === "number" &&
      typeof parsed.endedAt === "number"
    ) {
      return parsed as CancelledTombstone;
    }
    return undefined; // 结构不合法 → 降级。
  } catch {
    return undefined; // JSON 损坏 → 降级。
  }
}
