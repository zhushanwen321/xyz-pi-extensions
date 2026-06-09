/**
 * Statusline 纯格式化函数
 *
 * 从 index.ts 提取的可测试纯函数。
 * 不依赖 Pi 运行时（ExtensionAPI / Theme），只做数据→字符串转换。
 */

import type { QuotaProvider,QuotaWindow } from "@zhushanwen/pi-quota-providers";

// ── 时间常量 ───────────────────────────────────────────

export const MS_PER_SEC = 1000;
export const SEC_PER_MIN = 60;
const MIN_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SEC_PER_HOUR = SEC_PER_MIN * MIN_PER_HOUR;
const SEC_PER_DAY = SEC_PER_HOUR * HOURS_PER_DAY;

// ── token 数字单位阈值 ─────────────────────────────────

export const KILO = 1_000;
const MILLION = 1_000_000;

// ── 百分比阈值 ─────────────────────────────────────────

const PCT_HIGH = 80;
const PCT_MED = 60;
const PCT_LOW = 40;
export const PERCENT_SCALE = 100;

// ── 渲染常量 ───────────────────────────────────────────

/** 标题列宽（按最长 "minimax-token-plan"=18，+1 空格余量） */
export const TITLE_COL_W = 19;
/** reset 时间列宽（fmtResetSec 最长 "12d23h"=6 + 1 空格余量） */
export const RESET_COL_W = 7;
/** pct 列宽（"100%"=4，但 padStart(3) 给 " 23%"=4） */
export const PCT_COL_W = 3;

// ── 列定义 ─────────────────────────────────────────────

export const COLS = [
	{ key: "5h", label: "5h" },
	{ key: "week", label: "wk" },
	{ key: "month", label: "mh" },
] as const;

// ── 格式化函数 ─────────────────────────────────────────

export const MIN_PAD = 2;

export function fmtDuration(ms: number): string {
	const s = Math.floor(ms / MS_PER_SEC);
	if (s < SEC_PER_MIN) return `${s}s`;
	const m = Math.floor(s / SEC_PER_MIN);
	if (m < MIN_PER_HOUR) return `${m}m${String(s % SEC_PER_MIN).padStart(MIN_PAD, "0")}s`;
	return `${Math.floor(m / MIN_PER_HOUR)}h${String(m % MIN_PER_HOUR).padStart(MIN_PAD, "0")}m`;
}

export function fmtTokens(n: number): string {
	if (n >= MILLION) return `${(n / MILLION).toFixed(1)}M`;
	if (n >= KILO) return `${(n / KILO).toFixed(1)}K`;
	return `${n}`;
}

export function fmtResetSec(sec: number): string {
	if (sec <= 0) return "";
	const d = Math.floor(sec / SEC_PER_DAY);
	const h = Math.floor((sec % SEC_PER_DAY) / SEC_PER_HOUR);
	const m = Math.floor((sec % SEC_PER_HOUR) / SEC_PER_MIN);
	if (d > 0) return `${d}d${h}h`;
	if (h > 0) return `${h}h${m}m`;
	return `${m}m`;
}

export function fmtCount(n: number): string {
	return n < KILO ? `${n}` : `${(n / KILO).toFixed(1)}k`;
}

/** 按百分比返回语义色 token */
export function pctColor(pct: number): "error" | "warning" | "accent" | "success" {
	if (pct >= PCT_HIGH) return "error";
	if (pct >= PCT_MED) return "warning";
	if (pct >= PCT_LOW) return "accent";
	return "success";
}

// ── 速度渲染 ─────────────────────────────────────────

export interface SpeedLike {
	current: number;
	day: number;
}

/** 渲染速度部分：speed 123t/s · day 85t/s（无速度返回空串） */
export function formatSpeedPart(sp: SpeedLike, p: PlainPallet): string {
	const parts: string[] = [];
	if (sp.current > 0) parts.push(`${p.g(`${sp.current}`)}${p.d("t/s")}`);
	if (sp.day > 0) parts.push(`${p.d("day")} ${p.g(`${sp.day}`)}${p.d("t/s")}`);
	return parts.length ? `│ ${p.d("speed")} ${parts.join(" · ")}` : "";
}

// ── 缓存命中率渲染 ─────────────────────────────────────

export interface CacheRatioLike {
	current: number | null;
	day: number | null;
}

/** 渲染缓存命中率部分：cache 85% · day 72%（无数据返回空串） */
export function formatCacheRatioPart(cr: CacheRatioLike, p: PlainPallet): string {
	const parts: string[] = [];
	if (cr.current !== null) parts.push(`${p.g(`${cr.current}`)}${p.d("%")}`);
	if (cr.day !== null) parts.push(`${p.d("day")} ${p.g(`${cr.day}`)}${p.d("%")}`);
	return parts.length ? `│ ${p.d("cache")} ${parts.join(" · ")}` : "";
}

