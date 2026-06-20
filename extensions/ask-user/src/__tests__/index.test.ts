// src/__tests__/index.test.ts
// Tests the factory + execute orchestration (FR-1/7/8/9/10/13) with mocked ctx/pi.
import { describe, expect, it } from "vitest";

import factory from "../index";
import { mockTui, stubTheme } from "./fixtures";

// ── Types for the registered tool ───────────────────────
interface RegisteredTool {
	name: string;
	label: string;
	parameters: unknown;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: unknown,
		ctx: {
			hasUI: boolean;
			signal?: AbortSignal;
			ui: {
				custom<T = void>(
					factory: (...args: unknown[]) => unknown,
					options?: { overlay?: boolean },
				): Promise<T>;
			};
		},
	) => Promise<Record<string, unknown>>;
	renderCall: (args: Record<string, unknown>, theme: unknown) => unknown;
	renderResult: (result: { details: unknown }, options: { expanded: boolean }, theme: unknown) => unknown;
}

interface MockPi {
	tool?: RegisteredTool;
	registerTool(tool: RegisteredTool): void;
	getAllTools(): { name: string }[];
	activeTools?: string[] | null;
	setActiveTools(names: string[]): void;
}

/** Runs the factory, returns the captured registered tool. */
const getTool = (overrides: Partial<MockPi> = {}): RegisteredTool => {
	const pi: MockPi = {
		registerTool(tool) {
			this.tool = tool;
		},
		getAllTools() {
			return [{ name: "ask_user" }, { name: "other_tool" }];
		},
		setActiveTools(names) {
			this.activeTools = names;
		},
		...overrides,
	};
	factory(pi as never);
	if (!pi.tool) throw new Error("factory did not register a tool");
	return pi.tool;
};

// ── Mock ctx builder ────────────────────────────────────
const makeCtx = (
	overrides: Partial<{
		hasUI: boolean;
		customResult: unknown;
		customThrows: Error | null;
	}> = {},
) => {
	const { hasUI = true, customResult = null, customThrows = null } = overrides;
	return {
		hasUI,
		signal: undefined as AbortSignal | undefined,
		ui: {
			custom: async <T = void>(..._args: unknown[]): Promise<T> => {
				if (customThrows) throw customThrows;
				return customResult as T;
			},
		},
	};
};

const validSingle = {
	questions: [
		{
			question: "Which DB?",
			options: [{ label: "Postgres" }, { label: "SQLite" }],
		},
	],
};

