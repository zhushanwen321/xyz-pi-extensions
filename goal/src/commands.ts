/**
 * /goal 命令定义和参数解析
 */

import type { BudgetConfig } from "./state";
import { MAX_TURNS_CAP, MAX_STALL_CAP, UPDATE_PREFIX_LENGTH } from "./constants";

export interface GoalCommandArgs {
	action: "set" | "status" | "pause" | "resume" | "clear" | "update";
	objective?: string;
	budget?: Partial<BudgetConfig>;
}

export function parseGoalArgs(raw: string): GoalCommandArgs {
	const trimmed = raw.trim().toLowerCase();
	const fullRaw = raw.trim();

	// Subcommands without objective
	if (trimmed === "" || trimmed === "status") {
		return { action: "status" };
	}
	if (trimmed === "pause") {
		return { action: "pause" };
	}
	if (trimmed === "resume") {
		return { action: "resume" };
	}
	if (trimmed === "clear") {
		return { action: "clear" };
	}

	// /goal update <new objective>
	if (trimmed.startsWith("update ")) {
		return { action: "update", objective: fullRaw.slice(UPDATE_PREFIX_LENGTH).trim() };
	}
	// /goal update (without argument) → 报错
	if (trimmed === "update") {
		return { action: "update" };
	}

	// /goal <objective> [--tokens N] [--timeout N] [--max-turns N] [--max-stall N]
	// 只匹配已知 flag，避免误删 objective 中的 -- 文本
	const knownFlags = /--(?:tokens|timeout|max-turns|max-stall)\s+\d+/g;
	const objective = fullRaw.replace(knownFlags, "").trim();
	const budget: Partial<BudgetConfig> = {};

	const tokenMatch = fullRaw.match(/--tokens\s+(\d+)/);
	if (tokenMatch) {
		const val = parseInt(tokenMatch[1]!, 10);
		if (!isNaN(val) && val > 0) budget.tokenBudget = val;
	}

	const timeMatch = fullRaw.match(/--timeout\s+(\d+)/);
	if (timeMatch) {
		const val = parseInt(timeMatch[1]!, 10);
		if (!isNaN(val) && val > 0) budget.timeBudgetMinutes = val;
	}

	const maxTurnsMatch = fullRaw.match(/--max-turns\s+(\d+)/);
	if (maxTurnsMatch) {
		const val = parseInt(maxTurnsMatch[1]!, 10);
		if (!isNaN(val)) budget.maxTurns = Math.max(1, Math.min(val, MAX_TURNS_CAP));
	}

	const maxStallMatch = fullRaw.match(/--max-stall\s+(\d+)/);
	if (maxStallMatch) {
		const val = parseInt(maxStallMatch[1]!, 10);
		if (!isNaN(val)) budget.maxStallTurns = Math.max(1, Math.min(val, MAX_STALL_CAP));
	}

	if (!objective) {
		return { action: "status" };
	}

	return { action: "set", objective, budget };
}
