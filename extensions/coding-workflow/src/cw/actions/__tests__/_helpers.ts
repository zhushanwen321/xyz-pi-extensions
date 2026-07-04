/**
 * Wave 3 action 测试共享 helpers。
 *
 * 不以 .test.ts 结尾，vitest include（*.test.ts）不会把它当测试文件跑，仅供 import。
 *
 * Mock 策略参照 gates.test.ts：真实 CwStore（临时 db 文件）+ vi.spyOn 原型方法控制
 * GateRunner.runCheck / GitValidator.validate（类型安全，无 unsafe cast）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, vi } from "vitest";

import { GateRunner, GitValidator } from "../../gates.js";
import { CwStore } from "../../store.js";
import type { ActionDeps, CwTopic, TestCaseSeed, WaveSeed } from "../../types.js";

// ── 临时目录管理 ─────────────────────────────────────────────

const tmpDirsToClean: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (tmpDirsToClean.length > 0) {
    const d = tmpDirsToClean.pop();
    try {
      rmSync(d!, { recursive: true, force: true });
    } catch (e) {
      void e; // best-effort：tmp 目录由 OS 兜底
    }
  }
});

/** 建一个临时目录（含 _cw.db + changes/ 子目录），返回绝对路径。 */
export function makeTmpWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-action-test-"));
  tmpDirsToClean.push(dir);
  mkdirSync(join(dir, "changes"), { recursive: true });
  return dir;
}

// ── deps 构造 ────────────────────────────────────────────────

/** 用真实 CwStore + 真实 GateRunner/GitValidator 构造 ActionDeps（mock 由测试 spyOn 控制）。 */
export function makeDeps(workspacePath: string): { deps: ActionDeps; store: CwStore } {
  const store = new CwStore(join(workspacePath, "_cw.db"));
  const deps: ActionDeps = {
    store,
    git: new GitValidator(workspacePath),
    runner: new GateRunner(workspacePath),
    workspacePath,
    topicDir: workspacePath,
  };
  return { deps, store };
}

/** 关掉 store 连接（测试结束前调用，释放 sqlite 句柄）。 */
export function closeStore(store: CwStore): void {
  store.close();
}

// ── store 种子（直接构造前置状态，绕过未实现的 dev/test action） ──

/** 插入一个最小 topic，返回 topicId。 */
export function seedTopic(
  store: CwStore,
  overrides: Partial<CwTopic> & { topicId: string; slug: string; tier: "lite" | "mid" },
): string {
  const topic: CwTopic = {
    schemaVersion: 1,
    objective: "test objective",
    workspacePath: "/tmp/ws",
    createdAt: "2026-07-04T00:00:00.000Z",
    status: "created",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    ...overrides,
  };
  store.transaction(() => store.insertTopic(topic));
  return topic.topicId;
}

// ── verdict 常量（GateRunner.runCheck mock 返回值用） ─────────

export const PASS_CHECK = { passed: true, report: "[plan] machine check: 5/5 passed → PASS" };
export const FAIL_CHECK = {
  passed: false,
  report: "[issues] machine check: 3/5 passed → FAIL",
};

// ── JSON fixtures（合法结构，参照 plan-parser.test.ts） ──────

export function makeLitePlan(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: "lite",
    objective: "build demo feature",
    waves: [
      { id: "W1", changes: ["src/a.ts"], dependsOn: [] },
      { id: "W2", changes: ["src/b.ts"], dependsOn: ["W1"], parallelGroup: "g1" },
    ],
    testCases: [
      {
        id: "E1",
        layer: "real",
        scenario: "用户登录",
        steps: "打开 /login → 提交",
        expected: { url: "/dashboard", text: "欢迎" },
        executor: "vitest",
      },
    ],
    ...overrides,
  };
}

export function makeMidClarify(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: "mid-clarify",
    objective: "mid 需求 + 架构",
    deliverables: {
      requirements: "requirements.md",
      systemArchitecture: "system-architecture.md",
    },
    ...overrides,
  };
}

export function makeMidDetail(overrides: Record<string, unknown> = {}): unknown {
  return {
    format: "mid-detail",
    objective: "mid 详细设计",
    waves: [{ id: "W1", issues: ["#3", "#4"], dependsOn: [] }],
    testCases: [
      {
        id: "T1.1",
        layer: "integration",
        scenario: "gate 串行",
        steps: "跑 4 checker",
        assertion: "任一 fail 则 fail-fast",
        executor: "vitest",
      },
    ],
    deliverables: {
      issues: "issues.md",
      nonFunctional: "non-functional-design.md",
      codeArchitecture: "code-architecture.md",
      executionPlan: "execution-plan.md",
    },
    ...overrides,
  };
}

// ── review 桩文件写入（#7 预检命中时需要这些文件存在才能跑 gate） ──

/** 在 workspace/changes/ 下写 review-{slug}.md 桩文件（内容非空即可通过预检）。 */
export function writeReviewStubs(workspacePath: string, slugs: readonly string[]): void {
  for (const slug of slugs) {
    writeFileSync(
      join(workspacePath, "changes", `review-${slug}.md`),
      `---\nverdict: APPROVED\n---\nreview stub for ${slug}\n`,
    );
  }
}

// ── developed 前置态（test action 前置，Wave 4） ─────────────

/**
 * 构造 developed 态 topic + 全 Wave committed + testCases（test action 前置）。
 *
 * 模拟 dev action 跑完的稳定态：status=developed、gatePassed.dev=true、所有 wave 已
 * setWaveCommitted。这样 test action 的第二重 checkPhaseCascade（requirePhaseComplete=dev）
 * 与第三重 checkCacheConsistency（gatePassed.dev 缓存 vs 重算）都能通过。
 *
 * 不写 gatePassed.test（让第三重只校验 dev 这一个 key；test 由 handleTest 事务内首次写入）。
 */
export function seedDevelopedTopic(
  store: CwStore,
  opts: {
    topicId: string;
    slug: string;
    tier: "lite" | "mid";
    waves: WaveSeed[];
    testCases: TestCaseSeed[];
  },
): string {
  seedTopic(store, {
    topicId: opts.topicId,
    slug: opts.slug,
    tier: opts.tier,
    status: "developed",
    gatePassed: { dev: true },
  });
  store.transaction(() => {
    store.insertWaves(opts.topicId, opts.waves);
    for (const w of opts.waves) {
      store.setWaveCommitted(opts.topicId, w.id, `commit-${w.id}`);
    }
    store.insertTestCases(opts.topicId, opts.testCases);
  });
  return opts.topicId;
}

/** 占位引用，防 ts 未使用 import 警告（DatabaseSync 在种子辅助里可能被未来扩展使用）。 */
void DatabaseSync;
