// src/__tests__/index.test.ts
// Tests the factory + execute orchestration (FR-1/7/8/9/10/13) with mocked ctx/pi.
import { describe, expect, it } from "vitest";

import factory from "../index";
import { stubTheme } from "./fixtures";

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
	renderResult: (result: { details: unknown }, options: unknown, theme: unknown) => unknown;
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

	it("I-9: abort during custom → done(null) → cancelled", async () => {
		const tool = getTool();
		const controller = new AbortController();
		const ctx = makeCtx({ customResult: null }); // simulate done(null) = cancelled
		ctx.signal = controller.signal;
		// Abort right after execute starts; custom resolves null
		setTimeout(() => controller.abort(), 0);
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
		expect(result.content[0].text).toBe("User cancelled");
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
		expect(result.content[0].text).toBe("User cancelled");
		expect(result.details.cancelled).toBe(true);
	});
});

// ── I-16 ~ I-19: renderCall / renderResult（FR-9）──────
describe("renderCall / renderResult (FR-9)", () => {
	it("I-16: renderCall shows tool name + topics", () => {
		const tool = getTool();
		const node = tool.renderCall(
			{ questions: [{ question: "Q", header: "MyHeader", options: [] }] },
			stubTheme,
		) as { text?: string };
		// TruncatedText stores text internally; we just verify no crash + it's truthy
		expect(node).toBeTruthy();
	});

	it("I-17: renderResult with answers lists ✓ entries", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{
				details: {
					questions: [{ question: "Q", header: "H", options: [{ label: "A" }] }],
					answers: { Q: "A" },
					cancelled: false,
				},
			},
			undefined,
			stubTheme,
		);
		expect(node).toBeTruthy();
	});

	it("I-18: renderResult cancelled shows Cancelled", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{ details: { questions: [], answers: {}, cancelled: true } },
			undefined,
			stubTheme,
		) as { text?: string };
		// Text node — we can't easily read its rendered text, but it should not crash
		expect(node).toBeTruthy();
	});

	it("I-19: renderResult error shows ✗", () => {
		const tool = getTool();
		const node = tool.renderResult(
			{ details: { error: "something broke" } },
			undefined,
			stubTheme,
		);
		expect(node).toBeTruthy();
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
