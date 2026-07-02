// code-skeleton/runtime/subagent-service.ts — ⑤骨架（#7 修改 汇合点）
// 持有 WorktreeManager + FinalizedMarker + alive-store。D-017 finalizeRecord 时序。
// 本骨架聚焦 finalizeRecord D-017 接线 + execute 前置 create，其余见现有 subagent-service.ts。

import type { ExecutionRecord, ExecuteOptions } from "../types.ts";
import { WorktreeManager } from "./worktree-manager.ts";
import { writeFinalized } from "./execution/finalized-marker.ts";
import { removeAliveMarker } from "./execution/alive-store.ts";

/** AgentResult 最小形状（节选）。 */
interface AgentResult {
  success: boolean;
  text: string;
}

/**
 * SubagentService 汇合点（#7）。持有 WorktreeManager（D-013⑤）。
 * execute 前置 worktreeManager.create（worktree:true 时，handle 回填 record）。
 * finalizeRecord D-017 时序：⓪collectPatch→①completeRecord→②archive→③finalized+cleanup。
 */
export class SubagentService {
  private readonly worktreeManager: WorktreeManager;

  constructor(agentDir: string) {
    this.worktreeManager = new WorktreeManager(); // D-013⑤ 持有
    void agentDir;
  }

  /**
   * execute（#4/#7 ✎）。worktree:true 时前置 worktreeManager.create，handle 回填 record。
   *
   * 数据流：execute(worktree:true) → worktreeManager.create(mainCwd, recordId) → handle 回填 record
   * 失败路径：create 失败（脏树/recordId非法）→ 抛（不进入 run，调用方 finalizeFailed）
   */
  async execute(opts: ExecuteOptions, record: ExecutionRecord, mainCwd: string): Promise<void> {
    if (opts.worktree) {
      // 前置 worktree 创建，handle 回填 record（CC-3）
      record.worktreeHandle = this.worktreeManager.create(mainCwd, record.id);
    }
    // ... 现有 run() 调用（骨架省略，见现有 subagent-service.ts）
  }

  /**
   * finalizeRecord D-017 时序（#7 ✎ 核心）。
   * ⓪collectPatch（worktree 时，best-effort）→ ①completeRecord → ②archive → ③finalized+cleanup。
   *
   * D-022 数据黑洞防护：collectPatch 失败（⓪failed=true）→ ③cleanup 必须跳过（保 worktree+分支），
   *   record.result 记 patchFailed:true + worktree 路径供手动恢复。
   * B9 兜底：completeRecord/archive 抛错 → ③finalized/cleanup 仍执行（best-effort）。
   *
   * 数据流：run()→AgentResult → ⓪WTM.collectPatch(git diff→.patch) → ①completeRecord(patchFile进result)
   *         → ②store.archive → ③writeFinalized + [collectPatch成功]WTM.cleanup + removeAliveMarker
   */
  async finalizeRecord(
    record: ExecutionRecord,
    result: AgentResult,
    sessionFile: string | undefined,
  ): Promise<void> {
    // ⓪ collectPatch（worktree 时，best-effort try/catch）
    let patchOk = true;
    if (record.worktreeHandle) {
      const patch = this.worktreeManager.collectPatch(record.worktreeHandle);
      patchOk = !patch.failed;
      if (patch.failed) {
        // D-022: patchFailed 进 result（骨架标 console，实际进 record.result）
        result.text += `\n[patchFailed worktree=${record.worktreeHandle.path}]`;
      }
    }

    // ① completeRecord（freeze record.result）—— B9: 抛错则 ③仍执行
    try {
      // completeRecord(record, result, status) —— 现有函数，骨架省略
    } catch (_e) { void _e; /* B9: 不阻断 ③ */ }

    // ② store.archive —— B9: 抛错则 ③仍执行
    try {
      // store.archive(record) —— 现有函数，骨架省略
    } catch (_e) { void _e; /* B9 */ }

    // ③ 三件套（各自独立 try/catch）
    if (sessionFile) {
      try { writeFinalized(sessionFile); } catch (_e) { void _e; }
      // D-022: collectPatch 失败则跳过 cleanup（保 worktree 供手动恢复）
      if (patchOk && record.worktreeHandle) {
        try { this.worktreeManager.cleanup(record.worktreeHandle); } catch (_e) { void _e; }
      }
      try { removeAliveMarker(sessionFile); } catch (_e) { void _e; }
    }
  }

  /**
   * cancelBackground（#7 ✎）。加 WorktreeManager.cleanup + removeAliveMarker。
   * 不写 finalized（BC-4 与 .cancelled 互斥）。cancel 时 worktree 改动放弃（D-005）。
   */
  cancelBackground(record: ExecutionRecord, sessionFile: string | undefined): boolean {
    // worktreeHandle==null 跳过 cleanup（窗口期 cancel 或非 worktree）
    if (record.worktreeHandle) {
      try { this.worktreeManager.cleanup(record.worktreeHandle); } catch (_e) { void _e; }
    }
    if (sessionFile) {
      try { removeAliveMarker(sessionFile); } catch (_e) { void _e; }
    }
    // ... 现有 cancel tombstone + archive（骨架省略）
    return true;
  }
}
