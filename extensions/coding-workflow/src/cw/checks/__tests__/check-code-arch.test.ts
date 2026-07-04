/**
 * check-code-arch.test.ts — full-code-arch gate TS 实现（移植验证）。
 *
 * 覆盖：
 *   - PASS：合规 code-architecture.md + 测试矩阵 + 无骨架
 *   - FAIL：缺章节 / 缺测试层列 / 骨架有 TODO 占位符 / 骨架文件 >600 行 / NFR 缺用例 ID
 *   - SKIP：code-skeleton/ 不存在 → ③全 skip
 *   - 类型检查器子进程：用 vi.hoisted + vi.mock 配置 ENOENT（SKIP）/pass，不真跑 tsc
 */

import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runCheckCodeArch } from "../check-code-arch.js";

// ── 类型检查器子进程 mock（单例，可配置） ─────────────────────
// vi.hoisted 让 typecheckMode 在 vi.mock factory 中可访问。
// mode: "skip" → throw ENOENT（命令不存在）；"pass" → 返回 ""；"fail" → 抛非 ENOENT 错误。
const typecheckMode = vi.hoisted(() => ({ mode: "skip" as "skip" | "pass" | "fail" }));

vi.mock("node:child_process", () => ({
  execFileSync: () => {
    if (typecheckMode.mode === "skip") {
      const e = new Error("spawn tsc ENOENT");
      (e as { code?: string }).code = "ENOENT";
      throw e;
    }
    if (typecheckMode.mode === "fail") {
      const e = new Error("type error");
      (e as { stderr?: string }).stderr = "TS1234: bad type";
      throw e;
    }
    return "";
  },
}));

const tmpDirs: string[] = [];

afterEach(() => {
  typecheckMode.mode = "skip"; // 重置为默认（SKIP）
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeTmpTopicDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-code-arch-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "changes"), { recursive: true });
  return dir;
}

function writeApprovedReview(topicDir: string): void {
  writeFileSync(join(topicDir, "changes", "review-code-arch.md"), [
    "---", "verdict: APPROVED", "---", "review stub",
  ].join("\n"));
}

/**
 * 合规 code-architecture.md（含 4 章节 + 完整测试矩阵）。
 * 注意：NFR 表头不用「NFR」字样（避免被 NFR 行过滤器误判为数据行）。
 */
function writeValidCodeArch(topicDir: string): void {
  writeFileSync(join(topicDir, "code-architecture.md"), [
    "---", "verdict: pass", "---",
    "",
    "# Code Architecture",
    "## 工程目录",
    "src/ 目录结构",
    "## API 契约",
    "| 方法 | 签名 |",
    "|------|------|",
    "| createOrder | (input) => Result |",
    "## 时序图",
    "请求 → 处理 → 响应",
    "## 测试矩阵",
    "来源 A：功能用例",
    "| 用例 | 测试层 |",
    "|------|--------|",
    "| UC-1 登录 | real |",
    "来源 B：NFR 风险→用例映射",
    "| 风险 | 用例 |",
    "|-----|------|",
    "| 代码测试 性能 | T1.1 |",
  ].join("\n"));
}

/**
 * 写一个最小合规骨架（含接线 + createOrder 定义 + 无占位符）。
 * 接线用 this.<method>( 直接调用形式（匹配 WIRING_PATTERN）。
 */
function writeCleanSkeleton(topicDir: string): void {
  const skeletonPath = join(topicDir, "code-skeleton");
  mkdirSync(join(skeletonPath, "src"), { recursive: true });
  writeFileSync(join(skeletonPath, "src", "service.ts"), [
    "export class Service {",
    "  createOrder(input: string): void { this.persist(input); }",
    "  private persist(data: string): void { /* storage */ }",
    "}",
  ].join("\n"));
}

