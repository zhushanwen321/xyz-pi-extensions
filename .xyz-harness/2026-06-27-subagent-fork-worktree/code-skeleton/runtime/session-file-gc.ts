// code-skeleton/runtime/session-file-gc.ts — ⑤骨架（#10 修改）
// walkAndClean 加清 .finalized + .alive（B3: 清 .alive 先探活）。
// 现有 .jsonl/.cancelled 清理不变。

import * as fs from "node:fs";
import * as path from "node:path";
import { readAliveMarker, isProcessAlive } from "./execution/alive-store.ts";

/** 30 天 TTL（ms）。 */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * walkAndClean（#10 ✎）。加清 .finalized + .alive。
 * B3 安全网：清 .alive 不能盲删——若对应 pid 仍活（跨实例跑着），删 .alive 会让下次重建
 *   漏判 running-elsewhere 误判 crashed。故清 .alive 前先 readAliveMarker+isProcessAlive，活则跳过。
 *
 * 数据流：session_start → maybeCleanup → walkAndClean → 遍历 .jsonl/.cancelled/.finalized/.alive
 * 不变式：.alive 清理有探活守卫（区别于 .jsonl/.cancelled/.finalized 的 TTL 盲删）。
 */
export function walkAndClean(dir: string, now: number): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_e) {
    void _e;
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkAndClean(full, now);
    } else if (entry.name.endsWith(".jsonl")) {
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > TTL_MS) {
          fs.unlinkSync(full);
          // 对称清 .cancelled/.finalized（同名 sidecar）
          for (const ext of [".cancelled", ".finalized"]) {
            try { fs.unlinkSync(`${full}${ext}`); } catch (_e) { void _e; }
          }
          // B3: 清 .alive 先探活（isProcessAlive=true 不清，AC-10.2）
          const alivePath = `${full}.alive`;
          if (fs.existsSync(alivePath)) {
            const alive = readAliveMarker(full);
            if (!alive || !isProcessAlive(alive.pid)) {
              try { fs.unlinkSync(alivePath); } catch (_e) { void _e; }
            }
            // pid 活 → 跳过（跨实例正跑，不删 .alive）
          }
        }
      } catch (_e) {
        void _e;
      }
    } else if (entry.name.endsWith(".cancelled") || entry.name.endsWith(".finalized")) {
      // 孤儿 sidecar（兄弟 .jsonl 已删）：按同 TTL 清理
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > TTL_MS) {
          fs.unlinkSync(full);
        }
      } catch (_e) {
        void _e;
      }
    } else if (entry.name.endsWith(".alive")) {
      // 孤儿 .alive：B3 先探活（区别于其他 sidecar 的 TTL 盲删）
      const jsonl = full.slice(0, -".alive".length);
      const alive = readAliveMarker(jsonl);
      if (alive && isProcessAlive(alive.pid)) {
        continue; // pid 活 → 不清（AC-10.2）
      }
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > TTL_MS) {
          fs.unlinkSync(full);
        }
      } catch (_e) {
        void _e;
      }
    }
  }
}
