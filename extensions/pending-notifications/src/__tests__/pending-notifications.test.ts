// 测试框架：vitest
// 运行命令：npx vitest run src/__tests__/pending-notifications.test.ts
//
// W1 核心实现测试。覆盖 plan.md U1-U11。
//
// 测试策略：
// - 用最小 mock 的 ExtensionAPI（mock events.on/emit、appendEntry、on、registerTool）
// - 用最小 mock 的 ExtensionContext（mock sessionManager.getEntries/getSessionId）
// - 调 pendingNotificationsExtension(pi) 触发工厂注册 handler
// - 手动触发 session_start / events / tool / session_shutdown，断言 state + appendEntry

/* eslint-disable taste/no-unsafe-cast */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import pendingNotificationsExtension from "../index";
import type { PendingEntry } from "../state";
import { createRegistry, getActive, rebuildFromEntries, register, unregister } from "../state";

// ── Mock 工具 ───────────────────────────────────────

interface HandlerRegistry {
	sessionStart: ((event: unknown, ctx: ExtensionContext) => void | Promise<void>) | undefined;
	sessionShutdown: ((event: unknown, ctx: ExtensionContext) => void | Promise<void>) | undefined;
	pendingRegister: ((data: unknown) => void) | undefined;
	pendingUnregister: ((data: unknown) => void) | undefined;
}

interface MockSessionEntry {
	customType: string;
	data: Record<string, unknown>;
}

interface MockSetup {
	pi: ExtensionAPI;
	handlers: HandlerRegistry;
	appendEntryMock: ReturnType<typeof vi.fn>;
	registerToolMock: ReturnType<typeof vi.fn>;
}

function createMockPi(): MockSetup {
	const handlers: HandlerRegistry = {
		sessionStart: undefined,
		sessionShutdown: undefined,
		pendingRegister: undefined,
		pendingUnregister: undefined,
	};
	const appendEntryMock = vi.fn();
	const registerToolMock = vi.fn();
	const sendMessageMock = vi.fn();

	const pi = {
		appendEntry: appendEntryMock,
		registerTool: registerToolMock,
		sendMessage: sendMessageMock,
		on: vi.fn((event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>) => {
			if (event === "session_start") handlers.sessionStart = handler;
			if (event === "session_shutdown") handlers.sessionShutdown = handler;
		}),
		events: {
			emit: vi.fn(),
			on: vi.fn((channel: string, handler: (data: unknown) => void) => {
				if (channel === "pending:register") handlers.pendingRegister = handler;
				if (channel === "pending:unregister") handlers.pendingUnregister = handler;
			}),
		},
	} as unknown as ExtensionAPI;

	return { pi, handlers, appendEntryMock, registerToolMock };
}

function createMockCtx(entries: MockSessionEntry[], sessionId = "sess-current"): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => entries as unknown[],
			getSessionId: () => sessionId,
		},
	} as unknown as ExtensionContext;
}

function fireSessionStart(setup: MockSetup, ctx: ExtensionContext): void {
	if (!setup.handlers.sessionStart) throw new Error("session_start handler not registered");
	void setup.handlers.sessionStart({ type: "session_start", reason: "resume" }, ctx);
}

