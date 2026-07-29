// src/__tests__/build-lines-aggregation.test.ts
//
// Tests statusline footer 行聚合逻辑（内部行 + 外部 registry 行混合排序）。
//
// 覆盖（CW wave plan TC3/TC4/TC7/TC9）：
//   TC3 aggregateLines 聚合外部行：mock registry 返回 1 个外部行 order=2，
//       验证 6 行排序后外部行插在 order=1（model）和 order=3（ctx）之间（index 2）
//   TC4 外部行 render 返回 null → 该行被跳过
//   TC7 内部行 order 分配：sl:ctx order===3（为外部行留 order=2 间隙）
//   TC9 registry 持续性：多次 aggregateLines 调用 registry 仍可读（owner 持有 canonical 引用）
//   额外：外部行 render 抛异常 → 防御性跳过（不破坏整个 footer）
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
	type FooterLineRegistry,
	type FooterLineRenderer,
} from "../footer-handshake-access.js";
import { aggregateLines, INTERNAL_LINES } from "../index.js";

// ── 辅助：mock registry ────────────────────────────────

/** 构造 mock registry：entries 返回指定 renderer 列表。 */
function makeMockRegistry(entriesList: Array<[string, FooterLineRenderer]>): FooterLineRegistry {
	const map = new Map(entriesList);
	return {
		register(id, r) { map.set(id, r); },
		unregister(id) { map.delete(id); },
		entries() { return map.entries(); },
	};
}

// ctx/theme 在 aggregateLines 中只透传给 renderer.render，mock renderer 忽略它们。
//
// 显式 mock 类型定义：aggregateLines 的入参是 SDK 的 ExtensionContext / Theme（巨大结构），
// 测试不关心其内部，构造完整对象代价过高且与被测逻辑无关。这里用 Partial<...> 作中间层：
//  - 用显式命名类型 MockCtx / MockTheme 取代裸 `as Parameters<typeof aggregateLines>[N]` 索引，
//    让「这是 mock 空对象」的意图在类型层可读；
//  - Partial 保证空对象字面量是合法的，无需 `as any`（测试允许 any，但这里不必用）。
type MockCtx = Partial<ExtensionContext>;
type MockTheme = Partial<Theme>;

/** 构造 ctx mock：空对象（aggregateLines 仅透传给 renderer.render，mock renderer 忽略它）。 */
function makeMockCtx(): MockCtx {
	return {};
}

/** 构造 theme mock：空对象（同上，仅透传）。 */
function makeMockTheme(): MockTheme {
	return {};
}

const mockCtx = makeMockCtx();
const mockTheme = makeMockTheme();

// ── TC3 聚合外部行 ─────────────────────────────────────

describe("aggregateLines — TC3 外部行聚合与排序", () => {
	it("内部 5 行 + 1 外部行(order=2) → 6 行按 order 排序，外部行在 index 2", () => {
		// 模拟 statusline 的 5 类内部行
		const internal = [
			{ order: 0, text: "dir-line" }, // sl:dir
			{ order: 1, text: "model-line" }, // sl:model
			{ order: 3, text: "ctx-line" }, // sl:ctx
			{ order: 4, text: "search-line" }, // sl:search
			{ order: 5, text: "token-plan-line" }, // sl:token-plan
		];
		const externalRenderer: FooterLineRenderer = {
			order: 2,
			render: () => "permission-line",
		};
		const registry = makeMockRegistry([["pi-permission", externalRenderer]]);

		const result = aggregateLines(internal, registry, mockCtx, mockTheme);

		expect(result).toHaveLength(6);
		// 验证 order 升序
		const orders = result.map((l) => l.order);
		expect(orders).toEqual([0, 1, 2, 3, 4, 5]);
		// 外部行(order=2)插在 index 2（model=1 和 ctx=3 之间）
		expect(result[2]!.order).toBe(2);
		expect(result[2]!.text).toBe("permission-line");
	});

	it("无 registry(undefined) → 仅返回内部行，过滤空行", () => {
		const internal = [
			{ order: 0, text: "dir" },
			{ order: 1, text: "" }, // 空行应被过滤
			{ order: 3, text: "ctx" },
		];
		const result = aggregateLines(internal, undefined, mockCtx, mockTheme);
		expect(result).toHaveLength(2);
		expect(result.map((l) => l.order)).toEqual([0, 3]);
	});
});

// ── TC4 外部行 render 返回 null → 跳过 ─────────────────

