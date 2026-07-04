/**
 * plan.test.ts — plan action（UC-2 lite，AC-2.3/2.4/2.5）。
 *
 * 测试层：mock（vi.spyOn GateRunner.runCheck 控制 gate 结果）。
 */

import { describe, expect, it, vi } from "vitest";

import { GateRunner } from "../../gates.js";
import { handleCreate } from "../create.js";
import { handlePlan } from "../plan.js";
import {
  closeStore,
  FAIL_CHECK,
  makeDeps,
  makeLitePlan,
  makeTmpWorkspace,
  PASS_CHECK,
  seedTopic,
} from "./_helpers.js";

describe("handlePlan", () => {
  it("T2.1 — plan gate pass：created→planned，waves/testCases 写入，gatePassed.plan=true", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const runnerSpy = vi
      .spyOn(GateRunner.prototype, "runCheck")
      .mockReturnValue(PASS_CHECK);

    const created = handleCreate(
      { action: "create", slug: "demo", tier: "lite", objective: "x" },
      deps,
    );

    const result = handlePlan(
      { action: "plan", topicId: created.topicId, planJson: makeLitePlan() },
      deps,
    );

    expect(result.status).toBe("planned"); // created → planned
    expect(result.gatePassed.plan).toBe(true);
    expect(result.gateTier).toBe("weak-structural");
    expect(result.nextAction.action).toBe("dev");
    expect(result.nextAction.skill).toBe("coding-execute");
    // 没有必须修复的 gate fail
    expect(result.mustFix).toBeUndefined();

    // store 中 waves/testCases 已写入
    const loaded = store.loadTopic(created.topicId);
    expect(loaded?.waves.length).toBeGreaterThan(0);
    expect(loaded?.testCases.length).toBeGreaterThan(0);
    expect(loaded?.gatePassed.plan).toBe(true);

    // runCheck 被调一次（plan 单 checker）
    expect(runnerSpy).toHaveBeenCalledTimes(1);

    closeStore(store);
  });

  it("plan gate fail：status 不变（created），gatePassed.plan 未设，mustFix 含 report，gateHistory 追加 fail", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(FAIL_CHECK);

    const created = handleCreate(
      { action: "create", slug: "demo", tier: "lite", objective: "x" },
      deps,
    );

    const beforeStatus = store.loadTopic(created.topicId)?.status;
    const result = handlePlan(
      { action: "plan", topicId: created.topicId, planJson: makeLitePlan() },
      deps,
    );

    // status 不变
    expect(result.status).toBe(beforeStatus);
    expect(result.status).toBe("created");
    // gatePassed.plan 未设
    expect(result.gatePassed.plan).toBeFalsy();
    // mustFix 含 report 文本
    expect(result.mustFix).toContain("FAIL");
    // gateHistory 追加了 plan/fail 条目
    const loaded = store.loadTopic(created.topicId);
    const planFails = loaded?.gateHistory.filter(
      (e) => e.phase === "plan" && e.result === "fail",
    );
    expect(planFails?.length).toBe(1);

    closeStore(store);
  });
});

// 占位：seedTopic 在其他 action 测试里用于绕过 create，此处 import 防未来扩展时漏引
void seedTopic;
