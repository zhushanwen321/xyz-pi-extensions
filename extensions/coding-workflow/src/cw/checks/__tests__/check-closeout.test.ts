/**
 * check-closeout.test.ts — coding-closeout gate TS 实现（移植验证）。
 *
 * 不 mock check 函数本身（真调 runCheckCloseout），覆盖 PASS + 各 FAIL 场景。
 * fixture 构造 project_root 结构：topicDir = projectRoot/.xyz-harness/<slug>，
 * 让 resolveProjectRoot 能正确推算 project_root。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckCloseout } from "../check-closeout.js";

const tmpDirs: string[] = [];
const SLUG = "add-search-feature";

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/**
 * 构造完整 PASS 结构的 fixture，返回 { projectRoot, topicDir }。
 * 各测试可按需覆写/删除文件制造 FAIL。
 */
function makeValidFixture(): { projectRoot: string; topicDir: string } {
  const projectRoot = mkdtempSync(join(tmpdir(), "cw-closeout-root-"));
  tmpDirs.push(projectRoot);
  const topicDir = join(projectRoot, ".xyz-harness", SLUG);
  mkdirSync(topicDir, { recursive: true });
  mkdirSync(join(projectRoot, "docs", "adr"), { recursive: true });

  // ARCHIVED.md — 列出去向文档
  writeFileSync(join(topicDir, "ARCHIVED.md"), [
    "# Archived",
    "",
    "本 topic 沉淀至：PRODUCT.md / NFR.md / ADR。",
  ].join("\n"));

  // closeout-report.md — frontmatter unverified_count=0，文中无 [UNVERIFIED]
  writeFileSync(join(topicDir, "closeout-report.md"), [
    "---",
    "unverified_count: 0",
    "verdict: pass",
    "---",
    "",
    "# Closeout Report",
    "全部约束已验证。",
  ].join("\n"));

  // PRODUCT.md（project_root 下）含溯源
  writeFileSync(join(projectRoot, "PRODUCT.md"), [
    "# Product",
    `[from: ${SLUG}] 搜索能力沉淀`,
  ].join("\n"));

  // NFR.md — 本次 topic 沉淀的约束块含「验证」
  writeFileSync(join(projectRoot, "NFR.md"), [
    "# NFR",
    "",
    `### S-1 搜索延迟 [from: ${SLUG}]`,
    "P50 < 200ms。",
    "验证：基准压测脚本 bench/search.bench.ts。",
  ].join("\n"));

  // ADR — docs/adr 下，含溯源
  writeFileSync(join(projectRoot, "docs", "adr", "ADR-001.md"), [
    "# ADR-001 选 ES",
    `[from: ${SLUG}]`,
  ].join("\n"));

  // DESIGN-LOG.md — topic 行标 archived
  writeFileSync(join(projectRoot, "DESIGN-LOG.md"), [
    "# Design Log",
    `- ${SLUG} — status: archived`,
  ].join("\n"));

  return { projectRoot, topicDir };
}

describe("runCheckCloseout（移植自 check_closeout.py）", () => {
  it("PASS — 完整归档 → passed:true，不写 machine-check 报告", () => {
    const { topicDir } = makeValidFixture();
    const out = runCheckCloseout(topicDir);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
    expect(out.infraError).toBeUndefined();
    // closeout 不写报告（避免污染已清理的 changes/）
    expect(existsSync(join(topicDir, "changes", "machine-check-closeout.md"))).toBe(false);
  });

  it("FAIL — 缺 ARCHIVED.md → passed:false", () => {
    const { topicDir } = makeValidFixture();
    rmSync(join(topicDir, "ARCHIVED.md"));
    const out = runCheckCloseout(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — ARCHIVED.md 未列去向文档 → passed:false", () => {
    const { topicDir } = makeValidFixture();
    writeFileSync(join(topicDir, "ARCHIVED.md"), "# Archived\n\n无沉淀。\n");
    const out = runCheckCloseout(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 去向文档无 [from:topic] 溯源 → passed:false", () => {
    const { projectRoot, topicDir } = makeValidFixture();
    writeFileSync(join(projectRoot, "PRODUCT.md"), "# Product\n无溯源。\n");
    const out = runCheckCloseout(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — NFR 沉淀块缺「验证」字段 → passed:false", () => {
    const { projectRoot, topicDir } = makeValidFixture();
    writeFileSync(join(projectRoot, "NFR.md"), [
      "# NFR",
      "",
      `### S-1 搜索延迟 [from: ${SLUG}]`,
      "P50 < 200ms。（约束待补）",
    ].join("\n"));
    const out = runCheckCloseout(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — UNVERIFIED 数不一致 → passed:false", () => {
    const { topicDir } = makeValidFixture();
    writeFileSync(join(topicDir, "closeout-report.md"), [
      "---",
      "unverified_count: 2",
      "---",
      "",
      "# Closeout Report",
      "- [UNVERIFIED] 某约束待验证",
    ].join("\n"));
    const out = runCheckCloseout(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — DESIGN-LOG topic 行未标 archived → passed:false", () => {
    const { projectRoot, topicDir } = makeValidFixture();
    writeFileSync(join(projectRoot, "DESIGN-LOG.md"), [
      "# Design Log",
      `- ${SLUG} — status: in-progress`,
    ].join("\n"));
    const out = runCheckCloseout(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 缺 closeout-report.md → passed:false", () => {
    const { topicDir } = makeValidFixture();
    rmSync(join(topicDir, "closeout-report.md"));
    const out = runCheckCloseout(topicDir);
    expect(out.passed).toBe(false);
  });

  it("SKIP 不阻断 — changes/ 非空 + 残留 .html 仍 PASS（⑥ 为警告级）", () => {
    const { topicDir } = makeValidFixture();
    mkdirSync(join(topicDir, "changes"), { recursive: true });
    writeFileSync(join(topicDir, "changes", "leftover.md"), "残留");
    writeFileSync(join(topicDir, "preview.html"), "<html></html>");
    const out = runCheckCloseout(topicDir);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
  });

  it("溯源去 docs/ 子目录 — project_root/docs/PRODUCT.md 含溯源也 PASS", () => {
    const { projectRoot, topicDir } = makeValidFixture();
    // 把 PRODUCT.md 移到 docs/ 下
    rmSync(join(projectRoot, "PRODUCT.md"));
    writeFileSync(join(projectRoot, "docs", "PRODUCT.md"),
      `# Product\n[from: ${SLUG}] 迁移到 docs/\n`);
    const out = runCheckCloseout(topicDir);
    expect(out.passed).toBe(true);
  });
});
