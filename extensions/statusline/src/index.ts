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
	buildRuntimeProviders,
	type CacheRatioData,
	readCache,
	type SpeedData,
	trackCacheRatio,
	trackSpeed,
	triggerUpdate,
} from "@zhushanwen/pi-quota-providers";

import {
	buildSearchLine,
	buildTokenPlanLines,
	fmtCount,
	fmtDuration,
	fmtTokens,
	formatCacheRatioPart,
	formatSpeedPart,
	MIN_PAD,
	MS_PER_SEC,
	pctColor,
	PERCENT_SCALE,
	SEC_PER_MIN,
	splitPath,
	tailSessionId,
} from "./format.js";
import { registerSetupCommand } from "./setup.js";

// ── 本地事件类型 ───────────────────────────────────────
interface PiMessageEvent {
	message: { role: string } & Record<string, unknown>;
}

interface PiThinkingLevelEvent {
	level: string;
}

// ── 渲染常量 ───────────────────────────────────────────

const SEP = "│";
const DOT = "·";
const RUN_UPDATE_MS = 5000;
/** render 兜底间隔:空闲时也定期重绘,顺带触发 provider 缓存过期检测 + 走表 */
const RENDER_INTERVAL_MS = 30_000;
/** sessionId 截取末尾字符数 */
const SESSION_ID_TAIL = 12;
/** 路径展示的层数（cwd 倒数 N 段） */
const DIR_DEPTH = 2;
/** bogus replay 阈值：output > 50 tokens 但 duration < 100ms 视为重放，跳过速度统计 */
const BOGUS_OUTPUT_THRESHOLD = 50;
const BOGUS_DURATION_THRESHOLD_MS = 100;

/** contextWindow fallback */
const DEFAULT_CONTEXT_WINDOW = 128_000;

// ── 工具函数 ───────────────────────────────────────────

/** 当前 cwd 是否在 git worktree 内（粗略：看 .git 是文件还是目录） */
function isWorktree(cwd: string): boolean {
	return existsSync(join(cwd, ".git"));
}

// ── Footer API 适配类型 ─────────────────────────────────

/** Tui 句柄（Pi TUI 提供的渲染接口） */
interface TuiHandle {
	requestRender(): void;
}

/** Footer 渲染句柄（setFooter 回调的返回值） */
interface FooterHandle {
	dispose(): void;
	invalidate(): void;
	render(width: number): string[];
}

/** SDK 缺失的 setFooter 类型 — 仅本扩展需要
 *  绕过 `as any`：先用 `as unknown as` 明确意图，配合类型接口提供类型检查
 *  @todo SDK 补齐 setFooter 类型后移除本接口 */
interface UiWithFooter {
	setFooter(
		fn: (tui: TuiHandle, theme: Theme, footerData: ReadonlyFooterDataProvider) => FooterHandle,
	): void;
}

/** 引用包装：让 helper 写入闭包变量 */
interface TuiRef {
	current: TuiHandle | null;
}

/** 注册 statusline footer。从 session_start handler 提取。 */
function initFooter(
	ctx: ExtensionContext,
	state: StatuslineRuntimeState,
	tuiRef: TuiRef,
): void {
	(ctx.ui as unknown as UiWithFooter).setFooter(
		(t: TuiHandle, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
			tuiRef.current = t;
			const unsub = footerData.onBranchChange(() => t.requestRender());
			// 兜底定时器:定期 requestRender,让空闲时也能走表 + 检测 provider 缓存过期。
			// triggerUpdate 内部 TTL 节流(2min + 并发闸)防住过频请求。
			const interval = setInterval(() => t.requestRender(), RENDER_INTERVAL_MS);
			return {
				dispose() {
					unsub();
					clearInterval(interval);
					tuiRef.current = null;
				},
				invalidate() {},
				render(width: number) {
					return buildLines(ctx, theme, footerData, width, state);
				},
			};
		},
	);
}

// ── 状态 ───────────────────────────────────────────────

interface StatuslineRuntimeState {
	sessionStart: number;
	lastLlmTime: number;
	assistantStart: number;
	speed: SpeedData;
	cacheRatio: CacheRatioData;
	lastRunUpdate: number;
	isAgentBusy: boolean;
	thinkingLevel: string;
	totalInp: number;
	totalOut: number;
	totalCost: number;
	usedPct: number;
	contextTokens: number;
	contextWindow: number;
	/** ctx 百分比未知(如刚 compact 完,还没有新的 assistant 响应)。true 时渲染占位符。 */
	contextUnknown: boolean;
	sessionName: string | undefined;
}

function makeInitialState(): StatuslineRuntimeState {
	return {
		sessionStart: 0,
		lastLlmTime: 0,
		assistantStart: 0,
		speed: { current: 0, day: 0, d7: 0, d30: 0 },
		cacheRatio: { current: null, day: null },
		lastRunUpdate: 0,
		isAgentBusy: false,
		thinkingLevel: "",
		totalInp: 0,
		totalOut: 0,
		totalCost: 0,
		usedPct: 0,
		contextTokens: 0,
		contextWindow: 0,
		contextUnknown: true,
		sessionName: undefined,
	};
}

// ── 扩展入口 ───────────────────────────────────────────

export default function statuslineExtension(pi: ExtensionAPI) {
	registerSetupCommand(pi);
	registerSessionLifecycle(pi);
}