describe("runCheckCodeArch（移植自 check_code_arch.py）", () => {
  // ── ① 结构性 + ② 测试矩阵（无骨架） ──

  it("PASS — 合规文档 + 测试矩阵 + 无骨架 → passed:true（③全 skip）", () => {
    const topicDir = makeTmpTopicDir();
    writeValidCodeArch(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
  });

  it("FAIL — 交付物不存在 → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeApprovedReview(topicDir);
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — frontmatter verdict 非 pass → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "code-architecture.md"), [
      "---", "verdict: fail", "---",
      "", "# Code Architecture",
      "## 工程目录", "x",
      "## API 契约", "x",
      "## 时序图", "x",
      "## 测试矩阵", "来源 A / 来源 B / 测试层",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 缺关键章节（无「测试矩阵」）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "code-architecture.md"), [
      "---", "verdict: pass", "---",
      "", "# Code Architecture",
      "## 工程目录", "x",
      "## API 契约", "x",
      "## 时序图", "x",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 测试矩阵缺「测试层」列 → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "code-architecture.md"), [
      "---", "verdict: pass", "---",
      "", "# Code Architecture",
      "## 工程目录", "x",
      "## API 契约", "x",
      "## 时序图", "x",
      "## 测试矩阵",
      "来源 A：功能用例",
      "| 用例 |",
      "| UC-1 登录 |",
      "来源 B：NFR 风险→用例映射",
      "| 代码测试 性能 | T1.1 |",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — NFR 行缺用例 ID（无 T{N}.{M}）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "code-architecture.md"), [
      "---", "verdict: pass", "---",
      "", "# Code Architecture",
      "## 工程目录", "x",
      "## API 契约", "x",
      "## 时序图", "x",
      "## 测试矩阵",
      "来源 A：功能用例",
      "| 用例 | 测试层 |",
      "| UC-1 | real |",
      "来源 B：NFR 风险→用例映射",
      "| 代码测试 NFR 性能 | 待补 |",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 测试矩阵缺来源 B（NFR 风险映射）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "code-architecture.md"), [
      "---", "verdict: pass", "---",
      "", "# Code Architecture",
      "## 工程目录", "x",
      "## API 契约", "x",
      "## 时序图", "x",
      "## 测试矩阵",
      "来源 A：功能用例",
      "| 用例 | 测试层 |",
      "| UC-1 | real |",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(false);
  });

  // ── ③ 骨架反模式检查 ──

  it("SKIP ③骨架检查 — code-skeleton/ 不存在 → passed:true", () => {
    const topicDir = makeTmpTopicDir();
    writeValidCodeArch(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(true);
    // SKIP 信息在渲染的报告文件里（verdict 行只有 PASS/FAIL）
    const reportContent = readFileSync(
      join(topicDir, "changes", "machine-check-code-arch.md"), "utf8",
    );
    expect(reportContent).toContain("SKIP");
  });

  it("PASS — 合规骨架（含接线 + 无占位符 + createOrder 定义）→ passed:true", () => {
    typecheckMode.mode = "pass"; // tsc mock 通过
    const topicDir = makeTmpTopicDir();
    writeValidCodeArch(topicDir);
    writeApprovedReview(topicDir);
    writeCleanSkeleton(topicDir);
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(true);
  });

  it("FAIL — 骨架有 TODO 占位符 → passed:false（③a）", () => {
    typecheckMode.mode = "skip";
    const topicDir = makeTmpTopicDir();
    writeValidCodeArch(topicDir);
    writeApprovedReview(topicDir);
    const skeletonPath = join(topicDir, "code-skeleton");
    mkdirSync(join(skeletonPath, "src"), { recursive: true });
    writeFileSync(join(skeletonPath, "src", "service.ts"), [
      "export class Service {",
      "  // TODO: implement this",
      "  createOrder(input: string): void { this.persist(input); }",
      "  private persist(data: string): void {}",
      "}",
    ].join("\n"));
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 骨架有 @ts-ignore / any 类型逃逸 → passed:false（③a）", () => {
    typecheckMode.mode = "skip";
    const topicDir = makeTmpTopicDir();
    writeValidCodeArch(topicDir);
    writeApprovedReview(topicDir);
    const skeletonPath = join(topicDir, "code-skeleton");
    mkdirSync(join(skeletonPath, "src"), { recursive: true });
    writeFileSync(join(skeletonPath, "src", "bad.ts"), [
      "// @ts-ignore",
      "export function bad(): any { return 1; }",
      "badApi.foo(); // 接线，让 ③e PASS",
    ].join("\n"));
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 骨架文件 >600 行（god object）→ passed:false（③b）", () => {
    typecheckMode.mode = "skip";
    const topicDir = makeTmpTopicDir();
    writeValidCodeArch(topicDir);
    writeApprovedReview(topicDir);
    const skeletonPath = join(topicDir, "code-skeleton");
    mkdirSync(join(skeletonPath, "src"), { recursive: true });
    const lines = [
      "export class Big {",
      "  createOrder(): void { this.persist('x'); }",
      "  private persist(x: string): void {}",
    ];
    for (let i = 0; i < 597; i++) lines.push(`  // padding line ${i}`);
    lines.push("}");
    writeFileSync(join(skeletonPath, "src", "big.ts"), lines.join("\n"));
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 全骨架无接线（退化 Level 0）→ passed:false（③e）", () => {
    typecheckMode.mode = "skip";
    const topicDir = makeTmpTopicDir();
    writeValidCodeArch(topicDir);
    writeApprovedReview(topicDir);
    const skeletonPath = join(topicDir, "code-skeleton");
    mkdirSync(join(skeletonPath, "src"), { recursive: true });
    writeFileSync(join(skeletonPath, "src", "bare.ts"), [
      "export function run(): void {",
      "  throw new Error('not implemented');",
      "}",
    ].join("\n"));
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 类型检查器返回错误（非 ENOENT）→ passed:false（③c）", () => {
    typecheckMode.mode = "fail"; // tsc mock 失败
    const topicDir = makeTmpTopicDir();
    writeValidCodeArch(topicDir);
    writeApprovedReview(topicDir);
    writeCleanSkeleton(topicDir);
    const out = runCheckCodeArch(topicDir);
    expect(out.passed).toBe(false);
  });

  it("写报告到 changes/machine-check-code-arch.md", () => {
    const topicDir = makeTmpTopicDir();
    writeValidCodeArch(topicDir);
    writeApprovedReview(topicDir);
    runCheckCodeArch(topicDir);
    const reportPath = join(topicDir, "changes", "machine-check-code-arch.md");
    expect(existsSync(reportPath)).toBe(true);
    const content = readFileSync(reportPath, "utf8");
    expect(content).toContain("machine_check:");
  });
});
