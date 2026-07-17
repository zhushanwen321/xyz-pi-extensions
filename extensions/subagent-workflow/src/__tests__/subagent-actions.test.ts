/**
 * subagent-actions adapter + BG_MESSAGE + tool description 强化测试（FR-4/FR-5/FR-6/AC-4）。
 *
 * 修复目标：阻止 LLM 在 subagent 完成后继续轮询 subagent_list。三处冗余强化：
 *   1. adapter list action 返回 content 追加 reminder text block（每次 list 都看到）
 *   2. BG_MESSAGE 常量强化（启动时一次）
 *   3. tool description 强化（schema 阶段）
 *
 * 测试覆盖：adapter list 返回 content 数组含 reminder；BG_MESSAGE 字符串含
 * 'auto-injected' 关键词；description 源码含 'auto-injected'/'do not poll' 关键词。
 *
 * adapter import 不依赖 pi SDK（纯函数），可直接调用。description 测试用源码断言
 * （与 subagent-tool-prompt.test.ts 一致策略）。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { adapter } from "../interface/subagent-actions.ts";
import type { ListHandlerResult } from "../interface/subagent-actions.ts";

// ── adapter reminder test fixtures ──

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUBAGENT_TOOL_SRC = readFileSync(
	join(__dirname, "../interface/subagent-tool.ts"),
	"utf-8",
);

const SUBAGENT_ACTIONS_SRC = readFileSync(
	join(__dirname, "../interface/subagent-actions.ts"),
	"utf-8",
);

/** 构造一个空 list domain object（adapter 需要 listResponse 字段）。 */
function emptyListResult(): ListHandlerResult {
	return { response: { running: 0, items: [] } };
}

/** 构造一个 running list domain object（adapter 需要 listResponse 字段）。 */
function runningListResult(running: number, count: number): ListHandlerResult {
	const items = Array.from({ length: count }, (_, i) => ({
		subagentId: `bg-${i}`,
		agent: "worker",
		slug: `task-${i}`,
		status: "running" as const,
		mode: "background" as const,
		duration: 0,
		model: "m",
		totalTokens: 0,
		sessionFile: undefined,
	}));
	return { response: { running, items } };
}

describe("subagent-actions adapter list action reminder (FR-4/AC-4)", () => {
	it("list action 返回 content 是数组且第二个 text block 含 'auto-notif' 关键词", () => {
		// 模拟 service 调用 listHandler（不依赖 service 实例，构造 domain object 直接喂 adapter）
		const result = adapter({ action: "list", domain: emptyListResult() });

		// content 是数组（保证 reminder 不破坏 JSON 结构）
		expect(Array.isArray(result.content)).toBe(true);
		expect(result.content.length).toBeGreaterThanOrEqual(2);

		// 第二个 text block 是 reminder
		const reminderBlock = result.content[1];
		expect(reminderBlock.type).toBe("text");
		expect((reminderBlock as { text: string }).text).toMatch(/auto-notif|do not poll/i);
	});

	it("running list 同样带 reminder（与空 list 行为一致）", () => {
		const result = adapter({ action: "list", domain: runningListResult(2, 2) });

		expect(result.content.length).toBeGreaterThanOrEqual(2);
		expect((result.content[1] as { text: string }).text).toMatch(/auto-notif|do not poll/i);
	});
});

describe("BG_MESSAGE 强化 (FR-5)", () => {
	/** 从源码里提取 const BG_MESSAGE = "..." 的字符串值。 */
	function extractBgMessage(src: string): string {
		const m = src.match(/const\s+BG_MESSAGE\s*=\s*"([^"]*)"/);
		if (!m) throw new Error("BG_MESSAGE constant not found");
		return m[1];
	}

	it("subagent-actions.ts 源码 BG_MESSAGE 字符串含 'auto-injected' 或 'do not poll' 关键词", () => {
		const value = extractBgMessage(SUBAGENT_ACTIONS_SRC);
		expect(value).toMatch(/auto-injected|do not poll/i);
	});
});

describe("subagent tool description 强化 (FR-6)", () => {
	/** 提取 description: `...` 模板字符串的原始内容。 */
	function extractDescription(src: string): string {
		const m = src.match(/description:\s*`([\s\S]*?)`,/);
		if (!m) throw new Error("description template literal not found");
		return m[1];
	}

	it("description 'do NOT wait' 段含 'auto-injected' 关键词", () => {
		const description = extractDescription(SUBAGENT_TOOL_SRC);
		// 定位 "After launching" 段（section header）
		const idx = description.indexOf("## After launching");
		expect(idx).toBeGreaterThan(-1);
		const section = description.slice(idx, idx + 600);
		expect(section).toMatch(/auto-injected/i);
	});
});