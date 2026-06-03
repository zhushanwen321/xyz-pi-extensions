/**
 * Secrets 凭证加载器
 *
 * 读取 ~/.pi/agent/config/secrets.json，自动解析 ${ENV_VAR} 引用。
 * 不做 chmod 校验，不 warn。
 */

import { existsSync, readFileSync } from "node:fs";
import { getSecretsPath, resolveEnvRef } from "./paths.js";

export type Secrets = Record<string, Record<string, string>>;

export function loadSecrets(): Secrets {
	const path = getSecretsPath();
	if (!existsSync(path)) return {};
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		return resolveSecrets(raw);
	} catch (e) {
		console.warn(`[statusline] failed to parse ${path}:`, e);
		return {};
	}
}

function resolveSecrets(raw: unknown): Secrets {
	if (typeof raw !== "object" || raw === null) return {};
	const out: Secrets = {};
	for (const [provider, fields] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof fields !== "object" || fields === null) continue;
		const resolved: Record<string, string> = {};
		for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
			if (typeof value !== "string") continue;
			resolved[key] = resolveEnvRef(value);
		}
		// 跳过空 section（所有 key 都解析成空串）
		if (Object.keys(resolved).length > 0) out[provider] = resolved;
	}
	return out;
}

/** 取某个 provider 的某个字段，找不到返回 undefined */
export function getSecret(secrets: Secrets, providerId: string, key: string): string | undefined {
	return secrets[providerId]?.[key];
}
