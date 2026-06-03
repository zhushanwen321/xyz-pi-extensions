import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type NormalizedQuotaRow,
	type QuotaProvider,
} from "./types.js";

const HOME = homedir();
const SECRETS_DIR = join(HOME, ".pi", "agent", "secrets");

/** 默认 fetch 超时（毫秒） */
const FETCH_TIMEOUT_MS = 8000;
/** HTTP 200 状态码 */
const HTTP_OK = 200;
const OPENCODE_COOKIE_PATH = join(SECRETS_DIR, "opencode-cookie.txt");
const OPENCODE_WORKSPACE_URL =
	"https://opencode.ai/workspace/wrk_01KM5Q3EEQEHZJ3V5PXF5JCR62/go";

export interface OpenCodeGoUsage {
	status: "ok" | "rate-limited" | "unknown";
	usagePercent: number;
	resetInSec: number;
}

export interface OpenCodeGoData {
	rolling: OpenCodeGoUsage;
	weekly: OpenCodeGoUsage;
	monthly: OpenCodeGoUsage;
}

async function fetchOpenCodeGo(): Promise<OpenCodeGoData | null> {
	let cookie = process.env.OPENCODE_COOKIE ?? "";
	if (!cookie && existsSync(OPENCODE_COOKIE_PATH)) {
		cookie = readFileSync(OPENCODE_COOKIE_PATH, "utf-8").trim();
	}
	if (!cookie) return null;

	try {
		const resp = await fetch(OPENCODE_WORKSPACE_URL, {
			headers: {
				accept: "text/html",
				cookie,
				"user-agent": "Mozilla/5.0",
			},
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			redirect: "manual",
		});
		// 需要 cookie 才能获取数据，302 说明 cookie 过期
		if (resp.status !== HTTP_OK) return null;
		const html = await resp.text();
		return parseOpenCodeGo(html);
	} catch {
		return null;
	}
}

function parseOpenCodeGo(html: string): OpenCodeGoData | null {
	// SSR HTML 中嵌入了数据：rollingUsage/weeklyUsage/monthlyUsage
	// 格式：rollingUsage:$R[N]={status:"ok",resetInSec:18000,usagePercent:0}
	const extract = (
		name: string,
	): { status: string; resetInSec: number; usagePercent: number } | null => {
		const re = new RegExp(
			`${name}:\\$R\\[\\d+\\]=\\{([^}]+)\\}`,
		);
		const m = html.match(re);
		if (!m) return null;
		const obj = m[1]!;
		const statusM = obj.match(/status:"([^"]+)"/);
		const resetM = obj.match(/resetInSec:(\d+)/);
		const pctM = obj.match(/usagePercent:(\d+)/);
		if (!statusM || !resetM || !pctM) return null;
		return {
			status: statusM[1],
			resetInSec: Number(resetM[1]),
			usagePercent: Number(pctM[1]),
		};
	};

	const rolling = extract("rollingUsage");
	const weekly = extract("weeklyUsage");
	const monthly = extract("monthlyUsage");
	if (!rolling || !weekly || !monthly) return null;

	return {
		rolling: {
			status: rolling.status as OpenCodeGoUsage["status"],
			usagePercent: rolling.usagePercent,
			resetInSec: rolling.resetInSec,
		},
		weekly: {
			status: weekly.status as OpenCodeGoUsage["status"],
			usagePercent: weekly.usagePercent,
			resetInSec: weekly.resetInSec,
		},
		monthly: {
			status: monthly.status as OpenCodeGoUsage["status"],
			usagePercent: monthly.usagePercent,
			resetInSec: monthly.resetInSec,
		},
	};
}

export const opencodeGoProvider: QuotaProvider<OpenCodeGoData> = {
	id: "opencode-go",
	label: "opencode-go",
	category: "token-plan",
	fetch: fetchOpenCodeGo,
	normalize(raw): NormalizedQuotaRow | null {
		if (!raw?.rolling || !raw?.weekly || !raw?.monthly) return null;
		const toWin = (u: { usagePercent: number; resetInSec: number }) => ({
			pct: u.usagePercent,
			resetSec: u.resetInSec > 0 ? u.resetInSec : null,
		});
		return {
			label: "opencode-go",
			wins: [toWin(raw.rolling), toWin(raw.weekly), toWin(raw.monthly)],
		};
	},
};
