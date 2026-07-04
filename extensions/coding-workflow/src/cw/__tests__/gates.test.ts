/**
 * gates.test.ts — gate 注册表 + runGate 执行器 + GateRunner/GitValidator adapter（Wave 2，#4/#6/#3）。
 *
 * Mock 层：spawnSync / execFileSync 被 vi.mock 桩掉（不真跑 python / git）。
 * 覆盖来源 A + 来源 B 用例：
 *   T2.5       gate fail → runGate 返 passed:false（status 不由 gate 层碰；fail-fast）
 *   T2.7       mid detail 4 checker 串行 fail-fast（剩余 checker 不执行）
 *   T2.15      git ENOENT → infra-error throw vs commit 无效 → {valid:false} 业务 fail
 *   T2.19      topicDir 路径遍历拒（.. / 绝对路径）
 *   T2.20/T2.21c  subprocess 超时 kill（SIGTERM）→ infraError
 *   T2.21a     verdict/exitcode 矛盾 → infraError
 *   T2.21b     python ENOENT（status=null）→ infraError
 *   T2.22      check 脚本 verdict 行格式契约 pin
 *   T2.23      infra（infraError 置位）vs 业务 fail（report，无 infraError）可区分
 *   另含 GATE_REGISTRY 完整性 + lookupGateTier + progressive gate 不跑 checker 的单测。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted 保证 mock 引用在 vi.mock 工厂（被 hoist 到 import 之前）里可用。
const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawnSync,
  execFileSync: mocks.execFileSync,
}));

import { execFileSync, spawnSync } from "node:child_process";

import {
  GATE_REGISTRY,
  type GateContext,
  GateRunner,
  GitValidator,
  lookupGateTier,
  runGate,
} from "../gates.js";
import type { CwTopic } from "../types.js";

// ── fixtures ─────────────────────────────────────────────────

/** 最小 CwTopic（runGate 不读 topic 字段，只需满足 GateContext 类型）。 */
function makeTopic(): CwTopic {
  return {
    schemaVersion: 1,
    topicId: "cw-demo",
    slug: "demo",
    tier: "lite",
    objective: "build X",
    workspacePath: "/tmp/ws",
    createdAt: "2026-07-04T00:00:00.000Z",
    status: "created",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
  };
}

function makeCtx(overrides: Partial<GateContext> = {}): GateContext {
  return {
    topic: makeTopic(),
    topicDir: "demo-topic",
    workspacePath: "/tmp/ws",
    runner: new GateRunner("/tmp/ws"),
    git: new GitValidator("/tmp/ws"),
    ...overrides,
  };
}

/** 构造 spawnSync 返回值（覆盖 GateRunner 读取的 status/signal/stdout/stderr）。 */
function spawnResult(opts: {
  status: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
}): unknown {
  const stdout = opts.stdout ?? "";
  const stderr = opts.stderr ?? "";
  return {
    status: opts.status,
    signal: opts.signal ?? null,
    stdout,
    stderr,
    pid: 12345,
    output: [null, stdout, stderr],
  };
}

const PASS_VERDICT = "[plan] machine check: 5/5 passed → PASS";
const FAIL_VERDICT = "[plan] machine check: 3/5 passed → FAIL";

/** 让 spawnSync 对所有调用返回同一结果（fail-fast 测试用 FAIL）。 */
function spawnAlways(result: unknown): void {
  mocks.spawnSync.mockImplementation(() => result);
}

// ── execFileSync 错误构造 ───────────────────────────────────

/** git 非零退出（业务 fail：commit 不存在/不属仓库/空）。 */
function gitExitError(status: number): Error {
  const e = new Error(`git exited ${status}`);
  Object.assign(e, { status });
  return e;
}

/** git 可执行文件缺失（基础设施异常，应 throw）。 */
function gitEnoentError(): Error {
  const e = new Error("spawn git ENOENT");
  Object.assign(e, { code: "ENOENT" });
  return e;
}

