import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	INFINITE_WIN,
	type NormalizedQuotaRow,
	type QuotaProvider,
} from "./types.js";

const HOME = homedir();

export interface ZhipuData {
	label: string;
	tokensPct: number;
	timePct: number;
	timeCurrent: number;
	resetTime: string;
}


interface ZhipuLimit {
	type: string;
	percentage?: number;
	currentValue?: number;
	nextResetTime?: string;
}

interface ZhipuApiData {
	level?: string;
	limits?: ZhipuLimit[];
}

interface ZhipuApiResponse {
	success?: boolean;
	data?: ZhipuApiData;
}

async function fetchZhipu(): Promise<ZhipuData | null> {
	// 优先环境变量，兼容文件
	let token = process.env.ZAI_AUTH_TOKEN ?? "";
	if (!token) {
		const tokenPaths = [
			join(HOME, ".pi", ".zhipu_auth_token"),
			join(HOME, ".claude", ".zhipu_auth_token"),
		];
		for (const p of tokenPaths) {
			if (existsSync(p)) {
				token = readFileSync(p, "utf-8").trim();
				break;
			}
		}
	}
	if (!token) return null;

	try {
		const resp = await fetch(
			"https://bigmodel.cn/api/monitor/usage/quota/limit",
			{
				headers: {
					accept: "application/json, text/plain, */*",
					authorization: token,
					"bigmodel-organization":
						"org-8F82302F73594F44B2bdCc5A57BCfD1f",
					"bigmodel-project":
						"proj_8E86D38C8211410Baa4852408071D1F2",
					referer:
						"https://bigmodel.cn/usercenter/glm-coding/usage",
					"user-agent": "Mozilla/5.0",
				},
				signal: AbortSignal.timeout(5000),
			},
		);
		if (!resp.ok) return null;
		const data = await resp.json() as ZhipuApiResponse;
		return processZhipu(data);
	} catch {
		return null;
	}
}

function processZhipu(data: ZhipuApiResponse): ZhipuData | null {
	if (!data?.success) return null;
	const d = data.data;
	const label = d?.level ? `Z.ai-${d.level}` : "Z.ai";

	let tokensPct = 0;
	let timePct = 0;
	let timeCurrent = 0;
	let resetMs = 0;

	for (const lim of d?.limits ?? []) {
		if (lim.type === "TOKENS_LIMIT") {
			tokensPct = lim.percentage ?? 0;
			if (lim.nextResetTime) resetMs = Number(lim.nextResetTime);
		} else if (lim.type === "TIME_LIMIT") {
			timePct = lim.percentage ?? 0;
			timeCurrent = lim.currentValue ?? 0;
			if (!resetMs && lim.nextResetTime)
				resetMs = Number(lim.nextResetTime);
		}
	}

	let resetTime = "";
	if (resetMs) {
		const rem =
			Math.floor(resetMs / 1000) - Math.floor(Date.now() / 1000);
		if (rem > 0) {
			const days = Math.floor(rem / 86400);
			const hrs = Math.floor((rem % 86400) / 3600);
			const mins = Math.floor((rem % 3600) / 60);
			if (days > 0) resetTime = `${days}d${hrs}h`;
			else if (hrs > 0) resetTime = `${hrs}h${mins}m`;
			else resetTime = `${mins}m`;
		}
	}

	return { label, tokensPct, timePct, timeCurrent, resetTime };
}

export const zhipuProvider: QuotaProvider<ZhipuData> = {
	id: "zhipu",
	label: "Z.ai", // fallback；实际显示来自 raw.label（Z.ai-pro 等）
	fetch: fetchZhipu,
	normalize(raw): NormalizedQuotaRow | null {
		const resetSec = raw.resetTime ? parseZaiResetSec(raw.resetTime) : null;
		return {
			label: raw.label || "Z.ai",
			wins: [
				{ pct: raw.tokensPct, resetSec },
				INFINITE_WIN,
				INFINITE_WIN,
			],
		};
	},
};

/** 把 ZAI 的 resetTime（如 "4h11m"/"3d20h"）转成剩余秒 */
function parseZaiResetSec(label: string): number {
	const dM = label.match(/(\d+)d/);
	const hM = label.match(/(\d+)h/);
	const mM = label.match(/(\d+)m/);
	let sec = 0;
	if (dM) sec += Number(dM[1]) * 86400;
	if (hM) sec += Number(hM[1]) * 3600;
	if (mM) sec += Number(mM[1]) * 60;
	return sec;
}
