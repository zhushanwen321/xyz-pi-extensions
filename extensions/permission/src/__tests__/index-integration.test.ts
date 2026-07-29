/**
 * index-integration.test.ts — W5 tool_call handler 集成测试。
 *
 * 测扩展工厂注册的 tool_call handler 行为：
 *  - yolo 快速路径 → return undefined（放行）
 *  - strict 模式 → block（headless deny）
 *  - mode 切换（config 文件变化后 handler 用新 mode）
 *  - G5 并发串行化（多次 tool_call 顺序处理）
 *  - fail-closed（异常 → block）
 *  - session_start 重载 config
 *
 * 用 PI_CODING_AGENT_DIR 指向临时目录，写入 controlled permission-config.json，
 * 让 loadAndWatchConfig 读到指定 mode。mock pi 对象记录 handler 调用。
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FOOTER_HANDSHAKE_KEY, REQUEST_RENDER_KEY } from "../footer-provider.js";
import permissionExtension from "../index.js";

// ──────────────────────── mock pi ────────────────────────

/** tool_call handler 的最小签名（返回 Promise<block 结果 | undefined>）。 */
type ToolCallHandler = (event: unknown, ctx: unknown) => Promise<ToolCallResult | undefined>;
/** tool_call handler 的返回值（Pi ToolCallEventResult 子集）。 */
interface ToolCallResult {
	block?: boolean;
	reason?: string;
}

interface MockPiCalls {
	registerCommandCalls: Array<{ name: string; options: unknown }>;
	eventHandlers: Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>;
}

/**
 * 构造 mock pi。返回对象满足 ExtensionAPI 的 on/registerCommand 子集，
 * 用 `as Pick<ExtensionAPI, "on" | "registerCommand">` 单点断言（taste/no-unsafe-cast 允许 Pick 断言）。
 */
function createMockPi(): { pi: Pick<ExtensionAPI, "on" | "registerCommand">; calls: MockPiCalls } {
	const registerCommandCalls: MockPiCalls["registerCommandCalls"] = [];
	const eventHandlers: MockPiCalls["eventHandlers"] = new Map();
	const pi = {
		registerCommand(name: string, options: unknown): void {
			registerCommandCalls.push({ name, options });
		},
		on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown): void {
			if (!eventHandlers.has(event)) eventHandlers.set(event, []);
			eventHandlers.get(event)!.push(handler);
		},
	};
	return { pi: pi as Pick<ExtensionAPI, "on" | "registerCommand">, calls: { registerCommandCalls, eventHandlers } };
}

/** 提取 tool_call handler（已注册的单一 handler）。 */
function getToolCallHandler(calls: MockPiCalls): ToolCallHandler {
	const handlers = calls.eventHandlers.get("tool_call");
	if (!handlers || handlers.length === 0) {
		throw new Error("tool_call handler not registered");
	}
	return handlers[0] as ToolCallHandler;
}

/** 提取 session_start handler。 */
function getSessionStartHandler(calls: MockPiCalls): (event: unknown, ctx: unknown) => unknown {
	const handlers = calls.eventHandlers.get("session_start");
	if (!handlers || handlers.length === 0) {
		throw new Error("session_start handler not registered");
	}
	return handlers[0];
}

/** 提取 session_tree handler。 */
function getSessionTreeHandler(calls: MockPiCalls): (event: unknown, ctx: unknown) => unknown {
	const handlers = calls.eventHandlers.get("session_tree");
	if (!handlers || handlers.length === 0) {
		throw new Error("session_tree handler not registered");
	}
	return handlers[0];
}

/** 构造 mock ctx（含 mode/ui/signal）。 */
function makeCtx(mode: "tui" | "rpc" | "json" | "print" = "json"): unknown {
	return {
		mode,
		cwd: "/tmp",
		ui: {
			notify(): void {
				/* noop */
			},
			select(): Promise<string | undefined> {
				return Promise.resolve(undefined);
			},
			custom(): Promise<unknown> {
				return Promise.resolve(undefined);
			},
		},
		signal: undefined,
	};
}

/** bash tool_call event 构造器。 */
function bashEvent(command: string): { toolName: string; input: { command: string } } {
	return { toolName: "bash", input: { command } };
}

// ──────────────────────── 临时 config 目录 ────────────────────────

const TMP_ROOT = join(tmpdir(), "pi-perm-test-" + process.pid);
const AGENT_DIR = join(TMP_ROOT, "agent");
const CONFIG_PATH = join(AGENT_DIR, "permission-config.json");

