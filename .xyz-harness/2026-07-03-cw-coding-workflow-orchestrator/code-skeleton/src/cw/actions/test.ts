/**
 * test action — 渐进式提交测试结果双分支（UC-4）。时序图 §4 功能 C。
 *
 * gate：lite=strong-recompute（judgeByExpected 丢 claimedStatus）；mid=medium-coverage（信声明 + GitValidator）。
 * 双分支按 topic.tier 分化（D-008）。
 */

import { existsSync } from "node:fs";

import { lookupGateTier } from "../gates.js";
import {
  buildNextAction,
  computeGatePassed,
  computeNextStatus,
  guard,
} from "../state-machine.js";
import { judgeByExpected } from "../types.js";
import type { ActionDeps, ActionResult, Actual, Expected, TestCase } from "../types.js";

export interface TestCaseSubmission {
  caseId: string;
  /** lite：机器重算的真实观测值。 */
  actual?: Actual;
  /** lite：截图绝对路径（existsSync 校验）。 */
  screenshotPath?: string;
  /** mid：测试覆盖的 dev commit（GitValidator 校验真实性）。 */
  commitHash?: string;
  /** agent 声明（lite 丢弃，mid 采信）。 */
  claimedStatus?: "passed" | "failed";
}

export interface TestParams {
  action: "test";
  topicId: string;
  /** D-005：数组，长 1 / N。 */
  cases: TestCaseSubmission[];
}

export interface TestCaseResult {
  caseId: string;
  status: TestCase["status"];
  failureReason?: string;
}

export function handleTest(params: TestParams, deps: ActionDeps): ActionResult {
  // 接线：loadTopic → guard（含 checkPhaseCascade dev）→ transaction{loop case 双分支 → updateTestCase}。
  const topic = deps.store.loadTopic(params.topicId);
  if (!topic) {
    throw new Error(`topic not found: ${params.topicId}`);
  }
  const verdict = guard("test", topic, deps.store);
  if (!verdict.ok) {
    throw new Error(`guard failed: ${verdict.code} — ${verdict.reason}`);
  }
  const gateTier = lookupGateTier(topic.tier, "test");
  const caseResults: TestCaseResult[] = [];
  const result = deps.store.transaction(() => {
    for (const submission of params.cases) {
      const tc = (topic.testCases as TestCase[]).find((c) => c.id === submission.caseId);
      if (!tc) {
        caseResults.push({ caseId: submission.caseId, status: "failed", failureReason: "case not found" });
        continue;
      }
      // 双分支（D-008）。
      if (topic.tier === "lite") {
        const judged = judgeLite(tc.expected, submission);
        deps.store.updateTestCase(params.topicId, submission.caseId, judged.patch);
        caseResults.push({ caseId: submission.caseId, status: judged.patch.status ?? "failed", failureReason: judged.reason });
      } else {
        const judged = judgeMid(submission, deps);
        deps.store.updateTestCase(params.topicId, submission.caseId, judged.patch);
        caseResults.push({ caseId: submission.caseId, status: judged.patch.status ?? "failed", failureReason: judged.reason });
      }
    }
    const updated2 = deps.store.loadTopic(params.topicId)!;
    const gatePassed = computeGatePassed("test", updated2);
    const nextStatus = computeNextStatus("test", updated2.status);
    if (nextStatus !== updated2.status) {
      deps.store.updateStatus(params.topicId, nextStatus);
    }
    deps.store.updateGatePassed(params.topicId, "test", gatePassed);
    const failedCount = caseResults.filter((c) => c.status !== "passed").length;
    deps.store.appendGateHistory(params.topicId, {
      phase: "test", action: "test", gate: topic.tier === "lite" ? "judgeByExpected" : "medium-coverage",
      tier: gateTier, result: failedCount === 0 ? "pass" : "fail",
      report: JSON.stringify(caseResults), progressive: true,
    });
    return { gatePassed };
  });
  const updated = deps.store.loadTopic(params.topicId)!;
  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    gateTier,
    nextAction: buildNextAction("test", updated),
    testProgress: (updated.testCases as TestCase[]).map((c) => ({ id: c.id, status: c.status })),
    caseResults,
  };
}

// ── lite 分支：strong-recompute（丢 claimedStatus，D-008） ────

function judgeLite(
  expected: Expected | undefined,
  submission: TestCaseSubmission,
): { patch: Partial<TestCase>; reason?: string } {
  // 数据流：先校验截图存在（AC-4.2），再 judgeByExpected 重算（丢 claimedStatus）。
  if (!submission.screenshotPath || !existsSync(submission.screenshotPath)) {
    return { patch: { status: "failed", screenshotPath: submission.screenshotPath }, reason: "screenshot missing" };
  }
  // 接线：真调 judgeByExpected（claimedStatus 丢弃，D-008 AC-4.1）。
  const verdict = judgeByExpected(expected ?? {}, submission.actual ?? {});
  return {
    patch: {
      status: verdict.status,
      actual: submission.actual,
      screenshotPath: submission.screenshotPath,
      judgedAt: new Date().toISOString(),
      ...(verdict.status === "failed" ? { failureReason: verdict.reason } : {}),
    },
    reason: verdict.status === "failed" ? verdict.reason : undefined,
  };
}

// ── mid 分支：medium-coverage（信声明 + GitValidator） ───────

function judgeMid(
  submission: TestCaseSubmission,
  deps: ActionDeps,
): { patch: Partial<TestCase>; reason?: string } {
  // 数据流：GitValidator 校验 commitHash 真实（AC-4.3），信 claimedStatus。
  if (!submission.commitHash) {
    return { patch: { status: "failed" }, reason: "mid test requires commitHash" };
  }
  const v = deps.git.validate(submission.commitHash);
  if (!v.valid) {
    return { patch: { status: "failed", commitHash: submission.commitHash }, reason: `invalid commit: ${v.reason}` };
  }
  // 信声明（medium-coverage，不重算断言）。
  return {
    patch: {
      status: submission.claimedStatus === "passed" ? "passed" : "failed",
      commitHash: submission.commitHash,
      judgedAt: new Date().toISOString(),
    },
  };
}
