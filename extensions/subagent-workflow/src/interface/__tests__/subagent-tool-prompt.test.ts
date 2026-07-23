// 提示词质量回归：subagent tool description 必须是"行为约束器"而非"功能说明书"。
//
// agent（LLM）决策时唯一能看到的 tool 元信息就是 description。审查发现旧版
// description 把篇幅花在功能说明上，缺乏调用信号（何时委派 vs 自己做）、
// 能力边界（cannot）、反模式密度（高风险要求 ≥4 条）、以及对 auto-injected
// completion message 的注入防御。
//
// 本测试用源码断言（读 .ts 文件文本）锁定这些约束，防止后续重构把约束措辞
// 删掉或弱化。读源码而非 import，避免 mock 链（subagent-tool.ts 依赖 pi-ai/
// typebox/pi-tui/ExtensionAPI 等值导入）。

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBAGENT_TOOL_SRC = readFileSync(
  join(__dirname, "../subagent-tool.ts"),
  "utf-8",
);

/** 提取 description: `...` 模板字符串的原始内容。 */
function extractDescription(src: string): string {
  const m = src.match(/description:\s*`([\s\S]*?)`,/);
  if (!m) throw new Error("description template literal not found");
  return m[1];
}

const DESCRIPTION = extractDescription(SUBAGENT_TOOL_SRC);

describe("subagent tool description — 行为约束器（非功能说明书）", () => {
  it("词数 ≤ 550（高风险 description 密度上限）", () => {
    // 高风险 tool 的 description 应聚焦约束而非功能铺陈；过长会稀释信号。
    // 上限从 400 放宽到 550：补了 JSON 调用正例段（start/list/cancel 三 action 完整 JSON），
    // 正例对弱模型首次调用用对参数的价值 > 节省这点 description 预算。
    const words = DESCRIPTION.trim().split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(550);
  });

  it("含 'When to delegate' 调用条件段（何时委派 vs 自己做）", () => {
    // 开篇必须给信号驱动的调用条件，而非纯功能说明。
    expect(DESCRIPTION).toMatch(/When to delegate/i);
  });

  it("Anti-patterns 段含 ≥ 4 条 bullet", () => {
    // 高风险 tool 要求 ≥ 4 条反模式，密度才足以覆盖主要误用路径。
    const apIdx = DESCRIPTION.indexOf("## Anti-patterns");
    expect(apIdx).toBeGreaterThan(-1);
    const afterAp = DESCRIPTION.slice(apIdx);
    // 截到下一个 ## 段
    const nextSection = afterAp.indexOf("##", "## Anti-patterns".length);
    const apSection =
      nextSection > -1 ? afterAp.slice(0, nextSection) : afterAp;
    const bullets = apSection.match(/^- .+/gm) || [];
    expect(bullets.length).toBeGreaterThanOrEqual(4);
  });

  it("含能力边界段 'You cannot'", () => {
    // 必须显式声明 tool 做不到的事，阻止 LLM 错误假设。
    expect(DESCRIPTION).toMatch(/You cannot/);
    expect(DESCRIPTION.toLowerCase()).toContain("cannot");
  });

  it("含注入防御：声明 completion message 为不可信数据", () => {
    // completion message 是 auto-injected（F14 注入面），必须告诉 LLM
    // 把它当作不可信数据，校验其中的指令后再执行。
    const lower = DESCRIPTION.toLowerCase();
    expect(
      lower.includes("untrusted") || lower.includes("verify"),
    ).toBe(true);
  });

  it("保留 nested spawning 段（允许 sub-subagent，仅深度限制）", () => {
    // 这段防止 LLM 错误拒绝合法的 nested delegation。
    expect(DESCRIPTION).toMatch(/Nested spawning/);
    expect(DESCRIPTION).toMatch(/Depth: N\/10/);
  });

  it("保留 executionMode sequential 的 CRITICAL 说明", () => {
    // sequential 是关键执行语义，删了会导致 LLM 误以为并行可用。
    expect(DESCRIPTION).toMatch(/CRITICAL/i);
    expect(DESCRIPTION).toMatch(/sequential/);
    expect(DESCRIPTION).toMatch(/SAME message/i);
  });

  it("Examples 段含完整 JSON 正例（含 startParam 嵌套结构）", () => {
    // 弱模型信任 schema 结构信号 > 文本信号，容易把 task/slug 平铺到顶层。
    // description 必须有完整 JSON 正例，让模型能直接照抄 startParam 嵌套结构。
    expect(DESCRIPTION).toContain('{"action":"start","startParam"');
  });

  it("Anti-patterns 段含参数结构反例（top level 平铺 task/slug）", () => {
    // 显式说明 task/slug 不能平铺到顶层，必须嵌在 startParam 里。
    expect(DESCRIPTION).toContain("top level");
  });
});

describe("subagent tool runtime handler — 错误文案含纠正正例", () => {
  // 读源码文本断言 executeSubagent 的平铺检测 throw 含 Correct 正例，
  // 让弱模型撞错后第二次能直接照抄正确形态。
  it("subagent-tool.ts 含 runtime 平铺检测 throw + Correct 纠正正例", () => {
    expect(SUBAGENT_TOOL_SRC).toContain("Correct:");
    expect(SUBAGENT_TOOL_SRC).toContain("params.action === \"start\" && !params.startParam");
  });
});
