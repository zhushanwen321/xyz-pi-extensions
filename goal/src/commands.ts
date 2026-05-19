/**
 * /goal 命令定义和参数解析
 */

import type { BudgetConfig } from "./state";

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
		return { action: "update", objective: fullRaw.slice(7).trim() };
	}

	// /goal <objective> [--tokens N] [--timeout N] [--max-turns N] [--max-stall N]
	const objective = fullRaw.replace(/--\w+\s+\S+/g, "").trim();
	const budget: Partial<BudgetConfig> = {};

	const tokenMatch = fullRaw.match(/--tokens\s+(\d+)/);
	if (tokenMatch) budget.tokenBudget = parseInt(tokenMatch[1]!, 10);

	const timeMatch = fullRaw.match(/--timeout\s+(\d+)/);
	if (timeMatch) budget.timeBudgetMinutes = parseInt(timeMatch[1]!, 10);

	const maxTurnsMatch = fullRaw.match(/--max-turns\s+(\d+)/);
	if (maxTurnsMatch) budget.maxTurns = Math.max(1, Math.min(parseInt(maxTurnsMatch[1]!, 10), 100));

	const maxStallMatch = fullRaw.match(/--max-stall\s+(\d+)/);
	if (maxStallMatch) budget.maxStallTurns = Math.max(1, parseInt(maxStallMatch[1]!, 10));

	if (!objective) {
		return { action: "status" };
	}

	return { action: "set", objective, budget };
}
