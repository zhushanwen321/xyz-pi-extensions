/**
 * check-architecture.test.ts — full-architecture gate TS 实现（移植验证）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckArchitecture } from "../check-architecture.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch (e) { void e; /* best-effort */ }
  }
});

function makeTmpTopicDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-arch-check-"));
  tmpDirs.push(dir);
  mkdirSync(join(dir, "changes"), { recursive: true });
  return dir;
}

function writeApprovedReview(topicDir: string): void {
  writeFileSync(join(topicDir, "changes", "review-architecture.md"), [
    "---", "verdict: APPROVED", "---", "review stub",
  ].join("\n"));
}

/** 合规 system-architecture.md（含 4 章节 + 设计立场提核心计算 + 模型类型标注）。 */
function writeValidArchitecture(topicDir: string, opts: { withModels?: boolean; withRelation?: boolean } = {}): void {
  const modelSection = opts.withModels === false
    ? "## 核心模型\n无\n"
    : [
        "## 核心模型",
        "",
        "| 模型 | 类型 | 职责 |",
        "|------|------|------|",
        "| **FileNode** | aggregate | 文件节点 |",
        "| **DirNode** | 实体 | 目录节点 |",
        "",
        ...(opts.withRelation === false ? [] : [
          "FileNode 聚合 DirNode（contains 关系）",
          "",
          "```mermaid",
          "classDiagram",
          "  FileNode --> DirNode",
          "```",
        ]),
      ].join("\n");

  writeFileSync(join(topicDir, "system-architecture.md"), [
    "---", "verdict: pass", "---",
    "",
    "# System Architecture",
    "## 目标转换",
    "输入 → 输出",
    "## 设计立场",
    "核心计算是文件解析",
    "",
    modelSection,
    "## 分层架构",
    "L1 / L2 / L3",
  ].join("\n"));
}

describe("runCheckArchitecture（移植自 check_architecture.py）", () => {
  it("PASS — 合规 system-architecture.md → passed:true", () => {
    const topicDir = makeTmpTopicDir();
    writeValidArchitecture(topicDir);
    writeApprovedReview(topicDir);
    const out = runCheckArchitecture(topicDir);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
  });

  it("FAIL — 交付物不存在 → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeApprovedReview(topicDir);
    const out = runCheckArchitecture(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 缺关键章节（无「设计立场」）→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "system-architecture.md"), [
      "---", "verdict: pass", "---",
      "", "# SA",
      "## 目标转换", "x",
      "## 核心模型", "无",
      "## 分层架构", "x",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckArchitecture(topicDir);
    expect(out.passed).toBe(false);
  });

  it("FAIL — 设计立场未提「核心计算」→ passed:false", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "system-architecture.md"), [
      "---", "verdict: pass", "---",
      "", "# SA",
      "## 目标转换", "x",
      "## 设计立场", "做某个东西",
      "## 核心模型", "无",
      "## 分层架构", "x",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckArchitecture(topicDir);
    expect(out.passed).toBe(false);
  });

  it("SKIP 模型关联图 — 单模型 → 不 fail（skip）", () => {
    const topicDir = makeTmpTopicDir();
    writeFileSync(join(topicDir, "system-architecture.md"), [
      "---", "verdict: pass", "---",
      "", "# SA",
      "## 目标转换", "x",
      "## 设计立场", "核心计算是 Y",
      "## 核心模型",
      "| 模型 | 类型 |",
      "| **SingleModel** | aggregate |",
      "## 分层架构", "x",
    ].join("\n"));
    writeApprovedReview(topicDir);
    const out = runCheckArchitecture(topicDir);
    expect(out.passed).toBe(true); // 单模型 skip，不 fail
  });

  it("FAIL — 多模型有聚合关系但无 classDiagram → passed:false", () => {
    const topicDir = makeTmpTopicDir();
    // 默认 writeValidArchitecture 含 classDiagram + 聚合关键词。
    // 手动 replace 掉 classDiagram 块，保留聚合关键词 → 触发条件强制 FAIL。
    writeValidArchitecture(topicDir);
    const content = readFileSync(join(topicDir, "system-architecture.md"), "utf8");
    writeFileSync(
      join(topicDir, "system-architecture.md"),
      content.replace("```mermaid\nclassDiagram\n  FileNode --> DirNode\n```", ""),
    );
    writeApprovedReview(topicDir);
    const out = runCheckArchitecture(topicDir);
    expect(out.passed).toBe(false);
  });

  it("写报告到 changes/machine-check-architecture.md", () => {
    const topicDir = makeTmpTopicDir();
    writeValidArchitecture(topicDir);
    writeApprovedReview(topicDir);
    runCheckArchitecture(topicDir);
    expect(existsSync(join(topicDir, "changes", "machine-check-architecture.md"))).toBe(true);
  });
});