async function runTool(
	setup: MockSetup,
	params: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }> {
	const tool = setup.registerToolMock.mock.calls[0][0] as {
		execute: (p: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
	};
	return tool.execute(params);
}

async function getCount(setup: MockSetup): Promise<number> {
	const res = await runTool(setup, { action: "count" });
	return Number(res.content[0].text.replace(/[^0-9]/g, ""));
}

// ── 共享 fixtures ───────────────────────────────────

const NOW = 1_700_000_000_000;

function makeRegisterEntry(id: string, extra: Partial<PendingEntry> = {}): MockSessionEntry {
	return {
		customType: "pending:register",
		data: {
			id,
			type: "workflow",
			name: `op-${id}`,
			registeredAt: NOW,
			expiresAt: NOW + 3_600_000,
			sessionId: "sess-current",
			...extra,
		},
	};
}

function makeUnregisterEntry(id: string): MockSessionEntry {
	return { customType: "pending:unregister", data: { id } };
}

function rebuild(
	entries: MockSessionEntry[],
	currentSessionId: string,
	now: number,
): { activeIds: string[]; expiredToFlush: Array<{ id: string; status: string }> } {
	return rebuildFromEntries(createRegistry(), entries as unknown[], currentSessionId, now);
}

// ────────────────────────────────────────────────────
// state.ts 纯函数测试
// ────────────────────────────────────────────────────

describe("state pure functions", () => {
	describe("register", () => {
		it("registers a new active operation", () => {
			const r = createRegistry();
			const op: PendingEntry = {
				id: "w-1", type: "workflow", name: "test", status: "active",
				registeredAt: NOW, expiresAt: NOW + 3_600_000, sessionId: "s",
			};
			register(r, op);
			expect(getActive(r).map((o) => o.id)).toEqual(["w-1"]);
		});

		it("ignores duplicate active id (U6)", () => {
			const r = createRegistry();
			const op: PendingEntry = {
				id: "w-1", type: "workflow", name: "test", status: "active",
				registeredAt: NOW, expiresAt: NOW + 3_600_000, sessionId: "s",
			};
			register(r, op);
			register(r, { ...op, name: "dup" });
			expect(getActive(r)).toHaveLength(1);
			expect(getActive(r)[0].name).toBe("test");
		});
	});

	describe("unregister", () => {
		it("marks existing op non-active (U7)", () => {
			const r = createRegistry();
			register(r, {
				id: "w-1", type: "workflow", name: "test", status: "active",
				registeredAt: NOW, expiresAt: NOW + 3_600_000, sessionId: "s",
			});
			unregister(r, "w-1", "completed");
			expect(getActive(r)).toHaveLength(0);
		});

		it("ignores unknown id without error (U8)", () => {
			const r = createRegistry();
			expect(() => unregister(r, "nope", "completed")).not.toThrow();
		});
	});

	describe("rebuildFromEntries", () => {
		it("U1: register without unregister → 1 active", () => {
			const comp = rebuild([makeRegisterEntry("w-1")], "sess-current", NOW);
			expect(comp.activeIds).toEqual(["w-1"]);
			expect(comp.expiredToFlush).toEqual([]);
		});

		it("U2: register + matching unregister → 0 active", () => {
			const comp = rebuild([makeRegisterEntry("w-1"), makeUnregisterEntry("w-1")], "sess-current", NOW);
			expect(comp.activeIds).toEqual([]);
			expect(comp.expiredToFlush).toEqual([]);
		});

		it("U3: register expired → flush unregister with status=expired", () => {
			const comp = rebuild(
				[makeRegisterEntry("w-1", { expiresAt: NOW - 1 })],
				"sess-current",
				NOW,
			);
			expect(comp.activeIds).toEqual([]);
			expect(comp.expiredToFlush).toEqual([{ id: "w-1", status: "expired" }]);
		});

		it("U4: register with different sessionId → flush unregister with status=expired", () => {
			const comp = rebuild(
				[makeRegisterEntry("w-1", { sessionId: "sess-other" })],
				"sess-current",
				NOW,
			);
			expect(comp.activeIds).toEqual([]);
			expect(comp.expiredToFlush).toEqual([{ id: "w-1", status: "expired" }]);
		});
	});
});

// ────────────────────────────────────────────────────
// index.ts 工厂集成测试（U1-U11）
// ────────────────────────────────────────────────────

describe("pendingNotificationsExtension factory", () => {
	let setup: MockSetup;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		setup = createMockPi();
		pendingNotificationsExtension(setup.pi);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("session_start rebuild (U1-U4)", () => {
		it("U1: 1 register no unregister → 1 active, no flush", async () => {
			fireSessionStart(setup, createMockCtx([makeRegisterEntry("w-1")]));
			expect(await getCount(setup)).toBe(1);
			const stateChangeCalls = setup.appendEntryMock.mock.calls.filter(
				(c) => c[0] === "pending:register" || c[0] === "pending:unregister",
			);
			expect(stateChangeCalls).toHaveLength(0);
		});

		it("U2: register + unregister → 0 active", async () => {
			fireSessionStart(setup, createMockCtx([makeRegisterEntry("w-1"), makeUnregisterEntry("w-1")]));
			expect(await getCount(setup)).toBe(0);
		});

		it("U3: expired register → flush pending:unregister entry", async () => {
			vi.setSystemTime(NOW + 3_700_000);
			fireSessionStart(setup, createMockCtx([makeRegisterEntry("w-1", { expiresAt: NOW })]));
			expect(await getCount(setup)).toBe(0);
			expect(setup.appendEntryMock).toHaveBeenCalledWith(
				"pending:unregister",
				expect.objectContaining({ id: "w-1", status: "expired" }),
			);
		});

		it("U4: different sessionId → flush pending:unregister entry", async () => {
			fireSessionStart(setup, createMockCtx([makeRegisterEntry("w-1", { sessionId: "sess-old" })], "sess-current"));
			expect(await getCount(setup)).toBe(0);
			expect(setup.appendEntryMock).toHaveBeenCalledWith(
				"pending:unregister",
				expect.objectContaining({ id: "w-1", status: "expired" }),
			);
		});
	});

	describe("events.on pending:register (U5-U6)", () => {
		it("U5: register event → active + appendEntry", async () => {
			fireSessionStart(setup, createMockCtx([]));

			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "test" });

			expect(await getCount(setup)).toBe(1);
			expect(setup.appendEntryMock).toHaveBeenCalledWith(
				"pending:register",
				expect.objectContaining({ id: "w-1", type: "workflow", name: "test" }),
			);
		});

		it("U6: duplicate register event → ignored", async () => {
			fireSessionStart(setup, createMockCtx([]));

			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "first" });
			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "second" });

			expect(await getCount(setup)).toBe(1);
			const registerCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:register");
			expect(registerCalls).toHaveLength(1);
		});
	});

	describe("events.on pending:unregister (U7-U8)", () => {
		it("U7: unregister event → non-active + appendEntry", async () => {
			fireSessionStart(setup, createMockCtx([]));

			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "test" });
			setup.appendEntryMock.mockClear();
			setup.handlers.pendingUnregister!({ id: "w-1", reason: "completed" });

			expect(await getCount(setup)).toBe(0);
			expect(setup.appendEntryMock).toHaveBeenCalledWith(
				"pending:unregister",
				expect.objectContaining({ id: "w-1", reason: "completed" }),
			);
		});

		it("U8: unregister unknown id → ignored, no appendEntry, no throw", () => {
			fireSessionStart(setup, createMockCtx([]));
			setup.appendEntryMock.mockClear();

			expect(() => setup.handlers.pendingUnregister!({ id: "nope", reason: "completed" })).not.toThrow();
			const stateChangeCalls = setup.appendEntryMock.mock.calls.filter(
				(c) => c[0] === "pending:register" || c[0] === "pending:unregister",
			);
			expect(stateChangeCalls).toHaveLength(0);
		});
	});

	describe("tool count/list (U9-U10)", () => {
		it("U9: count returns active count", async () => {
			fireSessionStart(setup, createMockCtx([]));
			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "a" });

			const res = await runTool(setup, { action: "count" });
			expect(res.content[0].text).toContain("1");
		});

		it("U10: list returns active list", async () => {
			fireSessionStart(setup, createMockCtx([]));
			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "a" });
			setup.handlers.pendingRegister!({ id: "s-1", type: "subagent", name: "b" });

			const res = await runTool(setup, { action: "list" });
			const ids = (res.details as { items: PendingEntry[] }).items.map((i) => i.id);
			expect(ids.sort()).toEqual(["s-1", "w-1"]);
		});
	});

	describe("session_shutdown (U11)", () => {
		it("U11: marks all active as cancelled + flushes unregister entries", () => {
			fireSessionStart(setup, createMockCtx([]));
			setup.handlers.pendingRegister!({ id: "w-1", type: "workflow", name: "a" });
			setup.handlers.pendingRegister!({ id: "s-1", type: "subagent", name: "b" });
			setup.appendEntryMock.mockClear();

			if (!setup.handlers.sessionShutdown) throw new Error("session_shutdown not registered");
			void setup.handlers.sessionShutdown({ type: "session_shutdown" }, createMockCtx([]));

			const unregisterCalls = setup.appendEntryMock.mock.calls.filter((c) => c[0] === "pending:unregister");
			expect(unregisterCalls).toHaveLength(2);
			const flushedIds = unregisterCalls.map((c) => (c[1] as { id: string }).id).sort();
			expect(flushedIds).toEqual(["s-1", "w-1"]);
			for (const c of unregisterCalls) {
				expect((c[1] as { status: string }).status).toBe("cancelled");
			}
		});
	});
});
