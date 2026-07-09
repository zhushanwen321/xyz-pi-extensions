/**
 * clarify action — mid single-shot gate，2 checker（UC-2 mid 前段）。
 * 同 plan 结构，区别：tier=mid，check_clarity + check_architecture，不写任务清单（#5 AC-5.4）。
 *
 * #7 AC-7.1：gate 前预检 changes/review-{clarity,architecture}.md 是否存在。缺失则直接返
 * 结构化 hint（明确指出缺哪个文件 + 跑 review-fix-loop），不跑 gate（agent 不再面对裸 FAIL）。
 */

import { type GateContext,runGate } from "../gates.js";
import { parseMidClarify } from "../plan-parser.js";
import { buildNextAction, computeNextStatus, guard } from "../state-machine.js";
import type { ActionDeps, ActionResult, NextAction } from "../types.js";
import { resolveTopicDir } from "../types.js";
import { CLARIFY_REVIEW_SLUGS, findMissingReviewStubs, reviewStubHint } from "./review-stub.js";

export interface ClarifyParams {
  action: "clarify";
  topicId: string;
  clarifyJson: unknown;
}

export function handleClarify(params: ClarifyParams, deps: ActionDeps): ActionResult {
  // 接线：loadTopic → guard → parse → review 桩预检(#7) → transaction{runGate → mutate} → nextAction。
  const topic = deps.store.loadTopic(params.topicId);
  if (!topic) {
    throw new Error(`topic not found: ${params.topicId}`);
  }
  const verdict = guard("clarify", topic, deps.store);
  if (!verdict.ok) {
    throw new Error(`guard failed: ${verdict.code} — ${verdict.reason}`);
  }
  parseMidClarify(params.clarifyJson, topic.tier);

  // #7 AC-7.1：review 桩缺失 → 返结构化 hint，不跑 gate（非裸 check 报错）。
  // 不复用 buildNextAction 的 gate-fail guidance（它说「修 fail 项」），因此处 mustFix 是
  // 「跑 review-fix-loop」，guidance 需与之对齐——单独构造 nextAction 明确指出桩缺失 + 下一步。
  const missing = findMissingReviewStubs(resolveTopicDir(topic), CLARIFY_REVIEW_SLUGS);
  if (missing.length > 0) {
    const nextAction: NextAction = {
      action: "clarify",
      skill: "mid-plan",
      guidance:
        `review 桩缺失（${missing.join(", ")}），status 仍为 ${topic.status}。` +
        "跑 mid-plan skill 的 review-fix-loop 收敛后落盘 changes/review-*.md（verdict: APPROVED），" +
        "然后重调 cw(action=clarify)。勿调 detail（会 illegal_transition）。",
    };
    return {
      topicId: params.topicId,
      status: topic.status,
      gatePassed: topic.gatePassed,
      nextAction,
      mustFix: reviewStubHint(missing),
    };
  }

  const gateCtx: GateContext = {
    topic,
    topicDir: resolveTopicDir(topic),
    workspacePath: deps.workspacePath,
    runner: deps.runner,
    git: deps.git,
  };
  const result = deps.store.transaction(() => {
    const gate = runGate(gateCtx, "mid", "clarify");
    if (!gate.passed) {
      deps.store.appendGateHistory(params.topicId, {
        phase: "clarify",
        action: "clarify",
        gate: "check_clarity+check_architecture",
        tier: gate.gateTier,
        result: "fail",
        report: gate.reports.map((r) => r.report).join("\n"),
        progressive: false,
      });
      return { passed: false, gate };
    }
    // mid clarify 不写 waves/testCases（任务在 detail，AC-5.4）。
    deps.store.updateStatus(params.topicId, computeNextStatus("clarify", topic.status));
    deps.store.updateGatePassed(params.topicId, "clarify", true);
    deps.store.appendGateHistory(params.topicId, {
      phase: "clarify",
      action: "clarify",
      gate: "check_clarity+check_architecture",
      tier: gate.gateTier,
      result: "pass",
      progressive: false,
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
