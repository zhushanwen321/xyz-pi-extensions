// Medium batch 3: M2 thinkingLevel propagation + M3 model empty string semantics
//
// M2: AgentCallOpts has thinkingLevel field + resolveAgentOpts propagates it from agent .md
// M3: resolveAgentOpts uses === undefined check (not ||) for model fallback

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

// ── M2: AgentCallOpts has thinkingLevel ───────────────────────

describe("M2: AgentCallOpts has thinkingLevel field", () => {
  const src = readSrc(join("src", "orchestration", "models", "types.ts"));

  it("AgentCallOpts interface declares thinkingLevel", () => {
    // 找到 AgentCallOpts interface 块，断言含 thinkingLevel 字段
    const ifaceMatch = src.match(/export interface AgentCallOpts \{[\s\S]*?\}/);
    expect(ifaceMatch).toBeTruthy();
    expect(ifaceMatch![0]).toContain("thinkingLevel");
  });
});

describe("M2: resolveAgentOpts propagates thinkingLevel from agent .md", () => {
  const src = readSrc(join("src", "orchestration", "agent-opts-resolver.ts"));

  it("resolveAgentOpts sets thinkingLevel from discovered agent config", () => {
    // 断言 resolveAgentOpts 中有 thinkingLevel 传播逻辑
    expect(src).toMatch(/thinkingLevel.*discovered\.thinkingLevel|discovered\.thinkingLevel.*thinkingLevel/);
  });
});

// ── M3: model empty string semantics ─────────────────────────

describe("M3: resolveAgentOpts uses === undefined for model fallback", () => {
  const src = readSrc(join("src", "orchestration", "agent-opts-resolver.ts"));

  it("model fallback uses explicit undefined check, not ||", () => {
    // 旧代码：opts.model || discovered.model（空串被当 falsy 替换）
    // 新代码：opts.model === undefined ? discovered.model : opts.model
    // 断言不使用 || 做 model fallback
    const modelFallback = src.match(/opts\.model\s*\|\|\s*discovered\.model/);
    expect(modelFallback).toBeNull();
    // 断言使用 === undefined
    expect(src).toMatch(/opts\.model\s*===\s*undefined\s*\?\s*discovered\.model/);
  });
});
