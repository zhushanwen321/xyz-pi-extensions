/**
 * WT8/WT9: 扩展入口注册 + 占位 tool_call 测试
 *
 * 用 mock pi 对象记录调用，不依赖真实 Pi 运行时。
 */
import { describe, expect, it } from "vitest";

// Mock Pi SDK 模块（extension.ts import 的 @mariozechner/pi-coding-agent 类型是 stub）
// 直接 import 工厂函数，用 mock pi 调用它
import permissionExtension from "../index.js";

/** 创建 mock pi 对象记录所有调用 */
function createMockPi(): {
	pi: any;
	registerCommandCalls: Array<{ name: string; options: any }>;
	eventHandlers: Map<string, Array<(event?: any, ctx?: any) => any>>;
} {
	const registerCommandCalls: Array<{ name: string; options: any }> = [];
	const eventHandlers = new Map<string, Array<(event?: any, ctx?: any) => any>>();

	const pi: any = {
		registerCommand(name: string, options: any) {
			registerCommandCalls.push({ name, options });
		},
		on(event: string, handler: any) {
			if (!eventHandlers.has(event)) {
				eventHandlers.set(event, []);
			}
			eventHandlers.get(event)!.push(handler);
		},
	};

	return { pi, registerCommandCalls, eventHandlers };
}

describe("WT8: 扩展入口注册", () => {
	it("permissionExtension(pi) 注册 /permission 命令和事件处理器", () => {
		const { pi, registerCommandCalls, eventHandlers } = createMockPi();

		// 不应 throw
		expect(() => permissionExtension(pi)).not.toThrow();

		// 注册了 permission 命令
		const permCommand = registerCommandCalls.find((c) => c.name === "permission");
		expect(permCommand).toBeDefined();
		expect(permCommand!.options.description).toBeTruthy();
		expect(typeof permCommand!.options.handler).toBe("function");

		// 注册了 session_start 事件
		expect(eventHandlers.has("session_start")).toBe(true);

		// 注册了 tool_call 事件（W1 占位）
		expect(eventHandlers.has("tool_call")).toBe(true);

		// 注册了 statusline 事件
		expect(eventHandlers.has("statusline")).toBe(true);
	});

	it("permission 命令 handler 调用时返回状态消息（无参数）", async () => {
		const { pi, registerCommandCalls } = createMockPi();
		permissionExtension(pi);

		const permCommand = registerCommandCalls.find((c) => c.name === "permission");
		const notifyCalls: Array<{ message: string; level: string }> = [];
		const mockCtx: any = {
			ui: {
				notify(message: string, level: string) {
					notifyCalls.push({ message, level });
				},
			},
		};

		await permCommand!.options.handler("", mockCtx);

		expect(notifyCalls).toHaveLength(1);
		expect(notifyCalls[0].message).toContain("Current mode");
		expect(notifyCalls[0].message).toContain("yolo"); // 默认模式
		expect(notifyCalls[0].level).toBe("info");
	});
});

describe("WT9: W1 占位 tool_call（所有模式放行）", () => {
	it("yolo 模式 tool_call 放行（不 throw）", async () => {
		const { pi, eventHandlers } = createMockPi();
		permissionExtension(pi);

		const toolCallHandlers = eventHandlers.get("tool_call")!;
		expect(toolCallHandlers.length).toBeGreaterThan(0);

		// 调用 handler 应该不 throw，且不返回拦截值
		for (const handler of toolCallHandlers) {
			await expect(handler({ toolName: "bash", command: "rm -rf /" }, {} as any)).resolves.toBeUndefined();
		}
	});

	it("strict 模式 tool_call 也放行（W1 占位，W5 才实现管道）", async () => {
		// 通过修改配置文件切换到 strict（模拟）
		// 但 W1 的 tool_call 占位不读 mode，所以直接测 handler 行为
		const { pi, eventHandlers } = createMockPi();
		permissionExtension(pi);

		const toolCallHandlers = eventHandlers.get("tool_call")!;
		for (const handler of toolCallHandlers) {
			// 无论什么工具调用，W1 占位都放行
			await expect(handler({ toolName: "write", command: undefined }, {} as any)).resolves.toBeUndefined();
			await expect(handler({ toolName: "bash", command: "git push --force" }, {} as any)).resolves.toBeUndefined();
		}
	});
});

describe("statusline 集成", () => {
	it("statusline handler 返回当前模式标签", async () => {
		const { pi, eventHandlers } = createMockPi();
		permissionExtension(pi);

		const statuslineHandlers = eventHandlers.get("statusline")!;
		expect(statuslineHandlers.length).toBeGreaterThan(0);

		const result = await statuslineHandlers[0]({} as any);
		expect(typeof result).toBe("string");
		expect(result).toContain("perm:");
		expect(result).toContain("YOLO"); // 默认模式标签
	});
});
