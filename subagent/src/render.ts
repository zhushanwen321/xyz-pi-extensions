/**
 * Subagent rendering — view models, TUI components, and formatting helpers
 *
 * Extracted from index.ts to isolate rendering concerns from process management.
 * All types here are consumed by both the tool renderResult handler and
 * the process spawning layer (which produces SingleResult).
 */

import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import type { Theme } from "@mariozechner/pi-coding-agent";
import type { AgentScope } from "./agents.js";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";

// ──────────────────────── Constants ────────────────────────

export const COLLAPSED_ITEM_COUNT = 10;
export const CHAIN_COLLAPSED_ITEM_COUNT = 5;
export const TEXT_PREVIEW_LINES = 3;

const STATUS_ICONS: Record<string, string> = {
	running: "\u23F3",
	succeeded: "\u2705",
	failed: "\u274C",
	pending: "\u25CB",
};

const STATUS_COLORS: Record<string, string> = {
	running: "warning",
	succeeded: "success",
	failed: "error",
	pending: "muted",
};

type ThemeColorParam = Parameters<Theme["fg"]>[0];

export function renderStatusIcon(status: string, theme: Theme): string {
	const icon = STATUS_ICONS[status] ?? STATUS_ICONS.running;
	const color = (STATUS_COLORS[status] ?? "muted") as ThemeColorParam;
	return theme.fg(color, icon);
}

