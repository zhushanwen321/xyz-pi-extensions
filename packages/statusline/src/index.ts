/**
 * Pi Statusline — 自定义状态栏
 *
 * 布局：
 * Line 1: 目录/仓库名 · 分支 │ session-name │ provider : model [thinking level]
 * Line 2: ctx │ speed current+t/s day+t/s │ tavily
 * Line 3-5: 套餐用量（统一列对齐）
 *   Z.ai-pro      5h  XXX% [bar] ZzHh · wk  ∞ · mh  ∞  reset ZhZm
 *   opencode-go   5h  XXX% [bar] ZhZm · wk XXX% [bar] Zdh · mh XXX% [bar] Zdh
 *   kimi-coding   5h  XXX% [bar] ZhZm · wk XXX% [bar] Zdh · mh  ∞
 * Line 6: 时间 · 费用 · 会话ID
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@mariozechner/pi-coding-agent";
import { truncateToWidth } from "@mariozechner/pi-tui";
import {
	readCache,
	triggerUpdate,
	trackSpeed,
	PROVIDERS,
	type CacheData,
	type SpeedData,
	type QuotaWindow,
} from "@zhushanwen/pi-quota-providers";
// ── 常量 ───────────────────────────────────────────────

const SEP = "│";
const DOT = "·";
const WIDE_THRESHOLD = 100;
const RUN_UPDATE_MS = 5000;

/** 标题列宽（按最长 "opencode-go"=11, +4 空格余量） */
const TITLE_COL_W = 15;

// ── ANSI ──────────────────────────────────────────────

const R = "\x1b[0m";

function bgBar(pct: number, w = 6): string {
	const p = Math.max(0, Math.min(100, Math.round(pct)));
	if (p <= 0 && w <= 6) return `${R}${"\x1b[48;5;239m"}${" ".repeat(w)}${R}`;
	const filled = Math.floor((p * w) / 100);
	const fillBg =
		p >= 80 ? "\x1b[48;5;196m"
			: p >= 60 ? "\x1b[48;5;208m"
			: p >= 40 ? "\x1b[48;5;220m"
			: "\x1b[48;5;114m";
	const emptyBg = "\x1b[48;5;239m";
	return `${fillBg}${" ".repeat(filled)}${emptyBg}${" ".repeat(w - filled)}${R}`;
}

/** 构建一个窗口列，所有单元格 data 区域固定可见宽度。 */
function winCol(
	label: string,
	pct: number | null,
	resetSec: number | null,
	wide: boolean,
	d: (s: string) => string,
	v: (s: string) => string,
): string {
	const l = d(label);
	if (pct === null) {
		// infinite: 占位宽度 = 正常列 data 宽
		const dataW = wide ? 20 : 12;
		return `${l}  ${v(padCenter("∞", dataW))}`;
	}
	const pctStr = `${String(Math.round(pct)).padStart(3)}%`;
	const rtRaw = resetSec && resetSec > 0 ? fmtResetSec(resetSec) : "";
	const rtStr = rtRaw.padEnd(6);

	if (wide) {
		const bar = bgBar(pct, 6); // ANSI: 6 个空格带背景色
		// pct(4) + 2空格 + bar(6 可见) + 2空格 + reset(6) = 20 可见
		return `${l}  ${v(pctStr)}  ${bar}  ${v(rtStr)}`;
	}
	// pct(4) + 2空格 + reset(6) = 12 可见
	return `${l}  ${v(pctStr)}  ${v(rtStr)}`;
}

/** 将 str 居中到 width 宽度，用空格填充 */
function padCenter(str: string, width: number): string {
	const pad = width - str.length;
	if (pad <= 0) return str.slice(0, width);
	const left = Math.floor(pad / 2);
	const right = pad - left;
	return " ".repeat(left) + str + " ".repeat(right);
}

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

// ── 归一化的套餐窗口列 ─────────────────────────────────

interface QuotaRow {
	name: string;
	wins: [QuotaWindow, QuotaWindow, QuotaWindow];
}

const COLS = [
	{ key: "5h", label: "5h" },
	{ key: "week", label: "wk" },
	{ key: "month", label: "mh" },
] as const;

