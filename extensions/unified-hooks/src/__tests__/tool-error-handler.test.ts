// src/__tests__/tool-error-handler.test.ts
import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { setupToolErrorHandler, type HookContext } from "../hooks/tool-error-handler.ts";

/**
 * Minimal Pi stub: captures the handler registered via `on` and spies on
 * `appendEntry`. Tests invoke the captured handler directly with a mock event
 * + HookContext to verify behaviour on both isError paths.
 */
interface CapturedPi {
	on: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
}

function createMockPi(): CapturedPi {
	return {
		on: vi.fn(),
		appendEntry: vi.fn(),
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
			"warn",
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

		// Second arg of notify is the type — must be "warn" (not info/error).
		expect(notify.mock.calls[0]![1]).toBe("warn");
	});
});
