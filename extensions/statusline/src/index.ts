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

import { existsSync } from "node:fs";
import { join, sep } from "node:path";
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
import { formatSpeedPart, splitPath, tailSessionId } from "./format.js";

// ── 本地事件类型 ───────────────────────────────────────
interface PiMessageEvent {
	message: { role: string } & Record<string, unknown>;
}

interface PiThinkingLevelEvent {
	level: string;
}

// ── 时间常量 ───────────────────────────────────────────

const MS_PER_SEC = 1000;
const SEC_PER_MIN = 60;
const MIN_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SEC_PER_HOUR = SEC_PER_MIN * MIN_PER_HOUR;
const SEC_PER_DAY = SEC_PER_HOUR * HOURS_PER_DAY;

// ── 渲染常量 ───────────────────────────────────────────

const SEP = "│";
const DOT = "·";
const RUN_UPDATE_MS = 5000;
/** 标题列宽（按最长 "minimax-token-plan"=18，+1 空格余量） */
const TITLE_COL_W = 19;
/** reset 时间列宽（fmtResetSec 最长 "12d23h"=6 + 1 空格余量） */
const RESET_COL_W = 7;
/** pct 列宽（"100%"=4，但 padStart(3) 给 " 23%"=4） */
const PCT_COL_W = 3;
/** sessionId 截取末尾字符数 */
const SESSION_ID_TAIL = 12;
/** 路径展示的层数（cwd 倒数 N 段） */
const DIR_DEPTH = 2;
/** 分/秒 pad 宽度 */
const MIN_PAD = 2;
/** bogus replay 阈值：output > 50 tokens 但 duration < 100ms 视为重放，跳过速度统计 */
const BOGUS_OUTPUT_THRESHOLD = 50;
const BOGUS_DURATION_THRESHOLD_MS = 100;

// ── 阈值常量 ───────────────────────────────────────────

/** token 数字单位阈值 */
const KILO = 1_000;
const MILLION = 1_000_000;

/** pct 颜色分档 */
const PCT_HIGH = 80;
const PCT_MED = 60;
const PCT_LOW = 40;
/** 百分比标度 */
const PERCENT_SCALE = 100;

/** contextWindow fallback */
const DEFAULT_CONTEXT_WINDOW = 128_000;

// ── 工具函数 ───────────────────────────────────────────

function fmtDuration(ms: number): string {
	const s = Math.floor(ms / MS_PER_SEC);
	if (s < SEC_PER_MIN) return `${s}s`;
	const m = Math.floor(s / SEC_PER_MIN);
	if (m < MIN_PER_HOUR) return `${m}m${String(s % SEC_PER_MIN).padStart(MIN_PAD, "0")}s`;
	return `${Math.floor(m / MIN_PER_HOUR)}h${String(m % MIN_PER_HOUR).padStart(MIN_PAD, "0")}m`;
}

function fmtTokens(n: number): string {
	if (n >= MILLION) return `${(n / MILLION).toFixed(1)}M`;
	if (n >= KILO) return `${(n / KILO).toFixed(1)}K`;
	return `${n}`;
}

function fmtResetSec(sec: number): string {
	if (sec <= 0) return "";
	const d = Math.floor(sec / SEC_PER_DAY);
	const h = Math.floor((sec % SEC_PER_DAY) / SEC_PER_HOUR);
	const m = Math.floor((sec % SEC_PER_HOUR) / SEC_PER_MIN);
	if (d > 0) return `${d}d${h}h`;
	if (h > 0) return `${h}h${m}m`;
	return `${m}m`;
}

function fmtCount(n: number): string {
	return n < KILO ? `${n}` : `${(n / KILO).toFixed(1)}k`;
}

/** 按百分比返回语义色 token */
function pctColor(pct: number): "error" | "warning" | "accent" | "success" {
	if (pct >= PCT_HIGH) return "error";
	if (pct >= PCT_MED) return "warning";
	if (pct >= PCT_LOW) return "accent";
	return "success";
}

/** 当前 cwd 是否在 git worktree 内（粗略：看 .git 是文件还是目录） */
function isWorktree(cwd: string): boolean {
	return existsSync(join(cwd, ".git"));
}

// ── 状态 ───────────────────────────────────────────────

