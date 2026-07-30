/* eslint-disable taste/no-unsafe-cast */

import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 默认 isEnabled 返回 falsy（开关关闭），符合测试环境无 auto-rename-enabled 文件的语义，
// 也避免依赖开发者机器上真实文件是否存在而 flaky。个别 TC 按需 mockReturnValue。
vi.mock("../pure.js", async (importActual) => {
	const actual = await importActual<typeof import("../pure.js")>();
	return { ...actual, isEnabled: vi.fn() };
});

// mock completeSimple：callRenameLLM 内部动态 import("@earendil-works/pi-ai/compat")，
// vitest 会把该 mock 注入到动态 import 的解析结果。LTC8/10/11/12 通过 vi.mocked 控制其行为。
// vi.mock 被提升到文件顶部执行，故此处 import 拿到的是 mock 后的 completeSimple，与 import 位置无关。
vi.mock("@earendil-works/pi-ai/compat", () => ({
	completeSimple: vi.fn(),
}));

// 被测模块须在 vi.mock 之后 import：vi.mock 被 vitest 提升到文件顶部，被测模块才能拿到 mock 后的依赖。
import renameSessionExtension from "../index";
import { isEnabled } from "../pure.js";

// ── Mock 工具 ───────────────────────────────────────

interface MockSetup {
	pi: ExtensionAPI;
	setSessionNameMock: ReturnType<typeof vi.fn>;
	getAllToolsMock: ReturnType<typeof vi.fn>;
	turnEndHandler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
}

/** getAllTools 返回的固定非空 ToolInfo[]（callRenameLLM 不读工具内容，占位即可） */
const STUB_TOOLS = [
	{ name: "read", description: "read file", parameters: { type: "object" } },
];

function createMockPi(): MockSetup {
	const setSessionNameMock = vi.fn();
	const getAllToolsMock = vi.fn(() => STUB_TOOLS);
	let turnEndHandler!: MockSetup["turnEndHandler"];
	const pi = {
		on: vi.fn((event: string, handler: MockSetup["turnEndHandler"]) => {
			if (event === "turn_end") turnEndHandler = handler;
		}),
		registerCommand: vi.fn(),
		setSessionName: setSessionNameMock,
		getAllTools: getAllToolsMock,
	} as unknown as ExtensionAPI;
	return { pi, setSessionNameMock, getAllToolsMock, get turnEndHandler() { return turnEndHandler; } };
}

/** 扩展 ctx 的可选字段：未传则用主 session 默认值（getSessionDir 返回非 subagents 路径、model/auth 均就绪） */
interface MockCtxOptions {
	entries?: unknown[];
	sessionDir?: string;
	model?: unknown;
	auth?: { ok: true; apiKey?: string } | { ok: false; error: string };
}

function createMockCtx(opts: MockCtxOptions = {}): ExtensionContext {
	const entries = opts.entries ?? [];
	const sessionDir = opts.sessionDir ?? "/home/u/.pi/agent/sessions";
	// 用 in 判断区分「未传字段」（用默认 stub）与「显式传 undefined」（保留 undefined，LTC9 依赖此语义）。
	const model = "model" in opts ? opts.model : { id: "stub-model" };
	const auth = opts.auth ?? { ok: true, apiKey: "stub-key" };
	return {
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "test-session-id",
			getSessionDir: () => sessionDir,
		},
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => auth,
		},
		getSystemPrompt: () => "stub system prompt",
		signal: new AbortController().signal,
	} as unknown as ExtensionContext;
}

const ONE_ASSISTANT = [
	{ type: "message", message: { role: "user" } },
	{ type: "message", message: { role: "assistant" } },
];

/** 触发 turn_end handler 的便捷封装（事件载荷在测试中不被读取，固定即可） */
function fire(setup: MockSetup, ctx: ExtensionContext): Promise<void> {
	return setup.turnEndHandler(
		{ type: "turn_end", turnIndex: 0, message: null, toolResults: [] },
		ctx,
	) as Promise<void>;
}

// ────────────────────────────────────────────────────
// renameSessionExtension 工厂 + hook 注册
// ────────────────────────────────────────────────────

