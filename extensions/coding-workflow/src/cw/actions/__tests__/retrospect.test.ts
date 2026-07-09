/**
 * retrospect.test.ts — retrospect action（UC-5 前段，AC-5.1/5.4）。
 *
 * T5.1 前置不足（test 有 case 未 passed）→ guard phase_incomplete throw
 * T5.2 pass（retrospect.md 存在+非空，test 全 passed）→ status: tested→retrospected
 *
 * 测试层：mock（weak gate 走文件系统，不需 GateRunner）。
 * 前置状态用 store 直接种（绕过未实现的 dev/test action）。
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { TestCaseSeed } from "../../types.js";
import { handleCreate } from "../create.js";
import { handleRetrospect } from "../retrospect.js";
import {
  closeStore,
  makeDeps,
  makeTmpWorkspace,
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

describe("handleRetrospect", () => {
  it("T5.1 — 前置不足（test 有 case 未 passed）→ guard 抛 phase_incomplete，不跑 weak gate", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    // 种一个 tested 态 topic，插入 1 个 pending testCase（test 未全 passed）
    const topicId = seedTopic(store, {
      topicId: "cw-retro-incomplete",
      slug: "retro-inc",
      tier: "lite",
      status: "tested",
    });
    store.insertTestCases(topicId, [passedCase]);
    // insertTestCases 默认 status=pending，不 update → 仍 pending

    expect(() =>
      handleRetrospect(
        { action: "retrospect", topicId, retrospectPath: join(ws, "changes", "retrospect.md") },
        deps,
      ),
    ).toThrow(/phase_incomplete|guard failed/);

    // 状态不变
    expect(store.loadTopic(topicId)?.status).toBe("tested");

    closeStore(store);
  });

  it("T5.2 — pass：retrospect.md 存在+非空，test 全 passed → tested→retrospected，gatePassed.retrospect=true", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const topicId = seedTopic(store, {
      topicId: "cw-retro-ok",
      slug: "retro-ok",
      tier: "lite",
      status: "tested",
    });
    store.insertTestCases(topicId, [passedCase]);
    store.updateTestCase(topicId, "E1", { status: "passed" }); // test 全 passed

    // 写非空 retrospect.md
    const retroPath = join(ws, "changes", "retrospect.md");
    writeFileSync(retroPath, "# 复盘\n本次交付质量良好。\n");

    const result = handleRetrospect(
      { action: "retrospect", topicId, retrospectPath: retroPath },
      deps,
    );

    expect(result.status).toBe("retrospected"); // tested → retrospected
    expect(result.gatePassed.retrospect).toBe(true);
    expect(result.gateTier).toBe("weak-structural");
    expect(result.nextAction.action).toBe("closeout");
    expect(result.mustFix).toBeUndefined();

    // gateHistory 追加 retrospect/pass（progressive）
    const loaded = store.loadTopic(topicId);
    const retroPass = loaded?.gateHistory.filter(
      (e) => e.phase === "retrospect" && e.result === "pass",
    );
    expect(retroPass?.length).toBe(1);
    expect(retroPass?.[0]?.progressive).toBe(true);

    closeStore(store);
  });

  it("weak gate fail：retrospect.md 缺失 → status 不变，mustFix 提示缺失（progressive 可重试）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const topicId = seedTopic(store, {
      topicId: "cw-retro-miss",
      slug: "retro-miss",
      tier: "lite",
      status: "tested",
    });
    store.insertTestCases(topicId, [passedCase]);
    store.updateTestCase(topicId, "E1", { status: "passed" });

    // 不写 retrospect.md
    const result = handleRetrospect(
      { action: "retrospect", topicId, retrospectPath: join(ws, "changes", "retrospect.md") },
      deps,
    );

    expect(result.status).toBe("tested"); // 不变
    expect(result.gatePassed.retrospect).toBeFalsy();
    // nextAction 指向 retry retrospect（不是 closeout），防 agent 调 closeout 撞 illegal_transition
    expect(result.nextAction.action).toBe("retrospect");
    expect(result.nextAction.skill).toBe("coding-retrospect");
    expect(result.mustFix).toMatch(/retrospect\.md|missing|empty/);

    closeStore(store);
  });
});

// 防未使用 import 警告
void handleCreate;
