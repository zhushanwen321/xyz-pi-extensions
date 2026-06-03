/**
 * Provider 注册表 — 合并声明式 providers.json + 内置 fetcher 实现
 *
 * 职责：
 * 1. 读 ~/.pi/agent/config/providers.json 拿到 enabled=true 的 provider 列表
 * 2. 按 provider.fetcher 字段匹配内置实现
 * 3. 找不到 fetcher 时 warn 一次（不阻断）
 *
 * 未来加新 provider 只需：
 * - providers.json 加一行（label, enabled, fetcher）
 * - 在 FETCHERS 表里注册实现
 */

import type { NormalizedQuotaRow, QuotaProvider } from "./providers/types.js";
import { zhipuProvider } from "./providers/zhipu.js";
import { opencodeGoProvider } from "./providers/opencode-go.js";
import { kimiCodingProvider } from "./providers/kimi-coding.js";
import { minimaxProvider } from "./providers/minimax.js";
import { tavilyProvider } from "./providers/tavily.js";
import { loadProvidersConfig } from "./config.js";

type Fetcher = () => Promise<unknown>;
type Normalize = (raw: unknown) => NormalizedQuotaRow | null;

interface RuntimeProvider extends QuotaProvider {
	category: "token-plan" | "search-tool";
}

/** 内置 fetcher 表 — providers.json.fetcher 字段引用这里的 key */
const FETCHERS: Record<string, Fetcher> = {
	"zhipu": zhipuProvider.fetch as Fetcher,
	"opencode-go": opencodeGoProvider.fetch as Fetcher,
	"kimi-coding": kimiCodingProvider.fetch as Fetcher,
	"minimax": minimaxProvider.fetch as Fetcher,
	"tavily": tavilyProvider.fetch as Fetcher,
};

/** 内置 normalize 表 — token-plan 渲染需要 */
const NORMALIZERS: Record<string, Normalize> = {
	"zhipu": zhipuProvider.normalize as Normalize,
	"opencode-go": opencodeGoProvider.normalize as Normalize,
	"kimi-coding": kimiCodingProvider.normalize as Normalize,
	"minimax": minimaxProvider.normalize as Normalize,
};

/** 合并配置 + 内置实现，构建运行时 provider 列表 */
export function buildRuntimeProviders(): RuntimeProvider[] {
	const cfg = loadProvidersConfig();
	const all = [
		...cfg["token-plans"].map((p) => ({ ...p, category: "token-plan" as const })),
		...cfg["search-tools"].map((p) => ({ ...p, category: "search-tool" as const })),
	];

	const warnedFetchers = new Set<string>();
	const out: RuntimeProvider[] = [];
	for (const decl of all) {
		if (!decl.enabled) continue;
		const fetch = FETCHERS[decl.fetcher];
		if (!fetch) {
			if (!warnedFetchers.has(decl.fetcher)) {
				console.warn(`[statusline] unknown fetcher: ${decl.fetcher} (provider ${decl.id})`);
				warnedFetchers.add(decl.fetcher);
			}
			continue;
		}
		// search-tool 不需要 normalize（renderer 直接读 raw.used/total）
		const normalize: Normalize =
			decl.category === "search-tool"
				? () => null
				: NORMALIZERS[decl.fetcher] ?? (() => null);

		out.push({
			id: decl.id,
			label: decl.label,
			category: decl.category,
			fetch: fetch as QuotaProvider["fetch"],
			normalize: normalize as QuotaProvider["normalize"],
		});
	}
	return out;
}
