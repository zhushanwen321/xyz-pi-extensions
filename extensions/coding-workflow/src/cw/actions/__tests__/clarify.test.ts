/**
 * clarify.test.ts — clarify action（UC-2 mid 前段）。
 *
 * 重点：#7 AC-7.1 review 桩缺失预检 → 结构化 hint（非裸 check 报错）。
 *   T2.8  review-clarity.md 缺失 → mustFix 明确指出缺 review-clarity.md，不跑 gate
 *   T2.24 hint 稳定性（来源 B NFR）：mustFix 含可执行指引（跑 review-fix-loop + 文件名）
 */

import { describe, expect, it, vi } from "vitest";

import { GateRunner } from "../../gates.js";
import { handleClarify } from "../clarify.js";
import { handleCreate } from "../create.js";
import {
  closeStore,
  makeDeps,
  makeMidClarify,
  makeTmpWorkspace,
  PASS_CHECK,
  writeReviewStubs,
} from "./_helpers.js";

describe("handleClarify (#7 review 桩预检)", () => {
  it("T2.8 — review-clarity.md 缺失：返明确 hint 指出缺该文件，不跑 gate", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const runnerSpy = vi
      .spyOn(GateRunner.prototype, "runCheck")
      .mockReturnValue(PASS_CHECK);

    const created = handleCreate(
      { action: "create", slug: "midfeat", tier: "mid", objective: "x" },
      deps,
    );

    // 不写任何 review 桩 → 预检命中
    const result = handleClarify(
      { action: "clarify", topicId: created.topicId, clarifyJson: makeMidClarify() },
      deps,
    );

    // mustFix 含缺失文件名（review-clarity.md）
    expect(result.mustFix).toContain("review-clarity.md");
    // 非裸 check 报错：含可执行指引
    expect(result.mustFix).toMatch(/review-fix-loop|review 桩|不自动生成/);
    // status 不变（仍 created），gatePassed.clarify 未设
    expect(result.status).toBe("created");
    expect(result.gatePassed.clarify).toBeFalsy();
    // nextAction 指向 retry clarify（不是 detail），防 agent 调 detail 撞 illegal_transition
    expect(result.nextAction.action).toBe("clarify");
    expect(result.nextAction.skill).toBe("mid-plan");
    // gate 没跑（预检短路）
    expect(runnerSpy).not.toHaveBeenCalled();

    closeStore(store);
  });

  it("T2.24 — hint 稳定性（来源 B NFR）：缺失时 mustFix 含 review-fix-loop 指引 + 具体文件名", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const created = handleCreate(
      { action: "create", slug: "midfeat2", tier: "mid", objective: "x" },
      deps,
    );

    const result = handleClarify(
      { action: "clarify", topicId: created.topicId, clarifyJson: makeMidClarify() },
      deps,
    );

    // 结构化 hint 双要素：① 具体缺哪个文件 ② 下一步做什么
    expect(result.mustFix).toMatch(/review-clarity\.md|review-architecture\.md/);
    expect(result.mustFix).toMatch(/review-fix-loop/);
    expect(typeof result.mustFix).toBe("string");
    expect((result.mustFix as string).length).toBeGreaterThan(20);
    // nextAction 指向 retry clarify（不是 detail），防 agent 调 detail 撞 illegal_transition
    expect(result.nextAction.action).toBe("clarify");
    expect(result.nextAction.skill).toBe("mid-plan");

    closeStore(store);
  });

  it("AC-7.2 — review 桩存在 + gate pass：status→clarified，gatePassed.clarify=true", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(PASS_CHECK);

    const created = handleCreate(
      { action: "create", slug: "midok", tier: "mid", objective: "x" },
      deps,
    );
    // 写齐 clarify 两个 review 桩 → 预检通过，跑 gate
    writeReviewStubs(ws, ["clarity", "architecture"]);

    const result = handleClarify(
      { action: "clarify", topicId: created.topicId, clarifyJson: makeMidClarify() },
      deps,
    );

    expect(result.status).toBe("clarified"); // created → clarified
    expect(result.gatePassed.clarify).toBe(true);
    expect(result.nextAction.action).toBe("detail");
    expect(result.mustFix).toBeUndefined();
    // mid clarify 不写 waves/testCases（#5 AC-5.4）
    const loaded = store.loadTopic(created.topicId);
    expect(loaded?.waves).toHaveLength(0);
    expect(loaded?.testCases).toHaveLength(0);

    closeStore(store);
  });
});
