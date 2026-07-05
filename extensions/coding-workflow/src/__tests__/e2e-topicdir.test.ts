// extensions/coding-workflow/src/__tests__/e2e-topicdir.test.ts
//
// E2E 集成测试（TEST-DIVERGENCE-01）：经 registerCodingWorkflowTool 注册的 tool execute()
// （composition root）跑全链路 create → plan，验证 plan gate 能找到 skill 约定位置的交付物。
//
// 背景：生产 index.ts execute() 当前设 topicDir=workspacePath（项目根），而 lite-plan skill 把
// plan.md 写到 .xyz-harness/{slug}/plan.md。runCheckPlan(topicDir) 在 topicDir 下直接找 plan.md
// → 生产 gate 永远找不到文件 → 全 fail。check 测试和 action 测试都绕开了 composition root
// （直接传临时目录当 topicDir / 把 deliverable 写进 workspacePath），所以这条 divergence 一直没被覆盖。
//
// 修复方向：CwTopic 加 topicDir 字段，create 时算 join(workspacePath,'.xyz-harness',slug) 存入，
// handlePlan 用 topic.topicDir 构造 GateContext（不再用 deps.topicDir）。
//
// ⚠️ 本测试在 topicDir 修复前为 RED（TDD 红灯），修复后转 GREEN。写成正常 it()——不 skip/fails：
//   - PASS 用例：修复前 runCheckPlan 在项目根找不到 plan.md → gate fail → 期望 pass → RED。
//     修复后 runCheckPlan 在 .xyz-harness/{slug}/ 找到合规 plan.md → gate pass → GREEN。
//   - 回归用例：plan.md 写在项目根（错误位置）。修复前 runCheckPlan 在项目根能找到 → gate pass →
//     期望 fail → RED。修复后 runCheckPlan 只看 .xyz-harness/{slug}/，项目根的文件被忽略 →
//     gate fail → GREEN。此用例专门防护「把 topicDir 退回 workspacePath」的回归。

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { registerCodingWorkflowTool } from "../index.js";
import type { ActionResult } from "../cw/types.js";

// ── execute 签名/返回类型 ────────────────────────────────────

type ExecuteResult = {
  content: Array<{ type: "text"; text: string }>;
  details: ActionResult;
};
type ExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
) => Promise<ExecuteResult>;

// ── ExtensionAPI mock（捕获 registerTool 注册的 execute） ─────
// 参照 sdk-contract.test.ts：Proxy 把未 override 的方法短路为 no-op。

function mockExtensionApi(overrides: Record<string, unknown>): ExtensionAPI {
  const noop = (): void => { /* test mock */ };
  return new Proxy<ExtensionAPI>(overrides as unknown as ExtensionAPI, {
    get(target, prop: string | symbol): unknown {
      if (prop in target) return target[prop as keyof ExtensionAPI];
      return noop;
    },
  });
}

/** 注册 tool 并捕获其 execute（= composition root 入口）。 */
function captureExecute(): ExecuteFn {
  let captured: ExecuteFn | undefined;
  const pi = mockExtensionApi({
    registerTool: (tool: { execute: ExecuteFn }): void => {
      captured = tool.execute;
    },
  });
  registerCodingWorkflowTool(pi);
  if (!captured) {
    throw new Error("registerCodingWorkflowTool did not register execute");
  }
  return captured;
}

// ── 合规 plan.md（抄自 checks/__tests__/check-plan.test.ts 的 writeValidPlan，已知 PASS） ──
// 6 必须章节 + 实现步骤标题 + Wave 表（含验收 Wave）+ 单测表 + E2E 表（测试层列 mock/real）+ 覆盖率 gate。

function writeValidPlanMd(topicDir: string): void {
  writeFileSync(join(topicDir, "plan.md"), [
    "# Plan",
    "## 业务目标",
    "构建用户登录功能",
    "",
    "## 技术改动点",
    "- 修改 src/auth/login.ts — 登录逻辑",
    "- 创建 src/auth/session.ts — 会话管理",
    "",
    "## Wave 拆分与依赖",
    "| Wave | 改动文件 | 依赖 | 并行组 | 说明 |",
    "|------|----------|------|--------|------|",
    "| W1 | src/auth/login.ts | W0 | G1 | 登录 |",
    "| W2 | src/auth/session.ts | W1 | G1 | 会话 |",
    "| W9 | src/auth/login.ts,src/auth/session.ts | W2 | - | 验收 |",
    "",
    "## 单测用例清单",
    "| 用例ID | 覆盖改动点 | 输入 | 预期 |",
    "|--------|-----------|------|------|",
    "| U1 | src/auth/login.ts:login | 输入合法账号 | 返回 token 字符串 |",
    "| U2 | src/auth/session.ts:create | 输入用户对象 | 返回 sessionId |",
    "",
    "## E2E 用例清单",
    "| 用例ID | 场景 | 测试层 | 说明 |",
    "|--------|------|--------|------|",
    "| E1 | 登录页跳转 | mock | 不依赖真实服务 |",
    "| E2 | 端到端登录 | real | 走真实后端 |",
    "",
    "## 覆盖率 gate",
    "gate 命令: pnpm vitest run --coverage",
    "阈值: 80%",
    "",
    "## 实现步骤",
    "1. 写单测",
    "2. 实现登录",
  ].join("\n"));
}

