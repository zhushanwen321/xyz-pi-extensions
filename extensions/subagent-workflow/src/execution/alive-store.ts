// src/runtime/execution/alive-store.ts
//
// .alive sidecar 生产者 + pid 探活。
//
// 子进程启动时写 .alive（pid+id+startedAt），心跳检测时读它 + isProcessAlive
// 判活。finalize/cancel 收尾时 remove。与 .cancelled/.finalized 构成三件套。
//
// 设计对齐 tombstone-store：单文件 sidecar、best-effort I/O、无全局 index。

import * as fs from "node:fs";

import type { AliveMarker } from "./types.ts";

// ============================================================
// 公开函数
// ============================================================

/**
 * 在 sessionFile 旁写 .alive sidecar（单行 JSON）。
 * 覆盖写——同一 sessionFile 只有最后一个 alive marker 有意义。
 */
export function writeAliveMarker(sessionFile: string, marker: AliveMarker): void {
  const alivePath = `${sessionFile}.alive`;
  fs.writeFileSync(alivePath, `${JSON.stringify(marker)}\n`, "utf-8");
}

/**
 * 读 sessionFile 旁的 .alive sidecar。
 * 返回 undefined：不存在 / 损坏 / 解析失败。
 */
export function readAliveMarker(sessionFile: string): AliveMarker | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(`${sessionFile}.alive`, "utf-8");
  } catch {
    return undefined;
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
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 删除 sessionFile 旁的 .alive sidecar。
 * best-effort：不存在不抛（finalize/cancel 收尾调，sidecar 可能已被清理）。
 */
export function removeAliveMarker(sessionFile: string): void {
  try {
    fs.unlinkSync(`${sessionFile}.alive`);
  } catch {
    void 0; // best-effort
  }
}

/**
 * 检测 pid 是否存活。
 *
 * process.kill(pid, 0) 语义：不发信号，仅检查进程是否存在。
 *   - 无异常 → 存活
 *   - ESRCH（No such process）→ 死
 *   - EPERM（Process exists but no permission）→ 存活（保守）
 *   - 其他异常 → 保守判死 false，避免误删活进程
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (isErrnoException(err) && err.code === "EPERM") {
      return true; // 存在但无权限发信号 → 判活
    }
    return false; // ESRCH 或其他异常 → 保守判死
  }
}

// ============================================================
// 内部工具
// ============================================================

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}
