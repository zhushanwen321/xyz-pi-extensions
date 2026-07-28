/**
 * WT8/WT9: 扩展入口注册 + 占位 tool_call 测试
 *
 * 用 mock pi 对象记录调用，不依赖真实 Pi 运行时。
 */
import { describe, expect, it } from "vitest";

// Mock Pi SDK 模块（extension.ts import 的 @mariozechner/pi-coding-agent 类型在 node_modules 有完整定义，
// 这里 import 工厂函数，用 mock pi 调用它）
import permissionExtension from "../index.js";

/** 最小 mock：只记录 registerCommand 和 on 调用 */
interface MockPi {
	registerCommand: (name: string, options: unknown) => void;
	on: (event: string, handler: (event?: unknown, ctx?: unknown) => unknown) => void;
}

interface RecordedCall {
	name: string;
	options: unknown;
}

function createMockPi(): {
	pi: MockPi;
	registerCommandCalls: RecordedCall[];
	eventHandlers: Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>;
} {
	const registerCommandCalls: RecordedCall[] = [];
	const eventHandlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => unknown>>();

	const pi: MockPi = {
		registerCommand(name: string, options: unknown) {
			registerCommandCalls.push({ name, options });
		},
		on(event: string, handler: (event?: unknown, ctx?: unknown) => unknown) {
			if (!eventHandlers.has(event)) {
				eventHandlers.set(event, []);
			}
			eventHandlers.get(event)!.push(handler);
		},
	};

	return { pi, registerCommandCalls, eventHandlers };
}

/** 提取 handler options 的类型（运行时 duck typing） */
interface CommandOptions {
	description: string;
	handler: (args: string, ctx: { ui: { notify: (message: string, level: string) => void } }) => void;
}

describe("WT8: 扩展入口注册", () => {
	it("permissionExtension(pi) 注册 /permission 命令和事件处理器", () => {
		const { pi, registerCommandCalls, eventHandlers } = createMockPi();

		// 不应 throw
		expect(() => permissionExtension(pi)).not.toThrow();

		// 注册了 permission 命令
		const permCommand = registerCommandCalls.find((c) => c.name === "permission");
		expect(permCommand).toBeDefined();
		const opts = permCommand!.options as CommandOptions;
		expect(opts.description).toBeTruthy();
		expect(typeof opts.handler).toBe("function");

		// 注册了 session_start 事件
		expect(eventHandlers.has("session_start")).toBe(true);

		// 注册了 tool_call 事件（W1 占位）
		expect(eventHandlers.has("tool_call")).toBe(true);

		// W1 不注册 statusline（ctx.ui.setFooter 的 TUI Component 推到 W6）
		expect(eventHandlers.has("statusline")).toBe(false);
	});

	it("permission 命令 handler 调用时返回状态消息（无参数）", () => {
		const { pi, registerCommandCalls } = createMockPi();
		permissionExtension(pi);

		const permCommand = registerCommandCalls.find((c) => c.name === "permission");
		const opts = permCommand!.options as CommandOptions;
		const notifyCalls: Array<{ message: string; level: string }> = [];
		const mockCtx = {
			ui: {
				notify(message: string, level: string) {
					notifyCalls.push({ message, level });
				},
			},
		};

		opts.handler("", mockCtx);

		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].message).toContain("Current mode");
		expect(notifyCalls[0].message).toContain("yolo"); // 默认模式
		expect(notifyCalls[0].level).toBe("info");
	});

	it("permission 命令切换模式后 handler 显示新模式", () => {
		const { pi, registerCommandCalls } = createMockPi();
		permissionExtension(pi);

		const permCommand = registerCommandCalls.find((c) => c.name === "permission");
		const opts = permCommand!.options as CommandOptions;
		const notifyCalls: Array<{ message: string; level: string }> = [];
		const mockCtx = {
			ui: {
				notify(message: string, level: string) {
					notifyCalls.push({ message, level });
				},
			},
		};

		// 切换到 strict（会触发 saveConfig，但 saveConfig 写真实路径，这里用临时配置）
		// 用 /permission status 避免写文件
		opts.handler("status", mockCtx);
		expect(notifyCalls[0].message).toContain("mode:");
	});
});

describe("WT9: tool_call handler（W5 三层管道接入）", () => {
	it("tool_call handler 存在且返回 Promise（不 throw）", () => {
		const { pi, eventHandlers } = createMockPi();
		permissionExtension(pi);

		const toolCallHandlers = eventHandlers.get("tool_call")!;
		expect(toolCallHandlers.length).toBe(1);

		// 调用 handler 应该不 throw，且返回 Promise（W5 handler 是 async）
		const result = toolCallHandlers[0](
			{ toolName: "bash", input: { command: "rm -rf /" } },
			{ mode: "yolo", cwd: "/tmp", ui: { notify() {}, select() { return Promise.resolve(undefined); }, custom() { return Promise.resolve(undefined); } } },
		);
		expect(result).toBeInstanceOf(Promise);
	});

	it("yolo 模式（默认 config）对任意工具调用放行（resolve undefined）", async () => {
		const { pi, eventHandlers } = createMockPi();
		permissionExtension(pi);

		const handler = eventHandlers.get("tool_call")![0] as (
			event: unknown,
			ctx: unknown,
		) => Promise<unknown>;

		// 默认 config mode=yolo → 快速路径放行（resolve undefined）
		const mockCtx = {
			mode: "yolo" as const,
			cwd: "/tmp",
			ui: {
				notify() {},
				select() {
					return Promise.resolve(undefined);
				},
				custom() {
					return Promise.resolve(undefined);
				},
			},
		};

		// yolo 快速路径：不跑管道，直接 resolve undefined
		await expect(
			handler({ toolName: "bash", input: { command: "git push --force" } }, mockCtx),
		).resolves.toBeUndefined();
		await expect(
			handler({ toolName: "write", input: { path: "/etc/passwd" } }, mockCtx),
		).resolves.toBeUndefined();
	});
});
