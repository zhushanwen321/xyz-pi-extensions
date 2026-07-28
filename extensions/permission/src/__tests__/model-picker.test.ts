/**
 * model-picker.test.ts — W7 T5：model picker 单元测试。
 *
 * 覆盖：
 *  - listAvailableModels（5）：空文件 / 无 apiKey 过滤 / 多 provider 排序 / cost 升序 / 无 model 的 provider 不进 Map
 *  - pickModelViaOverlay（3）：TUI mock custom / RPC mock select / headless 降级
 *  - ProviderModelSelectorComponent（5，含 WR1 handleInput 锁定）：
 *      构造 / 初始 stage / provider onSelect / switchToModelStage / model onSelect
 *      + 直接调 comp.handleInput('\r') 验证 SelectList.onSelect 触发（WR1）
 *
 * 用真实 pi-tui SelectList（不 mock），验证键盘委托集成通路（WR1 critical）。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ResolvedModelEntry } from "../classifier/model-resolver.js";
import { listAvailableModels } from "../classifier/model-resolver.js";
import {
	DEFAULT_SELECT_THEME,
	type ModelPickerContext,
	pickModelViaOverlay,
	ProviderModelSelectorComponent,
	type SelectionResult,
} from "../model-picker.js";

// ──────────────────────── 临时文件 fixtures（listAvailableModels） ────────────────────────

let tempDir: string;
let modelsJsonPath: string;

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-perm-mp-"));
	modelsJsonPath = join(tempDir, "models.json");
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

function writeModels(data: unknown): void {
	writeFileSync(modelsJsonPath, JSON.stringify(data), "utf-8");
}

/** 构造一条 ResolvedModelEntry（测试 helper）。 */
function makeEntry(provider: string, id: string, inputCost: number, hasApiKey = true): ResolvedModelEntry {
	return {
		provider,
		id,
		name: id,
		api: "openai-completions",
		cost: { input: inputCost, output: 0, cacheRead: 0, cacheWrite: 0 },
		hasApiKey,
	};
}

/** 构造 models Map（用于 component / pickModelViaOverlay 测试，避免读盘）。 */
function makeModelsMap(providers: Record<string, ResolvedModelEntry[]>): Map<string, ResolvedModelEntry[]> {
	return new Map(Object.entries(providers));
}

// ──────────────────────── listAvailableModels（5 cases） ────────────────────────

