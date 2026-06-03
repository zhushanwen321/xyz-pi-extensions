import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	INFINITE_WIN,
	type NormalizedQuotaRow,
	type QuotaProvider,
} from "./types.js";

const HOME = homedir();
const SECRETS_DIR = join(HOME, ".pi", "agent", "secrets");
const KIMI_API_KEY_PATH = join(SECRETS_DIR, "kimi-coding-api-key.txt");

export interface KimiCodingWindow {
	limit: number;
	remaining: number;
	usedPct: number;
	resetTime: string;
}

interface KimiLimitDetail {
	limit?: number;
	remaining?: number;
	resetTime?: string;
}

interface KimiLimit {
	detail?: KimiLimitDetail;
}

interface KimiUsage {
	limit?: number;
	used?: number;
	resetTime?: string;
}

interface KimiApiResponse {
	limits?: KimiLimit[];
	usage?: KimiUsage;
}
export interface KimiCodingData {
	rollingWindow: KimiCodingWindow;
	dailyLimit: number;
	dailyUsed: number;
	dailyResetTime: string;
}

async function fetchKimiCoding(): Promise<KimiCodingData | null> {
	let apiKey = process.env.KIMI_API_KEY ?? "";
	if (!apiKey && existsSync(KIMI_API_KEY_PATH)) {
		apiKey = readFileSync(KIMI_API_KEY_PATH, "utf-8").trim();
	}
	if (!apiKey) return null;

	try {
		const resp = await fetch("https://api.kimi.com/coding/v1/usages", {
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			signal: AbortSignal.timeout(5000),
		});
		if (!resp.ok) return null;
	const data = (await resp.json()) as KimiApiResponse;

		const win = (data?.limits ?? [])[0];
		const winLimit = Number(win?.detail?.limit ?? 0);
		const winRemaining = Number(win?.detail?.remaining ?? 0);
		const dailyLimit = Number(data?.usage?.limit ?? 0);
		const dailyUsed = Number(data?.usage?.used ?? 0);

		return {
			rollingWindow: {
				limit: winLimit,
				remaining: winRemaining,
				usedPct:
					winLimit > 0
						? Math.round(((winLimit - winRemaining) / winLimit) * 100)
						: 0,
				resetTime: win?.detail?.resetTime ?? "",
			},
			dailyLimit,
			dailyUsed,
			dailyResetTime: data?.usage?.resetTime ?? "",
		};
	} catch {
		return null;
	}
}

export const kimiCodingProvider: QuotaProvider<KimiCodingData> = {
	id: "kimi-coding",
	label: "kimi-coding",
	fetch: fetchKimiCoding,
	normalize(raw): NormalizedQuotaRow | null {
		if (!raw?.rollingWindow) return null;
		const rw = raw.rollingWindow;
		const ki5h =
			rw.limit > 0
				? {
						pct: rw.usedPct,
						resetSec: rw.resetTime
							? isoResetRemaining(rw.resetTime)
							: null,
					}
				: INFINITE_WIN;

		const kiWk =
			raw.dailyLimit > 0
				? {
						pct: Math.round((raw.dailyUsed / raw.dailyLimit) * 100),
						resetSec: raw.dailyResetTime
							? isoResetRemaining(raw.dailyResetTime)
							: null,
					}
				: INFINITE_WIN;

		return {
			label: "kimi-coding",
			wins: [ki5h, kiWk, INFINITE_WIN],
		};
	},
};

/** ISO 时间戳 → 剩余秒 */
function isoResetRemaining(iso: string): number {
	return Math.max(
		0,
		Math.floor((new Date(iso).getTime() - Date.now()) / 1000),
	);
}
