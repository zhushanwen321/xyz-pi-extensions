/**
 * detail action — mid single-shot gate，4 checker 串行 fail-fast（UC-2 mid 后段，#4 AC-4.2）。
 *
 * #7 AC-7.1：gate 前预检 changes/review-{issues,nfr,code-arch,execution}.md 是否存在。
 * 缺失则返结构化 hint（与 clarify 同机制），不跑 gate。
 */

import { type GateContext,runGate } from "../gates.js";
import { parseMidDetail } from "../plan-parser.js";
import { buildNextAction, computeNextStatus, guard } from "../state-machine.js";
import type { ActionDeps, ActionResult, NextAction } from "../types.js";
import { resolveTopicDir } from "../types.js";
import { DETAIL_REVIEW_SLUGS, findMissingReviewStubs, reviewStubHint } from "./review-stub.js";

export interface DetailParams {
  action: "detail";
  topicId: string;
  detailJson: unknown;
}

export function handleDetail(params: DetailParams, deps: ActionDeps): ActionResult {
  // 接线：loadTopic → guard → parse → review 桩预检(#7) → transaction{runGate(4 checker fail-fast) → 写 waves/testCases → mutate}。
  const topic = deps.store.loadTopic(params.topicId);
  if (!topic) {
    throw new Error(`topic not found: ${params.topicId}`);
  }
  const verdict = guard("detail", topic, deps.store);
  if (!verdict.ok) {
    throw new Error(`guard failed: ${verdict.code} — ${verdict.reason}`);
  }
  const parsed = parseMidDetail(params.detailJson, topic.tier);

  // #7 AC-7.1：review 桩缺失 → 返结构化 hint，不跑 gate。
  // 不复用 buildNextAction 的 gate-fail guidance（它说「修 fail 项」），因此处 mustFix 是
  // 「跑 review-fix-loop」，guidance 需与之对齐——单独构造 nextAction 明确指出桩缺失 + 下一步。
  const missing = findMissingReviewStubs(resolveTopicDir(topic), DETAIL_REVIEW_SLUGS);
  if (missing.length > 0) {
    const nextAction: NextAction = {
      action: "detail",
      skill: "mid-detail-plan",
      guidance:
        `review 桩缺失（${missing.join(", ")}），status 仍为 ${topic.status}。` +
        "跑 mid-detail-plan skill 的 review-fix-loop 收敛后落盘 changes/review-*.md（verdict: APPROVED），" +
        "然后重调 cw(action=detail)。勿调 dev（会 illegal_transition）。",
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
    const gate = runGate(gateCtx, "mid", "detail");
    if (!gate.passed) {
      deps.store.appendGateHistory(params.topicId, {
        phase: "detail",
        action: "detail",
        gate: "check_issues+check_nfr+check_code_arch+check_execution",
        tier: gate.gateTier,
        result: "fail",
        report: gate.reports.map((r) => r.report).join("\n"),
        progressive: false,
      });
      return { passed: false, gate };
    }
    deps.store.insertWaves(params.topicId, parsed.waves);
    deps.store.insertTestCases(params.topicId, parsed.testCases);
    deps.store.updateStatus(params.topicId, computeNextStatus("detail", topic.status));
    deps.store.updateGatePassed(params.topicId, "detail", true);
    deps.store.appendGateHistory(params.topicId, {
      phase: "detail",
      action: "detail",
      gate: "check_issues+check_nfr+check_code_arch+check_execution",
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
    nextAction: buildNextAction("detail", updated),
    ...(result.passed ? {} : { mustFix: result.gate.reports.map((r) => r.report).join("\n") }),
  };
}
