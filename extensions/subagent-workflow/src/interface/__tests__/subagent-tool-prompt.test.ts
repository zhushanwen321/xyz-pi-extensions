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

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
  it("词数 ≤ 400（高风险 description 密度上限）", () => {
    // 高风险 tool 的 description 应聚焦约束而非功能铺陈；过长会稀释信号。
    const words = DESCRIPTION.trim().split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(400);
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
});
