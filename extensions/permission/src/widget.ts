// widget.ts
//
// permission 常驻 widget（onboarding hint bar）。
//
// PR-1 静态版：rule count + classifier model（auto 模式）。
// 不读 meta、不判断 isOnboarded（onboarding gating 是 PR-2 范围）。
//
// 通过 ctx.ui.setWidget("permission", lines) 注册，Pi 在 TUI 常驻区域渲染。
// 纯函数实现：输入结构化数据，输出行数组，便于单测。

import type { PermissionMode } from "./types.js";

/** widget 渲染输入（从 PermissionConfig 提取的最小子集）。 */
export interface PermissionHintInput {
	/** 当前权限模式 */
	mode: PermissionMode;
	/** 用户自定义规则数量 */
	userRuleCount: number;
	/** classifier 模型 id（'auto' 或 'provider/model-id'，auto 模式才显示） */
	classifierModel: string;
}

/**
 * 渲染 permission widget 行（纯函数，便于单测）。
 *
 *  - auto 模式 + 有 model → '[pi-permission] N user rule(s) · classifier: <model>'
 *  - 其他模式（或 model 为空）→ '[pi-permission] N user rule(s)'
 *
 * rule(s) 单复数随 count 变化（1→rule，其他→rules）。
 *
 * @param input 渲染输入
 * @returns 行数组（单行，数组包装便于 setWidget 统一接口与未来扩展）
 */
export function renderPermissionHint(input: PermissionHintInput): string[] {
	const { mode, userRuleCount, classifierModel } = input;
	const ruleWord = userRuleCount === 1 ? "rule" : "rules";
	const base = `[pi-permission] ${userRuleCount} user ${ruleWord}`;
	if (mode === "auto" && classifierModel) {
		return [`${base} · classifier: ${classifierModel}`];
	}
	return [base];
}