beforeEach(() => {
  mocks.spawnSync.mockReset();
  mocks.execFileSync.mockReset();
});

// ── GATE_REGISTRY 完整性 ────────────────────────────────────

describe("GATE_REGISTRY", () => {
  it("§5.2 的 11 行表 1:1 编码", () => {
    expect(GATE_REGISTRY).toHaveLength(11);
    // lite 5 行 + mid 6 行
    const lite = GATE_REGISTRY.filter((r) => r.tier === "lite");
    const mid = GATE_REGISTRY.filter((r) => r.tier === "mid");
    expect(lite).toHaveLength(5);
    expect(mid).toHaveLength(6);
  });

  it("mid detail 含 4 个 checker（check_issues/nfr/code_arch/execution）", () => {
    const detail = GATE_REGISTRY.find((r) => r.tier === "mid" && r.phase === "detail");
    expect(detail).toBeDefined();
    expect(detail!.checkers).toHaveLength(4);
  });

  it("progressive gate（dev/test）checkers 空", () => {
    for (const phase of ["dev", "test"] as const) {
      const liteDev = GATE_REGISTRY.find((r) => r.tier === "lite" && r.phase === phase);
      expect(liteDev!.progressive).toBe(true);
      expect(liteDev!.checkers).toHaveLength(0);
    }
  });
});

// ── lookupGateTier（progressive 透传 gateTier） ──────────────

describe("lookupGateTier", () => {
  it("lite dev → medium-git", () => {
    expect(lookupGateTier("lite", "dev")).toBe("medium-git");
  });
  it("lite test → strong-recompute", () => {
    expect(lookupGateTier("lite", "test")).toBe("strong-recompute");
  });
  it("mid test → medium-coverage", () => {
    expect(lookupGateTier("mid", "test")).toBe("medium-coverage");
  });
  it("未知 (tier,phase) → throw", () => {
    expect(() => lookupGateTier("mid", "plan")).toThrow(/no gate rule/);
  });
});

// ── runGate ──────────────────────────────────────────────────

