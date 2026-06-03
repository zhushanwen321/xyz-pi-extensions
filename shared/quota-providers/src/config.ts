/**
 * Providers 配置加载器
 *
 * 读取 ~/.pi/agent/config/providers.json，解析为声明式 provider 列表。
 * 缺失文件或解析失败返回空配置（statusline 仍可运行，只是没有 provider）。
 */

import { existsSync, readFileSync } from "node:fs";
import { getProvidersConfigPath } from "./paths.js";

export interface ProviderDecl {
	id: string;
	label: string;
	enabled: boolean;
	fetcher: string;
}

export interface ProvidersConfig {
	"token-plans": ProviderDecl[];
	"search-tools": ProviderDecl[];
}

const EMPTY: ProvidersConfig = { "token-plans": [], "search-tools": [] };

export function loadProvidersConfig(): ProvidersConfig {
	const path = getProvidersConfigPath();
	if (!existsSync(path)) return EMPTY;
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (typeof raw !== "object" || raw === null) return EMPTY;
		return {
			"token-plans": normalizeList((raw as Record<string, unknown>)["token-plans"]),
			"search-tools": normalizeList((raw as Record<string, unknown>)["search-tools"]),
		};
	} catch (e) {
		console.warn(`[statusline] failed to parse ${path}:`, e);
		return EMPTY;
	}
}

function normalizeList(input: unknown): ProviderDecl[] {
	if (!Array.isArray(input)) return [];
	const out: ProviderDecl[] = [];
	for (const item of input) {
		if (typeof item !== "object" || item === null) continue;
		const o = item as Record<string, unknown>;
		if (typeof o.id !== "string" || typeof o.fetcher !== "string") continue;
		out.push({
			id: o.id,
			label: typeof o.label === "string" ? o.label : o.id,
			enabled: o.enabled !== false,
			fetcher: o.fetcher,
		});
	}
	return out;
}