describe("MPT1: listAvailableModels", () => {
	it("文件缺失 → 空 Map（不 throw）", () => {
		expect(existsSync(modelsJsonPath)).toBe(false);
		const map = listAvailableModels(undefined, modelsJsonPath);
		expect(map.size).toBe(0);
	});

	it("无 apiKey 的 provider 被过滤（不进 Map）", () => {
		writeModels({
			providers: {
				"auth-co": { apiKey: "k1", api: "openai-completions", models: [{ id: "m1", cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
				"noauth-co": { api: "openai-completions", models: [{ id: "m2", cost: { input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
			},
		});
		const map = listAvailableModels(undefined, modelsJsonPath);
		expect(map.has("auth-co")).toBe(true);
		expect(map.has("noauth-co")).toBe(false); // 无 apiKey 过滤
	});

	it("多 provider 按 provider 名字母序排序（Map 插入序）", () => {
		writeModels({
			providers: {
				"zebra-co": { apiKey: "k1", api: "openai-completions", models: [{ id: "m1", cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
				"alpha-co": { apiKey: "k2", api: "openai-completions", models: [{ id: "m2", cost: { input: 0.2, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
			},
		});
		const map = listAvailableModels(undefined, modelsJsonPath);
		const providers = [...map.keys()];
		expect(providers).toEqual(["alpha-co", "zebra-co"]); // 字母序
	});

	it("provider 内 model 按 cost.input 升序 + id 字母序 tiebreaker", () => {
		writeModels({
			providers: {
				"co": {
					apiKey: "k1",
					api: "openai-completions",
					models: [
						{ id: "expensive", cost: { input: 1.0, output: 0, cacheRead: 0, cacheWrite: 0 } },
						{ id: "cheap-b", cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } },
						{ id: "cheap-a", cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } },
					],
				},
			},
		});
		const map = listAvailableModels(undefined, modelsJsonPath);
		const models = map.get("co")!;
		expect(models.map((m) => m.id)).toEqual(["cheap-a", "cheap-b", "expensive"]);
	});

	it("provider 有 apiKey 但无 model → 不进 Map（无 model 项被过滤）", () => {
		writeModels({
			providers: {
				"empty-co": { apiKey: "k1", api: "openai-completions", models: [] },
				"has-co": { apiKey: "k2", api: "openai-completions", models: [{ id: "m1", cost: { input: 0.1, output: 0, cacheRead: 0, cacheWrite: 0 } }] },
			},
		});
		const map = listAvailableModels(undefined, modelsJsonPath);
		expect(map.has("empty-co")).toBe(false); // 无 model 不进 Map
		expect(map.has("has-co")).toBe(true);
	});
});

// ──────────────────────── pickModelViaOverlay（3 cases） ────────────────────────

function makePickerCtx(overrides: Partial<ModelPickerContext> = {}): ModelPickerContext {
	const base: ModelPickerContext = {
		mode: "tui",
		ui: {
			notify: vi.fn(),
			select: vi.fn(() => Promise.resolve(undefined)),
			custom: vi.fn(() => Promise.resolve(undefined)),
		},
	};
	return { mode: overrides.mode ?? base.mode, ui: { ...base.ui, ...overrides.ui } };
}

describe("MPT2: pickModelViaOverlay 分发", () => {
	it("headless（json）→ 返回 undefined（降级）", async () => {
		const ctx = makePickerCtx({ mode: "json" });
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const result = await pickModelViaOverlay(ctx, "auto", models);
		expect(result).toBeUndefined();
	});

	it("空 models Map → 返回 undefined（降级，无论 mode）", async () => {
		const ctx = makePickerCtx({ mode: "tui" });
		const result = await pickModelViaOverlay(ctx, "auto", new Map());
		expect(result).toBeUndefined();
	});

	it("RPC 模式：第一次选 Auto → 返回 'auto'", async () => {
		const ctx = makePickerCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve("Auto")),
				custom: vi.fn(),
			},
		});
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const result = await pickModelViaOverlay(ctx, "auto", models);
		expect(result).toBe("auto");
		expect(ctx.ui.select).toHaveBeenCalledOnce();
	});

	it("RPC 模式：选 provider 后选 model → 返回 'provider/model'", async () => {
		const selectMock = vi.fn()
			.mockResolvedValueOnce("co") // provider
			.mockResolvedValueOnce("m1"); // model
		const ctx = makePickerCtx({
			mode: "rpc",
			ui: { notify: vi.fn(), select: selectMock, custom: vi.fn() },
		});
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const result = await pickModelViaOverlay(ctx, "auto", models);
		expect(result).toBe("co/m1");
		expect(ctx.ui.select).toHaveBeenCalledTimes(2);
	});

	it("RPC 模式：第一次 select undefined（cancel）→ 返回 undefined", async () => {
		const ctx = makePickerCtx({
			mode: "rpc",
			ui: {
				notify: vi.fn(),
				select: vi.fn(() => Promise.resolve(undefined)),
				custom: vi.fn(),
			},
		});
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const result = await pickModelViaOverlay(ctx, "auto", models);
		expect(result).toBeUndefined();
	});

	it("TUI 模式：custom factory 被调用，comp done settle 结果", async () => {
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		// 模拟 ctx.ui.custom：构造 comp 并模拟 done({kind:'auto'})
		const customMock = vi.fn(
			<T,>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => unknown) =>
				new Promise<T>((resolve) => {
					factory({}, {}, {}, (r: T) => resolve(r));
				}),
		);
		const ctx = makePickerCtx({ mode: "tui", ui: { notify: vi.fn(), select: vi.fn(), custom: customMock } });
		// 在 factory 内拿到 comp，但这里 mock 直接调 done({kind:'auto'})
		// 改写 mock：构造真实 comp 并用 cancel/settle
		customMock.mockImplementationOnce(
			<T,>(factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: T) => void) => unknown) =>
				new Promise<T>((resolve) => {
					const comp = factory({}, {}, {}, (r: T) => resolve(r)) as ProviderModelSelectorComponent;
					// 触发 provider stage 的 'Auto' 选中（index 0）
					comp.handleInput("\r"); // Enter → onSelect(Auto) → done({kind:'auto'})
				}),
		);
		const result = await pickModelViaOverlay(ctx, "auto", models);
		expect(result).toBe("auto");
		expect(customMock).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── ProviderModelSelectorComponent（5 cases + WR1） ────────────────────────

describe("MPT3: ProviderModelSelectorComponent 构造 + 初始 stage", () => {
	it("构造：初始 stage='provider'，render 非空含 'Select Provider'", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		const lines = comp.render(80);
		const joined = lines.join("\n");
		expect(joined).toContain("Select Provider");
		expect(joined).toContain("Auto");
		expect(done).not.toHaveBeenCalled();
	});

	it("currentSpec='auto' → 预选 'Auto'（index 0）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		comp.handleInput("\r"); // Enter 选中预选项（Auto）
		expect(done).toHaveBeenCalledOnce();
		const result = done.mock.calls[0]![0] as SelectionResult | undefined;
		expect(result).toEqual({ kind: "auto" });
	});

	it("currentSpec='provider/modelId' → 预选该 provider（Enter 直接到 model stage）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const comp = new ProviderModelSelectorComponent("co/m1", ["co"], models, done);
		// 预选 'co'（index 1），Enter 触发 switchToModelStage（不 done）
		comp.handleInput("\r");
		expect(done).not.toHaveBeenCalled(); // 进入 model stage，未 settle
		const lines = comp.render(80);
		expect(lines.join("\n")).toContain("Select Model");
	});
});

describe("MPT4: ProviderModelSelectorComponent provider onSelect", () => {
	it("provider stage 选 Auto → done({kind:'auto'})", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		comp.handleInput("\r"); // Enter 选中预选 Auto
		expect(done).toHaveBeenCalledWith({ kind: "auto" });
	});

	it("provider stage 选具体 provider → switchToModelStage（不 done）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		// 下移到 'co'（index 1），Enter 进入 model stage
		comp.handleInput("\x1b[B"); // Down arrow
		comp.handleInput("\r"); // Enter
		expect(done).not.toHaveBeenCalled();
		expect(comp.render(80).join("\n")).toContain("Select Model");
	});

	it("provider stage Esc → done(undefined)（cancel）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		comp.handleInput("\x1b"); // Esc
		expect(done).toHaveBeenCalledWith(undefined);
	});
});

describe("MPT5: ProviderModelSelectorComponent model onSelect", () => {
	it("model stage 选 model → done({kind:'specific', provider, modelId})", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1), makeEntry("co", "m2", 0.2)] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		// 下移到 'co'，Enter 进 model stage
		comp.handleInput("\x1b[B"); // Down
		comp.handleInput("\r"); // Enter → model stage
		// model stage 预选 m1（cost 升序第一个）
		comp.handleInput("\r"); // Enter 选 m1
		expect(done).toHaveBeenCalledWith({ kind: "specific", provider: "co", modelId: "m1" });
	});

	it("model stage Esc → 回退到 provider stage（不 done）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		// 进 model stage
		comp.handleInput("\x1b[B"); // Down
		comp.handleInput("\r"); // Enter → model stage
		// Esc 回退
		comp.handleInput("\x1b"); // Esc
		expect(done).not.toHaveBeenCalled();
		expect(comp.render(80).join("\n")).toContain("Select Provider"); // 回到 provider stage
	});

	it("_resolved 守卫：done 后再 handleInput no-op", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		comp.handleInput("\r"); // Auto → done
		expect(done).toHaveBeenCalledOnce();
		// 二次输入 no-op
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
	});
});