// ──────────────────────── Formatting ────────────────────────

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: Theme["fg"],
): string {
	// Safe string extraction with fallback — avoids `as string` type assertions
	// that silently produce "undefined" at runtime when the field is missing.
	const str = (v: unknown): string => typeof v === "string" ? v : "";

	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			const command = str(args.command) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = str(args.file_path || args.path) || "...";
			const filePath = shortenPath(rawPath);
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = str(args.file_path || args.path) || "...";
			const filePath = shortenPath(rawPath);
			const content = str(args.content);
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = str(args.file_path || args.path) || "...";
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = str(args.path) || ".";
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = str(args.pattern) || "*";
			const rawPath = str(args.path) || ".";
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = str(args.pattern);
			const rawPath = str(args.path) || ".";
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m${seconds}s`;
}

export function formatTimestamp(epochMs: number): string {
	const d = new Date(epochMs);
	return d.toTimeString().slice(0, 8);
}

// ──────────────────────── Data types ────────────────────────

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SingleResult {
	agent: string;
	agentSource: "user" | "project" | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	thinkingLevel?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	startTime: number;
	endTime?: number;
	durationMs?: number;
	lastActivityTime: number;
}

export interface SubagentDetails {
	mode: "single" | "parallel" | "chain" | "background";
	resolvedModel: string;
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
	memoryId?: string;
	memoryAction?: "create" | "resume";
	memoryFile?: string;
	_render?: {
		type: "summary-table";
		summary: string;
		data: {
			columns: string[];
			rows: Record<string, string>[];
		};
	};
}

export interface DurationInfo {
	startTime: number;
	endTime?: number;
	durationMs?: number;
	lastActivityTime: number;
}

export interface AgentResultView {
	name: string;
	source: string;
	status: "running" | "succeeded" | "failed";
	duration: DurationInfo;
	turns: number;
	tokens: { input: number; output: number };
	cost: number;
	model?: string;	
	thinkingLevel?: string;
	task: string;
	toolCalls: DisplayItem[];
	finalOutput: string;
	errorMessage?: string;
	stopReason?: string;
}

export interface ParallelSummaryView {
	total: number;
	succeeded: number;
	failed: number;
	running: number;
	isDone: boolean;
	agents: AgentResultView[];
	aggregateTokens: { input: number; output: number };
	aggregateCost: number;
	totalDurationMs?: number;
}

// ──────────────────────── Message helpers ────────────────────────

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text" && part.text.trim()) return part.text;
			}
		}
	}
	return "";
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "thinking") continue;
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

// ──────────────────────── View model builders ────────────────────────

export function buildAgentResultView(r: SingleResult, _now?: number): AgentResultView {
	let status: AgentResultView["status"];
	if (r.exitCode === -1) status = "running";
	else if (r.exitCode === 0) status = "succeeded";
	else status = "failed";

	return {
		name: r.agent,
		source: r.agentSource,
		status,
		duration: {
			startTime: r.startTime,
			endTime: r.endTime,
			durationMs: r.durationMs,
			lastActivityTime: r.lastActivityTime,
		},
		turns: r.usage.turns,
		tokens: { input: r.usage.input, output: r.usage.output },
		cost: r.usage.cost,
		model: r.model,
		thinkingLevel: r.thinkingLevel,
		task: r.task,
		toolCalls: getDisplayItems(r.messages),
		finalOutput: getFinalOutput(r.messages),
		errorMessage: r.errorMessage,
		stopReason: r.stopReason,
	};
}

export function buildParallelSummaryView(results: SingleResult[]): ParallelSummaryView {
	const agents = results.map((r) => buildAgentResultView(r));
	const succeeded = agents.filter((a) => a.status === "succeeded").length;
	const failed = agents.filter((a) => a.status === "failed").length;
	const running = agents.filter((a) => a.status === "running").length;
	const isDone = running === 0;

	const aggregateTokens = agents.reduce(
		(acc, a) => ({ input: acc.input + a.tokens.input, output: acc.output + a.tokens.output }),
		{ input: 0, output: 0 },
	);
	const aggregateCost = agents.reduce((acc, a) => acc + a.cost, 0);

	const durations = agents
		.filter((a) => a.duration.durationMs !== undefined)
		.map((a) => a.duration.durationMs!);
	const totalDurationMs = durations.length > 0 ? Math.max(...durations) : undefined;

	return {
		total: results.length,
		succeeded,
		failed,
		running,
		isDone,
		agents,
		aggregateTokens,
		aggregateCost,
		totalDurationMs,
	};
}

// ──────────────────────── Render functions ────────────────────────

export function aggregateUsageFromViews(views: AgentResultView[]): string {
	const total = views.reduce(
		(acc, v) => ({
			input: acc.input + v.tokens.input,
			output: acc.output + v.tokens.output,
			cost: acc.cost + v.cost,
			turns: acc.turns + v.turns,
		}),
		{ input: 0, output: 0, cost: 0, turns: 0 },
	);
	return formatUsageStats({
		input: total.input,
		output: total.output,
		cacheRead: 0,
		cacheWrite: 0,
		cost: total.cost,
		turns: total.turns,
	});
}


export function renderAgentDetail(
	view: AgentResultView,
	theme: Theme,
	mdTheme: MarkdownTheme,
	opts: { label?: string; showTask: boolean; sessionShortId?: string },
): Container {
	const container = new Container();
	const icon = renderStatusIcon(view.status, theme);

	const durationStr = view.duration.durationMs !== undefined
		? formatDuration(view.duration.durationMs)
		: "";

	const idPart = opts.sessionShortId ? ` #${opts.sessionShortId}` : "";
	let header = `${icon} ${theme.fg("toolTitle", theme.bold(view.name))}${theme.fg("accent", idPart)}`;
	if (opts.label) header += theme.fg("muted", ` (${opts.label})`);
	header += theme.fg("muted", ` (${view.source})`);
	if (durationStr) header += ` ${theme.fg("dim", durationStr)}`;
	if (view.model) {
		const modelDisplay = view.thinkingLevel ? `${view.model}/${view.thinkingLevel}` : view.model;
		header += ` ${theme.fg("dim", modelDisplay)}`;
	}
	if (view.status === "failed" && view.stopReason) header += ` ${theme.fg("error", `[${view.stopReason}]`)}`;

	container.addChild(new Text(header, 0, 0));

	if (view.status === "failed" && view.errorMessage) {
		container.addChild(new Text(theme.fg("error", `Error: ${view.errorMessage}`), 0, 0));
	}

	container.addChild(new Spacer(1));

	if (opts.showTask) {
		container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
		container.addChild(new Text(theme.fg("dim", view.task), 0, 0));
		container.addChild(new Spacer(1));
	}

	container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));

	if (view.toolCalls.length === 0 && !view.finalOutput) {
		container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
	} else {
		for (const item of view.toolCalls) {
			if (item.type === "toolCall") {
				container.addChild(
					new Text(
						theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme)),
						0, 0,
					),
				);
			} else if (item.type === "text" && item.text.trim()) {
				container.addChild(new Text(theme.fg("toolOutput", item.text), 0, 0));
			}
		}
		if (view.finalOutput) {
			container.addChild(new Spacer(1));
			container.addChild(new Markdown(view.finalOutput.trim(), 0, 0, mdTheme));
		}
	}

	const usageParts: string[] = [];
	if (view.turns) usageParts.push(`${view.turns} turn${view.turns > 1 ? "s" : ""}`);
	if (view.tokens.input) usageParts.push(`↑${formatTokens(view.tokens.input)}`);
	if (view.tokens.output) usageParts.push(`↓${formatTokens(view.tokens.output)}`);
	if (view.cost) usageParts.push(`$${view.cost.toFixed(4)}`);
	if (usageParts.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usageParts.join("  ")), 0, 0));
	}

	return container;
}

