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
    // nextAction 指向 retry plan（不是 dev），防 agent 调 dev 撞 illegal_transition
    expect(result.nextAction.action).toBe("plan");
    expect(result.nextAction.skill).toBe("lite-plan");
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

  // 回归测试（2026-07-04 bug）：LLM 把 planJson 当 JSON 字符串传（不是 object），
  // 到 parseLitePlan 的 typeof !== "object" 守卫被拒。报错必须明确指向 "not an object"，
  // 而不是更下游的 schema 错（误导调试）。这个测试守住「错误信息精确」契约。
  it("REGRESSION 2026-07-04: planJson 为 string（LLM 误传）→ throw 'invalid plan json: not an object'", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const created = handleCreate(
      { action: "create", slug: "demo", tier: "lite", objective: "x" },
      deps,
    );

    // 模拟 LLM 误把 plan.json 内容 JSON.stringify 后当 string 传
    const jsonString = JSON.stringify(makeLitePlan());
    expect(() =>
      handlePlan(
        // 故意违反类型（模拟 LLM 运行时传错）：planJson 期望 object，实际传 string
        // eslint-disable-next-line taste/no-unsafe-cast -- 测试专用：故意传错类型测校验路径
        { action: "plan", topicId: created.topicId, planJson: jsonString as unknown as object },
        deps,
      ),
    ).toThrow(/invalid plan json: not an object/);

    closeStore(store);
  });
});

// 占位：seedTopic 在其他 action 测试里用于绕过 create，此处 import 防未来扩展时漏引
void seedTopic;
