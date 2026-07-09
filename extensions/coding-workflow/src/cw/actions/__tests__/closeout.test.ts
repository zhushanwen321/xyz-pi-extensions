/**
 * closeout.test.ts — closeout action（UC-5 后段，AC-5.2/5.3）。
 *
 * T5.3 pass：retrospected + check_closeout exit0 → status=closed，evidence 含完整 gateHistory
 * 补 fail：check_closeout fail → status 不变（retrospected），mustFix
 *
 * 前置：先走通 retrospect 拿 retrospected 态（含 gatePassed.retrospect=true + gateHistory 记录）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { GateRunner } from "../../gates.js";
import type { TestCaseSeed } from "../../types.js";
import { handleCloseout } from "../closeout.js";
import { handleRetrospect } from "../retrospect.js";
import {
  closeStore,
  FAIL_CHECK,
  makeDeps,
  makeTmpWorkspace,
  PASS_CHECK,
  seedTopic,
} from "./_helpers.js";

const passedCase: TestCaseSeed = {
  id: "E1",
  layer: "real",
  scenario: "登录",
  steps: "提交",
  expected: { text: "欢迎" },
  executor: "vitest",
};

/** 种一个 retrospected 态 topic（test 全 passed + retrospect.md 已写 + handleRetrospect 跑通）。 */
function setupRetrospectedTopic(
  store: ReturnType<typeof makeDeps>["store"],
  deps: ReturnType<typeof makeDeps>["deps"],
  slug: string,
): string {
  const topicId = seedTopic(store, {
    topicId: `cw-closeout-${slug}`,
    slug,
    tier: "lite",
    status: "tested",
    workspacePath: deps.workspacePath,
  });
  store.insertTestCases(topicId, [passedCase]);
  store.updateTestCase(topicId, "E1", { status: "passed" });
  // retrospect.md 写进 topicDir/changes/（与 handler 的 resolveTopicDir(topic) 对齐）
  const changesDir = join(deps.workspacePath, ".xyz-harness", slug, "changes");
  mkdirSync(changesDir, { recursive: true });
  const retroPath = join(changesDir, "retrospect.md");
  writeFileSync(retroPath, "# 复盘\n交付完成。\n");
  handleRetrospect({ action: "retrospect", topicId, retrospectPath: retroPath }, deps);
  return topicId;
}

describe("handleCloseout", () => {
  it("T5.3 — pass：retrospected + check_closeout pass → closed，evidence 含完整 gateHistory，gatePassed.closeout=true", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(PASS_CHECK);

    const topicId = setupRetrospectedTopic(store, deps, "ok");

    const result = handleCloseout({ action: "closeout", topicId }, deps);

    expect(result.status).toBe("closed"); // retrospected → closed（终态）
    expect(result.gatePassed.closeout).toBe(true);
    expect(result.nextAction.guidance).toMatch(/关闭|closed|结束/);

    // evidence 已填充（返回值）
    expect(result.evidence).toBeDefined();
    const evidence = result.evidence!;
    expect(typeof evidence.closedAt).toBe("string");
    expect(evidence.gateHistory.length).toBeGreaterThan(0);
    // evidence.gateHistory 含完整历史（retrospect pass + closeout pass）
    const phases = evidence.gateHistory.map((e) => e.phase);
    expect(phases).toContain("retrospect");
    expect(phases).toContain("closeout");

    // store 持久化：loadTopic().evidence 非空（store evidence 列 round-trip）
    const loaded = store.loadTopic(topicId);
    expect(loaded?.evidence).toBeDefined();
    expect(loaded?.evidence?.gateHistory.length).toBeGreaterThan(0);
    expect(loaded?.gatePassed.closeout).toBe(true);

    closeStore(store);
  });

  it("closeout gate fail：status 不变（retrospected），mustFix 含 report", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    vi.spyOn(GateRunner.prototype, "runCheck").mockReturnValue(FAIL_CHECK);

    const topicId = setupRetrospectedTopic(store, deps, "fail");

    const result = handleCloseout({ action: "closeout", topicId }, deps);

    expect(result.status).toBe("retrospected"); // 不变
    expect(result.gatePassed.closeout).toBeFalsy();
    // nextAction 指向 retry closeout（不是终态 guidance），防 agent 误判已 closed 提前终止
    expect(result.nextAction.action).toBe("closeout");
    expect(result.nextAction.skill).toBe("coding-closeout");
    expect(result.mustFix).toContain("FAIL");
    // evidence 未填充（gate fail 不写 evidence）
    expect(result.evidence).toBeUndefined();

    const loaded = store.loadTopic(topicId);
    expect(loaded?.status).toBe("retrospected");
    expect(loaded?.evidence).toBeUndefined();

    closeStore(store);
  });
});