export function renderSingleCollapsedText(view: AgentResultView, theme: Theme, sessionShortId?: string, elapsed?: string): string {
	const icon = renderStatusIcon(view.status, theme);
	const durationStr = elapsed ?? (view.duration.durationMs !== undefined ? formatDuration(view.duration.durationMs) : "");
	const idPart = sessionShortId ? ` #${sessionShortId}` : "";

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("single"))}${theme.fg("accent", idPart)}`;
	const modelDisplay = view.model
		? (view.thinkingLevel ? `${view.model}/${view.thinkingLevel}` : view.model)
		: "";
	text += `\n  ${theme.fg("accent", view.name)}  ${theme.fg("dim", modelDisplay)}`;
	if (durationStr) text += `  ${theme.fg("dim", durationStr)}`;
	if (view.status === "failed" && view.stopReason) text += ` ${theme.fg("error", `[${view.stopReason}]`)}`;
	if (view.status === "failed" && view.errorMessage) {
		text += `\n${theme.fg("error", `Error: ${view.errorMessage}`)}`;
	} else if (view.toolCalls.length === 0) {
		text += `\n${theme.fg("muted", "(no output)")}`;
	} else {
		const toShow = view.toolCalls.slice(-COLLAPSED_ITEM_COUNT);
		const skipped = view.toolCalls.length > COLLAPSED_ITEM_COUNT ? view.toolCalls.length - COLLAPSED_ITEM_COUNT : 0;
		if (skipped > 0) text += `\n${theme.fg("muted", `... ${skipped} earlier items`)}`;
		for (const item of toShow) {
			if (item.type === "text") {
				const lines = item.text.split("\n");
				const preview = lines.slice(0, TEXT_PREVIEW_LINES).join("\n");
				text += `\n${theme.fg("toolOutput", preview)}`;
				if (lines.length > TEXT_PREVIEW_LINES) text += `\n${theme.fg("muted", "...")}`;
			} else {
				text += `\n${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
			}
		}
		if (skipped > 0 || view.toolCalls.length > COLLAPSED_ITEM_COUNT) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	}
	const usageParts: string[] = [];
	if (view.turns) usageParts.push(`${view.turns} turn${view.turns > 1 ? "s" : ""}`);
	if (view.tokens.input) usageParts.push(`↑${formatTokens(view.tokens.input)}`);
	if (view.tokens.output) usageParts.push(`↓${formatTokens(view.tokens.output)}`);
	if (view.cost) usageParts.push(`$${view.cost.toFixed(4)}`);
	if (usageParts.length > 0) text += `\n${theme.fg("dim", usageParts.join("  "))}`;
	return text;
}