/** 将缓存数据归一化为对齐的行数组（走注册表）。 */
function normalizeRows(cache: CacheData): QuotaRow[] {
	const rows: QuotaRow[] = [];
	for (const p of PROVIDERS) {
		try {
			const raw = (cache as Record<string, unknown>)[p.id];
			if (!raw) continue;
			const norm = p.normalize(raw);
			if (!norm) continue;
			rows.push({ name: norm.label || p.label, wins: norm.wins });
		} catch {
			// 单个 provider normalize 失败不影响其他 provider 显示
		}
	}
	return rows;
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
	treeTokens: number;
	treeId: string;
}

// ── 扩展入口 ───────────────────────────────────────────

export default function (pi: ExtensionAPI) {
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
		treeTokens: 0,
		treeId: "",
	};

	let tui: { requestRender(): void } | null = null;

	pi.on("session_start", async (_event: any, ctx: ExtensionContext) => {
		state.sessionStart = Date.now();
		state.lastLlmTime = 0;
		state.speed = { current: 0, day: 0, d7: 0, d30: 0 };
		state.isAgentBusy = false;
		state.thinkingLevel = pi.getThinkingLevel();
		refreshTotals(state, ctx);

		(ctx.ui as any).setFooter((t: { requestRender(): void }, theme: Theme, footerData: ReadonlyFooterDataProvider) => {
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

	pi.on("message_start", async (event: any) => {
		if (event.message.role === "assistant") {
			state.assistantStart = Date.now();
			state.isAgentBusy = true;
		}
	});

	pi.on("message_end", async (event: any, ctx: ExtensionContext) => {
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
	pi.on("thinking_level_select", async (event: any) => {
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
	refreshTreeTokens(st, ctx);
}

/** 从 session entries 中读取最新 ic-compact-tree 的 totalTokens */
function refreshTreeTokens(st: State, ctx: ExtensionContext): void {
	let latestTokens: number | undefined;
	let latestTreeId: string | undefined;
	for (const e of ctx.sessionManager.getEntries()) {
		if (e.type === "custom" && (e as { customType: string }).customType === "ic-compact-tree") {
			const data = (e as { data?: { totalTokens?: number; treeId?: string } }).data;
			if (data?.totalTokens != null) latestTokens = data.totalTokens;
			if (data?.treeId != null) latestTreeId = data.treeId;
		}
	}
	st.treeTokens = latestTokens ?? 0;
	st.treeId = latestTreeId ?? "";
}

// ── 渲染 ───────────────────────────────────────────────

function buildLines(
	ctx: ExtensionContext,
	theme: Theme,
	fd: ReadonlyFooterDataProvider,
	width: number,
	st: State,
): string[] {
	const cache = readCache();
	const wide = width >= WIDE_THRESHOLD;

	const fg = (c: string, t: string) => theme.fg(c, t);
	const d = (s: string) => fg("dim", s);
	const v = (s: string) => fg("text", s);
	const g = (s: string) => fg("success", s);
	const w = (s: string) => fg("warning", s);
	const a = (s: string) => fg("accent", s);
	const m = (s: string) => fg("muted", s);

	const lines: string[] = [];

	// ═══════════════════════════════════════════════════
	// Line 1: 目录/仓库 · 分支 │ session-name │ provider : model [thinking]
	// ═══════════════════════════════════════════════════
	const branch = fd.getGitBranch();
	const cwd = ctx.cwd || "";

	const idParts: string[] = [];
	if (branch) {
		const segs = cwd.split("/").filter(Boolean);
		const repoName = segs.slice(-2).join("/");
		if (repoName) idParts.push(a(repoName));
		idParts.push(`⎇ ${g(branch)}`);
	} else {
		const segs = cwd.split("/").filter(Boolean);
		const last2 = segs.slice(-2).join("/");
		if (last2) idParts.push(a(last2));
	}

	let line1 = idParts.join(` ${DOT} `);

	// Session name (set by /name command)
	const sessionName = ctx.sessionManager.getSessionName();
	if (sessionName) {
		line1 += ` ${SEP} ${a(sessionName)}`;
	}

	const model = ctx.model;
	if (model) {
		const provider = model.provider || "";
		const provShort = provider.includes("/")
			? provider.split("/").pop()!
			: provider;
		const modelId = model.id || model.name || "unknown";
		const tlPart = st.thinkingLevel ? ` ${m(`[${st.thinkingLevel}]`)}` : "";
		line1 += ` ${SEP} ${d(provShort)} : ${a(modelId)}${tlPart}`;
	}
	if (line1) lines.push(line1);

	// ═══════════════════════════════════════════════════
	// Line 2: ctx │ speed current+t/s day+t/s │ tavily
	// ═══════════════════════════════════════════════════
	const ctxSizeStr =
		st.contextWindow > 0
			? `${d("ctx")} ${v(fmtTokens(st.contextTokens))}/${v(fmtTokens(st.contextWindow))}`
			: `${d("ctx")} ${v(`${st.usedPct}%`)}`;
	const ctxBarStr = wide
		? `${bgBar(st.usedPct)} ${v(`${st.usedPct}%`)}`
		: `${v(`${st.usedPct}%`)}`;

	const line2Parts: string[] = [`${ctxSizeStr} ${ctxBarStr}`];

	// tree-ctx：格式和 ctx 相同，始终展示
	if (st.contextWindow > 0) {
		const treePctRaw = (st.treeTokens / st.contextWindow) * 100;
		const treePct = Math.min(Math.round(treePctRaw), 100);
		const treeDisplayPct = treePct === 0 && st.treeTokens > 0 ? "<1" : `${treePct}`;
		const treeSizeStr = `${d("tree")} ${v(fmtTokens(st.treeTokens))}/${v(fmtTokens(st.contextWindow))}`;
		const treeBarStr = wide
			? `${bgBar(treePct || 1)} ${v(`${treeDisplayPct}%`)}`
			: `${v(`${treeDisplayPct}%`)}`;
		line2Parts.push(`${treeSizeStr} ${treeBarStr}`);
	}

	const sp: string[] = [];
	if (st.speed.current > 0)
		sp.push(`${g(`${st.speed.current}`)}${d("t/s")}`);
	if (st.speed.day > 0)
		sp.push(`${d("day")} ${g(`${st.speed.day}`)}${d("t/s")}`);
	if (sp.length)
		line2Parts.push(`${d("speed")} ${sp.join(` ${DOT} `)}`);

	const tv = cache["tavily"] as { available: number; total: number } | undefined;
	if (tv)
		line2Parts.push(`${d("tavily")} ${g(`${tv.available}`)}/${v(`${tv.total}`)}`);

	lines.push(line2Parts.join(` ${SEP} `));

	// ═══════════════════════════════════════════════════
	// Line 3+: 套餐用量（归一化 → 统一列渲染）
	// ═══════════════════════════════════════════════════
	const rows = normalizeRows(cache);
	for (const row of rows) {
		const title = d(row.name.padEnd(TITLE_COL_W));
		const cells = COLS.map((col, i) => {
			const win = row.wins[i]!;
			return winCol(col.label, win.pct, win.resetSec, wide, d, v);
		});
		lines.push(title + cells.join(` ${DOT} `));
	}

	// ═══════════════════════════════════════════════════
	// 末行: 时间 · 费用 · 会话ID
	// ═══════════════════════════════════════════════════
	const tp: string[] = [];
	if (st.sessionStart) {
		const from = new Date(st.sessionStart);
		tp.push(
			`${d("from")} ${g(`${from.getHours()}:${String(from.getMinutes()).padStart(2, "0")}`)}`,
		);
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
		tp.push(
			`${d("last")} ${w(ago < 60 ? `${ago}s` : `${Math.floor(ago / 60)}m${ago % 60}s`)}`,
		);
	}

	const sid =
		ctx.sessionManager
			.getSessionFile()
			?.split("/")
			.pop()
			?.slice(-12) || "";

	const info: string[] = [];
	if (tp.length) info.push(tp.join(` ${DOT} `));
	if (st.totalCost > 0) info.push(`${d("cost")} ${w(`$${st.totalCost.toFixed(3)}`)}`);
	if (st.totalInp > 0 || st.totalOut > 0) {
		const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
		info.push(`${d("↑↓")} ${v(fmt(st.totalInp))}/${v(fmt(st.totalOut))}`);
	}
	const treeSid = st.treeId ? st.treeId.replace(/^tree_/, "").slice(-8) : "";
	if (treeSid) info.push(`${d("tree")} ${m(treeSid)}`);
	if (sid) info.push(m(sid));

	if (info.length) lines.push(info.join(` ${SEP} `));

	return lines.map((l) => truncateToWidth(l, width));
}
