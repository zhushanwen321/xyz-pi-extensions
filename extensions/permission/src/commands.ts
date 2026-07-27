/**
 * /permission 命令
 *
 * W1 版本：文本菜单模式（ctx.ui.notify 显示当前模式 + 提示用 /permission <mode> 切换）。
 * 交互式方向键菜单（ctx.ui.custom + 自定义 Component）留待 W6 或后续迭代。
 *
 * 用法：
 *   /permission              显示当前模式和可用模式列表
 *   /permission yolo         切换到 yolo 模式
 *   /permission auto         切换到 auto 模式
 *   /permission approve      切换到 approve 模式
 *   /permission strict       切换到 strict 模式
 *   /permission status       显示当前配置详情
 */

import {
	isValidPermissionMode,
	MODE_DESCRIPTIONS,
	MODE_LABELS,
	PERMISSION_MODES,
	type PermissionConfig,
	type PermissionMode,
} from "./types.js";
import { saveConfig } from "./config.js";

/** 命令处理器返回的文本消息（由 ctx.ui.notify 显示） */
export function handlePermissionCommand(
	args: string | undefined,
	config: PermissionConfig,
	onSave: (config: PermissionConfig) => { success: boolean; error?: string },
): string {
	const trimmed = (args ?? "").trim();

	// 无参数：显示当前模式 + 可用模式
	if (!trimmed) {
		return formatStatusMessage(config);
	}

	// status 子命令：详细配置
	if (trimmed === "status") {
		return formatDetailedStatus(config);
	}

	// 切换模式
	if (isValidPermissionMode(trimmed)) {
		return switchMode(trimmed, config, onSave);
	}

	// 未知参数
	return `[pi-permission] Unknown mode '${trimmed}'. Available: ${PERMISSION_MODES.join(", ")}. Usage: /permission [${PERMISSION_MODES.join("|")}|status]`;
}

// ──────────────────────── 消息格式化 ────────────────────────

function formatStatusMessage(config: PermissionConfig): string {
	const lines: string[] = [];
	lines.push("[pi-permission] Current mode: " + modeHighlight(config.mode));
	lines.push("");
	lines.push("Available modes (by strictness, low → high):");
	for (const mode of PERMISSION_MODES) {
		const marker = mode === config.mode ? "►" : " ";
		lines.push(`  ${marker} ${mode.padEnd(8)} — ${MODE_DESCRIPTIONS[mode]}`);
	}
	lines.push("");
	lines.push("Switch with: /permission <mode>");
	return lines.join("\n");
}

function formatDetailedStatus(config: PermissionConfig): string {
	const lines: string[] = [];
	lines.push("[pi-permission] Configuration:");
	lines.push(`  mode:       ${modeHighlight(config.mode)}`);
	lines.push(`  enabled:    ${config.enabled}`);
	lines.push(`  classifier:`);
	lines.push(`    enabled:           ${config.classifier.enabled}`);
	lines.push(`    model:             ${config.classifier.model}`);
	lines.push(`    timeout:           ${config.classifier.timeout}s`);
	lines.push(`    autoApproveLow:    ${config.classifier.autoApproveLowRisk}`);
	lines.push(`    autoDenyHigh:      ${config.classifier.autoDenyHighRisk}`);
	lines.push(`  userRules:  ${config.userRules.length} rule(s)`);
	return lines.join("\n");
}

function switchMode(
	mode: PermissionMode,
	config: PermissionConfig,
	onSave: (config: PermissionConfig) => { success: boolean; error?: string },
): string {
	if (mode === config.mode) {
		return `[pi-permission] Already in ${MODE_LABELS[mode]} mode.`;
	}

	const newConfig: PermissionConfig = {
		mode,
		enabled: config.enabled,
		classifier: { ...config.classifier },
		userRules: config.userRules.map((r) => ({ ...r })),
	};
	const result = onSave(newConfig);

	if (!result.success) {
		return `[pi-permission] Failed to switch to ${MODE_LABELS[mode]} mode: ${result.error ?? "unknown error"}`;
	}

	return `[pi-permission] Switched to ${MODE_LABELS[mode]} mode.\n  ${MODE_DESCRIPTIONS[mode]}`;
}

function modeHighlight(mode: PermissionMode): string {
	// 纯文本标记（项目规范禁 emoji），用括号标注
	return `${MODE_LABELS[mode]} (${mode})`;
}
