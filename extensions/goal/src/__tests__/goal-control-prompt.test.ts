// 提示词质量回归：goal_control tool description + runtime 错误文案必须是
// "可纠正的行为约束器"，而非干巴巴的错误。
//
// agent（LLM）唯一能看到的 tool 元信息就是 description + 报错文案。弱模型
// （如 step-3.7-flash）会在首次调用时省略条件必填字段（create 漏 slug、
// complete 漏 evidence——complete 需模型主动生成内容，省略动因最强）。
// description 补完整 JSON 正例 + 结构反例，runtime throw 补 "Correct:" 纠正
// 正例，能让弱模型在首轮或报错后无需猜测即可对齐。
//
// 本测试用源码断言（读 .ts 文件文本）锁定这些约束，防止后续重构把正例/反例
// 或纠错文案删掉。读源码而非 import，避免 mock 链（goal-control-adapter.ts
// 依赖 pi-ai/typebox/pi-tui/ExtensionAPI 等值导入）。
//
// 模式参考：subagent-workflow/src/interface/__tests__/subagent-tool-prompt.test.ts。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADAPTER_SRC = readFileSync(
	join(__dirname, "../adapters/goal-control-adapter.ts"),
	"utf-8",
);

/** 提取 description: `...` 模板字符串的原始内容。 */
function extractDescription(src: string): string {
	const m = src.match(/description:\s*`([\s\S]*?)`/);
	if (!m) throw new Error("description template literal not found");
	return m[1];
}

const DESCRIPTION = extractDescription(ADAPTER_SRC);

describe("goal_control description — 含完整 JSON 正例（弱模型首轮误用防御）", () => {
	it("含 create 正例子串", () => {
		// create 是弱模型最易漏 slug 的 action；完整 JSON 正例给出可直接复用的形态。
		expect(DESCRIPTION).toContain('{"action":"create"');
	});

	it("含 complete 正例子串", () => {
		// complete 需模型主动生成 evidence，省略动因最强；正例锁定必填字段。
		expect(DESCRIPTION).toContain('{"action":"complete"');
	});

	it("含 report_blocked 正例子串", () => {
		expect(DESCRIPTION).toContain('{"action":"report_blocked"');
	});
});

describe("goal_control description — 含参数结构反例（Don't 段）", () => {
	it("含 Don't 段", () => {
		expect(DESCRIPTION).toMatch(/Don't/);
	});

	it("Don't 段含 evidence 结构反例关键词（complete 漏 evidence）", () => {
		// complete 漏 evidence 是核心失败模式之一；反例文案必须提及 evidence。
		expect(DESCRIPTION).toMatch(/evidence/);
	});
});

describe("goal_control runtime 错误文案 — 含 'Correct:' 纠正正例（≥4 处）", () => {
	it("源码含 ≥4 处 'Correct:' 纠错文案（4 条 required throw 各一带正例）", () => {
		// objective/slug/evidence/reason 四条必填 throw 各应带完整 JSON 正例，
		// 让弱模型在报错后无需猜测即可纠正。读整份源码统计出现次数。
		const matches = ADAPTER_SRC.match(/Correct:/g) || [];
		expect(matches.length).toBeGreaterThanOrEqual(4);
	});

	it("objective 报错带 Correct 正例", () => {
		expect(ADAPTER_SRC).toMatch(/'objective' is required[\s\S]*?Correct:/);
	});

	it("evidence 报错带 Correct 正例", () => {
		expect(ADAPTER_SRC).toMatch(/'evidence' is required[\s\S]*?Correct:/);
	});
});
