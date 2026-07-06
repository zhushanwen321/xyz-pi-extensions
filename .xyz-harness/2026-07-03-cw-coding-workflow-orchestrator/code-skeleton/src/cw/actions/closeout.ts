/**
 * closeout action — 终态，check_closeout.py + evidence 填充（UC-5 后段）。
 * gate pass → status=closed（终态不可逆，AC-5.3）；evidence 含完整 gateHistory（AC-5.2）。
 */

import { runGate, type GateContext } from "../gates.js";
import { buildNextAction, computeNextStatus, guard } from "../state-machine.js";
import type { ActionDeps, ActionResult, Evidence } from "../types.js";

export interface CloseoutParams {
  action: "closeout";
  topicId: string;
}

export function handleCloseout(params: CloseoutParams, deps: ActionDeps): ActionResult {
  // 接线：loadTopic → guard → transaction{runGate(check_closeout) → setEvidence → updateStatus(closed)}。
  const topic = deps.store.loadTopic(params.topicId);
  if (!topic) {
    throw new Error(`topic not found: ${params.topicId}`);
  }
  const verdict = guard("closeout", topic, deps.store);
  if (!verdict.ok) {
    throw new Error(`guard failed: ${verdict.code} — ${verdict.reason}`);
  }
  const gateCtx: GateContext = {
    topic,
    topicDir: deps.topicDir,
    workspacePath: deps.workspacePath,
    runner: deps.runner,
    git: deps.git,
  };
  const result = deps.store.transaction(() => {
    const gate = runGate(gateCtx, topic.tier, "closeout");
    if (!gate.passed) {
      deps.store.appendGateHistory(params.topicId, {
        phase: "closeout", action: "closeout", gate: "check_closeout.py",
        tier: gate.gateTier, result: "fail",
        report: gate.reports.map((r) => r.report).join("\n"), progressive: false,
      });
      return { passed: false, gate };
    }
    // evidence 填充（AC-5.2：含完整 gateHistory 快照 + coverage）。
    const evidence: Evidence = {
      closedAt: new Date().toISOString(),
      coverage: topic.coverage,
      gateHistory: topic.gateHistory,
    };
    deps.store.setEvidence(params.topicId, evidence);
    deps.store.updateStatus(params.topicId, computeNextStatus("closeout", topic.status));
    deps.store.updateGatePassed(params.topicId, "closeout", true);
    deps.store.appendGateHistory(params.topicId, {
      phase: "closeout", action: "closeout", gate: "check_closeout.py",
      tier: gate.gateTier, result: "pass", progressive: false,
    });
    return { passed: true, gate };
  });
  const updated = deps.store.loadTopic(params.topicId)!;
  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    gateTier: result.gate.gateTier,
    evidence: updated.evidence,
    nextAction: buildNextAction("closeout", updated),
    ...(result.passed ? {} : { mustFix: result.gate.reports.map((r) => r.report).join("\n") }),
  };
}
