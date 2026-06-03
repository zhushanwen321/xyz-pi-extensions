/**
 * MiniMax (MiniMax) Token Plan 用量 provider
 *
 * API: GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains
 * Auth: Bearer <MINIMAX_API_KEY>
 *
 * 响应字段（实测）：
 *   model_remains[].model_name                    "general" | "video" | ...
 *   model_remains[].current_interval_remaining_percent   5h 剩余百分比 (0-100)
 *   model_remains[].current_interval_status             1=订阅  3=未订阅
 *   model_remains[].remains_time                        5h 窗口剩余毫秒
 *   model_remains[].current_weekly_remaining_percent    周剩余百分比
 *   model_remains[].current_weekly_status
 *   model_remains[].weekly_remains_time                 周窗口剩余毫秒
 *
 * 注：国内 api.minimaxi.com 端点实测稳定可用，不需要 UA 伪装。
 * 国外 www.minimax.io 端点需要 UA 伪装且当前 key 会被拒。
 */

import {
	INFINITE_WIN,
	type NormalizedQuotaRow,
	type QuotaProvider,
} from "./types.js";
import { MS_PER_SEC } from "../time.js";

const API_URL =
	"https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains";

/** 默认 fetch 超时（毫秒） */
const FETCH_TIMEOUT_MS = 5000;
/** 百分比标度 */
const PERCENT_SCALE = 100;

interface MinimaxBaseResp {
	status_code?: number;
}

interface MinimaxApiResponse {
	base_resp?: MinimaxBaseResp;
	model_remains?: MinimaxModelRemains[];
}
export interface MinimaxModelRemains {
	model_name: string;
	current_interval_remaining_percent: number;
	current_interval_status: number;
	remains_time: number;
	current_weekly_remaining_percent: number;
	current_weekly_status: number;
	weekly_remains_time: number;
	// 一些 API 版本还带的字段（保留以防 schema 变化）
	current_interval_total_count?: number;
	current_weekly_total_count?: number;
	[key: string]: unknown;
}

export interface MinimaxData {
	models: MinimaxModelRemains[];
	raw: unknown; // 原始响应，便于未来排错
}

async function fetchMinimax(): Promise<MinimaxData | null> {
	const token = process.env.MINIMAX_API_KEY ?? "";
	if (!token) return null;

	try {
		const resp = await fetch(API_URL, {
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!resp.ok) return null;
	const data = (await resp.json()) as MinimaxApiResponse;

		if (data?.base_resp?.status_code !== 0) return null;
		const models = (data?.model_remains ?? []) as MinimaxModelRemains[];
		if (models.length === 0) return null;

		return { models, raw: data };
	} catch {
		return null;
	}
}

/** status 字段语义：1=正常订阅；其他值（3=未订阅，0/2=异常）→ 当作无限 */
const isActive = (s: number | undefined) => s === 1;

export const minimaxProvider: QuotaProvider<MinimaxData> = {
	id: "minimax",
	label: "minimax-token-plan",
	category: "token-plan",
	fetch: fetchMinimax,
	normalize(raw): NormalizedQuotaRow | null {
		// 关注 model_name === "general"（文本/LLM 用量），过滤掉 video 等无关项
		if (!raw?.models) return null;
		const general = raw.models.find((m) => m.model_name === "general");
		if (!general) return null;

		const win5h = toWindow(
			general.current_interval_remaining_percent,
			general.current_interval_status,
			general.remains_time,
		);
		const winWk = toWindow(
			general.current_weekly_remaining_percent,
			general.current_weekly_status,
			general.weekly_remains_time,
		);

		return {
			label: "minimax-token",
			wins: [win5h, winWk, INFINITE_WIN], // 此 API 不提供月维度
		};
	},
};

/**
 * 把 API 的"剩余百分比"反转为"已用百分比"，并判断是否无限/未订阅。
 *  - status != 1: 当作无限
 *  - total=0 且 percent=100: 也当作无限（典型未订阅状态）
 */
function toWindow(
	remainingPercent: number | undefined,
	status: number | undefined,
	remainsMs: number | undefined,
): { pct: number | null; resetSec: number | null } {
	if (!isActive(status)) return INFINITE_WIN;
	const rem = Number(remainingPercent ?? 0);
	// 已用百分比 = PERCENT_SCALE - 剩余
	const used = Math.max(0, Math.min(PERCENT_SCALE, PERCENT_SCALE - rem));
	const resetSec =
		remainsMs && remainsMs > 0 ? Math.ceil(remainsMs / MS_PER_SEC) : null;
	return { pct: used, resetSec };
}
