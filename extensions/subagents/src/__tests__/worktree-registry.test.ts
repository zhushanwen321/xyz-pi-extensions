// src/__tests__/worktree-registry.test.ts
//
// WorktreeRegistry 单元测试。
// 用真实 tmpdir 做文件 IO（不 mock fs），验证：
//   - add/updatePid/remove/load 语义
//   - 同 branch 覆盖（去重）
//   - 文件不存在 / 损坏 / IO 错误的降级
//   - 原子写（.tmp → rename）

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SPAWN_GRACE_MS, type WorktreeEntry,WorktreeRegistry } from "../runtime/worktree-registry.ts";

const REPO_A = "/home/user/repo-a";
const REPO_B = "/home/user/repo-b";

function makeEntry(overrides: Partial<WorktreeEntry> = {}): WorktreeEntry {
  return {
    repo: REPO_A,
    branch: "pi-sub-bg-1",
    checkout: path.join(os.tmpdir(), "pi-sub-bg-1"),
    pid: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("WorktreeRegistry", () => {
  let tmpAgentDir: string;
  let registry: WorktreeRegistry;
  let registryFile: string;

  beforeEach(() => {
    tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-registry-test-"));
    registry = new WorktreeRegistry(tmpAgentDir);
    registryFile = path.join(tmpAgentDir, "subagents", "worktrees.json");
  });

  afterEach(() => {
    fs.rmSync(tmpAgentDir, { recursive: true, force: true });
  });

  describe("add + load", () => {
    it("add 后 load 能读到", () => {
      const entry = makeEntry();
      registry.add(entry);
      const loaded = registry.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0]).toEqual(entry);
    });

    it("多条目跨 repo 共存", () => {
      const entryA = makeEntry({ repo: REPO_A, branch: "pi-sub-bg-1" });
      const entryB = makeEntry({ repo: REPO_B, branch: "pi-sub-bg-2" });
      registry.add(entryA);
      registry.add(entryB);
      const loaded = registry.load();
      expect(loaded).toHaveLength(2);
    });

    it("同 branch add 覆盖（去重）", () => {
      const entry = makeEntry({ pid: 0 });
      registry.add(entry);
      // 同 branch 再次 add（覆盖）
      const updated = makeEntry({ pid: 999 });
      registry.add(updated);
      const loaded = registry.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].pid).toBe(999);
    });
  });

  describe("updatePid", () => {
    it("补全 pid（create 占位 → first header 补全）", () => {
      registry.add(makeEntry({ branch: "pi-sub-bg-1", pid: 0 }));
      registry.updatePid("pi-sub-bg-1", 12345);
      const loaded = registry.load();
      expect(loaded[0].pid).toBe(12345);
    });

    it("branch 不存在时忽略（幂等）", () => {
      registry.add(makeEntry({ branch: "pi-sub-bg-1" }));
      registry.updatePid("pi-sub-nonexistent", 12345);
      const loaded = registry.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].pid).toBe(0); // 原条目未变
    });

    it("update 不改变其他字段", () => {
      const entry = makeEntry({ branch: "pi-sub-bg-1", repo: REPO_A, checkout: "/tmp/x" });
      registry.add(entry);
      registry.updatePid("pi-sub-bg-1", 999);
      const loaded = registry.load();
      expect(loaded[0].repo).toBe(REPO_A);
      expect(loaded[0].checkout).toBe("/tmp/x");
      expect(loaded[0].branch).toBe("pi-sub-bg-1");
    });
  });

  describe("remove", () => {
    it("移除指定 branch", () => {
      registry.add(makeEntry({ branch: "pi-sub-bg-1" }));
      registry.add(makeEntry({ branch: "pi-sub-bg-2" }));
      registry.remove("pi-sub-bg-1");
      const loaded = registry.load();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].branch).toBe("pi-sub-bg-2");
    });

    it("branch 不存在时忽略（幂等）", () => {
      registry.add(makeEntry({ branch: "pi-sub-bg-1" }));
      registry.remove("pi-sub-nonexistent");
      expect(registry.load()).toHaveLength(1);
    });

    it("空注册表 remove 不报错", () => {
      expect(() => registry.remove("pi-sub-anything")).not.toThrow();
    });
  });

  describe("降级与健壮性", () => {
    it("文件不存在时 load 返回空数组", () => {
      expect(registry.load()).toEqual([]);
    });

    it("损坏 JSON 时 load 返回空数组", () => {
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      fs.writeFileSync(registryFile, "{ not valid json }}}", "utf-8");
      expect(registry.load()).toEqual([]);
    });

    it("entries 字段缺失时 load 返回空数组", () => {
      fs.mkdirSync(path.dirname(registryFile), { recursive: true });
      fs.writeFileSync(registryFile, '{"other": 123}', "utf-8");
      expect(registry.load()).toEqual([]);
    });

    it("save 创建不存在的父目录", () => {
      // registryFile 在 tmpAgentDir/subagents/ 下，subagents 目录不存在
      expect(fs.existsSync(path.dirname(registryFile))).toBe(false);
      registry.add(makeEntry());
      expect(fs.existsSync(registryFile)).toBe(true);
    });

    it("save 后无残留 .tmp 文件（原子写）", () => {
      registry.add(makeEntry());
      const tmpFile = `${registryFile}.tmp`;
      expect(fs.existsSync(tmpFile)).toBe(false);
    });
  });

  describe("SPAWN_GRACE_MS 常量", () => {
    it("值为 60s", () => {
      expect(SPAWN_GRACE_MS).toBe(60_000);
    });
  });
});
