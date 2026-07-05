/**
 * check-execution.test.ts — full-execution gate TS 实现（移植验证）。
 *
 * 覆盖：结构性五件套 / consistency-final 总闸门 / 测试清单集合相等 / 验收 Wave。
 * fixture 注意：避免 TODO/XXX/占位符文本（触发占位符检测）。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckExecution } from "../check-execution.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeTmpTopicDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-exec-check-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "changes"), { recursive: true });
  return dir;
}

function writeApprovedReview(topicDir: string): void {
  writeFileSync(join(topicDir, "changes", "review-execution.md"), [
    "---", "verdict: APPROVED", "---", "review stub",
  ].join("\n"));
}

function writeConsistentFinal(topicDir: string, verdict = "CONSISTENT"): void {
  writeFileSync(join(topicDir, "changes", "consistency-final.md"), [
    "---", `verdict: ${verdict}`, "---", "consistency final",
  ].join("\n"));
}

/** ⑤ code-architecture.md 测试矩阵（含 T1.1 / T2.1 / T2.2）。 */
function writeCodeArch(topicDir: string, ids = ["T1.1", "T2.1", "T2.2"]): void {
  const rows = ids.map((id) => `| ${id} | e2e | 验收 |`).join("\n");
  writeFileSync(join(topicDir, "code-architecture.md"), [
    "---", "verdict: pass", "---",
    "", "# Code Architecture",
    "", "## 测试矩阵", "",
    "| 用例 | 类型 | 说明 |",
    "|------|------|------|",
    rows,
  ].join("\n"));
}

/**
 * 合规 execution-plan.md：
 *   - 3 个 Wave（Wave 1/2 功能 + Wave 3 在 fixture 里命名「验收 Gate」但已不再被校验，保留作 T2.2 的归属 Wave 标签）
 *   - 测试验收清单含 T1.1/T2.1/T2.2（与 code-arch 全量相等）
 */
function writeValidPlan(topicDir: string): void {
  writeFileSync(join(topicDir, "execution-plan.md"), [
    "---", "verdict: pass", "---",
    "",
    "# Execution Plan",
    "",
    "## Wave 编排",
    "",
    "### Wave 1 基础功能",
    "**Blocked by**: (无)",
    "实现 UC-1 登录。",
    "",
    "### Wave 2 数据查询",
    "**Blocked by**: Wave 1",
    "实现 UC-2 查询。",
    "",
    "### Wave 3 验收 Gate",
    "**Blocked by**: Wave 1, Wave 2",
    "端到端验收。",
    "",
    "## 测试验收清单",
    "",
    "| 用例 | Wave | 状态 |",
    "|------|------|------|",
    "| T1.1 | Wave 1 | ✅ |",
    "| T2.1 | Wave 2 | ✅ |",
    "| T2.2 | Wave 3 | ✅ |",
  ].join("\n"));
}

describe("runCheckExecution（移植自 check_execution.py）", () => {
  it("PASS — 合规 execution-plan + code-arch + consistency-final → passed:true", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir);
    writeCodeArch(topicDir);
    writeConsistentFinal(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckExecution(topicDir);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
  });

  it("FAIL — 缺 consistency-final → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir);
    writeCodeArch(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckExecution(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — consistency-final verdict 非 CONSISTENT → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir);
    writeCodeArch(topicDir);
    writeConsistentFinal(topicDir, "DEVIATED");
    writeApprovedReview(topicDir);
    const out = runCheckExecution(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 测试清单缺用例（集合不等）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    // plan 清单缺 T2.2
    writeFileSync(join(topicDir, "execution-plan.md"), [
      "---", "verdict: pass", "---",
      "", "# Execution Plan",
      "## Wave 编排",
      "### Wave 1 基础", "**Blocked by**: (无)", "x",
      "### Wave 2 查询", "**Blocked by**: Wave 1", "y",
      "### Wave 3 验收 Gate", "**Blocked by**: Wave 1, Wave 2", "z",
      "## 测试验收清单",
      "| 用例 | Wave | 状态 |",
      "|------|------|------|",
      "| T1.1 | Wave 1 | ✅ |",
      "| T2.1 | Wave 2 | ✅ |",
    ].join("\n"));
    writeCodeArch(topicDir);
    writeConsistentFinal(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckExecution(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 测试清单多用例（⑤无）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "execution-plan.md"), [
      "---", "verdict: pass", "---",
      "", "# Execution Plan",
      "## Wave 编排",
      "### Wave 1 基础", "**Blocked by**: (无)", "x",
      "### Wave 2 查询", "**Blocked by**: Wave 1", "y",
      "### Wave 3 验收 Gate", "**Blocked by**: Wave 1, Wave 2", "z",
      "## 测试验收清单",
      "| 用例 | Wave | 状态 |",
      "|------|------|------|",
      "| T1.1 | Wave 1 | ✅ |",
      "| T2.1 | Wave 2 | ✅ |",
      "| T2.2 | Wave 3 | ✅ |",
      "| T9.9 | Wave 9 | ✅ |",
    ].join("\n"));
    writeCodeArch(topicDir);
    writeConsistentFinal(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckExecution(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 缺关键章节（无「测试验收清单」）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "execution-plan.md"), [
      "---", "verdict: pass", "---",
      "", "# Execution Plan",
      "## Wave 编排",
      "### Wave 1 基础", "**Blocked by**: (无)", "x",
    ].join("\n"));
    writeCodeArch(topicDir);
    writeConsistentFinal(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckExecution(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 交付物不存在 → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeConsistentFinal(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckExecution(topicDir);
    expect(out.passed).toBe(false);
  });

  it("写报告到 changes/machine-check-execution.md", () => {
    const topicDir = makeTmpTopicDir();
    writeValidPlan(topicDir);
    writeCodeArch(topicDir);
    writeConsistentFinal(topicDir);
    writeApprovedReview(topicDir);
    runCheckExecution(topicDir);
    expect(existsSync(join(topicDir, "changes", "machine-check-execution.md"))).toBe(true);
  });
});
