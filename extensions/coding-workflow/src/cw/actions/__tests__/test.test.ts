/**
 * test.test.ts — test action（UC-4，AC-4.1~4.5/4.7~4.10 + T2.15）。
 *
 * 双分支：lite=strong-recompute（judgeByExpected 重算，丢 claimedStatus）；
 * mid=medium-coverage（信声明 + GitValidator）。
 *
 * 测试层：mock（vi.spyOn GitValidator.prototype.validate 控制 mid 分支与 ENOENT）；
 * judgeByExpected 真调（不 mock）；截图走真实 tmpDir 文件。
 * 前置：developed topic + 全 Wave committed + testCases（seedDevelopedTopic）。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { GitValidator } from "../../gates.js";
import type { CommitValidation, TestCaseSeed, WaveSeed } from "../../types.js";
import { handleTest } from "../test.js";
import {
  closeStore,
  makeDeps,
  makeTmpWorkspace,
  seedDevelopedTopic,
} from "./_helpers.js";

const ONE_WAVE: WaveSeed[] = [{ id: "W1", dependsOn: [], changes: ["src/a.ts"], issues: [] }];

const URL_CASE: TestCaseSeed = {
  id: "E1",
  layer: "real",
  scenario: "访问页面",
  steps: "打开 url",
  expected: { url: "/dashboard" },
  executor: "vitest",
  requiresScreenshot: true,
};

function mockValidateValid(hash = "devcommit"): CommitValidation {
  return { commitHash: hash, exists: true, inRepo: true, nonEmpty: true, valid: true };
}

function writeShot(ws: string): string {
  const shot = join(ws, "changes", "shot.png");
  writeFileSync(shot, "png-bytes");
  return shot;
}

describe("handleTest — lite 分支（judgeByExpected 重算，丢 claimedStatus）", () => {
  it("T4.1/T4.9 — actual 匹配 expected → passed，claimedStatus 被忽略，developed→tested 首次流转", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-lite-pass",
      slug: "test-lite-pass",
      tier: "lite",
      waves: ONE_WAVE,
      testCases: [URL_CASE],
    });
    const shot = writeShot(ws);

    const result = handleTest(
      {
        action: "test",
        topicId,
        cases: [
          {
            caseId: "E1",
            actual: { url: "/dashboard" },
            screenshotPath: shot,
            claimedStatus: "failed", // 谎报，应被忽略
          },
        ],
      },
      deps,
    );

    expect(result.caseResults[0].status).toBe("passed");
    expect(result.gatePassed.test).toBe(true);
    expect(result.status).toBe("tested"); // 首次流转
    expect(result.gateTier).toBe("strong-recompute");
    expect(store.loadTopic(topicId)?.testCases.find((c) => c.id === "E1")?.status).toBe(
      "passed",
    );
    closeStore(store);
  });

  it("T4.2 — claimedStatus='passed' 但 actual≠expected → judgeByExpected 重算 failed（D-008 丢 claimedStatus）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-lite-lie",
      slug: "test-lite-lie",
      tier: "lite",
      waves: ONE_WAVE,
      testCases: [URL_CASE],
    });
    const shot = writeShot(ws);

    const result = handleTest(
      {
        action: "test",
        topicId,
        cases: [
          {
            caseId: "E1",
            actual: { url: "/wrong" },
            screenshotPath: shot,
            claimedStatus: "passed", // 谎报
          },
        ],
      },
      deps,
    );

    expect(result.caseResults[0].status).toBe("failed");
    expect(result.caseResults[0].failureReason).toContain("url"); // 逐字段 mismatch reason
    expect(result.gatePassed.test).toBe(false);
    const tc = store.loadTopic(topicId)?.testCases.find((c) => c.id === "E1");
    expect(tc?.status).toBe("failed");
    expect(tc?.failureReason).toContain("url");
    closeStore(store);
  });

  it("T4.3 — screenshotPath 指向不存在文件 → failed，failureReason='screenshot missing'", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-lite-shot",
      slug: "test-lite-shot",
      tier: "lite",
      waves: ONE_WAVE,
      testCases: [URL_CASE],
    });

    const result = handleTest(
      {
        action: "test",
        topicId,
        cases: [
          {
            caseId: "E1",
            actual: { url: "/dashboard" }, // 即使匹配，截图缺失也 fail
            screenshotPath: join(ws, "changes", "no-such.png"),
          },
        ],
      },
      deps,
    );

    expect(result.caseResults[0].status).toBe("failed");
    expect(result.caseResults[0].failureReason).toBe("screenshot required by plan but missing");
    closeStore(store);
  });

  it("P0 — requiresScreenshot=false 时缺 screenshot → passed（mock 层不强制截图）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    // mock 层用例 plan 声明 requiresScreenshot: false
    const mockCase: TestCaseSeed = {
      ...URL_CASE,
      id: "E2",
      layer: "mock",
      requiresScreenshot: false,
    };
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-lite-mock-no-shot",
      slug: "test-lite-mock-no-shot",
      tier: "lite",
      waves: ONE_WAVE,
      testCases: [mockCase],
    });

    const result = handleTest(
      {
        action: "test",
        topicId,
        // 不传 screenshotPath，actual 匹配 expected
        cases: [{ caseId: "E2", actual: { url: "/dashboard" } }],
      },
      deps,
    );

    // requiresScreenshot=false → 跳过 screenshot 校验，只跑 judgeByExpected
    expect(result.caseResults[0].status).toBe("passed");
    closeStore(store);
  });
});

describe("handleTest — mid 分支（信声明 + GitValidator）", () => {
  const MID_CASE: TestCaseSeed = {
    id: "M1",
    layer: "integration",
    scenario: "gate 串行",
    steps: "跑 checker",
    assertion: "任一 fail 则 fail-fast",
    executor: "vitest",
  };

  it("T4.4 — mid 信声明 pass + commitHash valid → passed（不重算 expected）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-mid-pass",
      slug: "test-mid-pass",
      tier: "mid",
      waves: ONE_WAVE,
      testCases: [MID_CASE],
    });
    vi.spyOn(GitValidator.prototype, "validate").mockReturnValue(mockValidateValid("devcommit"));
    // M-1: mock traceability 通过（dev commit 是 submission 的祖先）
    vi.spyOn(GitValidator.prototype, "isAncestorOfAny").mockReturnValue(true);

    const result = handleTest(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "M1", commitHash: "devcommit", claimedStatus: "passed" }],
      },
      deps,
    );

    expect(result.caseResults[0].status).toBe("passed");
    expect(result.gatePassed.test).toBe(true);
    expect(result.gateTier).toBe("medium-coverage");
    expect(store.loadTopic(topicId)?.testCases.find((c) => c.id === "M1")?.commitHash).toBe(
      "devcommit",
    );
    closeStore(store);
  });

  it("M-1 — mid commitHash valid 但不追溯任何 dev wave commit → failed（防提交无关 hash 蒙混 medium-coverage）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-mid-untraceable",
      slug: "test-mid-untraceable",
      tier: "mid",
      waves: ONE_WAVE,
      testCases: [MID_CASE],
    });
    vi.spyOn(GitValidator.prototype, "validate").mockReturnValue(mockValidateValid("stray"));
    // M-1: traceability 检查返 false（commitHash 不是任何 dev commit 的后裔）
    vi.spyOn(GitValidator.prototype, "isAncestorOfAny").mockReturnValue(false);

    const result = handleTest(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "M1", commitHash: "stray", claimedStatus: "passed" }],
      },
      deps,
    );

    expect(result.caseResults[0].status).toBe("failed");
    expect(result.caseResults[0].failureReason).toContain("不在已 committed 的 dev wave");
    expect(result.gatePassed.test).toBe(false);
    closeStore(store);
  });

  it("T4.5 — mid commitHash 无效 → failed，failureReason 含 'invalid commit'", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-mid-bad",
      slug: "test-mid-bad",
      tier: "mid",
      waves: ONE_WAVE,
      testCases: [MID_CASE],
    });
    vi.spyOn(GitValidator.prototype, "validate").mockReturnValue({
      commitHash: "bad",
      exists: false,
      inRepo: false,
      nonEmpty: false,
      valid: false,
      reason: "cat-file",
    });

    const result = handleTest(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "M1", commitHash: "bad", claimedStatus: "passed" }],
      },
      deps,
    );

    expect(result.caseResults[0].status).toBe("failed");
    expect(result.caseResults[0].failureReason).toContain("invalid commit");
    expect(result.gatePassed.test).toBe(false);
    closeStore(store);
  });

  it("T2.15 — git infra ENOENT（validate throw）→ handleTest throw（infra 错误 propagate，不吞）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-mid-enoent",
      slug: "test-mid-enoent",
      tier: "mid",
      waves: ONE_WAVE,
      testCases: [MID_CASE],
    });
    vi.spyOn(GitValidator.prototype, "validate").mockImplementation(() => {
      throw new Error("spawn git ENOENT");
    });

    expect(() =>
      handleTest(
        {
          action: "test",
          topicId,
          cases: [{ caseId: "M1", commitHash: "any", claimedStatus: "passed" }],
        },
        deps,
      ),
    ).toThrow("spawn git ENOENT");

    closeStore(store);
  });
});

describe("handleTest — 渐进式 + 状态流转", () => {
  const TWO_CASES: TestCaseSeed[] = [
    {
      id: "E1",
      layer: "real",
      scenario: "case1",
      steps: "s1",
      expected: { url: "/a" },
      executor: "vitest",
    },
    {
      id: "E2",
      layer: "real",
      scenario: "case2",
      steps: "s2",
      expected: { url: "/b" },
      executor: "vitest",
    },
  ];

  it("T4.7/T4.9 — 全 case passed 前（2 case 只提 1 passed）→ gatePassed.test=false，developed→tested 首次流转", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-partial",
      slug: "test-partial",
      tier: "lite",
      waves: ONE_WAVE,
      testCases: TWO_CASES,
    });
    const shot = writeShot(ws);

    const result = handleTest(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1", actual: { url: "/a" }, screenshotPath: shot }],
      },
      deps,
    );

    expect(result.gatePassed.test).toBe(false); // E2 仍 pending
    expect(result.status).toBe("tested"); // 首次流转
    expect(result.testProgress).toEqual([
      { id: "E1", status: "passed" },
      { id: "E2", status: "pending" },
    ]);
    expect(result.nextAction.action).toBe("test"); // 仍需 test
    closeStore(store);
  });

  it("T4.8 — 全 case passed（2 case 都匹配）→ gatePassed.test=true", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-all",
      slug: "test-all",
      tier: "lite",
      waves: ONE_WAVE,
      testCases: TWO_CASES,
    });
    const shot = writeShot(ws);

    const result = handleTest(
      {
        action: "test",
        topicId,
        cases: [
          { caseId: "E1", actual: { url: "/a" }, screenshotPath: shot },
          { caseId: "E2", actual: { url: "/b" }, screenshotPath: shot },
        ],
      },
      deps,
    );

    expect(result.gatePassed.test).toBe(true);
    expect(result.nextAction.action).toBe("retrospect"); // test 完成 → retrospect
    closeStore(store);
  });

  it("T4.10 — tested 态再提交（态内推进）→ status 不变（仍 tested）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-instate",
      slug: "test-instate",
      tier: "lite",
      waves: ONE_WAVE,
      testCases: TWO_CASES,
    });
    // 模拟首次 test 已发生：E1 passed + status 推到 tested（E2 仍 pending）
    store.updateTestCase(topicId, "E1", { status: "passed" });
    store.updateStatus(topicId, "tested");

    const shot = writeShot(ws);
    const result = handleTest(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E2", actual: { url: "/b" }, screenshotPath: shot }],
      },
      deps,
    );

    expect(result.status).toBe("tested"); // progressive 已处 nextStatus，不流转
    expect(result.gatePassed.test).toBe(true); // 现在 E1/E2 都 passed
    closeStore(store);
  });
});

describe("handleTest — m-1/m-2 边界修复", () => {
  it("m-1 — lite expected 为空（无 url/text）→ failed + 明确错误（防 topic 卡死）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-empty-expected",
      slug: "test-empty-expected",
      tier: "lite",
      waves: ONE_WAVE,
      // expected 完全为空（畸形 plan 数据）
      testCases: [{ ...URL_CASE, expected: undefined }],
    });
    const shot = writeShot(ws);

    const result = handleTest(
      {
        action: "test",
        topicId,
        cases: [{ caseId: "E1", actual: { url: "/dashboard" }, screenshotPath: shot }],
      },
      deps,
    );

    expect(result.caseResults[0].status).toBe("failed");
    expect(result.caseResults[0].failureReason).toContain("expected 为空");
    expect(result.gatePassed.test).toBe(false);
    closeStore(store);
  });

  it("m-2 — case not found → throw（与 topic not found 一致的硬错，不静默污染 gateHistory）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedDevelopedTopic(store, {
      topicId: "cw-test-case-not-found",
      slug: "test-case-not-found",
      tier: "lite",
      waves: ONE_WAVE,
      testCases: [URL_CASE],
    });
    const shot = writeShot(ws);

    expect(() =>
      handleTest(
        {
          action: "test",
          topicId,
          // E99 不存在
          cases: [{ caseId: "E99", actual: { url: "/dashboard" }, screenshotPath: shot }],
        },
        deps,
      ),
    ).toThrow(/case not found: E99/);

    closeStore(store);
  });
});
