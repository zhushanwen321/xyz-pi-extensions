/**
 * Model Switch — 共享类型定义
 *
 * 所有跨文件的类型、常量集中管理。
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── 常量 ───────────────────────────────────────────────

export const PI_AGENT_DIR = "~/.pi/agent";
export const EXTENSION_NAME = "model-switch";

// ── 工具函数 ────────────────────────────────────────────

/**
 * 从 ctx 中提取当前模型的 "provider/modelId" 字符串。
 * Pi SDK 的 ctx.model 类型不稳定，统一走这个函数。
 */
export function getCurrentModelId(ctx: ExtensionContext): string {
	const model = ctx.model as { provider?: string; id?: string } | undefined;
	if (!model) return "";
	return `${model.provider ?? ""}/${model.id ?? ""}`;
}