describe("renameSessionExtension", () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isEnabled).mockReset();
		vi.mocked(completeSimple).mockReset();
		setup = createMockPi();
		renameSessionExtension(setup.pi);
	});

	it("TC13: 注册后 pi.on 以 'turn_end' 调用一次", () => {
		expect(setup.pi.on).toHaveBeenCalledTimes(1);
		expect(setup.pi.on).toHaveBeenCalledWith("turn_end", expect.any(Function));
		expect(setup.turnEndHandler).toBeTypeOf("function");
	});

	it("TC14: 开关关闭时 handler 触发后不调 setSessionName", async () => {
		vi.mocked(isEnabled).mockReturnValue(false);

		await fire(setup, createMockCtx({ entries: ONE_ASSISTANT }));

		expect(isEnabled).toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("TC15: getEntries 抛错时 handler 不抛（catch console.error）", async () => {
		// 开关打开，让 handler 走到 getEntries
		vi.mocked(isEnabled).mockReturnValue(true);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const ctx = {
			sessionManager: {
				getEntries: () => { throw new Error("boom"); },
				getSessionId: () => "test-session-id",
				getSessionDir: () => "/home/u/.pi/agent/sessions",
			},
			model: { id: "stub-model" },
			modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true }) },
			getSystemPrompt: () => "stub system prompt",
			signal: new AbortController().signal,
		} as unknown as ExtensionContext;

		await expect(fire(setup, ctx)).resolves.toBeUndefined();

		expect(errorSpy).toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	// ────────────────────────────────────────────────────
	// rename-llm wave：callRenameLLM 集成覆盖（LTC7-LTC12）
	// ────────────────────────────────────────────────────

	it("LTC7: subagents 子 session 路径 → isSubagentSession 早退，不调 setSessionName", async () => {
		vi.mocked(isEnabled).mockReturnValue(true);

		await fire(setup, createMockCtx({
			entries: ONE_ASSISTANT,
			sessionDir: "/home/u/.pi/agent/subagents/--proj--/sessions",
		}));

		// isSubagentSession 在首 turn 判定之前早退，不应触达 LLM
		expect(completeSimple).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC8: getApiKeyAndHeaders resolve {ok:false} → callRenameLLM 返回 null，不调 setSessionName", async () => {
		vi.mocked(isEnabled).mockReturnValue(true);

		await fire(setup, createMockCtx({
			entries: ONE_ASSISTANT,
			auth: { ok: false, error: "no api key" },
		}));

		// auth 未通过，不应发起 LLM 调用
		expect(completeSimple).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC9: ctx.model = undefined → callRenameLLM 早退返回 null，不调 setSessionName", async () => {
		vi.mocked(isEnabled).mockReturnValue(true);

		await fire(setup, createMockCtx({ entries: ONE_ASSISTANT, model: undefined }));

		expect(completeSimple).not.toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC10: completeSimple 返回 text → extractTitle 去空白后 setSessionName 落库", async () => {
		vi.mocked(isEnabled).mockReturnValue(true);
		vi.mocked(completeSimple).mockResolvedValue({
			content: [{ type: "text", text: "  修复登录bug  " }],
		});

		await fire(setup, createMockCtx({ entries: ONE_ASSISTANT }));
		// handler 内 callRenameLLM 是 detached promise（fire-and-forget），fire 立即 resolve；
		// 需等 detached promise settle 后再断言落库结果。
		await vi.waitFor(() => expect(setup.setSessionNameMock).toHaveBeenCalledWith("修复登录bug"));

		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(setup.setSessionNameMock).toHaveBeenCalledWith("修复登录bug");
	});

	it("LTC11: completeSimple 返回无 text（仅 toolCall）→ extractTitle 空串 → 不调 setSessionName", async () => {
		vi.mocked(isEnabled).mockReturnValue(true);
		vi.mocked(completeSimple).mockResolvedValue({
			content: [{ type: "toolCall", name: "x", arguments: {} }],
		});

		await fire(setup, createMockCtx({ entries: ONE_ASSISTANT }));
		// handler 内 callRenameLLM 是 detached promise（fire-and-forget），fire 立即 resolve；
		// 需等 detached promise settle（completeSimple 被调用）后再断言不落库。
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));

		expect(completeSimple).toHaveBeenCalledTimes(1);
		// extractTitle 返回空串 → callRenameLLM 返回 null → 不落库
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
	});

	it("LTC12: completeSimple reject → handler 不抛，setSessionName 未调用", async () => {
		vi.mocked(isEnabled).mockReturnValue(true);
		vi.mocked(completeSimple).mockRejectedValue(new Error("llm down"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(fire(setup, createMockCtx({ entries: ONE_ASSISTANT }))).resolves.toBeUndefined();
		// handler 内 callRenameLLM 是 detached promise（fire-and-forget），fire 立即 resolve；
		// reject 由 detached promise 的 catch 兜底，需等其 settle 后再断言。
		await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledTimes(1));

		expect(completeSimple).toHaveBeenCalledTimes(1);
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});