// ── I-1 ~ I-4: 参数校验（AC-8/13）──────────────────────
describe("execute — validation (FR-2 / AC-8 / AC-13)", () => {
	it("I-1: duplicate question → isError", async () => {
		const tool = getTool();
		const result = await tool.execute(
			"id",
			{
				questions: [
					{ question: "Same", options: [{ label: "A" }, { label: "B" }] },
					{ question: "Same", options: [{ label: "C" }, { label: "D" }] },
				],
			},
			undefined,
			undefined,
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Duplicate");
	});

	it("I-2: duplicate option label → isError", async () => {
		const tool = getTool();
		const result = await tool.execute(
			"id",
			{
				questions: [
					{ question: "Q", options: [{ label: "A" }, { label: "A" }] },
				],
			},
			undefined,
			undefined,
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Duplicate option");
	});

	it("I-3: multi-question missing header → isError", async () => {
		const tool = getTool();
		const result = await tool.execute(
			"id",
			{
				questions: [
					{ question: "Q1", header: "H1", options: [{ label: "A" }, { label: "B" }] },
					{ question: "Q2", options: [{ label: "C" }, { label: "D" }] },
				],
			},
			undefined,
			undefined,
			makeCtx(),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("header");
	});

	it("I-4: validation error details.cancelled = true", async () => {
		const tool = getTool();
		const result = await tool.execute(
			"id",
			{ questions: [{ question: "Q", options: [{ label: "A" }, { label: "A" }] }] },
			undefined,
			undefined,
			makeCtx(),
		);
		expect(result.details.cancelled).toBe(true);
	});
});

// ── I-5 ~ I-7: Headless（FR-8 / AC-7）──────────────────
describe("execute — headless (FR-8 / AC-7)", () => {
	it("I-5: hasUI=false → isError with interactive-session message", async () => {
		const tool = getTool();
		const result = await tool.execute("id", validSingle, undefined, undefined, makeCtx({ hasUI: false }));
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("interactive");
	});

	it("I-6: hasUI=false disables ask_user tool via setActiveTools", async () => {
		const tool = getTool();
		await tool.execute("id", validSingle, undefined, undefined, makeCtx({ hasUI: false }));
		// The mock setActiveTools stores into activeTools; getAllTools returns ask_user + other_tool.
		// We verify by checking the pi mock captured a filtered list.
		// Re-run with a pi that records the call.
		let captured: string[] | null = null;
		const pi = {
			registerTool() {},
			getAllTools: () => [{ name: "ask_user" }, { name: "other" }],
			setActiveTools: (names: string[]) => {
				captured = names;
			},
		};
		factory(pi as never);
		// Re-extract tool — factory already registered, but registerTool is no-op above.
		// Use the getTool approach with override instead:
		const tool2 = getTool({
			getAllTools: () => [{ name: "ask_user" }, { name: "other" }],
			setActiveTools: (names: string[]) => {
				captured = names;
			},
		});
		await tool2.execute("id", validSingle, undefined, undefined, makeCtx({ hasUI: false }));
		expect(captured).not.toContain("ask_user");
		expect(captured).toContain("other");
	});

	it("I-7: hasUI=false details.cancelled = true", async () => {
		const tool = getTool();
		const result = await tool.execute("id", validSingle, undefined, undefined, makeCtx({ hasUI: false }));
		expect(result.details.cancelled).toBe(true);
	});
});

// ── I-8 ~ I-9: Signal abort（FR-10 / AC-14）────────────
describe("execute — signal abort (FR-10 / AC-14)", () => {
	it("I-8: pre-aborted signal → returns cancelled immediately", async () => {
		const tool = getTool();
		const controller = new AbortController();
		controller.abort();
		const ctx = makeCtx();
		ctx.signal = controller.signal;
		const result = await tool.execute("id", validSingle, controller.signal, undefined, ctx);
		expect(result.content[0].text).toContain("cancelled");
		expect(result.details.cancelled).toBe(true);
	});

	it("I-9: abort during custom → factory registers listener → done(null) → cancelled", async () => {
		const tool = getTool();
		const controller = new AbortController();
		// 真正调用 factory，使源码中的 signal.addEventListener("abort", () => done(null)) 被注册。
		// 此前 mock 直接返回 customResult、从不调用 factory，该 abort 监听器是 dead path。
		// 现在中断后监听器调用 done(null)，custom 解析为 null → cancelled。
		const ctx = {
			hasUI: true,
			signal: controller.signal,
			ui: {
				custom: <T = void>(factory: (...args: unknown[]) => unknown): Promise<T> =>
					new Promise((resolve) => {
						const done = (r: T): void => resolve(r);
						factory(mockTui, stubTheme, {}, done);
						setTimeout(() => controller.abort(), 0);
					}),
			},
		};
		const result = await tool.execute("id", validSingle, controller.signal, undefined, ctx);
		expect(result.details.cancelled).toBe(true);
	});
});

// ── I-10 ~ I-11: 错误兜底（FR-13 / AC-15）─────────────
describe("execute — error fallback (FR-13 / AC-15)", () => {
	it("I-10: ui.custom throws → isError with 'ask_user failed'", async () => {
		const tool = getTool();
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ customThrows: new Error("boom") }),
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("ask_user failed");
		expect(result.content[0].text).toContain("boom");
	});

	it("I-11: error details contains error message", async () => {
		const tool = getTool();
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ customThrows: new Error("crash") }),
		);
		expect(result.details.error).toBe("crash");
	});
});

// ── I-12 ~ I-15: 正常返回与取消（FR-7）─────────────────
describe("execute — result handling (FR-7)", () => {
	it("I-12: normal result returns answer summary", async () => {
		const tool = getTool();
		const fakeResult = {
			questions: [{ question: "Which DB?", options: [{ label: "Postgres" }] }],
			answers: { "Which DB?": "Postgres" },
			cancelled: false,
		};
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ customResult: fakeResult }),
		);
		expect(result.content[0].text).toContain("Postgres");
		expect(result.details.cancelled).toBe(false);
	});

	it("I-13: details passes through questions + answers", async () => {
		const tool = getTool();
		const fakeResult = {
			questions: [{ question: "Which DB?", options: [{ label: "Postgres" }] }],
			answers: { "Which DB?": "Postgres" },
			cancelled: false,
		};
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ customResult: fakeResult }),
		);
		expect(result.details.questions).toEqual(fakeResult.questions);
		expect(result.details.answers["Which DB?"]).toBe("Postgres");
	});

	it("I-14: cancelled (null) → 'User cancelled'", async () => {
		const tool = getTool();
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ customResult: null }),
		);
		expect(result.content[0].text).toContain("User cancelled");
		// P1-2: cancel message must guide the LLM not to assume an answer
		expect(result.content[0].text).toContain("Do not assume");
		expect(result.details.cancelled).toBe(true);
	});

	it("I-15: result.cancelled=true treated as cancel", async () => {
		const tool = getTool();
		const fakeResult = {
			questions: [],
			answers: {},
			cancelled: true,
		};
		const result = await tool.execute(
			"id",
			validSingle,
			undefined,
			undefined,
			makeCtx({ customResult: fakeResult }),
		);
		expect(result.content[0].text).toContain("User cancelled");
		expect(result.content[0].text).toContain("Do not assume");
		expect(result.details.cancelled).toBe(true);
	});
});

