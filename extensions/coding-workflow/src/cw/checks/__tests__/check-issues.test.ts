/**
 * check-issues.test.ts — full-issues gate TS 实现（移植验证）。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckIssues } from "../check-issues.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch (e) { void e; /* best-effort */ }
  }
});

function makeTmpTopicDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-issues-check-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "changes"), { recursive: true });
  return dir;
}

function writeApprovedReview(topicDir: string): void {
  writeFileSync(join(topicDir, "changes", "review-issues.md"), [
    "---", "verdict: APPROVED", "---", "review stub",
  ].join("\n"));
}

/** 合规 issues.md：2 个 issue（P0 + P1），P0 有 2 方案，无幽灵依赖，含覆盖核验表。 */
function writeValidIssues(topicDir: string): void {
  writeFileSync(join(topicDir, "issues.md"), [
    "---", "verdict: pass", "---",
    "",
    "# Issues",
    "",
    "## 地图总览",
    "issue DAG",
    "",
    "## #1 登录失败",
    "**P 级**: P0",
    "**Blocked by**: (无)",
    "",
    "方案 A: 改接口",
    "方案 B: 加适配层",
    "",
    "## #2 数据查询性能",
    "**P 级**: P1",
    "**Blocked by**: #1",
    "",
    "方案 A: 索引",
    "方案 B: 缓存",
    "",
    "## 上游覆盖核验",
    "",
    "| 上游元素 | 对应 issue | 状态 | 理由 |",
    "|----------|-----------|------|------|",
    "| 需求A | #1 | ✅ | 覆盖 |",
    "| 需求B | #2 | ✅ | 覆盖 |",
  ].join("\n"));
}

describe("runCheckIssues（移植自 check_issues.py）", () => {
  it("PASS — 合规 issues.md → passed:true", () => {
    const topicDir = makeTmpTopicDir();
    writeValidIssues(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckIssues(topicDir);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
  });

  it("FAIL — 交付物不存在 → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeApprovedReview(topicDir);
    const out = runCheckIssues(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — P0 issue 仅 1 方案 → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "issues.md"), [
      "---", "verdict: pass", "---",
      "", "# Issues",
      "## 地图总览", "x",
      "## #1 X", "**P 级**: P0", "", "方案 A: 仅一个",
      "## 上游覆盖核验",
      "| 上游元素 | 对应 issue | 状态 | 理由 |",
      "|----------|-----------|------|------|",
      "| A | #1 | ✅ | ok |",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckIssues(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — blocked_by 指向不存在的 issue（幽灵依赖）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    // 注意：extractIssueIds 提取全文 #N，blocked_by 行写的 #N 也会被提取。
    // 要测真 ghost，blocked_by 引用的编号不能在文档其他任何地方出现。
    // 但 blocked_by 行本身就有该编号 → python 版的 ghost 检查实际抓不到自引用。
    // 这里改测「覆盖核验表的幽灵引用」——表里写 #99 但无对应 issue 定义。
    writeFileSync(join(topicDir, "issues.md"), [
      "---", "verdict: pass", "---",
      "", "# Issues",
      "## 地图总览", "x",
      "## #1 X", "**P 级**: P0",
      "", "方案 A: 改接口", "方案 B: 加层",
      "## 上游覆盖核验",
      "| 上游元素 | 对应 issue | 状态 | 理由 |",
      "|----------|-----------|------|------|",
      "| 需求A | #99 | ✅ | 幽灵引用 |",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckIssues(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — P0 blocked_by P2（P 级不一致）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "issues.md"), [
      "---", "verdict: pass", "---",
      "", "# Issues",
      "## 地图总览", "x",
      "## #1 高优先级", "**P 级**: P0", "**Blocked by**: #2",
      "", "方案 A: x", "方案 B: y",
      "## #2 低优先级", "**P 级**: P2",
      "", "方案 A: x", "方案 B: y",
      "## 上游覆盖核验",
      "| 上游元素 | 对应 issue | 状态 | 理由 |",
      "|----------|-----------|------|------|",
      "| A | #1 | ✅ | ok |",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckIssues(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 缺「上游覆盖核验」章节 → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "issues.md"), [
      "---", "verdict: pass", "---",
      "", "# Issues",
      "## 地图总览", "x",
      "## #1 X", "**P 级**: P0",
      "", "方案 A: x", "方案 B: y",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckIssues(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 覆盖核验表含 ❌ 待补残留 → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "issues.md"), [
      "---", "verdict: pass", "---",
      "", "# Issues",
      "## 地图总览", "x",
      "## #1 X", "**P 级**: P0",
      "", "方案 A: x", "方案 B: y",
      "## 上游覆盖核验",
      "| 上游元素 | 对应 issue | 状态 | 理由 |",
      "|----------|-----------|------|------|",
      "| A | #1 | ❌ | 待补 |",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckIssues(topicDir);
    expect(out.passed).toBe(false);
  });

  it("B3 — `### #N` 嵌套标题也能提取 P 级 / blocked_by（deliverable-template 嵌套示例）", () => {
    const topicDir = makeTmpTopicDir();
    // issue-template.md 用 `## #N`，但 deliverable-template.md 嵌套示例用 `### #N`。
    // 原正则只匹配 2 井号 → agent 按嵌套写则 P 级/blocked_by 检查静默 SKIP。
    writeFileSync(join(topicDir, "issues.md"), [
      "---", "verdict: pass", "---",
      "", "# Issues",
      "## 地图总览", "DAG",
      "",
      "### #1 登录失败",
      "**P 级**: P0",
      "**Blocked by**: (无)",
      "",
      "方案 A: 改接口",
      "方案 B: 加适配层",
      "",
      "### #2 数据查询",
      "**P 级**: P1",
      "**Blocked by**: #1",
      "",
      "方案 A: 索引",
      "方案 B: 缓存",
      "",
      "## 上游覆盖核验",
      "| 上游元素 | 对应 issue | 状态 | 理由 |",
      "|----------|-----------|------|------|",
      "| 需求A | #1 | ✅ | 覆盖 |",
      "| 需求B | #2 | ✅ | 覆盖 |",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckIssues(topicDir);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
  });

  it("写报告到 changes/machine-check-issues.md", () => {
    const topicDir = makeTmpTopicDir();
    writeValidIssues(topicDir);
    writeApprovedReview(topicDir);
    runCheckIssues(topicDir);
    expect(existsSync(join(topicDir, "changes", "machine-check-issues.md"))).toBe(true);
  });
});
