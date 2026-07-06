/**
 * test action — 渐进式提交测试结果双分支（UC-4）。时序图 §4 功能 C。
 *
 * gate：lite=strong-recompute（judgeByExpected 丢 claimedStatus）；mid=medium-coverage（信声明 + GitValidator）。
 * 双分支按 topic.tier 分化（D-008）。
 *
 * 骨架修正（vs code-skeleton）：
 *   - 去掉未使用的 `const result = transaction(...)` 赋值 + 内部 return（外层 reload
 *     `updated` 已含最新 gatePassed/status，与 dev.ts/retrospect.ts 一致性无需此返回值）
 *   - 去掉冗余 `(topic.testCases as TestCase[])` / `(updated.testCases as TestCase[])`
 *     cast（CwTopic.testCases 类型已为 TestCase[]）
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
import type { ActionDeps, ActionResult, Actual, CwTopic, TestCase } from "../types.js";

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
  deps.store.transaction(() => {
    for (const submission of params.cases) {
      const tc = topic.testCases.find((c) => c.id === submission.caseId);
      if (!tc) {
        // m-2: case not found 应为硬错（与 topic not found 一致）。原实现只记 failed 不阻断，
        // gatePassed 仍可能 true 但 gateHistory 污染（result=fail 但 status 流转）。改为 throw
        // 让调用方明确知道提交了不存在的 caseId（plan 与 test 提交取活不一致）。
        throw new Error(`case not found: ${submission.caseId}`);
      }
      // 双分支（D-008）。
      if (topic.tier === "lite") {
        // m-1: lite expected 为空（url/text 都缺）时 judgeByExpected 永远返 failed，
        // topic 卡死。这是 plan 阶段不应产出的畸形数据，提前给明确错误。
        if (!tc.expected?.url && !tc.expected?.text) {
          const patch: Partial<TestCase> = {
            status: "failed",
            failureReason: "expected 为空（无 url/text），plan 阶段不应产空 expected",
          };
          deps.store.updateTestCase(params.topicId, submission.caseId, patch);
          caseResults.push({
            caseId: submission.caseId,
            status: "failed",
            failureReason: patch.failureReason,
          });
          continue;
        }
        const judged = judgeLite(tc, submission);
        deps.store.updateTestCase(params.topicId, submission.caseId, judged.patch);
        caseResults.push({
          caseId: submission.caseId,
          status: judged.patch.status ?? "failed",
          failureReason: judged.reason,
        });
      } else {
        const judged = judgeMid(submission, deps, topic);
        deps.store.updateTestCase(params.topicId, submission.caseId, judged.patch);
        caseResults.push({
          caseId: submission.caseId,
          status: judged.patch.status ?? "failed",
          failureReason: judged.reason,
        });
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
      phase: "test",
      action: "test",
      gate: topic.tier === "lite" ? "judgeByExpected" : "medium-coverage",
      tier: gateTier,
      result: failedCount === 0 ? "pass" : "fail",
      report: JSON.stringify(caseResults),
      progressive: true,
    });
  });
  const updated = deps.store.loadTopic(params.topicId)!;
  return {
    topicId: params.topicId,
    status: updated.status,
    gatePassed: updated.gatePassed,
    gateTier,
    nextAction: buildNextAction("test", updated),
    testProgress: updated.testCases.map((c) => ({ id: c.id, status: c.status })),
    caseResults,
  };
}

// ── lite 分支：strong-recompute（丢 claimedStatus，D-008） ────

/**
 * lite test 判定。screenshot 校验按 testCase.requiresScreenshot 决定（P0 修复）：
 * - requiresScreenshot=true：submission 缺 screenshot 或文件不存在 → failed
 * - requiresScreenshot=false：跳过 screenshot 校验，只跑 judgeByExpected 重算
 * plan 阶段 agent 在 plan.json 按用例性质声明（mock 层通常 false，real 层通常 true）。
 */
function judgeLite(
  testCase: TestCase,
  submission: TestCaseSubmission,
): { patch: Partial<TestCase>; reason?: string } {
  // 数据流：若 plan 声明需要 screenshot，先校验截图存在；再 judgeByExpected 重算（丢 claimedStatus）。
  if (testCase.requiresScreenshot) {
    if (!submission.screenshotPath || !existsSync(submission.screenshotPath)) {
      return {
        patch: { status: "failed", screenshotPath: submission.screenshotPath },
        reason: "screenshot required by plan but missing",
      };
    }
  }
  // 接线：真调 judgeByExpected（claimedStatus 丢弃，D-008 AC-4.1）。
  const verdict = judgeByExpected(testCase.expected ?? {}, submission.actual ?? {});
  return {
    patch: {
      status: verdict.status,
      actual: submission.actual,
      // requiresScreenshot=false 时不强制要求，但 submission 传了仍透传存储（agent 主动截图不算错）
      screenshotPath: submission.screenshotPath,
      judgedAt: new Date().toISOString(),
      ...(verdict.status === "failed" ? { failureReason: verdict.reason } : {}),
    },
    reason: verdict.status === "failed" ? verdict.reason : undefined,
  };
}

// ── mid 分支：medium-coverage（信声明 + GitValidator） ───────

/**
 * 收集 topic 所有 dev wave 的 committed hash（M-1 traceability 用）。
 * mid test submission.commitHash 必须是这些 hash 之一的后裔，证明测试覆盖的是真实 dev 工作。
 */
function collectDevCommits(topic: CwTopic): string[] {
  return topic.waves.map((w) => w.committed).filter((c): c is string => c !== null);
}

function judgeMid(
  submission: TestCaseSubmission,
  deps: ActionDeps,
  topic: CwTopic,
): { patch: Partial<TestCase>; reason?: string } {
  // 数据流：GitValidator 校验 commitHash 真实（AC-4.3），信 claimedStatus。
  if (!submission.commitHash) {
    return { patch: { status: "failed" }, reason: "mid test requires commitHash" };
  }
  const v = deps.git.validate(submission.commitHash);
  if (!v.valid) {
    return {
      patch: { status: "failed", commitHash: submission.commitHash },
      reason: `invalid commit: ${v.reason ?? "unknown"}`,
    };
  }
  // M-1: commitHash 可追溯性校验。原 judgeMid 只调 git.validate（通用三项），
  // 任何仓库内合法 commit 都过——agent 可提交与 dev wave 完全无关的 hash 蒙混
  // medium-coverage gate。现要求 commitHash 是某 dev wave commit 的后裔（或相等）。
  const devCommits = collectDevCommits(topic);
  if (devCommits.length === 0) {
    return {
      patch: { status: "failed", commitHash: submission.commitHash },
      reason: "no dev commit in topic (dev wave 未 committed)",
    };
  }
  if (!deps.git.isAncestorOfAny(submission.commitHash, devCommits)) {
    return {
      patch: { status: "failed", commitHash: submission.commitHash },
      reason: `commitHash 不在已 committed 的 dev wave 后裔中 (dev commits: ${JSON.stringify(devCommits)})`,
    };
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
