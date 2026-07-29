// src/__tests__/footer-handshake-access.test.ts
//
// Tests footer 握手协议 owner 端（statusline 是 canonical owner）。
//
// 覆盖（CW wave plan TC1/TC2/TC8）：
//   TC1/TC2 getOrCreateFooterRegistry 三分支：
//     - 无 slot → 建 slot + 立即建 registry（canonical 实例）
//     - slot 存在但 registry 未就绪（permission 先到过，塞过 pending）→ 创建 registry + flush pending
//     - slot 存在且 registry 已就绪 → 返回 === 同一实例（idempotent）
//   TC2 version mismatch / 非对象 → warn + 重建
//   TC8 registerRequestRender identity check（A 注册→B 注册→unreg A 不删 B→unreg B 才删）
//
// 隔离：每个用例前清理 globalThis 上 FOOTER_HANDSHAKE_KEY / REQUEST_RENDER_KEY。
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	FOOTER_HANDSHAKE_KEY,
	type FooterHandshakeSlot,
	type FooterLineRegistry,
	type FooterLineRenderer,
	getOrCreateFooterRegistry,
	registerRequestRender,
	REQUEST_RENDER_KEY,
} from "../footer-handshake-access.js";

// ── 辅助：读写 globalThis slot ─────────────────────────

/** 拿到当前 slot（手动读取，绕过 readSlot 的 version 守卫，用于断言内部结构） */
function readSlot(): FooterHandshakeSlot | undefined {
	return Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY) as
		| FooterHandshakeSlot
		| undefined;
}

/** 塞一个指定形状的 slot（手动构造，模拟 consumer 先到或脏数据场景）。 */
function writeSlot(slot: FooterHandshakeSlot): void {
	Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, slot);
}

/** 构造最小合法 renderer（order + render 返回固定文本） */
function makeRenderer(order: number, text: string): FooterLineRenderer {
	return { order, render: () => text };
}

// ── TC1/TC2 getOrCreateFooterRegistry ─────────────────

describe("getOrCreateFooterRegistry", () => {
	beforeEach(() => {
		Reflect.deleteProperty(globalThis, FOOTER_HANDSHAKE_KEY);
	});

	it("TC1 分支1: 无 slot → 建 slot + 立即建 canonical registry", () => {
		expect(readSlot()).toBeUndefined();

		const registry = getOrCreateFooterRegistry();

		// slot 已建，version=1，registry 就绪，pending 空
		const slot = readSlot();
		expect(slot).toBeDefined();
		expect(slot!.version).toBe(1);
		expect(slot!.registry).toBe(registry); // registry 即 canonical 实例
		expect(slot!.pending).toEqual([]);
		// registry 可用：register 后 entries 能读到
		registry.register("x", makeRenderer(2, "ext-line"));
		expect(Array.from(registry.entries())).toHaveLength(1);
	});

	it("TC2 分支2: slot 存在但 registry 未就绪（permission 先到）→ 建 registry + flush pending", () => {
		// 模拟 permission 先 session_start：塞了 pending renderer，registry 缺失
		const pendingRenderer = makeRenderer(2, "permission-line");
		const preSlot: FooterHandshakeSlot = {
			version: 1,
			pending: [{ id: "pi-permission", renderer: pendingRenderer }],
		};
		writeSlot(preSlot);

		const registry = getOrCreateFooterRegistry();

		// registry 就绪 + flush 后 pending 清空
		expect(preSlot.registry).toBe(registry);
		expect(preSlot.pending).toEqual([]);
		// pending 的 renderer 已被 flush 进 registry
		const entries = Array.from(registry.entries());
		expect(entries).toHaveLength(1);
		expect(entries[0]![0]).toBe("pi-permission");
		expect(entries[0]![1]).toBe(pendingRenderer);
	});

	it("TC1 分支3: slot 存在且 registry 已就绪 → 返回 === 同一实例（idempotent）", () => {
		// 第一次调用：建 slot + registry
		const first = getOrCreateFooterRegistry();
		// 第二次调用：registry 已就绪，应返回同一实例引用
		const second = getOrCreateFooterRegistry();

		expect(second).toBe(first); // === 严格相等，不重建
	});

	it("TC1 幂等性: 多次调用 + 中途 register 不丢数据", () => {
		const r1 = getOrCreateFooterRegistry();
		r1.register("a", makeRenderer(0, "a"));
		const r2 = getOrCreateFooterRegistry();
		r2.register("b", makeRenderer(1, "b"));
		const r3 = getOrCreateFooterRegistry();

		expect(r1).toBe(r2);
		expect(r2).toBe(r3);
		expect(Array.from(r3.entries())).toHaveLength(2);
	});

	// ── TC2 version mismatch / 非对象 ──────────────────

	it("TC2 version mismatch（version:2）→ warn + 丢弃重建为新 slot", () => {
		const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		// 塞一个 version=2 的旧 slot（模拟未来协议升级 / 脏数据）
		const legacySlot = {
			version: 2 as const,
			registry: undefined,
			pending: [{ id: "stale", renderer: makeRenderer(2, "stale") }],
		};
		// version:2 与 version:1 字面量类型不兼容，需 any 断言（测试允许 as any）
		writeSlot(legacySlot as FooterHandshakeSlot);

		const registry = getOrCreateFooterRegistry();

		const slot = readSlot();
		// 旧 slot 被替换为新 slot（version 退回 1，旧 pending 丢弃）
		expect(slot).not.toBe(legacySlot);
		expect(slot!.version).toBe(1);
		expect(slot!.registry).toBe(registry);
		// 旧 pending 不被 flush（重建后 pending 为空）
		expect(slot!.pending).toEqual([]);
		expect(Array.from(registry.entries())).toHaveLength(0);
		// warn 被调用（包含 version mismatch 提示）
		expect(spyWarn).toHaveBeenCalledTimes(1);
		expect(spyWarn.mock.calls[0]![0]).toContain("version mismatch");
		spyWarn.mockRestore();
	});

	it("TC2 slot 是非对象（字符串污染）→ 视为无 slot，静默重建", () => {
		const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		// 模拟 globalThis 被污染成字符串（不应 warn，直接重建）
		Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, "garbage");

		const registry = getOrCreateFooterRegistry();

		const slot = readSlot();
		expect(slot).toBeDefined();
		expect(slot!.version).toBe(1);
		expect(slot!.registry).toBe(registry);
		// 非对象污染不触发 version warn（只 version 数字不匹配才 warn）
		expect(spyWarn).not.toHaveBeenCalled();
		spyWarn.mockRestore();
	});

	it("TC2 slot 是 null → 视为无 slot，重建", () => {
		Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, null);

		const registry = getOrCreateFooterRegistry();

		const slot = readSlot();
		expect(slot).toBeDefined();
		expect(slot!.registry).toBe(registry);
	});

	it("TC2 slot.pending 非数组 → 视为无 slot，重建", () => {
		// 模拟结构畸形 slot（pending 是字符串）
		const malformed = { version: 1, pending: "not-an-array" };
		Reflect.set(globalThis, FOOTER_HANDSHAKE_KEY, malformed);

		const registry = getOrCreateFooterRegistry();

		const slot = readSlot();
		expect(slot).toBeDefined();
		expect(slot!.registry).toBe(registry);
		expect(Array.isArray(slot!.pending)).toBe(true);
	});
});

