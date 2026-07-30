import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { CONFIG, isEnabled, setSwitch } from "./pure.js";

/**
 * 解析 /auto-rename 参数并执行开关操作。纯函数，返回反馈文本（供 handler notify）。
 *
 * 用法：
 *   /auto-rename         — 查看当前状态
 *   /auto-rename on      — 开启
 *   /auto-rename off     — 关闭
 */
export function executeAutoRenameCommand(args: string): string {
	const trimmed = args.trim().toLowerCase();

	if (trimmed === "" || trimmed === "status") {
		const state = isEnabled(CONFIG.switchFilePath) ? "已开启 ✓" : "已关闭 ✗";
		return `自动重命名会话：${state}\n用法：/auto-rename on | off | status`;
	}

	if (trimmed === "on" || trimmed === "enable") {
		return setSwitch(CONFIG.switchFilePath, true);
	}

	if (trimmed === "off" || trimmed === "disable") {
		return setSwitch(CONFIG.switchFilePath, false);
	}

	return `未知参数 "${args.trim()}"。\n用法：/auto-rename on | off | status`;
}

/** 注册 /auto-rename 命令。 */
export function registerAutoRenameCommand(pi: ExtensionAPI): void {
	pi.registerCommand("auto-rename", {
		description: "控制自动重命名会话功能。/auto-rename [on|off|status]",
		getArgumentCompletions(prefix: string) {
			const trimmed = prefix.trimStart().toLowerCase();
			const opts = [
				{ label: "on", value: "on", description: "开启自动重命名" },
				{ label: "off", value: "off", description: "关闭自动重命名" },
				{ label: "status", value: "status", description: "查看当前状态" },
			];
			return trimmed === "" ? opts : opts.filter((o) => o.label.startsWith(trimmed));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			ctx.ui.notify(executeAutoRenameCommand(args), "info");
		},
	});
}
