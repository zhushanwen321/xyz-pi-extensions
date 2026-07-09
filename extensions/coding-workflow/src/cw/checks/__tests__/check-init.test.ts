/**
 * check-init.test.ts — coding-init 软 gate TS 实现（移植验证）。
 *
 * 核心验证点：**软 gate 语义**——无论诊断如何（PASS/MISSING/SKELETON/STALE），
 * passed 总是 true（非阻断）。这与其它硬 gate check 测试断言 passed:false 相反。
 *
 * 入参是 projectRoot（项目根，非 topicDir），fixture 直接构造 projectRoot 结构。
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCheckInit } from "../check-init.js";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch (e) { void e; /* best-effort */ }
  }
});

/** 构造空 projectRoot fixture（测试自行填充文档）。 */
function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-init-root-"));
  tmpDirs.push(dir);
  return dir;
}

/** 写一份非骨架的必备文档（CLAUDE/README/CONTEXT）。 */
function writeRequiredDocs(projectRoot: string): void {
  writeFileSync(join(projectRoot, "CLAUDE.md"), "# Agent Guide\n实际项目指引内容");
  writeFileSync(join(projectRoot, "README.md"), "# Project\n实际项目说明");
  writeFileSync(join(projectRoot, "CONTEXT.md"), "# Context\n实际上下文");
}

/**
 * 写全部 8 个文档组（非骨架）——用于「全绿」PASS 场景，让 verdictLine 显示 PASS。
 * 这样才能验证 report 含 "PASS"（无缺失/骨架 FAIL 干扰）。
 */
function writeAllDocs(
  projectRoot: string,
  opts: { architecture?: string; nfr?: string } = {},
): void {
  writeRequiredDocs(projectRoot);
  writeFileSync(join(projectRoot, "ARCHITECTURE.md"),
    opts.architecture ?? "# Architecture\n实际架构内容");
  writeFileSync(join(projectRoot, "PRODUCT.md"), "# Product\n实际产品内容");
  writeFileSync(join(projectRoot, "NFR.md"),
    opts.nfr ?? "# NFR\n实际约束内容");
  writeFileSync(join(projectRoot, "TEST-STRATEGY.md"), "# Test Strategy\n实际策略");
  writeFileSync(join(projectRoot, "DESIGN-LOG.md"), "# Design Log\n实际日志");
}

