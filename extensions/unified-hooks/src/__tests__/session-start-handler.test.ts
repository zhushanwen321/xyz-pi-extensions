// src/__tests__/session-start-handler.test.ts
import { describe, expect, it, vi } from "vitest";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { HookContext } from "../hooks/tool-error-handler.ts";

// --- mocks for hook setup modules ---
vi.mock("../hooks/tool-error-handler.ts", () => ({
	setupToolErrorHandler: vi.fn(),
}));

vi.mock("../hooks/network-timeout-guard.ts", () => ({
	setupNetworkTimeoutGuard: vi.fn(),
}));

vi.mock("../hooks/test-timeout-guard.ts", () => ({
	setupTestTimeoutGuard: vi.fn(),
}));

vi.mock("../hooks/subagent-list-injector.ts", () => ({
	setupSubagentListInjector: vi.fn(),
}));

// Re-import after mocking so the mocked versions are used
import { setupToolErrorHandler } from "../hooks/tool-error-handler.ts";
import { setupNetworkTimeoutGuard } from "../hooks/network-timeout-guard.ts";
import { setupTestTimeoutGuard } from "../hooks/test-timeout-guard.ts";
import { setupSubagentListInjector } from "../hooks/subagent-list-injector.ts";

import unifiedHooksExtension from "../index.ts";

// --- helpers ---
function createMockPi(): {
	on: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
} {
	return {
		on: vi.fn(),
		appendEntry: vi.fn(),
	};
}

function createMockCtx(): { ctx: HookContext; notify: ReturnType<typeof vi.fn> } {
	const notify = vi.fn();
	const ctx = { ui: { notify } } as unknown as HookContext;
	return { ctx, notify };
}

function getSessionStartHandler(pi: ReturnType<typeof createMockPi>): (event: unknown, ctx: HookContext) => void {
	return pi.on.mock.calls.find(
		(c: unknown[]) => c[0] === "session_start",
	)![1] as (event: unknown, ctx: HookContext) => void;
}

// --- tests ---
describe("session_start handler", () => {
	it("notifies 'info' when all hooks are enabled", () => {
		const pi = createMockPi();
		const { ctx, notify } = createMockCtx();

		// All hooks succeed
		(setupToolErrorHandler as ReturnType<typeof vi.fn>).mockImplementation(() => {});
		(setupNetworkTimeoutGuard as ReturnType<typeof vi.fn>).mockImplementation(() => {});
		(setupTestTimeoutGuard as ReturnType<typeof vi.fn>).mockImplementation(() => {});
		(setupSubagentListInjector as ReturnType<typeof vi.fn>).mockImplementation(() => {});

		unifiedHooksExtension(pi as unknown as ExtensionAPI);

		const handler = getSessionStartHandler(pi);
		handler({}, ctx);

		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]![1]).toBe("info");
		expect(pi.appendEntry).toHaveBeenCalledWith("unified-hooks:loaded", {
			enabled: ["tool-error-handler", "network-timeout-guard", "test-timeout-guard", "subagent-list-injector"],
			disabled: [],
		});
	});

	it("notifies 'warn' and lists disabled hooks when some hooks fail", () => {
		const pi = createMockPi();
		const { ctx, notify } = createMockCtx();

		// Two hooks fail
		(setupToolErrorHandler as ReturnType<typeof vi.fn>).mockImplementation(() => {});
		(setupNetworkTimeoutGuard as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("setup failed");
		});
		(setupTestTimeoutGuard as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("timeout");
		});
		(setupSubagentListInjector as ReturnType<typeof vi.fn>).mockImplementation(() => {});

		unifiedHooksExtension(pi as unknown as ExtensionAPI);

		const handler = getSessionStartHandler(pi);
		handler({}, ctx);

		expect(notify).toHaveBeenCalledTimes(1);
		const [msg, level] = notify.mock.calls[0]!;
		expect(level).toBe("warn");
		expect(msg).toContain("Failed: network-timeout-guard, test-timeout-guard");
		expect(msg).toContain("Loaded: tool-error-handler, subagent-list-injector");
		expect(pi.appendEntry).toHaveBeenCalledWith("unified-hooks:loaded", {
			enabled: ["tool-error-handler", "subagent-list-injector"],
			disabled: ["network-timeout-guard", "test-timeout-guard"],
		});
	});

	it("notifies 'warn' when all hooks are disabled", () => {
		const pi = createMockPi();
		const { ctx, notify } = createMockCtx();

		// All hooks fail
		(setupToolErrorHandler as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("a");
		});
		(setupNetworkTimeoutGuard as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("b");
		});
		(setupTestTimeoutGuard as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("c");
		});
		(setupSubagentListInjector as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("d");
		});

		unifiedHooksExtension(pi as unknown as ExtensionAPI);

		const handler = getSessionStartHandler(pi);
		handler({}, ctx);

		expect(notify.mock.calls[0]![1]).toBe("warn");
		const msg = notify.mock.calls[0]![0] as string;
		expect(msg).toContain("(none)");
		expect(pi.appendEntry).toHaveBeenCalledWith("unified-hooks:loaded", {
			enabled: [],
			disabled: ["tool-error-handler", "network-timeout-guard", "test-timeout-guard", "subagent-list-injector"],
		});
	});
});
