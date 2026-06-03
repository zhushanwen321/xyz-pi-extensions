/**
 * Provider 注册表 — 合并声明式 providers.json + 内置 fetcher 实现
 *
 * 职责：
 * 1. 读 ~/.pi/agent/config/providers.json 拿到 enabled=true 的 provider 列表
 * 2. 按 provider.fetcher 字段匹配内置 QuotaProvider 实现
 * 3. 找不到 fetcher 时 warn 一次（不阻断）
 * 4. 缓存结果，按 providers.json mtime 失效
 *
 * 未来加新 provider 只需：
 * - providers/<name>.ts 实现 QuotaProvider 接口并 push 到 PROVIDERS
 * - providers.json 加一行（label, enabled, fetcher）
 *   同一处声明，避免双重注册
 */

import { existsSync, statSync } from "node:fs";
import type { QuotaProvider } from "./providers/types.js";
import { PROVIDERS } from "./providers/index.js";
import { loadProvidersConfig } from "./config.js";
import { getProvidersConfigPath } from "./paths.js";

/** 从静态 PROVIDERS 数组派生 fetcher 查找表（消除双重注册） */
const PROVIDER_BY_FETCHER = new Map<string, QuotaProvider>(
	PROVIDERS.map((p) => [p.id, p]),
);

/** 模块级缓存：按 providers.json mtime 失效 */
let cached: QuotaProvider[] | null = null;
let cachedMtime = 0;

/** 合并配置 + 内置实现，构建运行时 provider 列表 */
export function buildRuntimeProviders(): QuotaProvider[] {
	const path = getProvidersConfigPath();
	const mtime = existsSync(path) ? statSync(path).mtimeMs : 0;
	if (cached && mtime === cachedMtime) return cached;

	const cfg = loadProvidersConfig();
	const all = [
		...cfg["token-plans"].map((p) => ({ ...p, category: "token-plan" as const })),
		...cfg["search-tools"].map((p) => ({ ...p, category: "search-tool" as const })),
	];

	const warnedFetchers = new Set<string>();
	const out: QuotaProvider[] = [];
	for (const decl of all) {
		if (!decl.enabled) continue;
		const impl = PROVIDER_BY_FETCHER.get(decl.fetcher);
		if (!impl) {
			if (!warnedFetchers.has(decl.fetcher)) {
				console.warn(`[statusline] unknown fetcher: ${decl.fetcher} (provider ${decl.id})`);
				warnedFetchers.add(decl.fetcher);
			}
			continue;
		}
		out.push({ ...impl, id: decl.id, label: decl.label, category: decl.category });
	}

	cached = out;
	cachedMtime = mtime;
	return out;
}