// ──────────────────────── WR1: handleInput 键盘委托锁定（critical） ────────────────────────

describe("MPT6: WR1 handleInput 委托 SelectList.onSelect（critical）", () => {
	it("handleInput('\\r') 直接触发 SelectList.onSelect（不绕过键盘委托通路）", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		// 直接调 handleInput('\r')，验证：
		// 1. Container.handleInput 不存在，组件 override 委托给 SelectList
		// 2. SelectList.handleInput('\r') 触发 onSelect → comp.settle({kind:'auto'})
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledOnce();
		const result = done.mock.calls[0]![0] as SelectionResult | undefined;
		expect(result).toEqual({ kind: "auto" });
	});

	it("handleInput(down + enter) 链式触发 SelectList 导航 + onSelect", () => {
		const done = vi.fn();
		const models = makeModelsMap({ "co": [makeEntry("co", "m1", 0.1)] });
		const comp = new ProviderModelSelectorComponent("auto", ["co"], models, done);
		// Down 移动到 'co'，Enter 选中 → 进 model stage（done 未调）
		comp.handleInput("\x1b[B"); // Down
		comp.handleInput("\r"); // Enter
		expect(done).not.toHaveBeenCalled(); // 进入 model stage
		// model stage Enter 选中 m1
		comp.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ kind: "specific", provider: "co", modelId: "m1" });
	});
});

// ──────────────────────── DEFAULT_SELECT_THEME（G2 修正验证） ────────────────────────

describe("MPT7: DEFAULT_SELECT_THEME（G2/WR2 修正）", () => {
	it("selectedPrefix 在文本前加 '▶ '", () => {
		expect(DEFAULT_SELECT_THEME.selectedPrefix("text")).toBe("\u25B6 text");
	});

	it("selectedPrefix 非 identity（有视觉区分）", () => {
		const result = DEFAULT_SELECT_THEME.selectedPrefix("foo");
		expect(result).not.toBe("foo");
		expect(result.startsWith("\u25B6")).toBe(true);
	});
});