// ── I-16 ~ I-19: renderCall / renderResult（FR-9）──────

/** 渲染一个 Component 节点到连接后的纯文本（剥除 stubTheme passthrough 后即原始字符串）。 */
const renderText = (node: { render(width: number): string[] }, width = 80): string =>
	node.render(width).join("\n");

describe("renderCall / renderResult (FR-9)", () => {
	it("I-16: renderCall shows tool name + header topics", () => {
		const tool = getTool();
		const node = tool.renderCall(
			{ questions: [{ question: "Q", header: "MyHeader", options: [] }] },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		const text = renderText(node);
		expect(text).toContain("ask_user");
		expect(text).toContain("MyHeader");
	});

	it("I-16b: renderCall falls back to truncated question when no header", () => {
		const tool = getTool();
		const node = tool.renderCall(
			{ questions: [{ question: "This is a very long question text", options: [] }] },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		// 无 header → 用 truncateToWidth(question, 12)：按显示宽度截断（带省略号），
		// 不再按 UTF-16 slice，emoji 代理对安全。
		const text = renderText(node);
		expect(text).toContain("ask_user");
		expect(text).not.toContain("This is a very long question text");
	});

	it("I-16c: renderCall tolerates missing questions (?? [] defensive branch)", () => {
		// S-10: args.questions 缺失时 ?? [] 兜底，不崩溃、渲染工具名（topics 为空）
		const tool = getTool();
		const node = tool.renderCall({} as never, stubTheme) as unknown as {
			render(width: number): string[];
		};
		expect(renderText(node)).toContain("ask_user");
	});

	it("I-17: renderResult with answers lists ✓ <header>: <answer>", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{
				details: {
					questions: [{ question: "Q", header: "H", options: [{ label: "A" }] }],
					answers: { Q: "A" },
					cancelled: false,
				},
			},
			{ expanded: false },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		const text = renderText(node);
		expect(text).toContain("✓");
		expect(text).toContain("H:");
		expect(text).toContain("A");
	});

	it("I-17b: renderResult shows (no answer) when question unanswered in details", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{
				details: {
					questions: [{ question: "Q", header: "H", options: [{ label: "A" }] }],
					answers: {},
					cancelled: false,
				},
			},
			{ expanded: false },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		expect(renderText(node)).toContain("(no answer)");
	});

	it("I-18: renderResult cancelled shows Cancelled", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{ details: { questions: [], answers: {}, cancelled: true } },
			{ expanded: false },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		expect(renderText(node)).toContain("Cancelled");
	});

	it("I-19: renderResult error shows ✗ <error>", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{ details: { error: "something broke" } },
			{ expanded: false },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		const text = renderText(node);
		expect(text).toContain("✗");
		expect(text).toContain("something broke");
	});

	// S-3: options.expanded 展开 —— 显示全部选项 + ●/○ 选中标记（spec FR-9）
	it("I-20: renderResult expanded shows all options with ●/○ marks", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{
				details: {
					questions: [
						{
							question: "Which DB?",
							header: "DB",
							options: [{ label: "Postgres" }, { label: "SQLite" }],
						},
					],
					answers: { "Which DB?": "Postgres" },
					cancelled: false,
				},
			},
			{ expanded: true },
			stubTheme,
		) as unknown as { render(width: number): string[] };
		const text = renderText(node);
		// 两个选项都展开显示
		expect(text).toContain("Postgres");
		expect(text).toContain("SQLite");
		// 选中的 Postgres 用 ●，未选的 SQLite 用 ○
		expect(text).toContain("●");
		expect(text).toContain("○");
	});
});

// ── FR-1: tool registration shape ───────────────────────
describe("factory registration (FR-1)", () => {
	it("registers tool named 'ask_user' with full metadata", () => {
		const tool = getTool();
		expect(tool.name).toBe("ask_user");
		expect(tool.label).toBe("Ask User");
		expect(tool.description).toBeTruthy();
		expect(tool.parameters).toBeTruthy();
		expect(typeof tool.execute).toBe("function");
		expect(typeof tool.renderCall).toBe("function");
		expect(typeof tool.renderResult).toBe("function");
	});
});
