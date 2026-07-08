/**
 * create.test.ts — create action（UC-1，AC-1.1~1.4）。
 *
 * 测试层：real（真实 CwStore + 临时 db）。T1.5 借 handlePlan 验证 tier 锁定。
 */

import { describe, expect, it } from "vitest";

import { parseLitePlan } from "../../plan-parser.js";
import { type CreateParams,handleCreate } from "../create.js";
import { handlePlan } from "../plan.js";
import {
  closeStore,
  makeDeps,
  makeLitePlan,
  makeTmpWorkspace,
} from "./_helpers.js";

describe("handleCreate", () => {
  it("T1.1 — tier=lite 建 topic：nextAction=plan/lite-plan，_cw.json tier=lite", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const params: CreateParams = {
      action: "create",
      slug: "demo",
      tier: "lite",
      objective: "build demo",
    };
    const result = handleCreate(params, deps);

    expect(result.status).toBe("created");
    expect(result.nextAction.action).toBe("plan");
    expect(result.nextAction.skill).toBe("lite-plan");
    expect(result.topicId).toMatch(/^cw-\d{4}-\d{2}-\d{2}-demo$/);

    const loaded = store.loadTopic(result.topicId);
    expect(loaded?.tier).toBe("lite");
    expect(loaded?.objective).toBe("build demo");
    expect(loaded?.status).toBe("created");

    closeStore(store);
  });

  it("T1.2 — tier=mid 建 topic：nextAction=clarify/mid-plan", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const result = handleCreate(
      { action: "create", slug: "midfeat", tier: "mid", objective: "mid obj" },
      deps,
    );

    expect(result.nextAction.action).toBe("clarify");
    expect(result.nextAction.skill).toBe("mid-plan");
    expect(store.loadTopic(result.topicId)?.tier).toBe("mid");

    closeStore(store);
  });

  it("T1.3 — 首次建库（全新空 db）：建表 + insert 不抛（幂等）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    expect(() =>
      handleCreate(
        { action: "create", slug: "first", tier: "lite", objective: "x" },
        deps,
      ),
    ).not.toThrow();

    // 二次 create 不同 slug 也不抛（建表幂等，DDL IF NOT EXISTS）
    expect(() =>
      handleCreate(
        { action: "create", slug: "second", tier: "lite", objective: "y" },
        deps,
      ),
    ).not.toThrow();

    closeStore(store);
  });

  it("T1.4 — slug 重复：insertTopic 抛 PRIMARY KEY 冲突，原 topic 不被覆盖", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const first = handleCreate(
      { action: "create", slug: "dup", tier: "lite", objective: "original" },
      deps,
    );
    const originalId = first.topicId;

    // 同日同 slug → 同 topicId → PRIMARY KEY 冲突
    expect(() =>
      handleCreate(
        { action: "create", slug: "dup", tier: "mid", objective: "overwrite attempt" },
        deps,
      ),
    ).toThrow();

    // 原 topic 未被覆盖：objective 仍是 original，tier 仍是 lite
    const loaded = store.loadTopic(originalId);
    expect(loaded?.objective).toBe("original");
    expect(loaded?.tier).toBe("lite");

    closeStore(store);
  });

  it("T1.5 — tier 锁定（D-003）：create lite 后 plan 传 format≠lite → parseLitePlan 拒", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);

    const created = handleCreate(
      { action: "create", slug: "lock", tier: "lite", objective: "x" },
      deps,
    );

    // topic.tier=lite，但 planJson.format=mid-detail → parseLitePlan 抛 tier mismatch
    expect(() =>
      handlePlan(
        { action: "plan", topicId: created.topicId, planJson: makeLitePlan({ format: "mid-detail" }) },
        deps,
      ),
    ).toThrow(/tier mismatch/);

    // 直接验证 parseLitePlan 的 tier 锁行为（D-003 AC-2.1）
    expect(() => parseLitePlan(makeLitePlan({ format: "mid" }), "lite")).toThrow(/tier mismatch/);

    // status 不变（仍 created）
    expect(store.loadTopic(created.topicId)?.status).toBe("created");

    closeStore(store);
  });
});