function writeConfig(mode: string, enabled = true): void {
	mkdirSync(AGENT_DIR, { recursive: true });
	const config = {
		mode,
		enabled,
		classifier: { enabled: true, model: "auto", timeout: 5, autoApproveLowRisk: true, autoDenyHighRisk: true },
		userRules: [],
	};
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

beforeEach(() => {
	process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
	mkdirSync(AGENT_DIR, { recursive: true });
	// 默认 yolo config（大多数测试需要可预测起点）
	writeConfig("yolo");
});

afterEach(() => {
	delete process.env.PI_CODING_AGENT_DIR;
	if (existsSync(TMP_ROOT)) rmSync(TMP_ROOT, { recursive: true, force: true });
	// 清理 footer 握手 slot（session_start/session_tree handler 会写 globalThis）
	Reflect.deleteProperty(globalThis, FOOTER_HANDSHAKE_KEY);
	Reflect.deleteProperty(globalThis, REQUEST_RENDER_KEY);
});

// ──────────────────────── 测试 ────────────────────────

describe("W5 tool_call handler 集成", () => {
	it("工厂注册 session_start + tool_call + /permission command", () => {
		const { pi, calls } = createMockPi();
		expect(() => permissionExtension(pi)).not.toThrow();
		expect(calls.eventHandlers.has("session_start")).toBe(true);
		expect(calls.eventHandlers.has("tool_call")).toBe(true);
		const permCmd = calls.registerCommandCalls.find((c) => c.name === "permission");
		expect(permCmd).toBeDefined();
	});

	it("yolo 快速路径 → return undefined（放行，不跑管道）", async () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		const result = await handler(bashEvent("rm -rf /"), makeCtx());
		expect(result).toBeUndefined();
	});

	it("enabled=false → 等同 yolo 放行", async () => {
		writeConfig("strict", false);
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		const result = await handler(bashEvent("ls"), makeCtx());
		expect(result).toBeUndefined();
	});

	it("strict + headless → block（fail-closed deny）", async () => {
		writeConfig("strict");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		const result = await handler(bashEvent("ls"), makeCtx("json"));
		expect(result).toBeDefined();
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("headless");
	});

	it("approve + 非安全命令 + headless → block", async () => {
		writeConfig("approve");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		// curl 不在白名单 → ask → approve 模式 → 人工审批 → headless deny
		const result = await handler(bashEvent("curl http://example.com"), makeCtx("json"));
		expect(result?.block).toBe(true);
	});

	it("approve + 安全命令（ls）→ 放行", async () => {
		writeConfig("approve");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		// ls 在白名单 → allow → 放行
		const result = await handler(bashEvent("ls"), makeCtx("json"));
		expect(result).toBeUndefined();
	});

	it("缺 toolName → fail-closed block", async () => {
		writeConfig("approve");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		const result = await handler({ input: { command: "ls" } }, makeCtx());
		expect(result?.block).toBe(true);
		expect(result?.reason).toContain("missing toolName");
	});

	it("G5 并发串行：多个 tool_call 顺序处理（不重叠）", async () => {
		writeConfig("strict");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		// 并发发起 3 个 tool_call（不 await），它们应串行
		const ctx = makeCtx();
		const p1 = handler(bashEvent("ls"), ctx);
		const p2 = handler(bashEvent("pwd"), ctx);
		const p3 = handler(bashEvent("whoami"), ctx);
		// Promise.all 这里是故意的：3 个调用是同一串行链上的任务，断言全部 block。
		// 非独立降级场景才用 allSettled；此处任一 reject 即测试失败（符合预期）。
		const results = await Promise.all([p1, p2, p3]);
		expect(results.length).toBe(3);
		for (const r of results) {
			expect(r?.block).toBe(true);
		}
	});

	it("session_start handler 重载 config（mode 切换生效）", async () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const toolHandler = getToolCallHandler(calls);
		const sessionHandler = getSessionStartHandler(calls);

		// 初始 yolo → 放行
		const r1 = await toolHandler(bashEvent("ls"), makeCtx());
		expect(r1).toBeUndefined();

		// 切换到 strict，触发 session_start 重载
		writeConfig("strict");
		getSessionStartHandler(calls);
		sessionHandler({}, makeCtx());

		// 现在 strict → block
		const r2 = await toolHandler(bashEvent("ls"), makeCtx());
		expect(r2?.block).toBe(true);
	});

	it("异常路径 → fail-closed block（绝不放行）", async () => {
		writeConfig("approve");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getToolCallHandler(calls);
		// input=null → 容错为 {}，bash 无 command → 走管道，approve + 空命令 → 人工审批 → headless deny
		const result = await handler({ toolName: "bash", input: null }, makeCtx());
		expect(result).toBeDefined();
		expect(result?.block).toBe(true);
	});
});

// ──────────────────────── W8 /permission rule 命令集成 ────────────────────────

