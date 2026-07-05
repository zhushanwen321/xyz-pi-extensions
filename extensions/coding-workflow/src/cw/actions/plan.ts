/**
 * plan action — lite single-shot gate（UC-2 lite）。时序图 §4 功能 A 代表。
 *
 * 关联：UC-2（AC-2.1~2.6）；issues #5（解析）/#6（subprocess）/#7（review 桩）。
 */

import { type GateContext,runGate } from "../gates.js";
import { parseLitePlan } from "../plan-parser.js";
import { buildNextAction, computeNextStatus, guard } from "../state-machine.js";
import type { ActionDeps, ActionResult } from "../types.js";
import { resolveTopicDir } from "../types.js";

export interface PlanParams {
  action: "plan";
  topicId: string;
  /** plan.json 内容（内联或路径，CW 内部读为对象）。 */
  planJson: unknown;
}

export function handlePlan(params: PlanParams, deps: ActionDeps): ActionResult {
  // 接线：loadTopic → guard → parse → transaction{runGate → mutate → commit} → nextAction。
  const topic = deps.store.loadTopic(params.topicId);
  if (!topic) {
    throw new Error(`topic not found: ${params.topicId}`);
  }
  const verdict = guard("plan", topic, deps.store);
  if (!verdict.ok) {
    throw new Error(`guard failed: ${verdict.code} — ${verdict.reason}`);
  }
  // 解析（含 format 锁定校验，D-003 AC-2.1）。
  const parsed = parseLitePlan(params.planJson, topic.tier);
  const gateCtx: GateContext = {
    topic,
    topicDir: resolveTopicDir(topic),
    workspacePath: deps.workspacePath,
    runner: deps.runner,
    git: deps.git,
  };
  // 事务包裹 guard 后的 gate + mutate（#1 事务边界 = 每个 action 一个）。
  const result = deps.store.transaction(() => {
    const gate = runGate(gateCtx, "lite", "plan");
    if (!gate.passed) {
      // gate fail：status 不变，gateHistory 追加 fail（AC-2.4）。
      deps.store.appendGateHistory(params.topicId, {
        phase: "plan",
        action: "plan",
        gate: "check_plan.py",
        tier: gate.gateTier,
        result: "fail",
        report: gate.reports.map((r) => r.report).join("\n"),
        progressive: false,
      });
      return { passed: false, gate };
    }
    // gate pass：解析的任务清单写入 + 状态流转（AC-2.3/2.5）。
    deps.store.insertWaves(params.topicId, parsed.waves);
    deps.store.insertTestCases(params.topicId, parsed.testCases);
    deps.store.updateStatus(params.topicId, computeNextStatus("plan", topic.status));
    deps.store.updateGatePassed(params.topicId, "plan", true);
    deps.store.appendGateHistory(params.topicId, {
      phase: "plan",
      action: "plan",
      gate: "check_plan.py",
      tier: gate.gateTier,
      result: "pass",
      progressive: false,
    });
    return { passed: true, gate };
  });
  // 重新 load 拿最新 topic（状态/任务清单已变）。
  const updated = deps.store.loadTopic(params.topicId)!;
  const next = buildNextAction("plan", updated);
  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    gateTier: result.gate.gateTier,
    nextAction: next,
    ...(result.passed ? {} : { mustFix: result.gate.reports.map((r) => r.report).join("\n") }),
  };
}
