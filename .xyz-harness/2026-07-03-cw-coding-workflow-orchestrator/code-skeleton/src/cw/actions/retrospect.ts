/**
 * retrospect action — weak gate（文件存在+非空），UC-5 前段。
 * gate：weak-structural，progressive（可多次提交直到 gatePassed）。
 */

import { existsSync, readFileSync } from "node:fs";

import { lookupGateTier } from "../gates.js";
import {
  buildNextAction,
  computeGatePassed,
  computeNextStatus,
  guard,
} from "../state-machine.js";
import type { ActionDeps, ActionResult } from "../types.js";

export interface RetrospectParams {
  action: "retrospect";
  topicId: string;
  /** changes/retrospect.md 绝对路径。 */
  retrospectPath: string;
}

export function handleRetrospect(params: RetrospectParams, deps: ActionDeps): ActionResult {
  // 接线：loadTopic → guard（含 checkPhaseCascade test 全 passed，AC-5.1）→ weak gate → mutate。
  const topic = deps.store.loadTopic(params.topicId);
  if (!topic) {
    throw new Error(`topic not found: ${params.topicId}`);
  }
  const verdict = guard("retrospect", topic, deps.store);
  if (!verdict.ok) {
    throw new Error(`guard failed: ${verdict.code} — ${verdict.reason}`);
  }
  const gateTier = lookupGateTier(topic.tier, "retrospect");
  // weak gate：文件存在 + 非空。
  const passed = existsSync(params.retrospectPath) && readFileSync(params.retrospectPath, "utf8").trim().length > 0;
  const result = deps.store.transaction(() => {
    deps.store.appendGateHistory(params.topicId, {
      phase: "retrospect", action: "retrospect", gate: "file-exists+non-empty",
      tier: gateTier, result: passed ? "pass" : "fail",
      report: passed ? undefined : "retrospect.md missing or empty", progressive: true,
    });
    if (passed) {
      const gatePassed = computeGatePassed("retrospect", topic);
      deps.store.updateStatus(params.topicId, computeNextStatus("retrospect", topic.status));
      deps.store.updateGatePassed(params.topicId, "retrospect", gatePassed);
      return { gatePassed };
    }
    return { gatePassed: false };
  });
  const updated = deps.store.loadTopic(params.topicId)!;
  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    gateTier,
    nextAction: buildNextAction("retrospect", updated),
    ...(result.gatePassed ? {} : { mustFix: "retrospect.md missing or empty" }),
  };
}
