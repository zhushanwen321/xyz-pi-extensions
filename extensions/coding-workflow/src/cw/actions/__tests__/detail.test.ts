/**
 * detail.test.ts — detail action（UC-2 mid 后段，#4 AC-4.2 串行 fail-fast）。
 *
 * 前置：先走通 clarify（create mid → review 桩 → mock pass → handleClarify）拿 clarified 态。
 */

import { describe, expect, it, vi } from "vitest";

import { GateRunner } from "../../gates.js";
import { handleClarify } from "../clarify.js";
import { handleCreate } from "../create.js";
import { handleDetail } from "../detail.js";
import {
  closeStore,
  FAIL_CHECK,
  makeDeps,
  makeMidClarify,
  makeMidDetail,
  makeTmpWorkspace,
  PASS_CHECK,
  writeReviewStubs,
} from "./_helpers.js";

/** 走通 clarify 拿 clarified 态的 mid topic（mock runner pass）。返回 topicId。 */
function setupClarifiedMidTopic(
  deps: ReturnType<typeof makeDeps>["deps"],
  slug: string,
): string {
  const created = handleCreate(
    { action: "create", slug, tier: "mid", objective: "x" },
    deps,
  );
  writeReviewStubs(deps.topicDir, ["clarity", "architecture"]);
  handleClarify(
    { action: "clarify", topicId: created.topicId, clarifyJson: makeMidClarify() },
    deps,
  );
  return created.topicId;
}

describe("handleDetail", () => {
  it("detail gate pass：clarified→detailed，waves/testCases 写入，gatePassed.detail=true（4 checker 全跑）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const runnerSpy = vi
      .spyOn(GateRunner.prototype, "runCheck")
      .mockReturnValue(PASS_CHECK);

    const topicId = setupClarifiedMidTopic(deps, "midfeat");
    // 写齐 detail 4 个 review 桩 → 预检通过
    writeReviewStubs(ws, ["issues", "nfr", "code-arch", "execution"]);

    const result = handleDetail(
      { action: "detail", topicId, detailJson: makeMidDetail() },
      deps,
    );

    expect(result.status).toBe("detailed"); // clarified → detailed
    expect(result.gatePassed.detail).toBe(true);
    expect(result.gateTier).toBe("weak-structural");
    expect(result.nextAction.action).toBe("dev");
    expect(result.mustFix).toBeUndefined();

    // store 中 waves/testCases 已写入（mid detail 才写任务清单）
    const loaded = store.loadTopic(topicId);
    expect(loaded?.waves.length).toBeGreaterThan(0);
    expect(loaded?.testCases.length).toBeGreaterThan(0);

    // 4 checker 全跑（mock pass 不 fail-fast）
    // clarify 用掉 2 次 + detail 4 次 = 6 次
    expect(runnerSpy.mock.calls.length).toBeGreaterThanOrEqual(6);

    closeStore(store);
  });

  it("T2.7 / AC-4.2 — detail fail-fast：首个 checker fail 则剩余不跑，status 不变", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    // clarify 阶段先 pass（拿到 clarified 态）
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(PASS_CHECK);
    const topicId = setupClarifiedMidTopic(deps, "midfail");
    writeReviewStubs(ws, ["issues", "nfr", "code-arch", "execution"]);

    // detail 阶段切到 fail：mock 总返 fail → runGate 首个 checker fail 即短路
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(FAIL_CHECK);
    const callsBeforeDetail = vi.mocked(GateRunner.prototype.runCheck).mock.calls.length;

    const result = handleDetail(
      { action: "detail", topicId, detailJson: makeMidDetail() },
      deps,
    );

    // fail-fast：detail 只新跑 1 个 checker（check_issues.py）
    const callsAfterDetail = vi.mocked(GateRunner.prototype.runCheck).mock.calls.length;
    expect(callsAfterDetail - callsBeforeDetail).toBe(1);

    // status 不变（仍 clarified），gatePassed.detail 未设
    expect(result.status).toBe("clarified");
    expect(result.gatePassed.detail).toBeFalsy();
    expect(result.mustFix).toContain("FAIL");

    // gateHistory 追加 detail/fail，report 只含 1 个 checker 的输出（fail-fast）
    const loaded = store.loadTopic(topicId);
    const detailFails = loaded?.gateHistory.filter(
      (e) => e.phase === "detail" && e.result === "fail",
    );
    expect(detailFails?.length).toBe(1);

    closeStore(store);
  });
});