function registerSessionLifecycle(pi: ExtensionAPI): void {
	const state: StatuslineRuntimeState = makeInitialState();
	const tuiRef: TuiRef = { current: null };

	pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
		Object.assign(state, makeInitialState(), {
			sessionStart: Date.now(),
			thinkingLevel: pi.getThinkingLevel(),
			sessionName: ctx.sessionManager.getSessionName() ?? undefined,
		});
		refreshTotals(state, ctx);
		initFooter(ctx, state, tuiRef);
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
		state.cacheRatio = trackCacheRatio(
			{ input: msg.usage.input, cacheRead: msg.usage.cacheRead ?? 0, cacheWrite: msg.usage.cacheWrite ?? 0 },
			ctx.model?.id ?? "",
		);
		state.totalInp += msg.usage.input;
		state.totalOut += msg.usage.output;
		state.totalCost += msg.usage.cost.total;
		refreshContextUsage(state, ctx);
		tuiRef.current?.requestRender();
		triggerUpdate();
	});

	pi.on("turn_end", () => {
		state.isAgentBusy = false;
		state.lastRunUpdate = Date.now();
		tuiRef.current?.requestRender();
	});
	pi.on("agent_end", () => {
		state.isAgentBusy = false;
		state.lastRunUpdate = Date.now();
		tuiRef.current?.requestRender();
	});
	pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
		// 切换分支后重建状态栏数据
		Object.assign(state, makeInitialState(), {
			sessionStart: Date.now(),
			thinkingLevel: pi.getThinkingLevel(),
			sessionName: ctx.sessionManager.getSessionName() ?? undefined,
		});
		refreshTotals(state, ctx);
		triggerUpdate();
	});

	pi.on("session_compact", async (_event: unknown, ctx: ExtensionContext) => {
		// compact 刚完成:历史已被摘要替换,重算累计量。
		// getContextUsage() 此刻返回 tokens:null(还没有 compact 后的 assistant 消息),
		// 所以标记 contextUnknown,渲染时显示占位符而非卡在压缩前的旧百分比。
		state.contextUnknown = true;
		refreshTotals(state, ctx);
		tuiRef.current?.requestRender();
		triggerUpdate();
	});

	pi.on("model_select", () => {
		state.thinkingLevel = pi.getThinkingLevel();
		tuiRef.current?.requestRender();
	});
	pi.on("thinking_level_select", (event: PiThinkingLevelEvent) => {
		state.thinkingLevel = event.level;
		if (!state.isAgentBusy) tuiRef.current?.requestRender();
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
	if (!usage || usage.tokens === null) {
		// ctx 未知(如刚 compact 完):标记占位,不再偷偷保留旧 ctx 值误导
		st.contextUnknown = true;
		return;
	}
	st.contextUnknown = false;
	const contextWindow = usage.contextWindow || DEFAULT_CONTEXT_WINDOW;
	st.contextTokens = usage.tokens;
	st.contextWindow = contextWindow;
	st.usedPct = Math.min(Math.round((usage.tokens / contextWindow) * PERCENT_SCALE), PERCENT_SCALE);
}

// ── 渲染 ───────────────────────────────────────────────

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

	const cachePart = formatCacheRatioPart(st.cacheRatio, p);
	const cachePrefix = cachePart ? ` ${cachePart}` : "";

	return `${p.d(provider)}/${p.a(modelId)}${tlPart}${speedPrefix}${cachePrefix}`;
}

function buildLine3(
	ctx: ExtensionContext,
	st: StatuslineRuntimeState,
	p: Pallet,
	theme: Theme,
): string {
	const ctxStr = st.contextUnknown
		? `${p.d("ctx")} ${p.d("--")}/${p.v(fmtTokens(st.contextWindow || DEFAULT_CONTEXT_WINDOW))} ${p.d("--%")}`
		: st.contextWindow > 0
			? `${p.d("ctx")} ${p.v(fmtTokens(st.contextTokens))}/${p.v(fmtTokens(st.contextWindow))} ${theme.fg(pctColor(st.usedPct), `${st.usedPct}%`)}`
			: `${p.d("ctx")} ${theme.fg(pctColor(st.usedPct), `${st.usedPct}%`)}`;

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
	const namePart = st.sessionName ? p.a(st.sessionName) : "";

	const parts: string[] = [ctxStr];
	if (tp.length) parts.push(tp.join(` ${DOT} `));
	if (st.totalInp > 0 || st.totalOut > 0) {
		parts.push(`${p.d("↑↓")} ${p.v(fmtCount(st.totalInp))}/${p.v(fmtCount(st.totalOut))}`);
	}
	if (namePart) parts.push(namePart);
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
	const themeFg = (token: string, text: string) => theme.fg(token, text);

	const lines: string[] = [
		buildLine1(ctx, fd, palette),
		buildLine2(ctx, st, palette),
		buildLine3(ctx, st, palette, theme),
		buildSearchLine(cache, providers, palette, themeFg),
		...buildTokenPlanLines(cache, providers, palette, themeFg),
	];

	// 过滤空行（line2/line3 在某些状态下可能空，line4 没搜索工具时空）
	return lines
		.filter((l) => l.length > 0)
		.map((l) => truncateToWidth(l, width));
}
