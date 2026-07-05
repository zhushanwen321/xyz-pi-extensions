/**
 * dev.test.ts — dev action（UC-3，AC-3.1~3.9 + T2.16/T2.26）。
 *
 * 渐进式 GitValidator gate：per-task 事务部分成功（#3 方案 A）。
 *
 * 测试层：mock（vi.spyOn GitValidator.prototype.validate 控制每 commit 返回值）。
 * 前置：planned topic + waves（store.insertWaves），不依赖 dev 前序 action。
 */

import { describe, expect, it, vi } from "vitest";

import { GitValidator } from "../../gates.js";
import type { CommitValidation, WaveSeed } from "../../types.js";
import { handleDev } from "../dev.js";
import { closeStore, makeDeps, makeTmpWorkspace, seedTopic } from "./_helpers.js";

const TWO_WAVES: WaveSeed[] = [
  { id: "W1", dependsOn: [], changes: ["src/a.ts"], issues: [] },
  { id: "W2", dependsOn: ["W1"], changes: ["src/b.ts"], issues: [] },
];

function mockValidateValid(hash: string): CommitValidation {
  return { commitHash: hash, exists: true, inRepo: true, nonEmpty: true, valid: true };
}

describe("handleDev", () => {
  it("T3.1/T3.7 — planned 单 task valid → W1 写入，gatePassed.dev=false（W2 未 committed），planned→developed 首次流转", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedTopic(store, {
      topicId: "cw-dev-single",
      slug: "dev-single",
      tier: "lite",
      status: "planned",
    });
    store.insertWaves(topicId, TWO_WAVES);
    vi.spyOn(GitValidator.prototype, "validate").mockReturnValue(mockValidateValid("abc"));

    const result = handleDev(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: "abc" }] },
      deps,
    );

    expect(result.status).toBe("developed"); // 首次有效流转
    expect(result.gatePassed.dev).toBe(false); // W2 未 committed
    expect(result.taskResults).toEqual([{ waveId: "W1", valid: true }]);
    expect(result.devProgress).toEqual([
      { id: "W1", committed: true },
      { id: "W2", committed: false },
    ]);
    expect(result.gateTier).toBe("medium-git");

    const loaded = store.loadTopic(topicId);
    expect(loaded?.waves.find((w) => w.id === "W1")?.committed).toBe("abc");
    expect(loaded?.waves.find((w) => w.id === "W2")?.committed).toBeNull();
    closeStore(store);
  });

  it("T3.2 — commit 不存在（cat-file fail）→ task fail，taskResults 含 reason，wave 未写入", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedTopic(store, {
      topicId: "cw-dev-noexist",
      slug: "dev-noexist",
      tier: "lite",
      status: "planned",
    });
    store.insertWaves(topicId, TWO_WAVES);
    vi.spyOn(GitValidator.prototype, "validate").mockReturnValue({
      commitHash: "deadbeef",
      exists: false,
      inRepo: false,
      nonEmpty: false,
      valid: false,
      reason: "cat-file",
    });

    const result = handleDev(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: "deadbeef" }] },
      deps,
    );

    expect(result.taskResults).toEqual([{ waveId: "W1", valid: false, reason: "cat-file" }]);
    expect(result.gatePassed.dev).toBe(false);
    expect(store.loadTopic(topicId)?.waves.find((w) => w.id === "W1")?.committed).toBeNull();
    closeStore(store);
  });

  it("T3.3 — commit 外来（merge-base fail，不在 repo 历史）→ task fail", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedTopic(store, {
      topicId: "cw-dev-foreign",
      slug: "dev-foreign",
      tier: "lite",
      status: "planned",
    });
    store.insertWaves(topicId, TWO_WAVES);
    vi.spyOn(GitValidator.prototype, "validate").mockReturnValue({
      commitHash: "foreign",
      exists: true,
      inRepo: false,
      nonEmpty: true,
      valid: false,
      reason: "merge-base",
    });

    const result = handleDev(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: "foreign" }] },
      deps,
    );

    expect(result.taskResults[0]).toEqual({ waveId: "W1", valid: false, reason: "merge-base" });
    closeStore(store);
  });

  it("T3.4 — 空 commit（diff-tree fail，--allow-empty）→ task fail", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedTopic(store, {
      topicId: "cw-dev-empty",
      slug: "dev-empty",
      tier: "lite",
      status: "planned",
    });
    store.insertWaves(topicId, TWO_WAVES);
    vi.spyOn(GitValidator.prototype, "validate").mockReturnValue({
      commitHash: "empty-commit",
      exists: true,
      inRepo: true,
      nonEmpty: false,
      valid: false,
      reason: "empty",
    });

    const result = handleDev(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: "empty-commit" }] },
      deps,
    );

    expect(result.taskResults[0]).toEqual({ waveId: "W1", valid: false, reason: "empty" });
    closeStore(store);
  });

  it("T3.5 — 部分 Wave 未 committed（2 wave 只提 1 valid）→ gatePassed.dev=false", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedTopic(store, {
      topicId: "cw-dev-partial",
      slug: "dev-partial",
      tier: "lite",
      status: "planned",
    });
    store.insertWaves(topicId, TWO_WAVES);
    vi.spyOn(GitValidator.prototype, "validate").mockReturnValue(mockValidateValid("only-w1"));

    const result = handleDev(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: "only-w1" }] },
      deps,
    );

    expect(result.gatePassed.dev).toBe(false);
    closeStore(store);
  });

  it("T3.6 — 全 Wave committed（2 wave 都 valid）→ gatePassed.dev=true，所有 wave.committed 非 null", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedTopic(store, {
      topicId: "cw-dev-all",
      slug: "dev-all",
      tier: "lite",
      status: "planned",
    });
    store.insertWaves(topicId, TWO_WAVES);
    vi.spyOn(GitValidator.prototype, "validate").mockReturnValue(mockValidateValid("full-hash"));

    const result = handleDev(
      {
        action: "dev",
        topicId,
        tasks: [
          { waveId: "W1", commitHash: "full-hash" },
          { waveId: "W2", commitHash: "full-hash" },
        ],
      },
      deps,
    );

    expect(result.gatePassed.dev).toBe(true);
    expect(store.loadTopic(topicId)?.waves.every((w) => w.committed !== null)).toBe(true);
    expect(result.nextAction.action).toBe("test"); // dev 完成 → test
    closeStore(store);
  });

  it("T3.8 — developed 态再提交（态内推进）→ status 不变（仍 developed）", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedTopic(store, {
      topicId: "cw-dev-instate",
      slug: "dev-instate",
      tier: "lite",
      status: "developed",
    });
    store.insertWaves(topicId, TWO_WAVES);
    vi.spyOn(GitValidator.prototype, "validate").mockReturnValue(
      mockValidateValid("instate-hash"),
    );

    const result = handleDev(
      { action: "dev", topicId, tasks: [{ waveId: "W1", commitHash: "instate-hash" }] },
      deps,
    );

    expect(result.status).toBe("developed"); // progressive 已处 nextStatus，不流转
    closeStore(store);
  });

  it("T3.9/T2.16/T2.26 — 批量混合（W1 valid + W2 invalid）→ W1 写入不被 W2 回滚，devProgress 反映 committed/未，per-task 事务部分成功", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedTopic(store, {
      topicId: "cw-dev-mixed",
      slug: "dev-mixed",
      tier: "lite",
      status: "planned",
    });
    store.insertWaves(topicId, TWO_WAVES);
    vi.spyOn(GitValidator.prototype, "validate").mockImplementation((hash: string) =>
      hash === "good"
        ? mockValidateValid(hash)
        : {
            commitHash: hash,
            exists: false,
            inRepo: false,
            nonEmpty: false,
            valid: false,
            reason: "cat-file",
          },
    );

    const result = handleDev(
      {
        action: "dev",
        topicId,
        tasks: [
          { waveId: "W1", commitHash: "good" },
          { waveId: "W2", commitHash: "bad" },
        ],
      },
      deps,
    );

    // T2.26 per-task 事务部分成功：W1 写入保留，W2 invalid 不回滚 W1
    const loaded = store.loadTopic(topicId);
    expect(loaded?.waves.find((w) => w.id === "W1")?.committed).toBe("good");
    expect(loaded?.waves.find((w) => w.id === "W2")?.committed).toBeNull();

    expect(result.taskResults).toEqual([
      { waveId: "W1", valid: true },
      { waveId: "W2", valid: false, reason: "cat-file" },
    ]);
    expect(result.gatePassed.dev).toBe(false);

    // T2.16 nextAction/devProgress 反映 committed/未
    expect(result.devProgress).toEqual([
      { id: "W1", committed: true },
      { id: "W2", committed: false },
    ]);
    expect(result.nextAction.action).toBe("dev"); // 仍需 dev
    expect(result.nextAction.waves).toEqual([
      { id: "W1", committed: true },
      { id: "W2", committed: false },
    ]);
    closeStore(store);
  });

  it("m-3 — 未知 waveId → task fail (reason='wave not found')，不静默成功", () => {
    const ws = makeTmpWorkspace();
    const { deps, store } = makeDeps(ws);
    const topicId = seedTopic(store, {
      topicId: "cw-dev-unknown-wave",
      slug: "dev-unknown-wave",
      tier: "lite",
      status: "planned",
    });
    store.insertWaves(topicId, TWO_WAVES);
    vi.spyOn(GitValidator.prototype, "validate").mockReturnValue(mockValidateValid("abc"));

    const result = handleDev(
      // W99 不存在
      { action: "dev", topicId, tasks: [{ waveId: "W99", commitHash: "abc" }] },
      deps,
    );

    expect(result.taskResults).toEqual([{ waveId: "W99", valid: false, reason: "wave not found" }]);
    expect(result.gatePassed.dev).toBe(false);
    // 真实 wave 未被写入
    expect(store.loadTopic(topicId)?.waves.every((w) => w.committed === null)).toBe(true);
    closeStore(store);
  });
});