export function renderChainCollapsedText(
	views: AgentResultView[],
	details: SubagentDetails,
	icon: string,
	theme: Theme,
	sessionShortId?: string,
): Text {
	const successCount = views.filter((v) => v.status === "succeeded").length;
	const runningCount = views.filter((v) => v.status === "running").length;
	const idPart = sessionShortId ? ` #${sessionShortId}` : "";
	const statusStr = runningCount > 0
		? `${successCount}/${views.length} done, ${runningCount} running`
		: `${successCount}/${views.length} succeeded`;

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain"))}${theme.fg("accent", idPart)}  ${theme.fg("dim", statusStr)}`;

	for (let i = 0; i < views.length; i++) {
		const view = views[i];
		const stepNum = details.results[i].step ?? i + 1;
		const stepIcon = renderStatusIcon(view.status, theme);
		const modelStr = view.model
			? (view.thinkingLevel ? ` ${theme.fg("dim", `${view.model}/${view.thinkingLevel}`)}` : ` ${theme.fg("dim", view.model)}`)
			: "";
		const durationStr = view.duration.durationMs !== undefined ? ` ${formatDuration(view.duration.durationMs)}` : "";
		text += `\n  ${theme.fg("muted", `Step ${stepNum}:`)} ${stepIcon} ${theme.fg("accent", view.name)}${modelStr}${theme.fg("dim", durationStr)}`;
		if (view.toolCalls.length === 0) {
			text += `\n    ${theme.fg("muted", "(no output)")}`;
		} else {
			const toShow = view.toolCalls.slice(-CHAIN_COLLAPSED_ITEM_COUNT);
			const skipped = view.toolCalls.length > CHAIN_COLLAPSED_ITEM_COUNT ? view.toolCalls.length - CHAIN_COLLAPSED_ITEM_COUNT : 0;
			if (skipped > 0) text += `\n    ${theme.fg("muted", `... ${skipped} earlier items`)}`;
			for (const item of toShow) {
				if (item.type === "text") {
					const lines = item.text.split("\n");
					const preview = lines.slice(0, TEXT_PREVIEW_LINES).join("\n");
					text += `\n    ${theme.fg("toolOutput", preview)}`;
					if (lines.length > TEXT_PREVIEW_LINES) text += `\n    ${theme.fg("muted", "...")}`;
				} else {
					text += `\n    ${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg.bind(theme))}`;
				}
			}
		}
	}
	const totalUsage = aggregateUsageFromViews(views);
	if (totalUsage) text += `\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

export function renderParallelTable(view: ParallelSummaryView, theme: Theme, sessionShortId?: string): Text {
	const isRunning = view.running > 0;
	const hasFailures = view.failed > 0;

	const overallStatus: AgentResultView["status"] = isRunning ? "running" : hasFailures ? "failed" : "succeeded";
	const headerIcon = renderStatusIcon(overallStatus, theme);

	const idPart = sessionShortId ? ` #${sessionShortId}` : "";
	const durationStr = view.totalDurationMs !== undefined
		? formatDuration(view.totalDurationMs)
		: "";

	let statusText: string;
	if (isRunning) {
		statusText = `${view.succeeded + view.failed}/${view.total} done, ${view.running} running`;
	} else {
		statusText = `${view.succeeded}/${view.total} succeeded`;
	}

	let text = `${headerIcon} ${theme.fg("toolTitle", theme.bold("parallel"))}${theme.fg("accent", idPart)}  ${theme.fg("dim", statusText)}  ${theme.fg("muted", durationStr)}`;

	for (const agent of view.agents) {
		const statusIcon = renderStatusIcon(agent.status, theme);
		const agentDuration = agent.duration.durationMs !== undefined
			? formatDuration(agent.duration.durationMs)
			: formatDuration(Date.now() - agent.duration.startTime);
		const modelStr = agent.model
			? (agent.thinkingLevel ? `  ${agent.model}/${agent.thinkingLevel}` : `  ${agent.model}`)
			: "";
		let agentLine = `  ${agent.name.padEnd(12)} ${statusIcon}  ${agentDuration.padStart(5)}${modelStr}  ${agent.turns} turn${agent.turns !== 1 ? "s" : ""}`;
		if (agent.status === "running") {
			agentLine += `  last @ ${formatTimestamp(agent.duration.lastActivityTime)}`;
		} else {
			if (agent.tokens.input) agentLine += `  ↑${formatTokens(agent.tokens.input)}`;
			if (agent.tokens.output) agentLine += ` ↓${formatTokens(agent.tokens.output)}`;
			if (agent.cost) agentLine += `  $${agent.cost.toFixed(4)}`;
			if (agent.errorMessage) agentLine += `  ${theme.fg("error", `Error: ${agent.errorMessage.slice(0, 50)}`)}`;
		}
		text += `\n${agentLine}`;
	}

	if (view.isDone) {
		const totalLine: string[] = [];
		if (view.aggregateTokens.input > 0 || view.aggregateTokens.output > 0) {
			totalLine.push(`Total: ↑${formatTokens(view.aggregateTokens.input)} ↓${formatTokens(view.aggregateTokens.output)}`);
		}
		if (view.aggregateCost > 0) {
			totalLine.push(`$${view.aggregateCost.toFixed(4)}`);
		}
		if (totalLine.length > 0) {
			text += `\n${theme.fg("dim", totalLine.join("  "))}`;
		}
	}

	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return new Text(text, 0, 0);
}

export function renderParallelDetail(view: ParallelSummaryView, theme: Theme, mdTheme: MarkdownTheme, sessionShortId?: string): Container {
	const hasFailures = view.failed > 0;
	const overallStatus: AgentResultView["status"] = hasFailures ? "failed" : "succeeded";
	const headerIcon = renderStatusIcon(overallStatus, theme);
	const idPart = sessionShortId ? ` #${sessionShortId}` : "";
	const durationStr = view.totalDurationMs !== undefined ? ` (${formatDuration(view.totalDurationMs)})` : "";

	const container = new Container();
	container.addChild(
		new Text(
			`${headerIcon} ${theme.fg("toolTitle", theme.bold("parallel"))}${theme.fg("accent", idPart)}  ${theme.fg("accent", `${view.succeeded}/${view.total} succeeded`)}${durationStr}`,
			0, 0,
		),
	);

	for (const agent of view.agents) {
		container.addChild(new Spacer(1));
		const detail = renderAgentDetail(agent, theme, mdTheme, { showTask: true });
		for (const child of detail.children) {
			container.addChild(child);
		}
	}

	const totalParts: string[] = [];
	if (view.aggregateTokens.input > 0 || view.aggregateTokens.output > 0) {
		totalParts.push(`↑${formatTokens(view.aggregateTokens.input)} ↓${formatTokens(view.aggregateTokens.output)}`);
	}
	if (view.aggregateCost > 0) {
		totalParts.push(`$${view.aggregateCost.toFixed(4)}`);
	}
	if (totalParts.length > 0) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", `Total: ${totalParts.join("  ")}`), 0, 0));
	}

	return container;
}
