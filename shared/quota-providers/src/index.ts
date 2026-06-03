/**
 * Quota Provider — 桶出口（barrel export）
 *
 * 所有类型和函数从子模块重新导出。
 */

export { readCache, triggerUpdate, trackSpeed, type CacheData, type SpeedData } from "./cache.js";
export { INFINITE_WIN, type QuotaWindow, type QuotaWins, type NormalizedQuotaRow, type QuotaProvider } from "./providers/types.js";
export { PROVIDERS, providerById } from "./providers/index.js";
export { loadProvidersConfig, type ProvidersConfig, type ProviderDecl } from "./config.js";
export { loadSecrets, getSecret, type Secrets } from "./secrets.js";
export { getConfigDir, getProvidersConfigPath, getSecretsPath, getCachePath, getSpeedDir, resolveEnvRef } from "./paths.js";
export { buildRuntimeProviders } from "./registry.js";
export type { ZhipuData } from "./providers/zhipu.js";
export type { OpenCodeGoData } from "./providers/opencode-go.js";
export type { KimiCodingData } from "./providers/kimi-coding.js";
export type { MinimaxData } from "./providers/minimax.js";
export type { TavilyData } from "./providers/tavily.js";