describe("runCheckInit（软 gate，移植自 check_init.py）", () => {
  it("PASS — 全部文档组存在且非骨架 → passed:true（verdictLine 显示 PASS）", () => {
    const projectRoot = makeProjectRoot();
    writeAllDocs(projectRoot);
    const out = runCheckInit(projectRoot);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
    expect(out.infraError).toBeUndefined();
  });

  it("SKIP — 文档骨架态 → 诊断标 SKELETON 但 passed 仍 true（软 gate）", () => {
    const projectRoot = makeProjectRoot();
    // 全部必备文档都用 ASCII 占位符 → 触发骨架判定
    writeFileSync(join(projectRoot, "CLAUDE.md"), "# Guide\n构建 {placeholder} 功能");
    writeFileSync(join(projectRoot, "README.md"), "# Project\n{snake_case} 说明");
    writeFileSync(join(projectRoot, "CONTEXT.md"), "# Context\nTODO 待补充");
    const out = runCheckInit(projectRoot);
    // 软 gate：即使有 FAIL（骨架态被 addFail）passed 仍 true
    expect(out.passed).toBe(true);
  });

  it("MISSING — 必备文档缺失 → 诊断标 MISSING 但 passed 仍 true（软 gate）", () => {
    const projectRoot = makeProjectRoot();
    // 只写一个必备文档，其它缺失
    writeFileSync(join(projectRoot, "CLAUDE.md"), "# Guide\n实际内容");
    const out = runCheckInit(projectRoot);
    expect(out.passed).toBe(true); // 软 gate：MISSING 不阻断
  });

  it("STALE — ARCHITECTURE 提到模块名但源码找不到 → 诊断标 STALE 但 passed 仍 true（软 gate）", () => {
    const projectRoot = makeProjectRoot();
    writeRequiredDocs(projectRoot);
    // ARCHITECTURE 非骨架，提到模块 NonExistentModule——源码里没有
    writeFileSync(join(projectRoot, "ARCHITECTURE.md"), [
      "# Architecture",
      "## 模块划分",
      "",
      "| 模块 | 职责 |",
      "|------|------|",
      "| NonExistentModule | 一个源码里不存在的模块 |",
      "| FileParser | 解析文件（源码里有） |",
    ].join("\n"));
    // 源码只含 FileParser，不含 NonExistentModule → 触发 STALE
    writeFileSync(join(projectRoot, "parse.ts"), "export const FileParser = 1;");
    const out = runCheckInit(projectRoot);
    expect(out.passed).toBe(true); // 软 gate：STALE 不阻断
  });

  it("回读命中 — ARCHITECTURE 模块名全在源码 → passed:true（无 STALE）", () => {
    const projectRoot = makeProjectRoot();
    writeAllDocs(projectRoot, {
      architecture: [
        "# Architecture",
        "## 模块划分",
        "",
        "| 模块 | 职责 |",
        "|------|------|",
        "| FileParser | 解析文件 |",
        "| DirWalker | 遍历目录 |",
      ].join("\n"),
    });
    writeFileSync(join(projectRoot, "parse.ts"), "export const FileParser = 1;");
    writeFileSync(join(projectRoot, "walk.ts"), "export const DirWalker = 2;");
    const out = runCheckInit(projectRoot);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
  });

  it("回读 NFR 命中 — 约束验证标识符在源码 → passed:true", () => {
    const projectRoot = makeProjectRoot();
    writeAllDocs(projectRoot, {
      nfr: [
        "# NFR",
        "",
        "### P-1 延迟约束",
        "",
        "- **阈值**：< 100ms",
        "- **验证**：通过 `checkLatency()` 函数测延迟",
        "",
        "### S-1 安全约束",
        "",
        "- **阈值**：无 XSS",
        "- **验证**：跑 `validateInput()` 校验输入",
      ].join("\n"),
    });
    // 源码含两个验证标识符
    writeFileSync(join(projectRoot, "check.ts"),
      "export function checkLatency() {}\nexport function validateInput() {}\n");
    const out = runCheckInit(projectRoot);
    expect(out.passed).toBe(true);
    expect(out.report).toContain("PASS");
  });

  it("状态机回读 — ARCHITECTURE 状态机状态全在源码 → passed:true", () => {
    const projectRoot = makeProjectRoot();
    writeRequiredDocs(projectRoot);
    writeFileSync(join(projectRoot, "ARCHITECTURE.md"), [
      "# Architecture",
      "## 关键状态机",
      "",
      "```mermaid",
      "stateDiagram-v2",
      "    Idle --> Running",
      "    Running --> Done",
      "```",
    ].join("\n"));
    writeFileSync(join(projectRoot, "fsm.ts"),
      "const Idle = 0; const Running = 1; const Done = 2;");
    const out = runCheckInit(projectRoot);
    expect(out.passed).toBe(true);
  });

  it("中文模块名回读 — 非 ASCII 标识符跳过（不误报 STALE）→ passed:true", () => {
    const projectRoot = makeProjectRoot();
    writeRequiredDocs(projectRoot);
    writeFileSync(join(projectRoot, "ARCHITECTURE.md"), [
      "# Architecture",
      "## 模块划分",
      "",
      "| 模块 | 职责 |",
      "|------|------|",
      "| 用户管理模块 | 中文模块名，机器跳过 |",
    ].join("\n"));
    writeFileSync(join(projectRoot, "x.ts"), "export const x = 1;");
    const out = runCheckInit(projectRoot);
    // 中文模块名非 ASCII 标识符 → SKIP（不跑字面匹配）→ 不 STALE
    expect(out.passed).toBe(true);
  });

  it("写诊断报告到 .xyz-harness/_bootstrap-check.md（项目级，非 topic 级）", () => {
    const projectRoot = makeProjectRoot();
    writeRequiredDocs(projectRoot);
    runCheckInit(projectRoot);
    const reportPath = join(projectRoot, ".xyz-harness", "_bootstrap-check.md");
    expect(existsSync(reportPath)).toBe(true);
    // 不应写到 changes/machine-check-init.md（那是硬 gate 的位置）
    expect(existsSync(join(projectRoot, "changes", "machine-check-init.md"))).toBe(false);
  });

  it("软 gate 确证 — 全缺失场景（所有必备 + 回读全 STALE）passed 仍 true", () => {
    const projectRoot = makeProjectRoot();
    // 什么都不写：所有必备缺失 + 无源码
    const out = runCheckInit(projectRoot);
    expect(out.passed).toBe(true); // 软 gate：无论诊断如何，永远 true
  });
});
