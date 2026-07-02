// test-orchestrator 单测 — 4 action 集成 + 机器重算 status + 两道关。
//
// 覆盖维度：
//   - judgeByExpected（机器重算：exact match，AI 摸不到判定逻辑）
//   - init（解析 plan → session）
//   - get（pending → in-progress 推进）
//   - complete（核心：截图校验 + 机器重算 + AI claimedStatus 丢弃）
//   - get-result（收尾门：全覆盖 + 全 pass 才放行）
//   - 两道关（schema 强制 + 运行时校验）
//
// fs 用 vi.mock 桩：避免真实文件依赖，截图校验由 mock 控制 existsSync 返回值。

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { judgeByExpected, registerTestOrchestratorTool } from "../test-orchestrator/index.js";
import { type Actual, type Expected } from "../test-orchestrator/state.js";

// ── fs mock ──────────────────────────────────────────────────

// 桩文件系统：existsSync 查 files Set，readFileSync 查 content Map。
// vi.mock 自动 hoist 到所有 import 之前，所以 nodeFs 拿到的是 mock。
const mockFiles = new Set<string>();
const mockContent = new Map<string, string>();

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn((p: string) => mockFiles.has(p)),
    readFileSync: vi.fn((p: string) => {
      if (!mockContent.has(p)) throw new Error(`mock: ${p} not found`);
      return mockContent.get(p);
    }),
  },
}));

// ── helpers ──────────────────────────────────────────────────

/** 构造最小 plan.md（含 1 条 E2E 用例）。 */
function makePlan(cases: Array<{ id: string; layer?: string; expected?: string }>): string {
  const rows = cases
    .map(
      (c) =>
        `| ${c.id} | 场景 | ${c.layer ?? "mock"} | - | - | ${c.expected ?? "url=/profile"} | vitest |`,
    )
    .join("\n");
  return [
    "# Plan",
    "",
    "## E2E 用例清单",
    "",
    "| 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |",
    "|--------|------|--------|------|------|------|---------|",
    rows,
    "",
  ].join("\n");
}

/** 注册 tool 并返回 store + 一个调用入口（绕过 typebox 校验直接进 dispatch）。 */
function setup() {
  const pi = { registerTool: vi.fn() } as unknown as ExtensionAPI;
  // registerTestOrchestratorTool 内部用闭包 store，测试通过注册时传入的 pi 拿到 execute
  registerTestOrchestratorTool(pi);
  const registerCall = (pi.registerTool as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
    execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  };
  if (!registerCall) throw new Error("registerTool not called");
  return { execute: registerCall.execute, pi };
}

/** 调用 execute（async）。 */
async function call(
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  }>,
  params: Record<string, unknown>,
) {
  return execute("t1", params);
}

beforeEach(() => {
  mockFiles.clear();
  mockContent.clear();
});

// ── judgeByExpected（核心：机器重算 status） ─────────────────

describe("judgeByExpected — 机器重算（AI 摸不到判定逻辑）", () => {
  it("expected.url 匹配 → passed", () => {
    const expected: Expected = { url: "/profile" };
    const actual: Actual = { url: "/profile" };
    expect(judgeByExpected(expected, actual)).toEqual({ status: "passed", reason: "" });
  });

  it("expected.url 不匹配 → failed + 逐字段原因", () => {
    const expected: Expected = { url: "/profile" };
    const actual: Actual = { url: "/login" };
    const r = judgeByExpected(expected, actual);
    expect(r.status).toBe("failed");
    expect(r.reason).toContain('url: "/login" !== "/profile"');
  });

  it("expected.url 存在但 actual.url 缺失 → failed", () => {
    const expected: Expected = { url: "/profile" };
    const actual: Actual = {};
    const r = judgeByExpected(expected, actual);
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("url missing");
  });

  it("expected.text 匹配 → passed", () => {
    const expected: Expected = { text: "用户名" };
    const actual: Actual = { text: "用户名" };
    expect(judgeByExpected(expected, actual)).toEqual({ status: "passed", reason: "" });
  });

  it("url + text 都存在，全匹配 → passed", () => {
    const expected: Expected = { url: "/profile", text: "用户名" };
    const actual: Actual = { url: "/profile", text: "用户名" };
    expect(judgeByExpected(expected, actual).status).toBe("passed");
  });

  it("url 匹配但 text 不匹配 → failed（逐字段独立判定）", () => {
    const expected: Expected = { url: "/profile", text: "用户名" };
    const actual: Actual = { url: "/profile", text: "错误" };
    const r = judgeByExpected(expected, actual);
    expect(r.status).toBe("failed");
    expect(r.reason).toContain('text: "错误" !== "用户名"');
    expect(r.reason).not.toContain("url"); // url 那条不该出现在 mismatch
  });

  it("expected 无任何字段 → failed（兜底，plan-parser 应已拦）", () => {
    const r = judgeByExpected({}, { url: "/x" });
    expect(r.status).toBe("failed");
    expect(r.reason).toMatch(/no judgeable field/);
  });

  it("exact match——URL 末尾斜杠差异也算不匹配", () => {
    const expected: Expected = { url: "/profile" };
    const actual: Actual = { url: "/profile/" };
    expect(judgeByExpected(expected, actual).status).toBe("failed");
  });
});