// ── TC8 registerRequestRender identity check ──────────

describe("registerRequestRender", () => {
	beforeEach(() => {
		Reflect.deleteProperty(globalThis, REQUEST_RENDER_KEY);
	});

	it("TC8 注册后 globalThis 持有该 fn", () => {
		const fn = vi.fn();
		const unreg = registerRequestRender(fn);

		expect(Reflect.get(globalThis, REQUEST_RENDER_KEY)).toBe(fn);
		unreg();
		expect(Reflect.get(globalThis, REQUEST_RENDER_KEY)).toBeUndefined();
	});

	it("TC8 identity check: A 注册→B 注册→unreg A 不删 B→unreg B 才删", () => {
		const fnA = vi.fn();
		const fnB = vi.fn();
		const unregA = registerRequestRender(fnA);
		// B 注册后覆盖 A（globalThis 槽位现在是 fnB）
		const unregB = registerRequestRender(fnB);
		expect(Reflect.get(globalThis, REQUEST_RENDER_KEY)).toBe(fnB);

		// unreg A:identity check 发现槽位已是 fnB（≠ fnA），不应删除
		unregA();
		expect(Reflect.get(globalThis, REQUEST_RENDER_KEY)).toBe(fnB);

		// unreg B:identity check 匹配，删除槽位
		unregB();
		expect(Reflect.get(globalThis, REQUEST_RENDER_KEY)).toBeUndefined();
	});

	it("TC8 多次 unreg 同一 fn:第二次 noop（槽位已删）", () => {
		const fn = vi.fn();
		const unreg = registerRequestRender(fn);
		unreg();
		expect(Reflect.get(globalThis, REQUEST_RENDER_KEY)).toBeUndefined();
		// 第二次调用不应抛错，也不应重新写入
		unreg();
		expect(Reflect.get(globalThis, REQUEST_RENDER_KEY)).toBeUndefined();
	});
});

// ── Registry 方法（register/unregister/entries）基本契约 ──

describe("FooterLineRegistry 方法契约", () => {
	beforeEach(() => {
		Reflect.deleteProperty(globalThis, FOOTER_HANDSHAKE_KEY);
	});

	it("register 同 id 覆盖（幂等），unregister 清除，entries 遍历", () => {
		const registry: FooterLineRegistry = getOrCreateFooterRegistry();
		const r1 = makeRenderer(2, "v1");
		const r2 = makeRenderer(2, "v2");

		registry.register("perm", r1);
		registry.register("perm", r2); // 同 id 覆盖
		const entries1 = Array.from(registry.entries());
		expect(entries1).toHaveLength(1);
		expect(entries1[0]![1]).toBe(r2); // 后注册覆盖

		registry.unregister("perm");
		expect(Array.from(registry.entries())).toHaveLength(0);
	});
});