// ── 路径工具 ─────────────────────────────────────────

/** 把路径切成段（按系统分隔符） */
export function splitPath(p: string): string[] {
	return p.split("/").filter(Boolean);
}

/** 截取 sessionId 文件名的末尾 N 字符（去路径） */
export function tailSessionId(filePath: string | undefined, n: number): string {
	if (!filePath) return "";
	return filePath.split("/").pop()?.slice(-n) ?? "";
}

// ── Palette（strip ANSI 的 plain 版本，用于测试） ──────

export interface PlainPallet {
	d: (s: string) => string;
	v: (s: string) => string;
	g: (s: string) => string;
	w: (s: string) => string;
	a: (s: string) => string;
	m: (s: string) => string;
}

/** 无 ANSI 色码的 palette，返回原始字符串 */
export const plainPallet: PlainPallet = {
	d: (s) => s,
	v: (s) => s,
	g: (s) => s,
	w: (s) => s,
	a: (s) => s,
	m: (s) => s,
};

/** 模拟 Theme.fg — 只返回原始文本 */
export const plainThemeFg = (_token: string, text: string) => text;

// ── 行数据类型 ─────────────────────────────────────────

export interface QuotaRow {
	name: string;
	wins: [QuotaWindow, QuotaWindow, QuotaWindow];
}

// ── 核心渲染函数 ───────────────────────────────────────

/** 缓存数据 → 归一化行（用于 token-plans 显示） */
export function normalizeRows(
	cache: Record<string, unknown>,
	providers: QuotaProvider[],
): QuotaRow[] {
	const rows: QuotaRow[] = [];
	for (const p of providers) {
		if (p.category !== "token-plan") continue;
		try {
			const raw = cache[p.id];
			if (!raw) continue;
			const norm = p.normalize(raw);
			if (!norm) continue;
			// 优先使用 providers.json 配置的 label，fallback 到 normalize 返回的 label
			rows.push({ name: p.label || norm.label, wins: norm.wins });
		// eslint-disable-next-line taste/no-silent-catch
		} catch (normalizeErr) {
			console.warn("[statusline] normalize failed:", normalizeErr);
		}
	}
	return rows;
}

/** 渲染搜索工具行 */
export function buildSearchLine(
	cache: Record<string, unknown>,
	providers: QuotaProvider[],
	p: PlainPallet,
	themeFg: (token: string, text: string) => string,
): string {
	const parts: string[] = [];
	for (const prov of providers) {
		if (prov.category !== "search-tool") continue;
		const raw = cache[prov.id] as Record<string, unknown> | undefined;
		if (!raw) continue;
		const used = (raw.planUsage as number) ?? (raw.available as number);
		const total = (raw.planLimit as number) ?? (raw.total as number);
		if (used === undefined || !total || total <= 0) continue;
		const pct = Math.round((used / total) * PERCENT_SCALE);
		const pctCol = themeFg(pctColor(pct), `${pct}%`);
		parts.push(`${p.d(prov.label)} ${p.g(`${used}`)}/${p.v(`${total}`)} ${pctCol}`);
	}
	return parts.join(" | ");
}

/** 渲染 token-plan 行列表 */
export function buildTokenPlanLines(
	cache: Record<string, unknown>,
	providers: QuotaProvider[],
	p: PlainPallet,
	themeFg: (token: string, text: string) => string,
): string[] {
	const rows = normalizeRows(cache, providers);
	return rows.map((row) => {
		const title = p.d(row.name.padEnd(TITLE_COL_W));
		const cells = COLS.map((col, i) => {
			const win = row.wins[i]!;
			return formatWinCol(col.label, win, p, themeFg);
		});
		return title + cells.join(" · ");
	});
}

/** 渲染单个窗口列：label pct% [reset]（无 bar） */
export function formatWinCol(
	label: string,
	win: QuotaWindow,
	p: PlainPallet,
	themeFg: (token: string, text: string) => string,
): string {
	const pctWidth = PCT_COL_W + 1; // "NNN%" = padStart(3) + 1 = 4 chars
	if (win.pct === null) {
		// 无限：∞ 右对齐到 pctStr 宽度，reset 用 -- 占位
		return `${p.d(label)}  ${p.v("∞".padStart(pctWidth))}  ${p.v("--".padStart(RESET_COL_W))}`;
	}
	const pctStr = `${String(Math.round(win.pct)).padStart(PCT_COL_W)}%`;
	const rtRaw = win.resetSec != null && win.resetSec > 0 ? fmtResetSec(win.resetSec) : "";
	const rtStr = rtRaw ? p.v(rtRaw.padStart(RESET_COL_W)) : " ".repeat(RESET_COL_W);
	return `${p.d(label)}  ${themeFg(pctColor(win.pct), pctStr)}  ${rtStr}`;
}
