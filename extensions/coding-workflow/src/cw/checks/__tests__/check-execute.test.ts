/**
 * check-execute.test.ts — coding-execute 执行收尾门 TS 实现（移植验证）。
 *
 * 覆盖：
 *   - PASS：lite plan.md + test-results.json 全 pass
 *   - FAIL：缺结果（逃逸①）/ mock 层 fail / real 层 fail /
 *           AI 自标 manual（逃逸②）/ AI 自标 blocked（逃逸③）/
 *           user-skipped 缺凭证（user_confirm_ref null）/ 损坏 JSON
 *   - 降级：resultsPath 缺失 → infraError
 *
 * fixture 注意：避免 TODO/XXX/占位符文本（避免误触占位符检测）。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckExecute } from "../check-execute.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-execute-check-"));
  tmpDirs.push(dir);
  return dir;
}

/** lite plan.md：2 单测（U1/U2，mock 层）+ 2 E2E（E1 mock / E2-r real）。 */
function writeLitePlan(dir: string): string {
  const planPath = join(dir, "plan.md");
  writeFileSync(planPath, [
    "---", "verdict: pass", "---",
    "",
    "# 执行计划",
    "",
    "## 单测用例清单",
    "",
    "| 用例 ID | 描述 |",
    "|---------|------|",
    "| U1 | 登录验证 |",
    "| U2 | 查询验证 |",
    "",
    "## E2E 用例清单",
    "",
    "| 用例 ID | 测试层 | 描述 |",
    "|---------|--------|------|",
    "| E1 | mock | 登录闭环 |",
    "| E2-r | real | 集成数据库查询 |",
  ].join("\n"));
  return planPath;
}

/** 写 test-results.json（顶层为数组）。 */
function writeResults(
  dir: string,
  items: Array<{ id: string; status: string; user_confirm_ref?: unknown }>,
): string {
  const resultsPath = join(dir, "test-results.json");
  writeFileSync(resultsPath, JSON.stringify(items));
  return resultsPath;
}

describe("runCheckExecute（移植自 check_execute.py）", () => {
  it("PASS — lite plan + 全 pass（mock + real 真跑）→ passed:true", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const resultsPath = writeResults(dir, [
      { id: "U1", status: "pass" },
      { id: "U2", status: "pass" },
      { id: "E1", status: "pass" },
      { id: "E2-r", status: "pass" },
    ]);
    const out = runCheckExecute(planPath, resultsPath);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
    expect(out.infraError).toBeUndefined();
  });

  it("FAIL — 缺结果（逃逸路径①）：E2-r 无对应条目 → passed:false", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const resultsPath = writeResults(dir, [
      { id: "U1", status: "pass" },
      { id: "U2", status: "pass" },
      { id: "E1", status: "pass" },
      // E2-r 缺失
    ]);
    const out = runCheckExecute(planPath, resultsPath);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — mock 层 fail（U2 非 pass）→ passed:false", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const resultsPath = writeResults(dir, [
      { id: "U1", status: "pass" },
      { id: "U2", status: "fail" },
      { id: "E1", status: "pass" },
      { id: "E2-r", status: "pass" },
    ]);
    const out = runCheckExecute(planPath, resultsPath);
    expect(out.passed).toBe(false);
  });

  it("FAIL — real 层 fail（E2-r 非 pass）→ passed:false", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const resultsPath = writeResults(dir, [
      { id: "U1", status: "pass" },
      { id: "U2", status: "pass" },
      { id: "E1", status: "pass" },
      { id: "E2-r", status: "fail" },
    ]);
    const out = runCheckExecute(planPath, resultsPath);
    expect(out.passed).toBe(false);
  });

  it("FAIL — real 层 AI 自标 manual（逃逸路径②）→ passed:false", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const resultsPath = writeResults(dir, [
      { id: "U1", status: "pass" },
      { id: "U2", status: "pass" },
      { id: "E1", status: "pass" },
      { id: "E2-r", status: "manual" },
    ]);
    const out = runCheckExecute(planPath, resultsPath);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — real 层 AI 自标 blocked（逃逸路径③）→ passed:false", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const resultsPath = writeResults(dir, [
      { id: "U1", status: "pass" },
      { id: "U2", status: "pass" },
      { id: "E1", status: "pass" },
      { id: "E2-r", status: "blocked" },
    ]);
    const out = runCheckExecute(planPath, resultsPath);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("FAIL — user-skipped 缺凭证（user_confirm_ref null）→ passed:false", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const resultsPath = writeResults(dir, [
      { id: "U1", status: "pass" },
      { id: "U2", status: "pass" },
      { id: "E1", status: "pass" },
      { id: "E2-r", status: "user-skipped", user_confirm_ref: null },
    ]);
    const out = runCheckExecute(planPath, resultsPath);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("PASS — real 层 user-skipped + 非空 user_confirm_ref → passed:true", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const resultsPath = writeResults(dir, [
      { id: "U1", status: "pass" },
      { id: "U2", status: "pass" },
      { id: "E1", status: "pass" },
      {
        id: "E2-r",
        status: "user-skipped",
        user_confirm_ref: "ask_user session 2026-07-04 用户确认无集成环境",
      },
    ]);
    const out = runCheckExecute(planPath, resultsPath);
    expect(out.passed).toBe(true);
  });

  it("FAIL — test-results.json 损坏（非合法 JSON）→ passed:false", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const resultsPath = join(dir, "test-results.json");
    writeFileSync(resultsPath, "{not valid json,,,}");
    const out = runCheckExecute(planPath, resultsPath);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });

  it("降级 — resultsPath 缺失 → passed:false + infraError", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const out = runCheckExecute(planPath);
    expect(out.passed).toBe(false);
    expect(out.infraError).toContain("resultsPath");
  });

  it("FAIL — plan.md 不存在 → passed:false", () => {
    const dir = makeTmpDir();
    const out = runCheckExecute(join(dir, "missing-plan.md"), join(dir, "x.json"));
    expect(out.passed).toBe(false);
  });

  it("PASS — {results:[...]} 包裹格式 → passed:true", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const resultsPath = join(dir, "test-results.json");
    writeFileSync(resultsPath, JSON.stringify({
      results: [
        { id: "U1", status: "pass" },
        { id: "U2", status: "pass" },
        { id: "E1", status: "pass" },
        { id: "E2-r", status: "pass" },
      ],
    }));
    const out = runCheckExecute(planPath, resultsPath);
    expect(out.passed).toBe(true);
  });

  it("FAIL — 重复 id（test-runner 静默覆盖）→ passed:false", () => {
    const dir = makeTmpDir();
    const planPath = writeLitePlan(dir);
    const resultsPath = writeResults(dir, [
      { id: "U1", status: "pass" },
      { id: "U1", status: "pass" }, // 重复
      { id: "U2", status: "pass" },
      { id: "E1", status: "pass" },
      { id: "E2-r", status: "pass" },
    ]);
    const out = runCheckExecute(planPath, resultsPath);
    expect(out.passed).toBe(false);
    expect(out.report).toContain("FAIL");
  });
});
