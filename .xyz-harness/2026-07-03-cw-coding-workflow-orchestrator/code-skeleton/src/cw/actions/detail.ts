/**
 * detail action — mid single-shot gate，4 checker 串行 fail-fast（UC-2 mid 后段，#4 AC-4.2）。
 */

import { runGate, type GateContext } from "../gates.js";
import { guard, buildNextAction, computeNextStatus } from "../state-machine.js";
import { parseMidDetail } from "../plan-parser.js";
import type { ActionDeps, ActionResult } from "../types.js";

export interface DetailParams {
  action: "detail";
  topicId: string;
  detailJson: unknown;
}

export function handleDetail(params: DetailParams, deps: ActionDeps): ActionResult {
  // 接线：loadTopic → guard → parse → transaction{runGate(4 checker fail-fast) → 写 waves/testCases → mutate}。
  const topic = deps.store.loadTopic(params.topicId);
  if (!topic) {
    throw new Error(`topic not found: ${params.topicId}`);
  }
  const verdict = guard("detail", topic, deps.store);
  if (!verdict.ok) {
    throw new Error(`guard failed: ${verdict.code} — ${verdict.reason}`);
  }
  const parsed = parseMidDetail(params.detailJson, topic.tier);
  const gateCtx: GateContext = {
    topic,
    topicDir: deps.topicDir,
    workspacePath: deps.workspacePath,
    runner: deps.runner,
    git: deps.git,
  };
  const result = deps.store.transaction(() => {
    const gate = runGate(gateCtx, "mid", "detail");
    if (!gate.passed) {
      deps.store.appendGateHistory(params.topicId, {
        phase: "detail", action: "detail", gate: "check_issues+check_nfr+check_code_arch+check_execution",
        tier: gate.gateTier, result: "fail",
        report: gate.reports.map((r) => r.report).join("\n"), progressive: false,
      });
      return { passed: false, gate };
    }
    deps.store.insertWaves(params.topicId, parsed.waves);
    deps.store.insertTestCases(params.topicId, parsed.testCases);
    deps.store.updateStatus(params.topicId, computeNextStatus("detail", topic.status));
    deps.store.updateGatePassed(params.topicId, "detail", true);
    deps.store.appendGateHistory(params.topicId, {
      phase: "detail", action: "detail", gate: "check_issues+check_nfr+check_code_arch+check_execution",
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
    nextAction: buildNextAction("detail", updated),
    ...(result.passed ? {} : { mustFix: result.gate.reports.map((r) => r.report).join("\n") }),
  };
}
