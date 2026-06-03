import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	type NormalizedQuotaRow,
	type QuotaProvider,
} from "./types.js";

const HOME = homedir();

/** Tavily 免费套餐每个 API key 的月调用上限 */
const FREE_TIER_PER_KEY_LIMIT = 1000;


interface TavilyUsageEntry {
	credits: number;
	requests: number;
}

interface TavilyApiUsageEntry {
	plan_usage: number;
	plan_limit: number;
	key_usage: number;
	key_limit: number;
	plan_name: string;
}

interface TavilyState {
	usage: Record<string, TavilyUsageEntry>;
	exhausted?: Record<string, unknown>;
	api_usage?: Record<string, TavilyApiUsageEntry>;
}
export interface TavilyData {
	available: number;
	total: number;
	planUsage: number;
	planLimit: number;
	planName: string;
	keyUsage: number;
	keyLimit: number;
	credits: number;
	requests: number;
}

async function readTavily(): Promise<TavilyData | null> {
	const stateFile = join(HOME, ".tavily", "state.json");
	try {
		const data = JSON.parse(readFileSync(stateFile, "utf-8")) as TavilyState;
		if (!data?.usage) return null;

		const total = Object.keys(data.usage).length;
		const exhausted = Object.keys(data.exhausted ?? {}).length;
		const entries = Object.values(data.usage) as TavilyUsageEntry[];
		const credits = entries.reduce(
			(s, v) => s + (v.credits ?? 0),
			0,
		);
		const requests = entries.reduce(
			(s, v) => s + (v.requests ?? 0),
			0,
		);

		const apiEntries = Object.values(data.api_usage ?? {}) as TavilyApiUsageEntry[];
		let planUsage = 0;
		let planLimit = 0;
		let keyUsage = 0;
		let keyLimit = 0;
		let planName = "";
		for (const v of apiEntries) {
			planUsage += v.plan_usage ?? 0;
			planLimit += v.plan_limit ?? 0;
			keyUsage += v.key_usage ?? 0;
			keyLimit += v.key_limit ?? 0;
			if (!planName) planName = v.plan_name ?? "";
		}

		// api_usage 缺失时（旧版 state.json），用 credits 近似 planUsage，
		// 用 key 数量 × 每密钥上限近似 planLimit
		const effectivePlanUsage = planUsage > 0 ? planUsage : credits;
		const effectivePlanLimit = planLimit > 0 ? planLimit : total * FREE_TIER_PER_KEY_LIMIT;

		return {
			available: total - exhausted,
			total,
			planUsage: effectivePlanUsage,
			planLimit: effectivePlanLimit,
			planName,
			keyUsage,
			keyLimit,
			credits,
			requests,
		};
	} catch {
		return null;
	}
}

/**
 * Tavily 不参与 3 窗口套餐显示（它在 line 2 的 "tavily X/Y" 单独展示）。
 * 这里仍然注册一个 provider 用于统一数据获取，但 normalize 返回 null（不显示行）。
 */
export const tavilyProvider: QuotaProvider<TavilyData> = {
	id: "tavily",
	label: "tavily",
	category: "search-tool",
	fetch: readTavily,
	normalize(_raw): NormalizedQuotaRow | null {
		return null; // 渲染层从 cache.tavily 单独取 available/total
	},
};
