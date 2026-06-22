// 测试框架：vitest
// 运行命令：npx vitest run src/engine/models/__tests__/workflow-script.test.ts

import { describe, expect, it } from "vitest";

import { type WorkflowMeta, WorkflowScript, type WorkflowSource } from "../workflow-script.js";
import type { WorkflowScriptRegistry } from "../workflow-script-registry.js";

function makeScript(overrides: {
  sourceCode?: string;
  source?: WorkflowSource;
  meta?: WorkflowMeta;
  available?: boolean;
} = {}): WorkflowScript {
  return new WorkflowScript({
    name: "test-wf",
    source: overrides.source ?? "saved",
    path: "/abs/.pi/workflows/test-wf.js",
    sourceCode: overrides.sourceCode ?? "const meta = { name: 'test-wf' };",
    meta: overrides.meta ?? { name: "test-wf", description: "", phases: [] },
    available: overrides.available ?? true,
  });
}

// ── 构造与字段 ───────────────────────────────────────────────

describe("WorkflowScript 构造", () => {
  it("字段齐全", () => {
    const s = makeScript({
      source: "tmp",
      meta: { name: "tmp-wf", description: "d", phases: ["build"] },
    });
    expect(s.name).toBe("test-wf");
    expect(s.source).toBe("tmp");
    expect(s.available).toBe(true);
    expect(s.meta.phases).toEqual(["build"]);
  });

  it("available=false 时仍可构造（loader 不抛错）", () => {
    const s = makeScript({ available: false, meta: { name: "test-wf", description: "", phases: [] } });
    expect(s.available).toBe(false);
  });
});

// ── validate（T17 前基础检查） ───────────────────────────────

describe("WorkflowScript.validate (basic, pre-T17)", () => {
  it("含 agent() 调用 → valid", () => {
    const s = makeScript({ sourceCode: 'const r = await agent({ prompt: "hi" });' });
    expect(s.validate().valid).toBe(true);
  });

  it("含 parallel() 调用 → valid", () => {
    const s = makeScript({ sourceCode: "await parallel([agent1, agent2]);" });
    expect(s.validate().valid).toBe(true);
  });

  it("含 pipeline() 调用 → valid", () => {
    const s = makeScript({ sourceCode: "await pipeline([stage1, stage2]);" });
    expect(s.validate().valid).toBe(true);
  });

  it("不含任何编排函数 → invalid（含 error finding）", () => {
    const s = makeScript({ sourceCode: 'const x = 1; console.log(x);' });
    const result = s.validate();
    expect(result.valid).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe("error");
    expect(result.findings[0].message).toMatch(/agent\(\)|parallel\(\)|pipeline\(\)/);
  });

  it("findings 为空时 valid=true", () => {
    const s = makeScript({ sourceCode: 'agent("x");' });
    const result = s.validate();
    expect(result.findings).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

// ── toExecutable（strip export） ─────────────────────────────

describe("WorkflowScript.toExecutable", () => {
  it("strip `export const meta` → `const meta`", () => {
    const s = makeScript({
      sourceCode: "export const meta = { name: 'x' };\nconst r = await agent({ prompt: 'hi' });",
    });
    const exec = s.toExecutable();
    expect(exec).toContain("const meta = { name: 'x' };");
    expect(exec).not.toMatch(/\bexport\s+const\s+meta\b/);
  });

  it("不改 sourceCode 原始字段（返回副本）", () => {
    const original = "export const meta = { name: 'x' };";
    const s = makeScript({ sourceCode: original });
    s.toExecutable();
    expect(s.sourceCode).toBe(original); // 未被改
  });

  it("无 export 时原样返回", () => {
    const code = "const meta = { name: 'x' };\nagent('x');";
    const s = makeScript({ sourceCode: code });
    expect(s.toExecutable()).toBe(code);
  });

  it("脚本格式不变（AC-4）—— agent/parallel/pipeline 调用保留", () => {
    const code = "export const meta = { name: 'x' };\nawait parallel([() => agent({ prompt: 'hi' })]);";
    const s = makeScript({ sourceCode: code });
    const exec = s.toExecutable();
    expect(exec).toContain("parallel([");
    expect(exec).toContain("agent({ prompt: 'hi' })");
  });

  it("多个 export const meta 全部 strip", () => {
    const s = makeScript({
      sourceCode: "export const meta = { name: 'x' };\nexport const meta = { name: 'y' };",
    });
    expect(s.toExecutable()).not.toMatch(/\bexport\s+const\s+meta\b/);
  });
});

// ── WorkflowScriptRegistry interface 形状 ─────────────────────

describe("WorkflowScriptRegistry interface", () => {
  it("loadAll/get/invalidate 三方法签名", async () => {
    const registry: WorkflowScriptRegistry = {
      async loadAll() {
        return [makeScript()];
      },
      async get(name) {
        return name === "test-wf" ? makeScript() : undefined;
      },
      invalidate() {
        /* mock */
      },
    };
    const all = await registry.loadAll();
    expect(all).toHaveLength(1);
    const one = await registry.get("test-wf");
    expect(one?.name).toBe("test-wf");
    expect(await registry.get("missing")).toBeUndefined();
    expect(() => registry.invalidate()).not.toThrow();
  });
});
