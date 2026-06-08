/**
 * Mimo (小米) Token Plan 用量 provider
 *
 * API: GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage
 * Auth: Cookie（完整 cookie 字符串，通过 MIMO_COOKIE 环境变量配置）
 *
 * 响应结构：
 *   code: 0 表示成功
 *   data.monthUsage.percent — 月使用比例（0~1 小数，如 0.0007 = 0.07%）
 *   data.usage.items[] — 含 plan_total_token 的 used/limit/percent
 *
 * 只提供月窗口，其余窗口显示 ∞ / --。
 */

import {
	INFINITE_WIN,
	type NormalizedQuotaRow,
	type QuotaProvider,
} from "./types.js";

const API_URL = "https://platform.xiaomimimo.com/api/v1/tokenPlan/usage";
const FETCH_TIMEOUT_MS = 5000;
const PERCENT_SCALE = 100;

interface MimoApiResponse {
	code: number;
	message: string;
	data: {
		monthUsage: { percent: number; items: MimoUsageItem[] };
		usage: { percent: number; items: MimoUsageItem[] };
	};
}

interface MimoUsageItem {
	name: string;
	used: number;
	limit: number;
	percent: number;
}

export interface MimoData {
	/** 月使用百分比（0-100 标度） */
	monthPct: number;
	raw: unknown;
}

async function fetchMimo(): Promise<MimoData | null> {
	const cookie = process.env.MIMO_COOKIE ?? "";
	if (!cookie) return null;

	try {
		const resp = await fetch(API_URL, {
			headers: {
				accept: "application/json",
				cookie,
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!resp.ok) return null;
		const data = (await resp.json()) as MimoApiResponse;
		if (data.code !== 0) return null;

		const monthPct = (data.data?.monthUsage?.percent ?? 0) * PERCENT_SCALE;
		return { monthPct, raw: data };
	} catch {
		return null;
	}
}

export const mimoProvider: QuotaProvider<MimoData> = {
	id: "mimo",
	label: "mimo-token-plan",
	category: "token-plan",
	fetch: fetchMimo,
	normalize(raw): NormalizedQuotaRow | null {
		if (raw?.monthPct === undefined) return null;
		return {
			label: "mimo-token",
			wins: [INFINITE_WIN, INFINITE_WIN, { pct: raw.monthPct, resetSec: null }],
		};
	},
};
