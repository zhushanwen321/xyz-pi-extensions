// src/__tests__/tool-error-handler.test.ts
import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { setupToolErrorHandler, type HookContext } from "../hooks/tool-error-handler.ts";

// --- helper types ---
interface MockPi {
	on: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
}

function createMockPi(overrides?: Partial<MockPi>): MockPi {
	return {
		on: vi.fn(),
		appendEntry: vi.fn(),
		...overrides,
	};
}

function createMockCtx(): { ctx: HookContext; notify: ReturnType<typeof vi.fn> } {
	const notify = vi.fn();
	const ctx = { ui: { notify } };
	return { ctx, notify };
}

describe("setupToolErrorHandler", () => {
	it("registers a handler on the tool_execution_end event", () => {
		const pi = createMockPi();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);

		expect(pi.on).toHaveBeenCalledWith("tool_execution_end", expect.any(Function));
	});

	it("notifies via ctx.ui.notify and persists via appendEntry on isError:true", async () => {
		const pi = createMockPi();
		const { ctx, notify } = createMockCtx();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown, ctx: HookContext) => Promise<void>;

		await handler(
			{ isError: true, toolName: "read", toolCallId: "call-42" },
			ctx,
		);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(
			"[unified-hooks] read error (callId=call-42)",
			"warning",
		);
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith("unified-hooks:tool-error", {
			toolName: "read",
			toolCallId: "call-42",
			errorText: null,
		});
	});

	it("does nothing on isError:false (no notify, no appendEntry)", async () => {
		const pi = createMockPi();
		const { ctx, notify } = createMockCtx();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown, ctx: HookContext) => Promise<void>;

		await handler(
			{ isError: false, toolName: "bash", toolCallId: "call-99" },
			ctx,
		);

		expect(notify).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("uses the warn notification type for errors", async () => {
		const pi = createMockPi();
		const { ctx, notify } = createMockCtx();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown, ctx: HookContext) => Promise<void>;

		await handler(
			{ isError: true, toolName: "edit", toolCallId: "c1" },
			ctx,
		);

		// Second arg of notify is the type — must be "warning" (matches SDK literal union, not info/error).
		expect(notify.mock.calls[0]![1]).toBe("warning");
	});

	// --- edge cases ---

	it("propagates if pi.on throws during registration", () => {
		const pi = createMockPi({
		on: vi.fn(() => { throw new Error("registration failed"); }),
		});

		expect(() => setupToolErrorHandler(pi as unknown as ExtensionAPI)).toThrow("registration failed");
	});

	it("does not crash if handler callback throws (notify throws)", async () => {
		const pi = createMockPi();
		const { ctx, notify } = createMockCtx();
		notify.mockImplementation(() => { throw new Error("notify broke"); });

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown, ctx: HookContext) => Promise<void>;

		await expect(
			handler({ isError: true, toolName: "bash", toolCallId: "c2" }, ctx),
		).rejects.toThrow("notify broke");

		// appendEntry should NOT have been called since notify threw first
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not crash if handler callback throws (appendEntry throws)", async () => {
		const pi = createMockPi();
		const { ctx, notify } = createMockCtx();
		pi.appendEntry.mockImplementation(() => { throw new Error("append broke"); });

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown, ctx: HookContext) => Promise<void>;

		await expect(
			handler({ isError: true, toolName: "grep", toolCallId: "c3" }, ctx),
		).rejects.toThrow("append broke");

		// notify was called before appendEntry threw
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("handles concurrent error events independently", async () => {
		const pi = createMockPi();
		const { ctx, notify } = createMockCtx();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown, ctx: HookContext) => Promise<void>;

		await Promise.all([
			handler({ isError: true, toolName: "read", toolCallId: "e1" }, ctx),
			handler({ isError: true, toolName: "bash", toolCallId: "e2" }, ctx),
			handler({ isError: false, toolName: "edit", toolCallId: "e3" }, ctx),
		]);

		expect(notify).toHaveBeenCalledTimes(2);
		expect(pi.appendEntry).toHaveBeenCalledTimes(2);

		// verify both calls persisted independently
		const calls = pi.appendEntry.mock.calls.map((c) => c[1]);
		expect(calls).toEqual(
			expect.arrayContaining([
				{ toolName: "read", toolCallId: "e1", errorText: null },
				{ toolName: "bash", toolCallId: "e2", errorText: null },
			]),
		);
	});

	it("falls back to console.warn when ctx.ui is undefined (headless session)", async () => {
		// [HISTORICAL] headless / RPC 会话 ctx.ui 为 undefined，旧实现直接 ctx.ui.notify 会 NPE。
		const pi = createMockPi();
		const ctx = { ui: undefined } as unknown as HookContext;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown, ctx: HookContext) => Promise<void>;

		await handler({ isError: true, toolName: "bash", toolCallId: "h1" }, ctx);

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]![0]).toContain("bash error");
		// appendEntry 仍持久化
		expect(pi.appendEntry).toHaveBeenCalledWith("unified-hooks:tool-error", {
			toolName: "bash",
			toolCallId: "h1",
			errorText: null,
		});
		warnSpy.mockRestore();
	});

	// --- errorText 提取（核心新增能力）---

	it("从 result.content[0].text 提取错误文本并拼到 warning（如 'hub disposed'）", async () => {
		// [HISTORICAL] subagent execute throw 时 Pi 把 error.message 塞进 result.content[0].text。
		// 旧实现只打 "(callId=xxx)" 无详情，AI 看不到真实原因（如 hub disposed）只能盲猜。
		const pi = createMockPi();
		const { ctx, notify } = createMockCtx();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown, ctx: HookContext) => Promise<void>;

		await handler(
			{
				isError: true,
				toolName: "subagent",
				toolCallId: "call-disposed",
				result: { content: [{ type: "text", text: "hub disposed" }] },
			},
			ctx,
		);

		expect(notify).toHaveBeenCalledWith(
			"[unified-hooks] subagent error (callId=call-disposed): hub disposed",
			"warning",
		);
		expect(pi.appendEntry).toHaveBeenCalledWith("unified-hooks:tool-error", {
			toolName: "subagent",
			toolCallId: "call-disposed",
			errorText: "hub disposed",
		});
	});

	it("result 缺失或无 content 时降级到无详情（不崩）", async () => {
		const pi = createMockPi();
		const { ctx, notify } = createMockCtx();

		setupToolErrorHandler(pi as unknown as ExtensionAPI);
		const handler = pi.on.mock.calls[0]![1] as (event: unknown, ctx: HookContext) => Promise<void>;

		// result 为 undefined（某些 headless 路径）
		await handler({ isError: true, toolName: "bash", toolCallId: "x1" }, ctx);
		// result.content 为空数组
		await handler(
			{ isError: true, toolName: "bash", toolCallId: "x2", result: { content: [] } },
			ctx,
		);
		// result 不是对象
		await handler(
			{ isError: true, toolName: "bash", toolCallId: "x3", result: "oops" },
			ctx,
		);

		// 三次都降级为无详情后缀
		expect(notify.mock.calls[0]![0]).toBe("[unified-hooks] bash error (callId=x1)");
		expect(notify.mock.calls[1]![0]).toBe("[unified-hooks] bash error (callId=x2)");
		expect(notify.mock.calls[2]![0]).toBe("[unified-hooks] bash error (callId=x3)");
		pi.appendEntry.mock.calls.forEach((c) => {
			expect(c[1]).toHaveProperty("errorText", null);
		});
	});
});
