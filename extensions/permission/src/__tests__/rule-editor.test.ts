/**
 * rule-editor.test.ts — W8 T8: rule-editor 三模式分发 + RPC 循环测试。
 *
 * 覆盖：
 *  - editRulesViaOverlay headless 降级（notify + undefined）
 *  - editRulesViaOverlay TUI 模式（mock custom → done）
 *  - editViaRpc：cancel（第一次 select undefined）
 *  - editViaRpc：[Done] → undefined（无变更）
 *  - editViaRpc：[+ Add rule] → 选模板 → 选命令 → ops
 *  - editViaRpc：选已有规则 → delete → ops
 *  - editViaRpc：G16 多循环反映前序 ops
 */
import { describe, expect, it, vi } from "vitest";

import { editRulesViaOverlay,type RuleEditorContext } from "../rule-editor.js";
import type { Rule } from "../types.js";

// ──────────────────────── helpers ────────────────────────

function makeRule(overrides: Partial<Rule> = {}): Rule {
	return {
		id: "user-1",
		tool: "bash",
		pattern: "npm *",
		action: "allow",
		source: "user",
		...overrides,
	};
}

function makeCtx(overrides: Partial<RuleEditorContext> = {}): RuleEditorContext {
	return {
		mode: overrides.mode ?? "rpc",
		ui: {
			notify: overrides.ui?.notify ?? vi.fn(),
			select: overrides.ui?.select ?? vi.fn(() => Promise.resolve(undefined)),
			custom: overrides.ui?.custom ?? vi.fn(() => Promise.resolve(undefined)),
		},
	};
}

function makeCounter(): () => string {
	let n = 1;
	return (): string => `user-${n++}`;
}

// ──────────────────────── headless 降级 ────────────────────────

describe("RE1: headless 模式降级", () => {
	it("json mode → notify + undefined", async () => {
		const notify = vi.fn();
		const ctx = makeCtx({ mode: "json", ui: { notify, select: vi.fn(), custom: vi.fn() } });
		const result = await editRulesViaOverlay(ctx, [], makeCounter());
		expect(result).toBeUndefined();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("not available in headless"), "warn");
	});

	it("print mode → notify + undefined", async () => {
		const notify = vi.fn();
		const ctx = makeCtx({ mode: "print", ui: { notify, select: vi.fn(), custom: vi.fn() } });
		const result = await editRulesViaOverlay(ctx, [], makeCounter());
		expect(result).toBeUndefined();
		expect(notify).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── TUI 模式 ────────────────────────

describe("RE2: TUI 模式", () => {
	it("custom factory 被调用，comp cancel settle 空 ops", async () => {
		const customMock = vi.fn(
			<T,>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => unknown) =>
				new Promise<T>((resolve) => {
					const comp = factory({}, {}, {}, (r: T) => resolve(r));
					// 模拟 cancel：comp 是 RuleEditorComponent，调 cancel → done(ops)
					if (comp !== null && typeof comp === "object" && "cancel" in comp) {
						(comp as { cancel: () => void }).cancel();
					}
				}),
		);
		const ctx = makeCtx({ mode: "tui", ui: { notify: vi.fn(), select: vi.fn(), custom: customMock } });
		const result = await editRulesViaOverlay(ctx, [], makeCounter());
		expect(customMock).toHaveBeenCalledOnce();
		expect(result).toEqual([]);
	});
});

// ──────────────────────── RPC: cancel ────────────────────────

describe("RE3: RPC cancel", () => {
	it("第一次 select undefined → 返回 undefined", async () => {
		const ctx = makeCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: vi.fn(() => Promise.resolve(undefined)), custom: vi.fn() },
		});
		const result = await editRulesViaOverlay(ctx, [makeRule()], makeCounter());
		expect(result).toBeUndefined();
	});
});

// ──────────────────────── RPC: [Done] ────────────────────────

describe("RE4: RPC [Done]", () => {
	it("选 [Done]（无变更）→ undefined", async () => {
		const selectMock = vi.fn()
			.mockResolvedValueOnce("[Done]"); // list 选 [Done]
		const ctx = makeCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		const result = await editRulesViaOverlay(ctx, [makeRule()], makeCounter());
		expect(result).toBeUndefined();
	});
});

// ──────────────────────── RPC: add flow ────────────────────────

describe("RE5: RPC add flow", () => {
	it("[+ Add rule] → 选 allow-family → 选 npm → ops 含 add", async () => {
		const selectMock = vi.fn()
			.mockResolvedValueOnce("[+ Add rule]") // list
			.mockResolvedValueOnce("Allow command family") // template
			.mockResolvedValueOnce("npm (Node package manager)") // command
			.mockResolvedValueOnce("[Done]"); // list（第二次循环）
		const ctx = makeCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		const result = await editRulesViaOverlay(ctx, [], makeCounter());
		expect(result).toBeDefined();
		expect(result).toHaveLength(1);
		expect(result![0]!.kind).toBe("add");
		expect(result![0]!.rule.pattern).toBe("npm *");
	});
});

// ──────────────────────── RPC: delete flow ────────────────────────

describe("RE6: RPC delete flow", () => {
	it("选已有规则 → [Delete this rule] → ops 含 delete", async () => {
		const existingRule = makeRule({ id: "user-1", pattern: "npm *" });
		const selectMock = vi.fn()
			.mockResolvedValueOnce("[allow] npm *") // list 选规则
			.mockResolvedValueOnce("[Delete this rule]") // edit action
			.mockResolvedValueOnce("[Done]"); // list（第二次循环）
		const ctx = makeCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		const result = await editRulesViaOverlay(ctx, [existingRule], makeCounter());
		expect(result).toBeDefined();
		expect(result).toHaveLength(1);
		expect(result![0]!.kind).toBe("delete");
		expect(result![0]!.id).toBe("user-1");
	});
});

// ──────────────────────── RPC: G16 多循环反映前序 ops ────────────────────────

describe("RE7: G16 多循环反映前序 ops", () => {
	it("add 后第二次 list 包含新规则", async () => {
		const selectMock = vi.fn()
			.mockResolvedValueOnce("[+ Add rule]") // list 1 (call 0)
			.mockResolvedValueOnce("Ask before command") // template (call 1)
			.mockResolvedValueOnce("docker (container runtime)") // command (call 2)
			.mockResolvedValueOnce("[Done]"); // list 2 (call 3, 应含新规则)
		const ctx = makeCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		await editRulesViaOverlay(ctx, [], makeCounter());
		// 第四次 select（index 3）是第二次 list，options 应包含新规则
		const secondListArgs = selectMock.mock.calls[3] as [string, string[]];
		expect(secondListArgs[1]).toContain("[ask] docker *");
	});
});
