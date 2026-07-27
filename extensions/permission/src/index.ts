/**
 * @zhushanwen/pi-permission — Pi permission 扩展
 *
 * 四档权限模式（yolo/auto/approve/strict）+ 三层管道（AST + 规则 + AI Classifier）。
 *
 * W1 阶段（本文件）：骨架 + 模式状态机 + 配置 + /permission 命令。
 * tool_call hook 是占位（所有模式放行），W5 替换为三层管道。
 * statusline 集成（ctx.ui.setFooter 的 TUI Component）推到 W6，W1 不做（避免重量级 UI 代码混入骨架）。
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { handlePermissionCommand } from "./commands.js";
import { getConfigPath, loadAndWatchConfig, saveConfig } from "./config.js";
import type { PermissionConfig } from "./types.js";

/**
 * 扩展工厂。每个 session 独立闭包状态（遵循 Pi session 隔离约束，
 * 不用模块级 let 避免多 session 共享）。
 */
export default function permissionExtension(pi: ExtensionAPI): void {
	// ──────────────────────── 闭包状态（每 session 独立） ────────────────────────
	let config: PermissionConfig = loadAndWatchConfig(getConfigPath(), (msg) => {
		console.warn(msg);
	});

	/** 读取最新配置到闭包变量（mtime 缓存内部去重，未变化不读 fs） */
	function refreshConfig(): void {
		config = loadAndWatchConfig(getConfigPath(), (msg) => console.warn(msg));
	}

	// ──────────────────────── session_start：重载配置 ────────────────────────
	pi.on("session_start", (_event: unknown, _ctx: ExtensionContext) => {
		refreshConfig();
	});

	// ──────────────────────── /permission 命令 ────────────────────────
	pi.registerCommand("permission", {
		description: "View or switch permission mode (yolo/auto/approve/strict). Usage: /permission [mode|status]",
		handler: (args: string, ctx: ExtensionCommandContext): Promise<void> => {
			// 命令执行前重载配置（确保最新，用户可能手动改过文件）
			refreshConfig();
			const message = handlePermissionCommand(args, config, (newConfig) => {
				const result = saveConfig(newConfig);
				if (result.success) {
					config = newConfig; // 更新闭包状态
				}
				return result;
			});
			ctx.ui.notify(message, "info");
			return Promise.resolve();
		},
	});

	// ──────────────────────── tool_call 占位（W5 替换为三层管道） ────────────────────────
	pi.on("tool_call", (_event: unknown, _ctx: ExtensionContext) => {
		// W1 阶段：所有模式都放行，不阻塞。
		// 不读 config（占位逻辑不依赖 mode，避免每次 tool_call 都 statSync）。
		// W5 将替换为 checkPermission（AST → 规则 → AI Classifier），那时才需要读 config。
		// 不 return 任何值 = 不拦截（放行）
	});
}
