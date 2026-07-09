/**
 * dev action — 渐进式提交开发 commit（UC-3）。时序图 §4 功能 B。
 *
 * gate：medium-git（GitValidator 逐条，#3 方案 A 逐条容错）。
 * 不走 runGate（progressive），直接调 deps.git + lookupGateTier 透传。
 */

import { lookupGateTier } from "../gates.js";
import {
  buildNextAction,
  computeGatePassed,
  computeNextStatus,
  guard,
} from "../state-machine.js";
import type { ActionDeps, ActionResult, Wave } from "../types.js";

export interface DevTask {
  waveId: string;
  commitHash: string;
}

export interface DevParams {
  action: "dev";
  topicId: string;
  /** D-005：数组，长 1 = 单个渐进提交，长 N = 批量。 */
  tasks: DevTask[];
}

export interface DevTaskResult {
  waveId: string;
  valid: boolean;
  reason?: string;
}

export function handleDev(params: DevParams, deps: ActionDeps): ActionResult {
  // 接线：loadTopic → guard → transaction{loop task: git.validate → setWaveCommitted → 累计 gatePassed}。
  const topic = deps.store.loadTopic(params.topicId);
  if (!topic) {
    throw new Error(`topic not found: ${params.topicId}`);
  }
  const verdict = guard("dev", topic, deps.store);
  if (!verdict.ok) {
    throw new Error(`guard failed: ${verdict.code} — ${verdict.reason}`);
  }
  const gateTier = lookupGateTier(topic.tier, "dev");
  const taskResults: DevTaskResult[] = [];
  const result = deps.store.transaction(() => {
    // 渐进式：逐 task GitValidator，部分 fail 不阻塞（#3 AC-3.4）。
    for (const task of params.tasks) {
      const v = deps.git.validate(task.commitHash);
      if (v.valid) {
        deps.store.setWaveCommitted(params.topicId, task.waveId, task.commitHash);
        taskResults.push({ waveId: task.waveId, valid: true });
      } else {
        // 该 task 记 fail，继续其他（#3 方案 A）。
        taskResults.push({ waveId: task.waveId, valid: false, reason: v.reason });
      }
    }
    // 重读拿最新 waves 算 gatePassed（dev=全 Wave committed，§4.3）。
    const updated2 = deps.store.loadTopic(params.topicId)!;
    const gatePassed = computeGatePassed("dev", updated2);
    // 首次有效提交流转状态（progressive，§4.3 进入态）。
    const nextStatus = computeNextStatus("dev", updated2.status);
    if (nextStatus !== updated2.status) {
      deps.store.updateStatus(params.topicId, nextStatus);
    }
    deps.store.updateGatePassed(params.topicId, "dev", gatePassed);
    const failedCount = taskResults.filter((t) => !t.valid).length;
    deps.store.appendGateHistory(params.topicId, {
      phase: "dev", action: "dev", gate: "GitValidator",
      tier: gateTier, result: failedCount === 0 ? "pass" : "fail",
      report: JSON.stringify(taskResults), progressive: true,
    });
    return { gatePassed };
  });
  const updated = deps.store.loadTopic(params.topicId)!;
  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    gateTier,
    nextAction: buildNextAction("dev", updated),
    devProgress: (updated.waves as Wave[]).map((w) => ({ id: w.id, committed: w.committed !== null })),
    taskResults,
  };
}
