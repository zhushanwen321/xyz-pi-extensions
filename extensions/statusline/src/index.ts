/**
 * Pi Statusline — 自定义状态栏
 *
 * 布局：
 * Line 1: 父目录/子目录 · ⎇ branch │ worktree
 * Line 2: provider/model [thinking level]
 * Line 3: ctx X/Y 23% │ from · run · last │ ↑↓ in/out │ <sessionId>
 * Line 4: search-tool 行（tavily 234/1000次 23% | anysearch 250/500次 50%）
 * Line 5+: token-plans 行（去 bar，列对齐）
 *
 * 配置：通过 ~/.pi/agent/config/{providers,secrets}.json 声明式管理
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";

import {
	readCache,
	triggerUpdate,
	trackSpeed,
	buildRuntimeProviders,
	type CacheData,
	type SpeedData,
	type QuotaWindow,
	type QuotaProvider,
} from "@zhushanwen/pi-quota-providers";
import { registerSetupCommand } from "./setup.js";

// ── 本地事件类型 ───────────────────────────────────────
interface PiMessageEvent {
	message: { role: string } & Record<string, unknown>;
}

interface PiThinkingLevelEvent {
	level: string;
}

// ── 常量 ───────────────────────────────────────────────

const SEP = "│";
const DOT = "·";
const RUN_UPDATE_MS = 5000;

/** 标题列宽（按最长 "minimax-token-plan"=18，+1 空格余量） */
const TITLE_COL_W = 19;

// ── 工具函数 ───────────────────────────────────────────

function fmtDuration(ms: number): string {
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return `${n}`;
}

function fmtResetSec(sec: number): string {
	if (sec <= 0) return "";
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	if (d > 0) return `${d}d${h}h`;
	if (h > 0) return `${h}h${m}m`;
	return `${m}m`;
}

/** 按百分比返回语义色 token */
function pctColor(pct: number): "error" | "warning" | "accent" | "success" {
	if (pct >= 80) return "error";
	if (pct >= 60) return "warning";
	if (pct >= 40) return "accent";
	return "success";
}

// ── 状态 ───────────────────────────────────────────────

interface State {
	sessionStart: number;
	lastLlmTime: number;
	assistantStart: number;
	speed: SpeedData;
	lastRunUpdate: number;
	isAgentBusy: boolean;
	thinkingLevel: string;
	totalInp: number;
	totalOut: number;
	totalCost: number;
	usedPct: number;
	contextTokens: number;
	contextWindow: number;
}

// ── 扩展入口 ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	registerSetupCommand(pi);

	const state: State = {
		sessionStart: 0,
		lastLlmTime: 0,
		assistantStart: 0,
		speed: { current: 0, day: 0, d7: 0, d30: 0 },
		lastRunUpdate: 0,
		isAgentBusy: false,
		thinkingLevel: "",
		totalInp: 0,
		totalOut: 0,
		totalCost: 0,
		usedPct: 0,
		contextTokens: 0,
		contextWindow: 0,
	};

	let tui: { requestRender(): void } | null = null;

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		state.sessionStart = Date.now();
		state.lastLlmTime = 0;
		state.speed = { current: 0, day: 0, d7: 0, d30: 0 };
		state.isAgentBusy = false;
		state.thinkingLevel = pi.getThinkingLevel();
		refreshTotals(state, ctx);

		// SDK ExtensionContext.ui 类型缺失 setFooter，临时绕过
		ctx.ui.setFooter((t: { requestRender(): void }, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
			tui = t;
			const unsub = footerData.onBranchChange(() => t.requestRender());
			return {
				dispose() { unsub(); tui = null; },
				invalidate() {},
				render(width: number) {
					return buildLines(ctx, theme, footerData, width, state);
				},
			};
		});

		triggerUpdate();
	});

	pi.on("message_start", async (event: PiMessageEvent) => {
		if (event.message.role === "assistant") {
			state.assistantStart = Date.now();
			state.isAgentBusy = true;
		}
	});

	pi.on("message_end", async (event: PiMessageEvent, ctx: ExtensionContext) => {
		if (event.message.role === "assistant") {
			const msg = event.message as AssistantMessage;
			if (!msg.usage) return;
			const dur = state.assistantStart ? Date.now() - state.assistantStart : 0;
			state.lastLlmTime = Date.now();
			const isBogusReplay = msg.usage.output > 50 && dur < 100;
			if (isBogusReplay) {
				state.speed = { current: 0, day: 0, d7: 0, d30: 0 };
				return;
			}
			state.speed = trackSpeed(msg.usage.output, dur, ctx.model?.id ?? "");
			state.totalInp += msg.usage.input;
			state.totalOut += msg.usage.output;
			state.totalCost += msg.usage.cost.total;
			refreshContextUsage(state, ctx);
			tui?.requestRender();
			triggerUpdate();
		}
	});

	pi.on("turn_end", async () => {
		state.isAgentBusy = false;
		state.lastRunUpdate = Date.now();
		tui?.requestRender();
	});
	pi.on("agent_end", async () => {
		state.isAgentBusy = false;
		state.lastRunUpdate = Date.now();
		tui?.requestRender();
	});
	pi.on("model_select", async () => {
		state.thinkingLevel = pi.getThinkingLevel();
		tui?.requestRender();
	});
	pi.on("thinking_level_select", async (event: PiThinkingLevelEvent) => {
		state.thinkingLevel = event.level;
		if (!state.isAgentBusy) tui?.requestRender();
	});
}

