/**
 * check-clarity.test.ts — full-clarity gate TS 实现（移植验证）。
 *
 * 不 mock check 函数本身（真调 runCheckClarity），覆盖 PASS + 各 FAIL 场景。
 * 这是移植 python→TS 的核心价值：消除测试盲区，验证 check 函数真的能跑。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckClarity } from "../check-clarity.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch (e) { void e; /* best-effort */ }
  }
});

function makeTmpTopicDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-clarity-check-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "changes"), { recursive: true });
  return dir;
}

/** 写一份合规的 requirements.md（含 frontmatter + 4 章节 + UC/AC）。 */
function writeValidRequirements(topicDir: string): void {
  writeFileSync(join(topicDir, "requirements.md"), [
    "---",
    "verdict: pass",
    "---",
    "",
    "# Requirements",
    "",
    "## 业务目标",
    "构建 X 功能",
    "",
    "## 业务用例",
    "UC-1: 用户登录",
    "AC-1.1: 登录成功",
    "AC-1.2: 登录失败",
    "UC-2: 数据查询",
    "AC-2.1: 查询返回结果",
    "",
    "## 数据流转",
    "输入 → 处理 → 输出",
    "",
    "## 约束",
    "Constraints: 性能 < 100ms",
    "",
    "## 实现步骤",
    "1. do A",
    "2. do B",
  ].join("\n"));
}

/** 写 review-clarity.md 桩（verdict: APPROVED）。 */
function writeApprovedReview(topicDir: string): void {
  writeFileSync(join(topicDir, "changes", "review-clarity.md"), [
    "---",
    "verdict: APPROVED",
    "---",
    "review stub",
  ].join("\n"));
}

describe("runCheckClarity（移植自 check_clarity.py）", () => {
  it("PASS — 合规 requirements.md + APPROVED review → passed:true + report 含 PASS", () => {
    const topicDir = makeTmpTopicDir();
    writeValidRequirements(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckClarity(topicDir);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
    expect(out.infraError).toBeUndefined();
  });

  it("FAIL — requirements.md 不存在 → passed:false（交付物缺失）", () => {
    const topicDir = makeTmpTopicDir();
    writeApprovedReview(topicDir); // review 在，但 requirements 不在
    const out = runCheckClarity(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — frontmatter verdict 非 pass → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "requirements.md"), [
      "---",
      "verdict: draft",
      "---",
      "",
      "# Requirements",
      "",
      "## 业务目标",
      "x",
      "## 业务用例",
      "UC-1: x",
      "AC-1.1: x",
      "## 数据流转",
      "x",
      "## 约束",
      "x",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckClarity(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — 缺关键章节（无「业务用例」）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "requirements.md"), [
      "---",
      "verdict: pass",
      "---",
      "",
      "# Requirements",
      "## 业务目标",
      "x",
      "## 数据流转",
      "x",
      "## 约束",
      "x",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckClarity(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — 含占位符 {xxx} → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "requirements.md"), [
      "---",
      "verdict: pass",
      "---",
      "",
      "# Requirements",
      "## 业务目标",
      "构建 {placeholder} 功能",
      "## 业务用例",
      "UC-1: x",
      "AC-1.1: x",
      "## 数据流转",
      "x",
      "## 约束",
      "x",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckClarity(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — review-clarity.md 缺失或 verdict 非 APPROVED → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeValidRequirements(topicDir);
    // 不写 review-clarity.md
    const out = runCheckClarity(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — UC 无对应 AC → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "requirements.md"), [
      "---",
      "verdict: pass",
      "---",
      "",
      "# Requirements",
      "## 业务目标",
      "x",
      "## 业务用例",
      "UC-1: 有 AC",
      "AC-1.1: x",
      "UC-2: 无 AC",
      "## 数据流转",
      "x",
      "## 约束",
      "x",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckClarity(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — 含系统实现（CREATE TABLE）→ passed:false（①铁律）", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "requirements.md"), [
      "---",
      "verdict: pass",
      "---",
      "",
      "# Requirements",
      "## 业务目标",
      "x",
      "## 业务用例",
      "UC-1: x",
      "AC-1.1: x",
      "## 数据流转",
      "CREATE TABLE users (id INT)",
      "## 约束",
      "x",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckClarity(topicDir);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("写报告到 changes/machine-check-clarity.md", () => {
    const topicDir = makeTmpTopicDir();
    writeValidRequirements(topicDir);
    writeApprovedReview(topicDir);
    runCheckClarity(topicDir);
    const reportPath = join(topicDir, "changes", "machine-check-clarity.md");
    expect(existsSync(reportPath)).toBe(true);
  });
});
