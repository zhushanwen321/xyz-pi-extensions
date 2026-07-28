/**
 * statusline.test.ts — W6 T10: createPermissionFooter + renderPermissionLine 测试。
 *
 * 覆盖（4 case）：
 *  1. renderPermissionLine：四档模式 + enabled/disabled 渲染正确
 *  2. createPermissionFooter：factory 返回 FooterHandle（dispose/invalidate/render）
 *  3. render 缓存：同 width 第二次返回缓存；invalidate 后重算
 *  4. registerPermissionFooter：duck typing（无 setFooter/theme 时跳过）
 */
import { describe, expect, it, vi } from "vitest";

import {
	createPermissionFooter,
	type FooterFactory,
	type FooterHandle,
	MODE_ACCENT_TOKEN,
	paletteFromTheme,
	registerPermissionFooter,
	renderPermissionLine,
	type PermissionPalette,
} from "../statusline.js";
import type { PermissionMode } from "../types.js";
import { MODE_LABELS } from "../types.js";

// ──────────────────────── mock helpers ────────────────────────

/** 透传 palette（不加 ANSI，便于断言原始字符串）。 */
function passthroughPalette(): PermissionPalette {
	return {
		dim: (s) => s,
		text: (s) => s,
		accent: (s) => s,
		success: (s) => s,
		warning: (s) => s,
	};
}

/** mock theme（fg 透传，记录 token）。 */
function mockTheme(): { fg: (token: string, text: string) => string; calls: Array<{ token: string; text: string }> } {
	const calls: Array<{ token: string; text: string }> = [];
	return {
		fg(token: string, text: string): string {
			calls.push({ token, text });
			return text;
		},
		calls,
	};
}

const ALL_MODES: PermissionMode[] = ["yolo", "auto", "approve", "strict"];

// ──────────────────────── case 1: renderPermissionLine ────────────────────────

describe("W6 T10 case 1: renderPermissionLine（四档模式 + enabled）", () => {
	it("每个模式渲染对应的 MODE_LABELS", () => {
		const palette = passthroughPalette();
		for (const mode of ALL_MODES) {
			const lines = renderPermissionLine(mode, true, palette);
			expect(lines).toHaveLength(1);
			expect(lines[0]).toContain(MODE_LABELS[mode]);
		}
	});

	it("enabled=true 渲染 'enabled' + 模式 detail", () => {
		const palette = passthroughPalette();
		const lines = renderPermissionLine("strict", true, palette);
		expect(lines[0]).toContain("enabled");
		expect(lines[0]).toContain("all require approval");
	});

	it("enabled=false 渲染 'disabled' + passthrough 提示", () => {
		const palette = passthroughPalette();
		const lines = renderPermissionLine("yolo", false, palette);
		expect(lines[0]).toContain("disabled");
		expect(lines[0]).toContain("passthrough");
	});

	it("yolo 模式 detail 是 'all tools allowed'", () => {
		const lines = renderPermissionLine("yolo", true, passthroughPalette());
		expect(lines[0]).toContain("all tools allowed");
	});

	it("auto 模式 detail 是 'AST + rules + AI classifier'", () => {
		const lines = renderPermissionLine("auto", true, passthroughPalette());
		expect(lines[0]).toContain("AST + rules + AI classifier");
	});

	it("行含 [pi-permission] 前缀（grep 友好）", () => {
		const lines = renderPermissionLine("auto", true, passthroughPalette());
		expect(lines[0]).toContain("[pi-permission]");
	});

	it("MODE_ACCENT_TOKEN 映射完整（四档模式都有对应 token）", () => {
		for (const mode of ALL_MODES) {
			expect(MODE_ACCENT_TOKEN[mode]).toBeDefined();
		}
	});
});

// ──────────────────────── case 2: createPermissionFooter factory ────────────────────────

