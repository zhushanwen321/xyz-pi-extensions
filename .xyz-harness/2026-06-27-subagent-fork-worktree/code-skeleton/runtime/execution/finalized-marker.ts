// code-skeleton/runtime/execution/finalized-marker.ts — ⑤骨架（#5 NEW）
// .finalized sidecar 持久化。范式复用 tombstone-store.ts（.cancelled sidecar）。
// D-006: finalize 时写 .finalized；重建时 readFinalized 判 done/failed（区别 crashed）。
// BC-4: 与 .cancelled 互斥（cancel 不写 finalized）。

import * as fs from "node:fs";

/**
 * 写 .finalized sidecar（#5）。finalizeRecord D-017 ③调。
 * 内容极简（存在性即信号）——done/failed 细分仍靠 recon.stopReason 推。
 * best-effort：IO 错静默（D-017 ③独立 try/catch）。
 *
 * 数据流：finalizeRecord(D-017 ③) → writeFinalized → .finalized sidecar 落盘
 * 失败路径：IO 错静默（下次重建「都无」分支判 crashed——保守降级，record 磁盘完整）
 */
export function writeFinalized(sessionFile: string): void {
  try {
    fs.writeFileSync(`${sessionFile}.finalized`, "", "utf-8");
  } catch (_e) {
    void _e; // 静默：D-017 ③ best-effort。
  }
}

/**
 * 读 .finalized sidecar（#5）。reconstructAll 四分支分支2调。
 * sidecar 存在=true（正常完成），不存在/损坏=false（走 crashed 分支）。
 */
export function readFinalized(sessionFile: string): boolean {
  try {
    return fs.existsSync(`${sessionFile}.finalized`);
  } catch (_e) {
    void _e;
    return false; // 损坏 → 降级 false。
  }
}
