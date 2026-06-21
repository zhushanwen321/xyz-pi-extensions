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
				{ toolName: "read", toolCallId: "e1" },
				{ toolName: "bash", toolCallId: "e2" },
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
		});
		warnSpy.mockRestore();
	});
});