describe("W6 T10 case 2: createPermissionFooter（factory 返回 FooterHandle）", () => {
	it("factory 返回含 dispose/invalidate/render 的 handle", () => {
		const palette = passthroughPalette();
		const factory = createPermissionFooter(() => "auto", () => true, palette);
		const handle = factory({ requestRender() {} }, {}, {});
		expect(typeof handle.dispose).toBe("function");
		expect(typeof handle.invalidate).toBe("function");
		expect(typeof handle.render).toBe("function");
	});

	it("dispose 不抛异常（noop）", () => {
		const palette = passthroughPalette();
		const factory = createPermissionFooter(() => "yolo", () => true, palette);
		const handle = factory({ requestRender() {} }, {}, {});
		expect(() => handle.dispose()).not.toThrow();
	});

	it("render 返回行数组（含当前模式）", () => {
		const palette = passthroughPalette();
		const factory = createPermissionFooter(() => "strict", () => true, palette);
		const handle = factory({ requestRender() {} }, {}, {});
		const lines = handle.render(80);
		expect(Array.isArray(lines)).toBe(true);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join(" ")).toContain("Strict");
	});

	it("getMode/getEnabled 闭包读最新值（mode 变化反映到 render）", () => {
		let currentMode: PermissionMode = "yolo";
		const palette = passthroughPalette();
		const factory = createPermissionFooter(() => currentMode, () => true, palette);
		const handle = factory({ requestRender() {} }, {}, {});
		const lines1 = handle.render(80);
		expect(lines1.join(" ")).toContain("YOLO");

		// 切换 mode 后 invalidate + 重 render
		currentMode = "strict";
		handle.invalidate();
		const lines2 = handle.render(80);
		expect(lines2.join(" ")).toContain("Strict");
		expect(lines2.join(" ")).not.toContain("YOLO");
	});
});

// ──────────────────────── case 3: render 缓存 ────────────────────────

describe("W6 T10 case 3: render 缓存（同 width 复用，invalidate 重算）", () => {
	it("同 width 第二次 render 返回缓存（同一引用）", () => {
		const palette = passthroughPalette();
		const factory = createPermissionFooter(() => "auto", () => true, palette);
		const handle = factory({ requestRender() {} }, {}, {});
		const first = handle.render(100);
		const second = handle.render(100);
		expect(second).toBe(first); // 同一引用（缓存命中）
	});

	it("不同 width → 重新渲染（缓存 key 含 width）", () => {
		const palette = passthroughPalette();
		const factory = createPermissionFooter(() => "auto", () => true, palette);
		const handle = factory({ requestRender() {} }, {}, {});
		const first = handle.render(80);
		const second = handle.render(120);
		expect(second).not.toBe(first); // 不同引用（width 变了）
	});

	it("invalidate 后同 width → 重新渲染", () => {
		const palette = passthroughPalette();
		const factory = createPermissionFooter(() => "auto", () => true, palette);
		const handle = factory({ requestRender() {} }, {}, {});
		const first = handle.render(80);
		handle.invalidate();
		const second = handle.render(80);
		expect(second).not.toBe(first); // invalidate 后重新渲染
	});
});

// ──────────────────────── case 4: registerPermissionFooter duck typing ────────────────────────

describe("W6 T10 case 4: registerPermissionFooter（duck typing 跳过）", () => {
	it("ctx.ui 含 setFooter + theme → 调用 setFooter 注册 factory", () => {
		const setFooter = vi.fn();
		const theme = mockTheme();
		registerPermissionFooter({ setFooter, theme }, () => "auto", () => true);
		expect(setFooter).toHaveBeenCalledOnce();
		const factory = setFooter.mock.calls[0]![0] as FooterFactory;
		expect(typeof factory).toBe("function");
		// 验证 factory 产出可用
		const handle: FooterHandle = factory({ requestRender() {} }, {}, {});
		expect(handle.render(80).length).toBeGreaterThan(0);
	});

	it("ctx.ui 无 setFooter → 跳过（不抛异常）", () => {
		const theme = mockTheme();
		// 只有 theme，没有 setFooter
		expect(() => registerPermissionFooter({ theme }, () => "auto", () => true)).not.toThrow();
	});

	it("ctx.ui 无 theme → 跳过", () => {
		const setFooter = vi.fn();
		// 只有 setFooter，没有 theme
		registerPermissionFooter({ setFooter }, () => "auto", () => true);
		expect(setFooter).not.toHaveBeenCalled();
	});

	it("ctx.ui.theme 无 fg 函数 → 跳过", () => {
		const setFooter = vi.fn();
		const theme = { fg: "not-a-function" };
		registerPermissionFooter({ setFooter, theme }, () => "auto", () => true);
		expect(setFooter).not.toHaveBeenCalled();
	});

	it("paletteFromTheme 从 theme 构造 palette（透传 fg 调用）", () => {
		const theme = mockTheme();
		const palette = paletteFromTheme(theme);
		palette.dim("test-dim");
		palette.accent("test-accent");
		expect(theme.calls.some((c) => c.token === "dim" && c.text === "test-dim")).toBe(true);
		expect(theme.calls.some((c) => c.token === "accent" && c.text === "test-accent")).toBe(true);
	});
});
