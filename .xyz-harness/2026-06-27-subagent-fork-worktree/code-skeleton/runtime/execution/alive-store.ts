// code-skeleton/runtime/execution/alive-store.ts — ⑤骨架（#13 NEW 生产者）
// .alive sidecar + pid 探活。对称 .cancelled/.finalized sidecar 家族。
// 范式复用 tombstone-store.ts（.cancelled sidecar）。纯函数模块，无 Pi 依赖。
// D-021 方案A（pid 探活）：运行时写 .alive，重建「都无」分支先探活。

import * as fs from "node:fs";
import type { AliveMarker } from "../../types.ts";

/**
 * 写 .alive sidecar（#13）。session 创建后 prompt 前调（紧邻 identity entry）。
 * 对称 .cancelled/.finalized 三件。best-effort：IO 错静默（session 已创建，标记是次要的）。
 *
 * 数据流：session-runner(session创建后) → writeAliveMarker → .alive sidecar 落盘
 * 失败路径：IO 错静默（下次重建「都无」分支判 crashed——保守安全降级）
 */
export function writeAliveMarker(sessionFile: string, marker: AliveMarker): void {
  try {
    fs.writeFileSync(`${sessionFile}.alive`, `${JSON.stringify(marker)}\n`, "utf-8");
  } catch (_e) {
    void _e; // 静默：写失败不阻断 session 主流程。
  }
}

/**
 * 读 .alive sidecar（#13）。重建四分支 + reaper 调。
 * 返回 undefined：sidecar 不存在/损坏/解析失败。
 */
export function readAliveMarker(sessionFile: string): AliveMarker | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`${sessionFile}.alive`, "utf-8");
  } catch {
    return undefined; // sidecar 不存在（正常——非 running record 无 sidecar）。
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AliveMarker>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.id === "string" &&
      typeof parsed.startedAt === "number"
    ) {
      return parsed as AliveMarker;
    }
    return undefined; // 结构不合法 → 降级。
  } catch {
    return undefined; // JSON 损坏 → 降级。
  }
}

/**
 * 删 .alive sidecar（#13）。finalize/cancel 收尾调。
 * best-effort：不存在忽略。
 */
export function removeAliveMarker(sessionFile: string): void {
  try {
    fs.unlinkSync(`${sessionFile}.alive`);
  } catch (_e) {
    void _e; // 不存在忽略。
  }
}

/**
 * pid 探活（#12/D-021 方案A）。process.kill(pid, 0) 发空信号测存在性。
 * 竞态/不变式：pid 复用（A 死后 pid 被 B 复用）→ 误判活，靠 startedAt+24h 软超时兜底（D-021）。
 *
 * 返回语义：
 *   无异常=活 / ESRCH(pid 不存在)=死 / EPERM(存在但无权限)=存活 / 其他异常=保守判死 false
 * 保守判死：避免异常路径误判活进程为死导致 reaper 误删（D-024 安全网）。
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true; // 无异常=活（含 EPERM 由 catch 区分）。
  } catch (e) {
    const err = e as { code?: string };
    if (err.code === "EPERM") {
      return true; // pid 存在但无权限发信号 → 存活。
    }
    return false; // ESRCH(pid 不存在) 或其他异常 → 保守判死。
  }
}

/** 24h 软超时（ms）。超过此则无视探活直接判 crashed（D-021 pid 复用兜底）。 */
export const ALIVE_SOFT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