// ── init ─────────────────────────────────────────────────────

describe("action: init", () => {
  it("解析 plan → 返回 sessionId + cases", async () => {
    const plan = makePlan([{ id: "E1" }, { id: "E2", expected: "text=成功" }]);
    mockContent.set("/tmp/plan.md", plan);
    const { execute } = setup();

    const r = await call(execute, { action: "init", planPath: "/tmp/plan.md" });

    expect(r.details.sessionId).toMatch(/^to-/);
    expect(r.details.cases).toHaveLength(2);
    expect(r.details.parsedCount).toBe(2);
  });

  it("planPath 缺失 → throw", async () => {
    const { execute } = setup();
    await expect(call(execute, { action: "init" })).rejects.toThrow(/planPath/);
  });

  it("文件不存在 → throw", async () => {
    const { execute } = setup();
    await expect(
      call(execute, { action: "init", planPath: "/tmp/nope.md" }),
    ).rejects.toThrow(/cannot read plan/);
  });

  it("plan 无 E2E 用例 → throw", async () => {
    mockContent.set("/tmp/empty.md", "# Plan\n无 E2E");
    const { execute } = setup();
    await expect(
      call(execute, { action: "init", planPath: "/tmp/empty.md" }),
    ).rejects.toThrow(/no E2E cases/);
  });
});

// ── get ──────────────────────────────────────────────────────

describe("action: get", () => {
  it("返回第一个 pending 用例 + 标记 in-progress", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }, { id: "E2" }]));
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;

    const r = await call(execute, { action: "get", sessionId: sid });

    const next = r.details.nextCase as { id: string; status: string };
    expect(next.id).toBe("E1");
    expect(next.status).toBe("in-progress");
  });

  it("第二次 get 返回下一个 pending（E1 已 in-progress）", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }, { id: "E2" }]));
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;

    await call(execute, { action: "get", sessionId: sid });
    const r2 = await call(execute, { action: "get", sessionId: sid });

    expect((r2.details.nextCase as { id: string }).id).toBe("E2");
  });

  it("无 pending + 有 in-progress → message 提示先 complete", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }]));
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    await call(execute, { action: "get", sessionId: sid }); // E1 → in-progress

    const r = await call(execute, { action: "get", sessionId: sid });

    expect(r.details.nextCase).toBeNull();
    expect(r.details.message as string).toMatch(/in-progress.*complete/);
  });

  it("全终态 → message 提示调 get-result", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }]));
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    mockFiles.add("/tmp/shot.png");
    await call(execute, { action: "get", sessionId: sid });
    await call(execute, {
      action: "complete",
      sessionId: sid,
      caseId: "E1",
      actual: { url: "/profile" },
      screenshotPath: "/tmp/shot.png",
    });

    const r = await call(execute, { action: "get", sessionId: sid });

    expect(r.details.nextCase).toBeNull();
    expect(r.details.message as string).toMatch(/get-result/);
  });

  it("sessionId 不存在 → throw", async () => {
    const { execute } = setup();
    await expect(
      call(execute, { action: "get", sessionId: "bogus" }),
    ).rejects.toThrow(/session not found/);
  });
});