// ── 数据刷新 ───────────────────────────────────────────

function refreshTotals(st: State, ctx: ExtensionContext): void {
	let inp = 0, out = 0, cost = 0;
	for (const e of ctx.sessionManager.getBranch()) {
		if (e.type === "message" && e.message.role === "assistant") {
			const u = (e.message as AssistantMessage).usage;
			if (!u) continue;
			inp += u.input;
			out += u.output;
			cost += u.cost.total;
		}
	}
	st.totalInp = inp;
	st.totalOut = out;
	st.totalCost = cost;
	refreshContextUsage(st, ctx);
}

function refreshContextUsage(st: State, ctx: ExtensionContext): void {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return;
	const contextWindow = usage.contextWindow || 128_000;
	st.contextTokens = usage.tokens;
	st.contextWindow = contextWindow;
	st.usedPct = Math.min(Math.round((usage.tokens / contextWindow) * 100), 100);
}

// ── 渲染 ───────────────────────────────────────────────

interface QuotaRow {
	name: string;
	wins: [QuotaWindow, QuotaWindow, QuotaWindow];
}

const COLS = [
	{ key: "5h", label: "5h" },
	{ key: "week", label: "wk" },
	{ key: "month", label: "mh" },
] as const;

/** 缓存数据 → 归一化行（用于 token-plans 显示） */
function normalizeRows(cache: CacheData, providers: QuotaProvider[]): QuotaRow[] {
	const rows: QuotaRow[] = [];
	for (const p of providers) {
		if (p.category !== "token-plan") continue;
		try {
			const raw = (cache as Record<string, unknown>)[p.id];
			if (!raw) continue;
			const norm = p.normalize(raw);
			if (!norm) continue;
			rows.push({ name: norm.label || p.label, wins: norm.wins });
		} catch (e) {
			console.warn(`[statusline] normalize failed for ${p.id}:`, e);
		}
	}
	return rows;
}

