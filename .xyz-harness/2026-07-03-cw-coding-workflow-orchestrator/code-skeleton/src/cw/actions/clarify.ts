/**
 * clarify action — mid single-shot gate，2 checker（UC-2 mid 前段）。
 * 同 plan 结构，区别：tier=mid，check_clarity + check_architecture，不写任务清单（#5 AC-5.4）。
 */

import { runGate, type GateContext } from "../gates.js";
import { guard, buildNextAction, computeNextStatus } from "../state-machine.js";
import { parseMidClarify } from "../plan-parser.js";
import type { ActionDeps, ActionResult } from "../types.js";

export interface ClarifyParams {
  action: "clarify";
  topicId: string;
  clarifyJson: unknown;
}

export function handleClarify(params: ClarifyParams, deps: ActionDeps): ActionResult {
  // 接线：loadTopic → guard → parse → transaction{runGate(2 checker fail-fast) → mutate} → nextAction。
  const topic = deps.store.loadTopic(params.topicId);
  if (!topic) {
    throw new Error(`topic not found: ${params.topicId}`);
  }
  const verdict = guard("clarify", topic, deps.store);
  if (!verdict.ok) {
    throw new Error(`guard failed: ${verdict.code} — ${verdict.reason}`);
  }
  parseMidClarify(params.clarifyJson, topic.tier);
  const gateCtx: GateContext = {
    topic,
    topicDir: deps.topicDir,
    workspacePath: deps.workspacePath,
    runner: deps.runner,
    git: deps.git,
  };
  const result = deps.store.transaction(() => {
    const gate = runGate(gateCtx, "mid", "clarify");
    if (!gate.passed) {
      deps.store.appendGateHistory(params.topicId, {
        phase: "clarify", action: "clarify", gate: "check_clarity+check_architecture",
        tier: gate.gateTier, result: "fail",
        report: gate.reports.map((r) => r.report).join("\n"), progressive: false,
      });
      return { passed: false, gate };
    }
    // mid clarify 不写 waves/testCases（任务在 detail，AC-5.4）。
    deps.store.updateStatus(params.topicId, computeNextStatus("clarify", topic.status));
    deps.store.updateGatePassed(params.topicId, "clarify", true);
    deps.store.appendGateHistory(params.topicId, {
      phase: "clarify", action: "clarify", gate: "check_clarity+check_architecture",
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
    nextAction: buildNextAction("clarify", updated),
    ...(result.passed ? {} : { mustFix: result.gate.reports.map((r) => r.report).join("\n") }),
  };
}