// ── complete（核心：机器重算 + 两道关） ─────────────────────

describe("action: complete — 机器重算 + AI claimedStatus 丢弃", () => {
  it("actual 匹配 expected → passed，AI 的 claimedStatus=passed 也存但非判定依据", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1", expected: "url=/profile" }]));
    mockFiles.add("/tmp/shot.png");
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    await call(execute, { action: "get", sessionId: sid });

    const r = await call(execute, {
      action: "complete",
      sessionId: sid,
      caseId: "E1",
      actual: { url: "/profile" },
      screenshotPath: "/tmp/shot.png",
      claimedStatus: "passed",
    });

    expect(r.details.machineVerdict).toBe("passed");
    const completed = r.details.completedCase as { status: string; claimedStatus?: string };
    expect(completed.status).toBe("passed");
    expect(completed.claimedStatus).toBe("passed");
  });

  it("actual 不匹配 → failed，即使 AI 填 claimedStatus=passed", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1", expected: "url=/profile" }]));
    mockFiles.add("/tmp/shot.png");
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    await call(execute, { action: "get", sessionId: sid });

    const r = await call(execute, {
      action: "complete",
      sessionId: sid,
      caseId: "E1",
      actual: { url: "/login" }, // 不匹配
      screenshotPath: "/tmp/shot.png",
      claimedStatus: "passed", // AI 谎报——机器重算覆盖
    });

    expect(r.details.machineVerdict).toBe("failed");
    expect(r.details.failureReason as string).toContain("url");
    const completed = r.details.completedCase as { status: string };
    expect(completed.status).toBe("failed");
  });

  it("关 1：screenshotPath 文件不存在 → throw（防假截图路径）", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }]));
    // 不加 /tmp/shot.png 到 mockFiles
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    await call(execute, { action: "get", sessionId: sid });

    await expect(
      call(execute, {
        action: "complete",
        sessionId: sid,
        caseId: "E1",
        actual: { url: "/profile" },
        screenshotPath: "/tmp/nonexistent.png",
      }),
    ).rejects.toThrow(/screenshot not found/);
  });

  it("关 1：缺 actual 参数 → throw（运行时 requireParam 拒收残缺上报）", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }]));
    mockFiles.add("/tmp/shot.png");
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    await call(execute, { action: "get", sessionId: sid });

    await expect(
      call(execute, {
        action: "complete",
        sessionId: sid,
        caseId: "E1",
        // actual 缺失
        screenshotPath: "/tmp/shot.png",
      }),
    ).rejects.toThrow(/missing required parameter: actual/);
  });

  it("关 1：缺 screenshotPath 参数 → throw（运行时 requireParam 拒收残缺上报）", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }]));
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    await call(execute, { action: "get", sessionId: sid });

    await expect(
      call(execute, {
        action: "complete",
        sessionId: sid,
        caseId: "E1",
        actual: { url: "/profile" },
        // screenshotPath 缺失
      }),
    ).rejects.toThrow(/missing required parameter: screenshotPath/);
  });

  it("关 1：缺 caseId 参数 → throw（运行时 requireParam 拒收残缺上报）", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }]));
    mockFiles.add("/tmp/shot.png");
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    await call(execute, { action: "get", sessionId: sid });

    await expect(
      call(execute, {
        action: "complete",
        sessionId: sid,
        // caseId 缺失
        actual: { url: "/profile" },
        screenshotPath: "/tmp/shot.png",
      }),
    ).rejects.toThrow(/missing required parameter: caseId/);
  });

  it("caseId 不存在 → throw", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }]));
    mockFiles.add("/tmp/shot.png");
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;

    await expect(
      call(execute, {
        action: "complete",
        sessionId: sid,
        caseId: "EX",
        actual: { url: "/x" },
        screenshotPath: "/tmp/shot.png",
      }),
    ).rejects.toThrow(/case not found/);
  });

  it("重复 complete 终态用例 → throw（不可回退）", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }]));
    mockFiles.add("/tmp/shot.png");
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    await call(execute, { action: "get", sessionId: sid });
    await call(execute, {
      action: "complete",
      sessionId: sid,
      caseId: "E1",
      actual: { url: "/profile" },
      screenshotPath: "/tmp/shot.png",
    });

    await expect(
      call(execute, {
        action: "complete",
        sessionId: sid,
        caseId: "E1",
        actual: { url: "/profile" },
        screenshotPath: "/tmp/shot.png",
      }),
    ).rejects.toThrow(/already terminal/);
  });
});