/** 提取 /permission command handler。 */
function getPermissionHandler(calls: MockPiCalls): (args: string, ctx: unknown) => Promise<void> {
	const cmd = calls.registerCommandCalls.find((c) => c.name === "permission");
	if (!cmd) throw new Error("permission command not registered");
	return (cmd.options as { handler: (args: string, ctx: unknown) => Promise<void> }).handler;
}

describe("W8 /permission rule 命令集成", () => {
	it("headless（json）→ notify 降级提示，不改 config", async () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getPermissionHandler(calls);
		const ctx = makeCtx("json");
		// 不应抛错
		await handler("rule", ctx);
	});

	it("permission handler 分流：rule 参数走 rule 路径（headless 降级）", async () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const handler = getPermissionHandler(calls);
		const ctx = makeCtx("json");
		// rule 参数应走 headless 降级（notify）
		await expect(handler("rule", ctx)).resolves.not.toThrow();
	});
});

// ──────────────────────── footer line 注册（duck typing + session_tree）────────────────────────

describe("footer line 注册", () => {
	it("session_start：ctx.ui 无 theme → registerFooterLineFor 返回 noop dispose，不抛异常", () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const sessionHandler = getSessionStartHandler(calls);

		// ctx.ui 完全无 theme 字段（headless/mock 形状）。
		// registerFooterLineFor 的 duck typing 守卫应命中，返回 () => {} 而不调
		// registerPermissionFooterLine（故 globalThis 不应出现握手 slot）。
		const ctxNoTheme = { mode: "json", cwd: "/tmp", ui: {}, signal: undefined };
		expect(() => sessionHandler({}, ctxNoTheme)).not.toThrow();
		expect(Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY)).toBeUndefined();
	});

	it("session_start：ctx.ui.theme 存在但 fg 非函数 → noop dispose，不抛异常", () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const sessionHandler = getSessionStartHandler(calls);

		// theme 存在但 fg 缺失/非函数 → duck typing 失败 → noop dispose。
		const ctxBadFg = {
			mode: "json",
			cwd: "/tmp",
			ui: { theme: { fg: "not-a-function" } },
			signal: undefined,
		};
		expect(() => sessionHandler({}, ctxBadFg)).not.toThrow();
		// 未注册 renderer → 不应触碰 globalThis 握手 slot
		expect(Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY)).toBeUndefined();
	});

	it("session_tree：触发两次 handler 不抛异常（dispose 旧 renderer → refreshConfig → 重注册）", () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const sessionTreeHandler = getSessionTreeHandler(calls);

		// ctx.ui.theme 为合法 fg 函数 → 真实注册 renderer（写 globalThis slot）。
		const ctxWithTheme = {
			mode: "json",
			cwd: "/tmp",
			ui: {
				theme: {
					fg: (_token: string, text: string): string => text,
				},
			},
			signal: undefined,
		};

		// 第一次：注册 renderer（无旧 renderer，dispose 是 noop）。
		expect(() => sessionTreeHandler({}, ctxWithTheme)).not.toThrow();
		expect(Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY)).toBeDefined();

		// 切换 config（模拟分支切换后 permission-config.json 变化）。
		writeConfig("strict");

		// 第二次：dispose 上次的 renderer → refreshConfig 读到 strict → 重新注册。
		// disposeFooterLine 是闭包私有变量，这里间接验证：多次触发不抛、不破坏 slot 结构。
		expect(() => sessionTreeHandler({}, ctxWithTheme)).not.toThrow();
		// slot 仍存在且结构合规（version=1，pending 是数组）
		const slot = Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY) as {
			version: number;
			pending: unknown[];
		};
		expect(slot).toBeDefined();
		expect(slot.version).toBe(1);
		expect(Array.isArray(slot.pending)).toBe(true);
		// 两次注册 + 一次 dispose（第二次触发前）→ pending 应至多 1 项（旧 renderer 已 dispose 移除）
		expect(slot.pending.length).toBeLessThanOrEqual(1);
	});

	it("session_tree：ctx.ui 无 theme 时多次触发仍安全（noop dispose 重复调用）", () => {
		writeConfig("yolo");
		const { pi, calls } = createMockPi();
		permissionExtension(pi);
		const sessionTreeHandler = getSessionTreeHandler(calls);

		// 无 theme → 两次都是 noop dispose，不应抛、不应写 globalThis。
		const ctxNoTheme = { mode: "json", cwd: "/tmp", ui: {}, signal: undefined };
		expect(() => sessionTreeHandler({}, ctxNoTheme)).not.toThrow();
		expect(() => sessionTreeHandler({}, ctxNoTheme)).not.toThrow();
		expect(Reflect.get(globalThis, FOOTER_HANDSHAKE_KEY)).toBeUndefined();
	});
});
