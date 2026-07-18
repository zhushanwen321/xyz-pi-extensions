// Batch 3 prompt quality 验证
//
// U1: explorer.md 黑名单格式（替代旧白名单）
// U2: oracle.md / reviewer.md 交叉 scope defer 声明
// U3: context-builder.md / planner.md 输出载体互斥声明
// E1: tool-workflow-script.ts description + promptGuidelines discovery 提示 + anti-pattern
// E2: 5 个 agent .md 改动后仍保留有效 frontmatter

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

function readAgent(name: string): string {
  return readSrc(join("agents", `${name}.md`));
}

// ── U1: explorer 黑名单 ──────────────────────────────────────

describe("U1: explorer.md 黑名单替代白名单", () => {
  const explorer = readAgent("explorer");

  it("包含 NEVER run 黑名单标题", () => {
    expect(explorer).toContain("NEVER run");
  });

  it("黑名单含 git 写操作", () => {
    expect(explorer).toContain("git commit");
    expect(explorer).toContain("git push");
    expect(explorer).toContain("git reset");
    expect(explorer).toContain("git checkout");
  });

  it("不含旧白名单措辞", () => {
    expect(explorer).not.toContain("Your bash access is for exploration only");
    expect(explorer).not.toContain("unlisted commands");
  });

  it("包含 Free to run 只读白名单", () => {
    expect(explorer).toContain("Free to run");
    expect(explorer).toContain("git log");
    expect(explorer).toContain("git diff");
  });
});

// ── U2: oracle ↔ reviewer scope defer ─────────────────────────

describe("U2: oracle/reviewer 交叉 scope defer", () => {
  const oracle = readAgent("oracle");
  const reviewer = readAgent("reviewer");

  it("oracle 声明 requirements alignment 职责范围", () => {
    expect(oracle).toContain("requirements alignment only");
  });

  it("oracle 发现 code bugs 时 defer reviewer", () => {
    expect(oracle.toLowerCase()).toContain("defer to a reviewer");
  });

  it("reviewer 声明 code-level issues 职责范围", () => {
    expect(reviewer).toContain("code-level issues only");
  });

  it("reviewer 发现 requirements gap 时 defer oracle/planner", () => {
    expect(reviewer.toLowerCase()).toContain("defer to an oracle or planner");
  });
});

// ── U3: context-builder ↔ planner 输出载体互斥 ────────────────

describe("U3: context-builder/planner 输出载体互斥", () => {
  const ctxBuilder = readAgent("context-builder");
  const planner = readAgent("planner");

  it("context-builder 声明 meta-prompt 载体", () => {
    expect(ctxBuilder).toContain("meta-prompt");
    expect(ctxBuilder).toContain("task description for another agent");
  });

  it("context-builder 禁止 step-by-step plan", () => {
    expect(ctxBuilder).toContain("do NOT produce a step-by-step plan");
  });

  it("planner 声明 numbered plan 载体", () => {
    expect(planner).toContain("numbered");
    expect(planner).toContain("execution guide for a worker");
  });

  it("planner 禁止 meta-prompt / requirements analysis", () => {
    expect(planner).toContain("do NOT produce a meta-prompt");
  });
});

// ── E1: tool-workflow-script.ts discovery + anti-pattern ───────

describe("E1: workflow-script tool description + anti-pattern", () => {
  const src = readSrc(join("src", "interface", "tool-workflow-script.ts"));

  it("description 含 discovery 优先提示", () => {
    expect(src).toContain("Before generating");
    expect(src).toContain("action:list");
  });

  it("promptGuidelines 含 ANTI-PATTERN 条目", () => {
    expect(src).toContain("ANTI-PATTERN");
  });

  it("anti-pattern 引用内置 workflow 名称（chain 非 sequential）", () => {
    expect(src).toContain("chain/parallel/scatter-gather/map-reduce");
  });
});

// ── E2: 5 个 agent .md frontmatter 完整性 ─────────────────────

describe("E2: agent .md frontmatter 保留有效格式", () => {
  const agents = ["explorer", "oracle", "reviewer", "context-builder", "planner"];

  for (const name of agents) {
    it(`${name}.md 以 --- 开头且含 name + description 字段`, () => {
      const md = readAgent(name);
      expect(md.startsWith("---")).toBe(true);
      expect(md).toContain(`name: ${name}`);
      expect(md).toMatch(/^description:\s+.+/m);
    });
  }
});