// ── get-result（收尾门：防跳过） ────────────────────────────

describe("action: get-result — 收尾门（全覆盖 + 全 pass）", () => {
  it("全 passed → 放行，返回汇总", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }, { id: "E2", expected: "text=成功" }]));
    mockFiles.add("/tmp/s1.png");
    mockFiles.add("/tmp/s2.png");
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    await completeAll(execute, sid, [
      { id: "E1", actual: { url: "/profile" }, shot: "/tmp/s1.png" },
      { id: "E2", actual: { text: "成功" }, shot: "/tmp/s2.png" },
    ]);

    const r = await call(execute, { action: "get-result", sessionId: sid });

    expect(r.details.passed).toBe(true);
    expect(r.details.totalCases).toBe(2);
  });

  it("有 pending 未 complete → throw（防跳过：不能提前收尾）", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1" }, { id: "E2" }]));
    mockFiles.add("/tmp/s1.png");
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    // 只 complete E1，E2 留 pending
    await completeAll(execute, sid, [
      { id: "E1", actual: { url: "/profile" }, shot: "/tmp/s1.png" },
    ]);

    await expect(
      call(execute, { action: "get-result", sessionId: sid }),
    ).rejects.toThrow(/coverage gate FAILED/);
  });

  it("有 failed 用例 → throw（不能带伤收尾）", async () => {
    mockContent.set("/tmp/p.md", makePlan([{ id: "E1", expected: "url=/profile" }]));
    mockFiles.add("/tmp/s1.png");
    const { execute } = setup();
    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;
    await completeAll(execute, sid, [
      { id: "E1", actual: { url: "/wrong" }, shot: "/tmp/s1.png" }, // 故意失败
    ]);

    await expect(
      call(execute, { action: "get-result", sessionId: sid }),
    ).rejects.toThrow(/result gate FAILED/);
  });
});

// ── 完整流程集成 ─────────────────────────────────────────────

describe("完整流程：init → get*2 → complete*2 → get-result", () => {
  it("两用例全 pass 走完", async () => {
    mockContent.set(
      "/tmp/p.md",
      makePlan([
        { id: "E1", expected: "url=/profile, text=用户名" },
        { id: "E2", expected: "text=登出" },
      ]),
    );
    mockFiles.add("/tmp/s1.png");
    mockFiles.add("/tmp/s2.png");
    const { execute } = setup();

    const init = await call(execute, { action: "init", planPath: "/tmp/p.md" });
    const sid = init.details.sessionId as string;

    // E1
    const g1 = await call(execute, { action: "get", sessionId: sid });
    expect((g1.details.nextCase as { id: string }).id).toBe("E1");
    await call(execute, {
      action: "complete",
      sessionId: sid,
      caseId: "E1",
      actual: { url: "/profile", text: "用户名" },
      screenshotPath: "/tmp/s1.png",
    });

    // E2
    const g2 = await call(execute, { action: "get", sessionId: sid });
    expect((g2.details.nextCase as { id: string }).id).toBe("E2");
    await call(execute, {
      action: "complete",
      sessionId: sid,
      caseId: "E2",
      actual: { text: "登出" },
      screenshotPath: "/tmp/s2.png",
    });

    // 收尾
    const result = await call(execute, { action: "get-result", sessionId: sid });
    expect(result.details.passed).toBe(true);
    expect(result.details.totalCases).toBe(2);
  });
});

// ── helpers ──────────────────────────────────────────────────

/** 批量 complete：自动跳过 get（测试内已 init，直接 complete 多条）。 */
async function completeAll(
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  sessionId: string,
  items: Array<{ id: string; actual: Actual; shot: string }>,
): Promise<void> {
  for (const item of items) {
    await call(execute, {
      action: "get",
      sessionId,
    });
    await call(execute, {
      action: "complete",
      sessionId,
      caseId: item.id,
      actual: item.actual,
      screenshotPath: item.shot,
    });
  }
}