interface StatuslineRuntimeState {
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

function makeInitialState(): StatuslineRuntimeState {
	return {
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
}

// ── 扩展入口 ───────────────────────────────────────────

export default function statuslineExtension(pi: ExtensionAPI) {
	registerSetupCommand(pi);
	registerSessionLifecycle(pi);
}

function registerSessionLifecycle(pi: ExtensionAPI): void {
	const state: StatuslineRuntimeState = makeInitialState();
	let tui: { requestRender(): void } | null = null;

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		Object.assign(state, makeInitialState(), {
			sessionStart: Date.now(),
			thinkingLevel: pi.getThinkingLevel(),
		});
		refreshTotals(state, ctx);

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

	pi.on("message_start", (event: PiMessageEvent) => {
		if (event.message.role === "assistant") {
			state.assistantStart = Date.now();
			state.isAgentBusy = true;
		}
	});

	pi.on("message_end", (event: PiMessageEvent, ctx: ExtensionContext) => {
		if (event.message.role !== "assistant") return;
		const msg = event.message as AssistantMessage;
		if (!msg.usage) return;
		const dur = state.assistantStart ? Date.now() - state.assistantStart : 0;
		state.lastLlmTime = Date.now();
		if (msg.usage.output > BOGUS_OUTPUT_THRESHOLD && dur < BOGUS_DURATION_THRESHOLD_MS) {
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
	});

	pi.on("turn_end", () => {
		state.isAgentBusy = false;
		state.lastRunUpdate = Date.now();
		tui?.requestRender();
	});
	pi.on("agent_end", () => {
		state.isAgentBusy = false;
		state.lastRunUpdate = Date.now();
		tui?.requestRender();
	});
	pi.on("model_select", () => {
		state.thinkingLevel = pi.getThinkingLevel();
		tui?.requestRender();
	});
	pi.on("thinking_level_select", (event: PiThinkingLevelEvent) => {
		state.thinkingLevel = event.level;
		if (!state.isAgentBusy) tui?.requestRender();
	});
}

// ── 数据刷新 ───────────────────────────────────────────

function refreshTotals(st: StatuslineRuntimeState, ctx: ExtensionContext): void {
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

function refreshContextUsage(st: StatuslineRuntimeState, ctx: ExtensionContext): void {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null) return;
	const contextWindow = usage.contextWindow || DEFAULT_CONTEXT_WINDOW;
	st.contextTokens = usage.tokens;
	st.contextWindow = contextWindow;
	st.usedPct = Math.min(Math.round((usage.tokens / contextWindow) * PERCENT_SCALE), PERCENT_SCALE);
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

type Pallet = {
	d: (s: string) => string;
	v: (s: string) => string;
	g: (s: string) => string;
	w: (s: string) => string;
	a: (s: string) => string;
	m: (s: string) => string;
};

function makePalette(theme: Theme): Pallet {
	const fg = (c: string, t: string) => theme.fg(c, t);
	return {
		d: (s) => fg("dim", s),
		v: (s) => fg("text", s),
		g: (s) => fg("success", s),
		w: (s) => fg("warning", s),
		a: (s) => fg("accent", s),
		m: (s) => fg("muted", s),
	};
}

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
			// 优先使用 providers.json 配置的 label，fallback 到 normalize 返回的 label
			rows.push({ name: p.label || norm.label, wins: norm.wins });
		// eslint-disable-next-line taste/no-silent-catch -- render 容错：单 provider normalize 失败不应拖垮整个 statusline
		} catch (e) {
			console.warn(`[statusline] normalize failed for ${p.id}:`, e);
		}
	}
	return rows;
}

// ── 5 个独立行渲染函数 ─────────────────────────────────

function buildLine1(ctx: ExtensionContext, fd: ReadonlyFooterDataProvider, p: Pallet): string {
	const branch = fd.getGitBranch();
	const cwd = ctx.cwd || "";
	const segs = splitPath(cwd);
	const dirLabel = segs.slice(-DIR_DEPTH).join(sep) || cwd;
	const inWt = isWorktree(cwd);

	const parts: string[] = [p.a(dirLabel)];
	if (branch) parts.push(`⎇ ${p.g(branch)}`);
	if (inWt) parts.push(p.d("worktree"));
	return parts.join(` ${DOT} `);
}

function buildLine2(ctx: ExtensionContext, st: StatuslineRuntimeState, p: Pallet): string {
	const model = ctx.model;
	if (!model) return "";
	const provider = model.provider || "";
	const modelId = model.id || model.name || "unknown";
	const tlPart = st.thinkingLevel ? ` ${p.m(`[${st.thinkingLevel}]`)}` : "";

	const speedPart = formatSpeedPart(st.speed, p);
	const speedPrefix = speedPart ? ` ${speedPart}` : "";

	return `${p.d(provider)}/${p.a(modelId)}${tlPart}${speedPrefix}`;
}

function buildLine3(
	ctx: ExtensionContext,
	st: StatuslineRuntimeState,
	p: Pallet,
	theme: Theme,
): string {
	const ctxPct = st.usedPct;
	const ctxPctCol = theme.fg(pctColor(ctxPct), `${ctxPct}%`);
	const ctxStr = st.contextWindow > 0
		? `${p.d("ctx")} ${p.v(fmtTokens(st.contextTokens))}/${p.v(fmtTokens(st.contextWindow))} ${ctxPctCol}`
		: `${p.d("ctx")} ${ctxPctCol}`;

	const tp: string[] = [];
	if (st.sessionStart) {
		const from = new Date(st.sessionStart);
		tp.push(`${p.d("from")} ${p.g(`${from.getHours()}:${String(from.getMinutes()).padStart(MIN_PAD, "0")}`)}`);
	}
	if (shouldRefreshRun(st)) st.lastRunUpdate = Date.now();
	const displayRunMs = computeRunMs(st);
	if (displayRunMs > 0) tp.push(`${p.d("run")} ${p.g(fmtDuration(displayRunMs))}`);
	if (st.lastLlmTime) {
		const ago = Math.floor((Date.now() - st.lastLlmTime) / MS_PER_SEC);
		tp.push(`${p.d("last")} ${p.w(ago < SEC_PER_MIN ? `${ago}s` : `${Math.floor(ago / SEC_PER_MIN)}m${ago % SEC_PER_MIN}s`)}`);
	}

	const sid = tailSessionId(ctx.sessionManager.getSessionFile(), SESSION_ID_TAIL);

	const parts: string[] = [ctxStr];
	if (tp.length) parts.push(tp.join(` ${DOT} `));
	if (st.totalInp > 0 || st.totalOut > 0) {
		parts.push(`${p.d("↑↓")} ${p.v(fmtCount(st.totalInp))}/${p.v(fmtCount(st.totalOut))}`);
	}
	if (sid) parts.push(p.m(sid));
	return parts.join(` ${SEP} `);
}

function shouldRefreshRun(st: StatuslineRuntimeState): boolean {
	return !st.isAgentBusy && (st.lastRunUpdate === 0 || Date.now() - st.lastRunUpdate >= RUN_UPDATE_MS);
}

function computeRunMs(st: StatuslineRuntimeState): number {
	if (st.lastRunUpdate) return st.lastRunUpdate - st.sessionStart;
	if (st.sessionStart) return Date.now() - st.sessionStart;
	return 0;
}

function buildSearchLine(
	cache: CacheData,
	providers: QuotaProvider[],
	p: Pallet,
	theme: Theme,
): string {
	const parts: string[] = [];
	for (const prov of providers) {
		if (prov.category !== "search-tool") continue;
		const raw = (cache as Record<string, unknown>)[prov.id] as Record<string, unknown> | undefined;
		if (!raw) continue;
		// 优先使用 planUsage/planLimit（API 调用次数），fallback 到 available/total（key 数量）
		const used = (raw.planUsage as number) ?? (raw.available as number);
		const total = (raw.planLimit as number) ?? (raw.total as number);
		if (used === undefined || !total || total <= 0) continue;
		const pct = Math.round((used / total) * PERCENT_SCALE);
		const pctCol = theme.fg(pctColor(pct), `${pct}%`);
		parts.push(`${p.d(prov.label)} ${p.g(`${used}`)}/${p.v(`${total}`)}${p.d("次")} ${pctCol}`);
	}
	return parts.join(" | ");
}

function buildTokenPlanLines(
	cache: CacheData,
	providers: QuotaProvider[],
	p: Pallet,
	theme: Theme,
): string[] {
	const rows = normalizeRows(cache, providers);
	return rows.map((row) => {
		const title = p.d(row.name.padEnd(TITLE_COL_W));
		const cells = COLS.map((col, i) => {
			const win = row.wins[i]!;
			return formatWinCol(col.label, win, p, theme);
		});
		return title + cells.join(` ${DOT} `);
	});
}

/** 渲染单个窗口列：label pct% [reset]（无 bar） */
function formatWinCol(label: string, win: QuotaWindow, p: Pallet, theme: Theme): string {
	const pctWidth = PCT_COL_W + 1; // "NNN%" = padStart(3) + 1 = 4 chars
	if (win.pct === null) {
		// 无限：∞ 右对齐到 pctStr 宽度，reset 用 -- 占位
		return `${p.d(label)}  ${p.v("∞".padStart(pctWidth))}  ${p.v("--".padStart(RESET_COL_W))}`;
	}
	const pctStr = `${String(Math.round(win.pct)).padStart(PCT_COL_W)}%`;
	const rtRaw = win.resetSec != null && win.resetSec > 0 ? fmtResetSec(win.resetSec) : "";
	const rtStr = rtRaw ? p.v(rtRaw.padStart(RESET_COL_W)) : " ".repeat(RESET_COL_W);
	return `${p.d(label)}  ${theme.fg(pctColor(win.pct), pctStr)}  ${rtStr}`;
}

function buildLines(
	ctx: ExtensionContext,
	theme: Theme,
	fd: ReadonlyFooterDataProvider,
	width: number,
	st: StatuslineRuntimeState,
): string[] {
	const cache = readCache();
	const providers = buildRuntimeProviders();
	const palette = makePalette(theme);

	const lines: string[] = [
		buildLine1(ctx, fd, palette),
		buildLine2(ctx, st, palette),
		buildLine3(ctx, st, palette, theme),
		buildSearchLine(cache, providers, palette, theme),
		...buildTokenPlanLines(cache, providers, palette, theme),
	];

	// 过滤空行（line2/line3 在某些状态下可能空，line4 没搜索工具时空）
	return lines
		.filter((l) => l.length > 0)
		.map((l) => truncateToWidth(l, width));
}
