/**
 * check-plan.test.ts — lite-plan gate TS 实现（移植验证）。
 *
 * 不 mock check 函数本身（真调 runCheckPlan），覆盖 PASS + 各 FAIL 场景。
 * fixture 全程避免用 XXX/TODO/TBD/FIXME/{xxx}（会触发占位符检测），用中文描述代替。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckPlan } from "../check-plan.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch (e) { void e; /* best-effort */ }
  }
});

function makeTmpTopicDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-plan-check-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "changes"), { recursive: true });
  return dir;
}

/** 合规 plan.md：6 章节 + 实现步骤 + Wave 表（含验收）+ 单测表 + E2E 表（mock/real）+ 覆盖率 gate。 */
function writeValidPlan(topicDir: string, over: { plan?: Partial<ValidPlanPatch> } = {}): void {
  const patch = over.plan ?? {};
  writeFileSync(join(topicDir, "plan.md"), [
    "# Plan",
    "## 业务目标",
    patch.businessGoal ?? "构建用户登录功能",
    "",
    "## 技术改动点",
    `- 修改 src/auth/login.ts — 登录逻辑`,
    `- 创建 src/auth/session.ts — 会话管理`,
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

interface ValidPlanPatch {
  businessGoal: string;
}

describe("runCheckPlan（移植自 check_plan.py）", () => {
  it("PASS — 合规 plan.md（6 章节 + Wave 表 + 单测/E2E 表 + 覆盖率 gate）→ passed:true", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir);
    const out = runCheckPlan(topicDir);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
    expect(out.infraError).toBeUndefined();
  });

  it("FAIL — plan.md 不存在 → passed:false（交付物缺失，提前返回）", () => {
    const topicDir = makeTmpTopicDir();
    const out = runCheckPlan(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — 缺必须章节（无「单测用例清单」）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir);
    // 删掉单测章节，触发 6 必须章节 + 单测可机器判定双 fail
    const content = readPlan(topicDir).replace(/## 单测用例清单[\s\S]*?(?=## E2E)/, "");
    writePlan(topicDir, content);
    const out = runCheckPlan(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — 含占位符 {xxx} → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir, { plan: { businessGoal: "构建 {placeholder} 功能" } });
    const out = runCheckPlan(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — Wave 表缺失（无可解析 Wave 行）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir);
    // 把 Wave 行改成无 W 前缀的伪数据行
    const content = readPlan(topicDir)
      .replace("| W1 | src/auth/login.ts | W0 | G1 | 登录 |", "| step1 | src/auth/login.ts | W0 | G1 | 登录 |")
      .replace("| W2 | src/auth/session.ts | W1 | G1 | 会话 |", "| step2 | src/auth/session.ts | W1 | G1 | 会话 |")
      .replace("| W9 | src/auth/login.ts,src/auth/session.ts | W2 | - | 验收 |", "");
    writePlan(topicDir, content);
    const out = runCheckPlan(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — 单测含模糊断言词（正常工作）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir);
    const content = readPlan(topicDir).replace(
      "| U1 | src/auth/login.ts:login | 输入合法账号 | 返回 token 字符串 |",
      "| U1 | src/auth/login.ts:login | 输入合法账号 | 登录后正常工作 |",
    );
    writePlan(topicDir, content);
    const out = runCheckPlan(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — E2E 缺测试层（只有 mock，无 real）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir);
    const content = readPlan(topicDir).replace(
      "| E2 | 端到端登录 | real | 走真实后端 |",
      "| E2 | 端到端登录 | mock | 也走 mock |",
    );
    writePlan(topicDir, content);
    const out = runCheckPlan(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — 覆盖率 gate 阈值 < 60% → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir);
    const content = readPlan(topicDir).replace("阈值: 80%", "阈值: 30%");
    writePlan(topicDir, content);
    const out = runCheckPlan(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("写报告到 changes/machine-check-plan.md", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir);
    runCheckPlan(topicDir);
    const reportPath = join(topicDir, "changes", "machine-check-plan.md");
    expect(existsSync(reportPath)).toBe(true);
  });
});

// ── 小工具 ──────────────────────────────────────────────────────

function readPlan(topicDir: string): string {
  return readFileSync(join(topicDir, "plan.md"), "utf8");
}

function writePlan(topicDir: string, content: string): void {
  writeFileSync(join(topicDir, "plan.md"), content, "utf8");
}
