/**
 * @zhushanwen/pi-permission — Pi permission 扩展
 *
 * 四档权限模式（yolo/auto/approve/strict）+ 三层管道（AST + 规则 + AI Classifier）。
 *
 * W1 阶段（本文件）：骨架 + 模式状态机 + 配置 + /permission 命令。
 * tool_call hook 是占位（所有模式放行），W5 替换为三层管道。
 * statusline 集成显示当前模式。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { handlePermissionCommand } from "./commands.js";
import { getConfigPath, loadAndWatchConfig, saveConfig } from "./config.js";
import { MODE_LABELS, type PermissionConfig } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi SDK 类型在 shared/types stub，运行时由 Pi 提供
type PiAPI = ExtensionAPI & {
	on(event: "tool_call", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "turn_end", handler: (event: unknown, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "statusline", handler: (ctx: ExtensionContext) => string | Promise<string>): void;
};

/**
 * 扩展工厂。每个 session 独立闭包状态（遵循 Pi session 隔离约束，
 * 不用模块级 let 避免多 session 共享）。
 */
export default function permissionExtension(pi: PiAPI): void {
	// ──────────────────────── 闭包状态（每 session 独立） ────────────────────────
	let config: PermissionConfig = loadAndWatchConfig(getConfigPath(), (msg) => {
		console.warn(msg);
	});

	// ──────────────────────── session_start：重载配置 ────────────────────────
	pi.on("session_start", async (_event: unknown, _ctx: ExtensionContext) => {
		config = loadAndWatchConfig(getConfigPath(), (msg) => console.warn(msg));
	});

	// ──────────────────────── /permission 命令 ────────────────────────
	pi.registerCommand("permission", {
		description: "View or switch permission mode (yolo/auto/approve/strict). Usage: /permission [mode|status]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			// 命令执行前重载配置（确保最新，用户可能手动改过文件）
			config = loadAndWatchConfig(getConfigPath(), (msg) => console.warn(msg));
			const message = handlePermissionCommand(args, config, (newConfig) => {
				const result = saveConfig(newConfig);
				if (result.success) {
					config = newConfig; // 更新闭包状态
				}
				return result;
			});
			ctx.ui.notify(message, "info");
		},
	});

	// ──────────────────────── tool_call 占位（W5 替换为三层管道） ────────────────────────
	pi.on("tool_call", async (_event: unknown, _ctx: ExtensionContext) => {
		// W1 阶段：所有模式都放行，不阻塞。
		// W5 将替换为 checkPermission（AST → 规则 → AI Classifier）。
		// 配置热重载：每次 tool_call 时检查 mtime（loadAndWatchConfig 内部处理缓存）。
		config = loadAndWatchConfig(getConfigPath());
		// 不 return 任何值 = 不拦截（放行）
	});

	// ──────────────────────── statusline：显示当前模式 ────────────────────────
	pi.on("statusline", (_ctx: ExtensionContext) => {
		return `perm:${MODE_LABELS[config.mode]}`;
	});
}
