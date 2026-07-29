/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 默认 isEnabled 返回 falsy（开关关闭），符合测试环境无 auto-rename-enabled 文件的语义，
// 也避免依赖开发者机器上真实文件是否存在而 flaky。个别 TC 按需 mockReturnValue。
vi.mock("../pure.js", async (importActual) => {
	const actual = await importActual<typeof import("../pure.js")>();
	return { ...actual, isEnabled: vi.fn() };
});

// 被测模块须在 vi.mock 之后 import：vi.mock 被 vitest 提升到文件顶部，被测模块才能拿到 mock 后的依赖。
import renameSessionExtension from "../index";
import { isEnabled } from "../pure.js";

// ── Mock 工具 ───────────────────────────────────────

interface MockSetup {
	pi: ExtensionAPI;
	setSessionNameMock: ReturnType<typeof vi.fn>;
	turnEndHandler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
}

function createMockPi(): MockSetup {
	const setSessionNameMock = vi.fn();
	let turnEndHandler!: MockSetup["turnEndHandler"];
	const pi = {
		on: vi.fn((event: string, handler: MockSetup["turnEndHandler"]) => {
			if (event === "turn_end") turnEndHandler = handler;
		}),
		setSessionName: setSessionNameMock,
	} as unknown as ExtensionAPI;
	return { pi, setSessionNameMock, get turnEndHandler() { return turnEndHandler; } };
}

function createMockCtx(entries: unknown[] = []): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => entries,
			getSessionId: () => "test-session-id",
		},
	} as unknown as ExtensionContext;
}

const ONE_ASSISTANT = [
	{ type: "message", message: { role: "user" } },
	{ type: "message", message: { role: "assistant" } },
];

// ────────────────────────────────────────────────────
// renameSessionExtension 工厂 + hook 注册
// ────────────────────────────────────────────────────

describe("renameSessionExtension", () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(isEnabled).mockReset();
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

		await setup.turnEndHandler(
			{ type: "turn_end", turnIndex: 0, message: null, toolResults: [] },
			createMockCtx(ONE_ASSISTANT),
		);

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
			},
		} as unknown as ExtensionContext;

		await expect(
			setup.turnEndHandler({ type: "turn_end", turnIndex: 0, message: null, toolResults: [] }, ctx),
		).resolves.toBeUndefined();

		expect(errorSpy).toHaveBeenCalled();
		expect(setup.setSessionNameMock).not.toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});