// ── 合规 planJson（LitePlanSchema 结构，CW 内部解析用，与 plan.md 独立） ──

function makeLitePlanJson(): Record<string, unknown> {
  return {
    format: "lite",
    objective: "构建用户登录功能",
    waves: [
      { id: "W1", changes: ["src/auth/login.ts"], dependsOn: [] },
      { id: "W2", changes: ["src/auth/session.ts"], dependsOn: ["W1"], parallelGroup: "G1" },
    ],
    testCases: [
      {
        id: "E1",
        layer: "real",
        scenario: "端到端登录",
        steps: "打开 /login → 提交",
        expected: { url: "/dashboard", text: "欢迎" },
        executor: "vitest",
      },
    ],
  };
}

// ── 临时 workspace 管理 ──────────────────────────────────────

const tmpWorkspaces: string[] = [];

afterEach(() => {
  while (tmpWorkspaces.length > 0) {
    const ws = tmpWorkspaces.pop()!;
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* best-effort：tmp 目录由 OS 兜底 */
    }
  }
});

/** 建临时项目根 + .xyz-harness/ 子目录（execute() 会 new CwStore(`${ws}/.xyz-harness/_cw.db`)）。 */
function makeTmpWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "cw-e2e-topicdir-"));
  tmpWorkspaces.push(ws);
  mkdirSync(join(ws, ".xyz-harness"), { recursive: true });
  return ws;
}

// ── 测试 ─────────────────────────────────────────────────────

describe("E2E topicDir（TEST-DIVERGENCE-01）— 经 execute() composition root 跑 plan gate", () => {
  it("plan.md 写在 .xyz-harness/{slug}/ 下 → plan gate PASS、status→planned、nextAction=dev", async () => {
    const execute = captureExecute();
    const ws = makeTmpWorkspace();
    const slug = "login-feature";

    // 模拟 lite-plan skill 行为：把 plan.md 写到 .xyz-harness/{slug}/plan.md（非项目根）
    const topicDir = join(ws, ".xyz-harness", slug);
    mkdirSync(topicDir, { recursive: true });
    writeValidPlanMd(topicDir);

    // 1. create topic（锁 tier=lite；workspacePath 指向临时项目根）
    const created = await execute("e2e-create", {
      action: "create",
      slug,
      tier: "lite",
      objective: "构建用户登录功能",
      workspacePath: ws,
    }, undefined);
    expect(created.details.status).toBe("created");
    const topicId = created.details.topicId;
    expect(topicId).toContain(slug);

    // 2. plan（planJson 内联；gate 应读 .xyz-harness/{slug}/plan.md）
    const planned = await execute("e2e-plan", {
      action: "plan",
      topicId,
      workspacePath: ws,
      planJson: makeLitePlanJson(),
    }, undefined);

    // 核心断言：gate 在正确位置找到 plan.md 并通过
    expect(planned.details.gatePassed.plan).toBe(true);
    expect(planned.details.status).toBe("planned");
    expect(planned.details.nextAction.action).toBe("dev");
    // gate pass 不应带 mustFix（fail 时 handlePlan 才附加）
    expect(planned.details.mustFix).toBeUndefined();
  });

  it("回归防护：plan.md 写在项目根（错误位置）而非 .xyz-harness/{slug}/ → plan gate FAIL", async () => {
    const execute = captureExecute();
    const ws = makeTmpWorkspace();
    const slug = "misplaced-plan";

    // 错误位置：plan.md 写在项目根（= 旧/错误 topicDir 指向的位置）
    writeValidPlanMd(ws);
    // .xyz-harness/{slug}/ 下不写 plan.md（仅建目录让 _cw.db 的兄弟路径合法）
    mkdirSync(join(ws, ".xyz-harness", slug), { recursive: true });

    const created = await execute("e2e-create-bad", {
      action: "create",
      slug,
      tier: "lite",
      objective: "构建用户登录功能",
      workspacePath: ws,
    }, undefined);
    const topicId = created.details.topicId;

    const planned = await execute("e2e-plan-bad", {
      action: "plan",
      topicId,
      workspacePath: ws,
      planJson: makeLitePlanJson(),
    }, undefined);

    // 回归断言：topicDir 修复后 runCheckPlan 只看 .xyz-harness/{slug}/plan.md，
    // 项目根的 plan.md 不应被发现 → gate fail、status 不流转、mustFix 给出修复指引。
    // 若有人把 topicDir 退回 workspacePath，此用例会 RED（gate 误在项目根找到 plan.md 而 pass）。
    expect(planned.details.gatePassed.plan).toBeFalsy();
    expect(planned.details.status).toBe("created");
    expect(planned.details.mustFix).toBeDefined();
    // fail 时 nextAction 指向重试 plan（不是 dev），防 agent 误推进
    expect(planned.details.nextAction.action).toBe("plan");
    // renderSummary 必须把 mustFix 输出到 content 文本，否则 agent 在 TUI 看不到具体 fail 清单
    // （Bug 3 修复：旧版 renderSummary 只输出 guidance，agent 拿到「修 mustFix」却看不到 mustFix 是什么）
    expect(planned.content[0]?.text).toContain("mustFix:");
    expect(planned.content[0]?.text).toContain("plan.md 存在");
  });
});