describe("runGate", () => {
  it("progressive gate（dev）不跑 checker，直接返 gateTier + passed", () => {
    const ctx = makeCtx();
    const result = runGate(ctx, "lite", "dev");
    expect(result.passed).toBe(true);
    expect(result.gateTier).toBe("medium-git");
    expect(result.reports).toHaveLength(0);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("T2.5 — 单 checker gate fail（check_plan FAIL）→ passed:false；status 不由 gate 层碰", () => {
    spawnAlways(spawnResult({ status: 1, stdout: FAIL_VERDICT }));
    const ctx = makeCtx();
    const before = ctx.topic.status;
    const result = runGate(ctx, "lite", "plan");
    expect(result.passed).toBe(false);
    expect(result.gateTier).toBe("weak-structural");
    expect(result.reports).toHaveLength(1);
    expect(result.reports[0]!.passed).toBe(false);
    // gate 层不碰 topic.status（status 由 action handler 在 Wave 3 改）
    expect(ctx.topic.status).toBe(before);
  });

  it("单 checker gate pass（check_plan PASS）→ passed:true + report", () => {
    spawnAlways(spawnResult({ status: 0, stdout: PASS_VERDICT }));
    const ctx = makeCtx();
    const result = runGate(ctx, "lite", "plan");
    expect(result.passed).toBe(true);
    expect(result.reports[0]!.passed).toBe(true);
    expect(result.reports[0]!.report).toContain("PASS");
  });

  it("T2.7 — mid detail 4 checker 串行 fail-fast（首个 fail 则剩余不跑）", () => {
    spawnAlways(spawnResult({ status: 1, stdout: FAIL_VERDICT }));
    const ctx = makeCtx();
    const result = runGate(ctx, "mid", "detail");
    expect(result.passed).toBe(false);
    // fail-fast：只跑了第 1 个 checker（check_issues.py）
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    const firstCallArgs = mocks.spawnSync.mock.calls[0]!;
    // spawnSync("python3", [scriptPath, topicDir], options) — args[1][0] = scriptPath
    expect((firstCallArgs[1] as string[])[0]).toBe("check_issues.py");
    expect(result.reports).toHaveLength(1);
  });

  it("mid detail 全 checker pass → passed:true（4 个都跑）", () => {
    spawnAlways(spawnResult({ status: 0, stdout: PASS_VERDICT }));
    const ctx = makeCtx();
    const result = runGate(ctx, "mid", "detail");
    expect(result.passed).toBe(true);
    expect(mocks.spawnSync).toHaveBeenCalledTimes(4);
  });
});

// ── GateRunner（subprocess adapter，#6） ─────────────────────

describe("GateRunner.runCheck", () => {
  const runner = new GateRunner("/tmp/ws");

  it("T2.22 — verdict 行格式契约：`machine check: N/M passed → PASS` 解析为 pass", () => {
    mocks.spawnSync.mockReturnValue(
      spawnResult({ status: 0, stdout: `some log\n${PASS_VERDICT}\n` }),
    );
    const out = runner.runCheck("check_plan.py", "demo-topic");
    expect(out.passed).toBe(true);
    expect(out.report).toBe(PASS_VERDICT);
    expect(out.infraError).toBeUndefined();
  });

  it("T2.22 — verdict 格式改变（无 machine check 行）→ 解析断，infraError", () => {
    mocks.spawnSync.mockReturnValue(
      spawnResult({ status: 0, stdout: "all good, no verdict line here\n" }),
    );
    const out = runner.runCheck("check_plan.py", "demo-topic");
    expect(out.passed).toBe(false);
    expect(out.infraError).toBeTruthy();
  });

  it("业务 fail：exit 1 + verdict FAIL → passed:false + report，无 infraError", () => {
    mocks.spawnSync.mockReturnValue(spawnResult({ status: 1, stdout: FAIL_VERDICT }));
    const out = runner.runCheck("check_issues.py", "demo-topic");
    expect(out.passed).toBe(false);
    expect(out.report).toBe(FAIL_VERDICT);
    expect(out.infraError).toBeUndefined();
  });

  it("T2.21a — verdict/exitcode 矛盾（exit0 但 verdict FAIL）→ infraError", () => {
    mocks.spawnSync.mockReturnValue(spawnResult({ status: 0, stdout: FAIL_VERDICT }));
    const out = runner.runCheck("check_plan.py", "demo-topic");
    expect(out.passed).toBe(false);
    expect(out.infraError).toMatch(/contradiction/i);
  });

  it("T2.21a 镜像 — exit1 但 verdict PASS → infraError", () => {
    mocks.spawnSync.mockReturnValue(spawnResult({ status: 1, stdout: PASS_VERDICT }));
    const out = runner.runCheck("check_plan.py", "demo-topic");
    expect(out.passed).toBe(false);
    expect(out.infraError).toMatch(/contradiction/i);
  });

  it("T2.21b — python ENOENT（status=null，无 signal）→ infraError", () => {
    mocks.spawnSync.mockReturnValue(spawnResult({ status: null, stderr: "python3 not found" }));
    const out = runner.runCheck("check_plan.py", "demo-topic");
    expect(out.passed).toBe(false);
    expect(out.infraError).toBeTruthy();
  });

  it("T2.20 / T2.21c — subprocess 超时 kill（SIGTERM，status=null）→ infraError", () => {
    mocks.spawnSync.mockReturnValue(
      spawnResult({ status: null, signal: "SIGTERM", stderr: "timed out" }),
    );
    const out = runner.runCheck("check_plan.py", "demo-topic");
    expect(out.passed).toBe(false);
    expect(out.infraError).toMatch(/SIGTERM|timeout|crash/i);
  });

  it("T2.19 — topicDir 含 .. 段 → 拒（infraError，不 spawn）", () => {
    const out = runner.runCheck("check_plan.py", "../../etc/passwd");
    expect(out.passed).toBe(false);
    expect(out.infraError).toMatch(/traversal|\.\./i);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("T2.19 — topicDir 绝对路径 → 拒", () => {
    const out = runner.runCheck("check_plan.py", "/etc/passwd");
    expect(out.passed).toBe(false);
    expect(out.infraError).toMatch(/traversal|absolute/i);
    expect(mocks.spawnSync).not.toHaveBeenCalled();
  });

  it("T2.23 — infra 场景（status=null）与业务 fail（exit1+FAIL）在 CheckOutput 可区分", () => {
    mocks.spawnSync.mockReturnValue(spawnResult({ status: null }));
    const infra = runner.runCheck("check_plan.py", "demo-topic");
    expect(infra.infraError).toBeDefined();
    expect(infra.report).toBeUndefined();

    mocks.spawnSync.mockReturnValue(spawnResult({ status: 1, stdout: FAIL_VERDICT }));
    const business = runner.runCheck("check_plan.py", "demo-topic");
    expect(business.infraError).toBeUndefined();
    expect(business.report).toBeDefined();
  });
});

// ── GitValidator（execFileSync adapter，#3） ─────────────────

describe("GitValidator.validate", () => {
  /**
   * 装配 execFileSync mock：按 git 子命令分发。
   * missing/notAncestor/empty 控制三项校验各自是否 throw（业务 fail）。
   */
  function mockGit(opts: {
    catFileThrows?: boolean;
    mergeBaseThrows?: boolean;
    diffTreeOutput?: string;
    enoent?: boolean;
  }): void {
    mocks.execFileSync.mockImplementation((cmd: string, args: readonly string[]) => {
      if (opts.enoent) throw gitEnoentError();
      const sub = args[0];
      if (sub === "cat-file") {
        if (opts.catFileThrows) throw gitExitError(128);
        return "";
      }
      if (sub === "merge-base") {
        if (opts.mergeBaseThrows) throw gitExitError(1);
        return "";
      }
      if (sub === "diff-tree") {
        return opts.diffTreeOutput ?? "";
      }
      throw new Error(`unexpected git subcommand: ${sub}`);
    });
  }

  it("合法 commit（三项全过）→ valid:true", () => {
    mockGit({ diffTreeOutput: " 1 file changed, 2 insertions(+)\n" });
    const v = new GitValidator("/tmp/ws").validate("abc1234");
    expect(v.exists).toBe(true);
    expect(v.inRepo).toBe(true);
    expect(v.nonEmpty).toBe(true);
    expect(v.valid).toBe(true);
    expect(v.reason).toBeUndefined();
  });

  it("T2.15 — commit 不存在（cat-file 非零退出）→ exists:false, valid:false，不 throw", () => {
    mockGit({ catFileThrows: true, diffTreeOutput: " 1 file changed\n" });
    const v = new GitValidator("/tmp/ws").validate("deadbee");
    expect(v.exists).toBe(false);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/cat-file/);
  });

  it("commit 不属仓库（merge-base 非零）→ inRepo:false, valid:false", () => {
    mockGit({ mergeBaseThrows: true, diffTreeOutput: " 1 file changed\n" });
    const v = new GitValidator("/tmp/ws").validate("abc1234");
    expect(v.inRepo).toBe(false);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/merge-base/);
  });

  it("空 commit（diff-tree 空输出，--allow-empty）→ nonEmpty:false, valid:false", () => {
    mockGit({ diffTreeOutput: "" });
    const v = new GitValidator("/tmp/ws").validate("abc1234");
    expect(v.nonEmpty).toBe(false);
    expect(v.valid).toBe(false);
    expect(v.reason).toMatch(/empty/);
  });

  it("T2.15 — git ENOENT（可执行文件缺失）→ throw infra-error，不是业务 fail", () => {
    mockGit({ enoent: true });
    expect(() => new GitValidator("/tmp/ws").validate("abc1234")).toThrow(/ENOENT|git/);
  });
});

// 防未使用 import 警告（spawnSync/execFileSync 通过 mocks 操作，此处仅占位引用）。
void spawnSync;
void execFileSync;