function buildLines(
	ctx: ExtensionContext,
	theme: Theme,
	fd: ReadonlyFooterDataProvider,
	width: number,
	st: State,
): string[] {
	const cache = readCache();
	const providers = buildRuntimeProviders();

	const fg = (c: string, t: string) => theme.fg(c, t);
	const d = (s: string) => fg("dim", s);
	const v = (s: string) => fg("text", s);
	const g = (s: string) => fg("success", s);
	const w = (s: string) => fg("warning", s);
	const a = (s: string) => fg("accent", s);
	const m = (s: string) => fg("muted", s);

	const lines: string[] = [];

	// ═══════════════════════════════════════════════════
	// Line 1: 父目录/子目录 · ⎇ branch │ worktree
	// ═══════════════════════════════════════════════════
	const branch = fd.getGitBranch();
	const cwd = ctx.cwd || "";
	const segs = cwd.split("/").filter(Boolean);
	const dirLabel = segs.slice(-2).join("/") || cwd;

	const line1Parts: string[] = [a(dirLabel)];
	if (branch) line1Parts.push(`⎇ ${g(branch)}`);
	line1Parts.push(d("worktree"));
	lines.push(line1Parts.join(` ${DOT} `));

	// ═══════════════════════════════════════════════════
	// Line 2: provider/model [thinking level]
	// ═══════════════════════════════════════════════════
	const model = ctx.model;
	if (model) {
		const provider = model.provider || "";
		const modelId = model.id || model.name || "unknown";
		const tlPart = st.thinkingLevel ? ` ${m(`[${st.thinkingLevel}]`)}` : "";
		lines.push(`${d(provider)}/${a(modelId)}${tlPart}`);
	}

	// ═══════════════════════════════════════════════════
	// Line 3: ctx X/Y 23% │ from · run · last │ ↑↓ in/out │ <sessionId>
	// ═══════════════════════════════════════════════════
	const ctxPct = st.usedPct;
	const ctxPctCol = theme.fg(pctColor(ctxPct), `${ctxPct}%`);
	const ctxStr = st.contextWindow > 0
		? `${d("ctx")} ${v(fmtTokens(st.contextTokens))}/${v(fmtTokens(st.contextWindow))} ${ctxPctCol}`
		: `${d("ctx")} ${ctxPctCol}`;

	const tp: string[] = [];
	if (st.sessionStart) {
		const from = new Date(st.sessionStart);
		tp.push(`${d("from")} ${g(`${from.getHours()}:${String(from.getMinutes()).padStart(2, "0")}`)}`);
	}
	const shouldRefreshRun =
		!st.isAgentBusy &&
		(st.lastRunUpdate === 0 || Date.now() - st.lastRunUpdate >= RUN_UPDATE_MS);
	if (shouldRefreshRun) st.lastRunUpdate = Date.now();
	const displayRunMs = st.lastRunUpdate
		? st.lastRunUpdate - st.sessionStart
		: st.sessionStart ? Date.now() - st.sessionStart : 0;
	if (displayRunMs > 0) tp.push(`${d("run")} ${g(fmtDuration(displayRunMs))}`);
	if (st.lastLlmTime) {
		const ago = Math.floor((Date.now() - st.lastLlmTime) / 1000);
		tp.push(`${d("last")} ${w(ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}m${ago % 60}s`)}`);
	}

	const sid = ctx.sessionManager.getSessionFile()?.split("/").pop()?.slice(-12) || "";
	const fmt = (n: number) => n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
	const tps = `${d("↑↓")} ${v(fmt(st.totalInp))}/${v(fmt(st.totalOut))}`;

	const line3Parts: string[] = [ctxStr];
	if (tp.length) line3Parts.push(tp.join(` ${DOT} `));
	if (st.totalInp > 0 || st.totalOut > 0) line3Parts.push(tps);
	if (sid) line3Parts.push(m(sid));
	lines.push(line3Parts.join(` ${SEP} `));

	// ═══════════════════════════════════════════════════
	// Line 4: 搜索工具行（去 bar，tavily 234/1000次 23% | anysearch 250/500次 50%）
	// ═══════════════════════════════════════════════════
	const searchParts: string[] = [];
	for (const p of providers) {
		if (p.category !== "search-tool") continue;
		const raw = (cache as Record<string, unknown>)[p.id] as
			| { available: number; total: number; used?: number }
			| undefined;
		if (!raw) continue;
		const used = raw.used ?? raw.available;
		const total = raw.total;
		if (!total || total <= 0) continue;
		const pct = Math.round((used / total) * 100);
		const pctCol = theme.fg(pctColor(pct), `${pct}%`);
		searchParts.push(`${d(p.label)} ${g(`${used}`)}/${v(`${total}`)}${d("次")} ${pctCol}`);
	}
	if (searchParts.length) lines.push(searchParts.join(" | "));

	// ═══════════════════════════════════════════════════
	// Line 5+: token-plans 行（去 bar，列对齐）
	// ═══════════════════════════════════════════════════
	const rows = normalizeRows(cache, providers);
	for (const row of rows) {
		const title = d(row.name.padEnd(TITLE_COL_W));
		const cells = COLS.map((col, i) => {
			const win = row.wins[i]!;
			return formatWinCol(col.label, win, d, v, theme);
		});
		lines.push(title + cells.join(` ${DOT} `));
	}

	return lines.map((l) => truncateToWidth(l, width));
}

/** 渲染单个窗口列：label pct% [reset]（无 bar） */
function formatWinCol(
	label: string,
	win: QuotaWindow,
	d: (s: string) => string,
	v: (s: string) => string,
	theme: Theme,
): string {
	if (win.pct === null) {
		return `${d(label)}  ${v("∞")}`;
	}
	const pctStr = `${String(Math.round(win.pct)).padStart(3)}%`;
	const rtRaw = win.resetSec && win.resetSec > 0 ? fmtResetSec(win.resetSec) : "";
	const rtStr = rtRaw ? v(rtRaw.padStart(7)) : " ".repeat(7);
	return `${d(label)}  ${theme.fg(pctColor(win.pct), pctStr)}  ${rtStr}`;
}
