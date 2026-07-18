// src/execution/finalize-record.ts
//
// 时序收尾逻辑（从 subagent-service.ts 提取，降低主文件行数 < 1000 上限）。
//
// D-017 时序：collectPatch → completeRecord → archive → cleanup(finalized+worktree+
// aliveMarker+pending注销) → manifest(最后 best-effort)。
//
// [Critical #1 / PR #85] cleanup 全部在 manifest 写之前执行——manifest 是诊断辅助
//（orphan recovery），写失败仅记录不阻断。旧实现 Step 2.5 throw 会跳过 Step 3 cleanup，
// 导致磁盘满/权限错时 worktree 泄漏 + finalized marker 不写 + alive marker 残留 +
// pending 记账错乱。现 manifest 写移到 Step 4（最后），best-effort（console.error +
// appendEntry，不 throw）。
//
// B9 兜底：completeRecord/archive 抛错→后续 cleanup/manifest 仍执行。

import * as fs from "node:fs";
import * as path from "node:path";

import { removeAliveMarker } from "./alive-store.ts";
import { bestEffort } from "./best-effort.ts";
import { completeRecord } from "./execution-record.ts";
import { writeFinalized } from "./finalized-marker.ts";
import type { ManifestStore } from "./manifest-store.ts";
import type { ModelConfigService } from "./model-config-service.ts";
import { getSubagentSessionDir } from "./path-encoding.ts";
import type { RecordStore } from "./record-store.ts";
import { writeCancelledTombstone } from "./tombstone-store.ts";
import type { AgentResult, ExecutionRecord } from "./types.ts";
import type { WorktreeManager } from "./worktree-manager.ts";

/** doFinalizeRecord 的依赖（从 SubagentService 注入，避免 this 绑定 + 解耦可测试）。 */
export interface FinalizeDeps {
  manifestStore: ManifestStore;
  worktreeManager: WorktreeManager;
  store: RecordStore;
  modelService: ModelConfigService;
  /** Pi ExtensionAPI（仅用 appendEntry 记录 manifest 写失败事件）。null 在 dispose 后。 */
  pi: { appendEntry?: (type: string, data: unknown) => void } | null;
  /** 清节流状态（防 trailing timer 在 record 归档后误发陈旧 onUpdate）。 */
  clearThrottle(id: string): void;
  /** pending-notifications 终态注销（绑定 pi.events.emit，由调用方闭包提供）。 */
  emitUnregister(id: string, status: string): void;
}

/**
 * 时序收尾（D-017）。步骤 0→4 全部 best-effort 互不阻断（除 manifest 外都幂等）。
 *
 * [Critical #1] Step 3 cleanup 全部在 Step 4 manifest 之前——manifest 写失败仅 console.error +
 * appendEntry，不 throw 不跳过 cleanup。task/slug/model 从 ExecutionRecord 抓取（配合 ManifestRecord
 * 补字段），manifestToSubagent 投影真实值而非硬编码空串。
 */
export async function doFinalizeRecord(
  deps: FinalizeDeps,
  record: ExecutionRecord,
  result: AgentResult,
  status: "done" | "failed" | "cancelled",
): Promise<void> {
  // 终态清节流状态：防 trailing timer 在 record 归档后误发陈旧 onUpdate
  deps.clearThrottle(record.id);

  // ── Step 0: collectPatch（best-effort）──
  // [MF#3] patchFile 写到 worktree 之外（sessionsDir/<branch>.patch），避免被 cleanup 删除；
  //        路径回填 record.patchFile，供调用方（tool result / /subagents list）应用。
  if (record.worktreeHandle) {
    try {
      const sessionsDir = getSubagentSessionDir(
        deps.modelService.getAgentDir(),
        record.worktreeHandle.mainCwd,
      );
      fs.mkdirSync(sessionsDir, { recursive: true });
      const patchFile = path.join(sessionsDir, `${record.worktreeHandle.branch}.patch`);
      const patch = deps.worktreeManager.collectPatch(record.worktreeHandle, patchFile);
      if (patch.written) record.patchFile = patchFile;
    } catch (pe: unknown) {
      bestEffort(pe, "collectPatch (finalizeRecord Step0)");
    }
  }

  // ── Step 1: completeRecord（B9: 抛错→后续仍执行）──
  try {
    completeRecord(record, result, status);
  } catch (err) {
    bestEffort(err, "completeRecord (finalizeRecord B9)", "error");
  }

  // ── Step 2: archive（B9: 抛错→后续仍执行）──
  try {
    deps.store.archive(record);
  } catch (err) {
    bestEffort(err, "store.archive (finalizeRecord B9)", "error");
  }

  // ── Step 3: finalized + cleanup + aliveMarker + pending注销（全部先执行，幂等）──
  // [Critical] 清理必须在 manifest 写入之前：worktree cleanup / finalized marker / aliveMarker
  //   都是幂等且不可跳过的副作用。绝不能因 manifest 写失败而跳过 worktree cleanup
  //   （否则 worktree 泄漏）。各件独立 try/catch，互不阻断。
  if (record.sessionFile) {
    try {
      // MF-1 fix: cancelled 状态写 tombstone 而非 finalized，防重建丢失 cancelled
      if (status === "cancelled") {
        writeCancelledTombstone(record.sessionFile, {
          id: record.id,
          status: "cancelled",
          agent: record.agent,
          startedAt: record.startedAt,
          endedAt: record.endedAt ?? Date.now(),
        });
      } else {
        writeFinalized(record.sessionFile);
      }
    } catch (err) {
      bestEffort(err, "writeFinalized/tombstone (finalizeRecord Step3)");
    }
  }
  if (record.worktreeHandle) {
    try {
      deps.worktreeManager.cleanup(record.worktreeHandle);
    } catch (err) {
      bestEffort(err, "worktree cleanup (finalizeRecord Step3)");
    }
  }
  if (record.sessionFile) {
    try {
      removeAliveMarker(record.sessionFile);
    } catch (err) {
      bestEffort(err, "removeAliveMarker (finalizeRecord Step3)");
    }
  }

  // pending-notifications：终态注销（只记 registry 状态，通知由 BgNotifier 发）
  deps.emitUnregister(record.id, status);

  // ── Step 4 (last): manifest 持久化（best-effort，不阻断、不 throw）──
  // [Critical #1] manifest 是诊断辅助（orphan recovery），不是正确性依赖。写失败时
  //   仅记录（console.error + appendEntry），绝不让 manifest 写失败跳过上面的 worktree
  //   cleanup 或抛出打断 finalize 链。旧实现 Step 2.5 throw 会跳过 Step 3 cleanup。
  //   task/slug/model 从 ExecutionRecord 抓取（配合 ManifestRecord 补字段），
  //   manifestToSubagent 投影时用真实值而非硬编码空串。
  try {
    await deps.manifestStore.writeManifest({
      id: record.id,
      rootSessionId: record.rootSessionId ?? "",
      agentName: record.agent,
      status: status === "done" ? "completed" : status === "cancelled" ? "failed" : status,
      createdAt: record.startedAt,
      completedAt: record.endedAt ?? Date.now(),
      sessionFile: record.sessionFile,
      pid: process.pid,
      task: record.task,
      slug: record.slug,
      model: record.model,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[subagent] manifest 写入失败 (record=${record.id}): ${msg}`);
    deps.pi?.appendEntry?.("subagent:manifest-write-failed", {
      id: record.id,
      error: msg,
    });
  }
}