describe("aggregateLines — TC4 外部行 null/异常防御", () => {
	it("外部行 render 返回 null → 该行被跳过", () => {
		const internal = [{ order: 0, text: "dir" }];
		const nullRenderer: FooterLineRenderer = {
			order: 2,
			render: () => null,
		};
		const registry = makeMockRegistry([["perm", nullRenderer]]);

		const result = aggregateLines(internal, registry, mockCtx, mockTheme);

		expect(result).toHaveLength(1);
		expect(result[0]!.text).toBe("dir");
	});

	it("外部行 render 抛异常 → 防御性跳过，不破坏整个 footer", () => {
		const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const internal = [{ order: 0, text: "dir" }, { order: 1, text: "model" }];
		const throwingRenderer: FooterLineRenderer = {
			order: 2,
			render: () => { throw new Error("boom"); },
		};
		const okRenderer: FooterLineRenderer = {
			order: 3,
			render: () => "after-throw",
		};
		const registry = makeMockRegistry([
			["bad", throwingRenderer],
			["ok", okRenderer],
		]);

		const result = aggregateLines(internal, registry, mockCtx, mockTheme);

		// 抛异常的行被跳过，其余行保留
		expect(result.map((l) => l.text)).toEqual(["dir", "model", "after-throw"]);
		spyWarn.mockRestore();
	});

	it("外部行 render 返回空串 → 跳过", () => {
		const internal = [{ order: 0, text: "dir" }];
		const emptyRenderer: FooterLineRenderer = {
			order: 2,
			render: () => "",
		};
		const registry = makeMockRegistry([["perm", emptyRenderer]]);

		const result = aggregateLines(internal, registry, mockCtx, mockTheme);
		expect(result).toHaveLength(1);
	});
});

// ── TC7 INTERNAL_LINES order 分配 ──────────────────────

describe("INTERNAL_LINES — TC7 order 分配（为外部行留 order=2 间隙）", () => {
	it("sl:dir order === 0", () => {
		const dir = INTERNAL_LINES.find((l) => l.id === "sl:dir");
		expect(dir).toBeDefined();
		expect(dir!.order).toBe(0);
	});

	it("sl:model order === 1", () => {
		const model = INTERNAL_LINES.find((l) => l.id === "sl:model");
		expect(model).toBeDefined();
		expect(model!.order).toBe(1);
	});

	it("sl:ctx order === 3（原隐式位置 2，留 order=2 给外部行）", () => {
		const ctx = INTERNAL_LINES.find((l) => l.id === "sl:ctx");
		expect(ctx).toBeDefined();
		expect(ctx!.order).toBe(3); // 关键：不是 2
	});

	it("order=2 间隙未被任何内部行占用", () => {
		const orders = INTERNAL_LINES.map((l) => l.order);
		expect(orders).not.toContain(2);
	});
});

// ── TC9 registry 持续性（owner 持有 canonical 引用）─────

describe("aggregateLines — TC9 registry 持续性", () => {
	it("同一 registry 多次 aggregateLines 调用仍可读全部 entries", () => {
		// 模拟 statusline owner 持有的 canonical registry：
		// permission 注册一行后，statusline 多次渲染（含 session_tree rebuild）仍能读到
		const registry = makeMockRegistry([]);
		const renderer: FooterLineRenderer = { order: 2, render: () => "perm" };
		registry.register("pi-permission", renderer);

		const internal = [{ order: 0, text: "dir" }];

		// 第一次渲染
		const r1 = aggregateLines(internal, registry, mockCtx, mockTheme);
		// 第二次渲染（如 session_tree 后 statusline rebuild state）
		const r2 = aggregateLines(internal, registry, mockCtx, mockTheme);

		expect(r1).toHaveLength(2);
		expect(r2).toHaveLength(2);
		expect(r1[1]!.text).toBe("perm");
		expect(r2[1]!.text).toBe("perm");
		// renderer 实例未变（持续性）
		expect(r1[1]).toEqual(r2[1]);
	});

	it("registry 外部行更新后立即反映（register 同 id 覆盖）", () => {
		const registry = makeMockRegistry([]);
		const r1: FooterLineRenderer = { order: 2, render: () => "mode-yolo" };
		const r2: FooterLineRenderer = { order: 2, render: () => "mode-auto" };
		registry.register("perm", r1);

		const internal = [{ order: 0, text: "dir" }];
		const before = aggregateLines(internal, registry, mockCtx, mockTheme);
		expect(before[1]!.text).toBe("mode-yolo");

		// mode 切换：permission 端 re-register 同 id 覆盖
		registry.register("perm", r2);
		const after = aggregateLines(internal, registry, mockCtx, mockTheme);
		expect(after[1]!.text).toBe("mode-auto");
	});
});
