/**
 * check-nfr.test.ts — full-nfr gate TS 实现（移植验证）。
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckNfr } from "../check-nfr.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch (e) { void e; /* best-effort */ }
  }
});

function makeTmpTopicDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-nfr-check-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "changes"), { recursive: true });
  return dir;
}

function writeApprovedReview(topicDir: string): void {
  writeFileSync(join(topicDir, "changes", "review-nfr.md"), [
    "---", "verdict: APPROVED", "---", "review stub",
  ].join("\n"));
}

/** 合规 non-functional-design.md + issues.md。
 *
 * 列序约定：验收方式在倒数第 2 列（python check_nfr.py 假设），
 * 状态在最后 1 列。回灌去向放前面避免打乱列序假设。
 */
function writeValidNfr(topicDir: string): void {
  writeFileSync(join(topicDir, "non-functional-design.md"), [
    "---", "verdict: pass", "---",
    "",
    "# NFR",
    "## 风险分析矩阵",
    "| 风险 | 影响 |",
    "|------|------|",
    "| 性能 | 中 |",
    "",
    "## 缓解项回灌登记",
    "",
    "| 风险 | 回灌去向 | 缓解方式 | 验收方式 | 状态 |",
    "|------|---------|---------|---------|------|",
    "| 性能 | ③#1 | 索引 | 代码测试 | PASS |",
    "| 可用性 | 运维项 | 监控 | 运维项 | PASS |",
  ].join("\n"));
  writeFileSync(join(topicDir, "issues.md"), [
    "# Issues",
    "## #1 性能优化",
  ].join("\n"));
}

describe("runCheckNfr（移植自 check_nfr.py）", () => {
  it("PASS — 合规 nfr + issues.md → passed:true", () => {
    const topicDir = makeTmpTopicDir();
    writeValidNfr(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckNfr(topicDir);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
  });

  it("FAIL — 交付物不存在 → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeApprovedReview(topicDir);
    const out = runCheckNfr(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 缺「缓解项回灌」章节 → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "non-functional-design.md"), [
      "---", "verdict: pass", "---",
      "", "# NFR",
      "## 风险分析矩阵", "| 风险 | 影响 |",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckNfr(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 验收方式不合法（值不在白名单）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "non-functional-design.md"), [
      "---", "verdict: pass", "---",
      "", "# NFR",
      "## 风险分析矩阵", "| 风险 | 影响 |",
      "## 缓解项回灌登记",
      "| 风险 | 缓解方式 | 验收方式 | 状态 |",
      "|------|---------|---------|------|",
      "| 性能 | 索引 | 未知方式 | PASS |",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckNfr(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 含 ❌ 不可接受项残留 → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "non-functional-design.md"), [
      "---", "verdict: pass", "---",
      "", "# NFR",
      "## 风险分析矩阵", "| 风险 | 影响 |",
      "## 缓解项回灌登记",
      "| 风险 | 缓解方式 | 验收方式 | 状态 |",
      "|------|---------|---------|------|",
      "| 性能 | 索引 | 代码测试 | PASS |",
      "",
      "❌ 某个不可接受的风险（应回 Step3）",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckNfr(topicDir);
    expect(out.passed).toBe(false);
  });

  it("B1 — nfr 模板图例 + 回灌指针表延期承诺说明 ❌ 不计为残留（agent 保留模板不 FAIL）", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "non-functional-design.md"), [
      "---", "verdict: pass", "---",
      "", "# NFR",
      "## 风险分析矩阵",
      "| Issue | 方案 | 安全 |",
      "|-------|------|------|",
      "| #1 | 方案A | ⚠️ |",
      "",
      "（✅ 无风险 / ⚠️ 有风险已缓解 / ❌ 不可接受需回退 / — 不适用+理由）",
      "",
      "> 延期承诺说明：❌ ⑤还没写，查不了 / ❌ ⑥还没编排，查不了",
      "",
      "## 残余风险登记",
      "",
      "## 缓解项回灌登记",
      "| 缓解项 | 回灌去向 | 验收方式 | 状态 |",
      "|--------|---------|---------|------|",
      "| 幂等键 | ③#1 | 代码测试 | 待落 |",
    ].join("\n"));
    writeFileSync(join(topicDir, "issues.md"), "# Issues\n## #1 性能优化\n");
    writeApprovedReview(topicDir);
    const out = runCheckNfr(topicDir);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
  });

  it("FAIL — 回灌指向不存在的 issue（PHANTOM）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "non-functional-design.md"), [
      "---", "verdict: pass", "---",
      "", "# NFR",
      "## 风险分析矩阵", "| 风险 | 影响 |",
      "## 缓解项回灌登记",
      "| 风险 | 回灌去向 | 缓解方式 | 验收方式 | 状态 |",
      "|------|---------|---------|---------|------|",
      "| 性能 | ③#99 | 索引 | 代码测试 | PASS |",
    ].join("\n"));
    writeFileSync(join(topicDir, "issues.md"), "# Issues\n## #1 真实 issue\n");
    writeApprovedReview(topicDir);
    const out = runCheckNfr(topicDir);
    expect(out.passed).toBe(false);
  });

  it("SKIP PHANTOM — issues.md 不存在 → skip（不 fail）", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "non-functional-design.md"), [
      "---", "verdict: pass", "---",
      "", "# NFR",
      "## 风险分析矩阵", "| 风险 | 影响 |",
      "## 缓解项回灌登记",
      "| 风险 | 回灌去向 | 缓解方式 | 验收方式 | 状态 |",
      "|------|---------|---------|---------|------|",
      "| 性能 | ③#1 | 索引 | 代码测试 | PASS |",
    ].join("\n"));
    // 不写 issues.md
    writeApprovedReview(topicDir);
    const out = runCheckNfr(topicDir);
    expect(out.passed).toBe(true); // PHANTOM 跳过，不 fail
  });

  it("C2 — verdict 大小写不敏感（frontmatter 'Pass' / review 'approved' 也通过）", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "non-functional-design.md"), [
      "---", "verdict: Pass", "---",  // 大小写混合
      "", "# NFR",
      "## 风险分析矩阵", "| 风险 | 影响 |",
      "## 缓解项回灌登记",
      "| 风险 | 回灌去向 | 验收方式 | 状态 |",
      "|------|---------|---------|------|",
      "| 性能 | ③#1 | 代码测试 | PASS |",
    ].join("\n"));
    writeFileSync(join(topicDir, "issues.md"), "# Issues\n## #1 性能优化\n");
    // review verdict 小写 'approved'
    writeFileSync(join(topicDir, "changes", "review-nfr.md"), [
      "---", "verdict: approved", "---", "review stub",
    ].join("\n"));
    const out = runCheckNfr(topicDir);
    expect(out.passed).toBe(true);
  });

  it("写报告到 changes/machine-check-nfr.md", () => {
    const topicDir = makeTmpTopicDir();
    writeValidNfr(topicDir);
    writeApprovedReview(topicDir);
    runCheckNfr(topicDir);
    expect(existsSync(join(topicDir, "changes", "machine-check-nfr.md"))).toBe(true);
  });
});
