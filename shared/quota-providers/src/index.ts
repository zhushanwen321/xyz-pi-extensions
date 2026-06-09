/**
 * Quota Provider — 桶出口（barrel export）
 *
 * 所有类型和函数从子模块重新导出。
 */

export { type CacheData, type CacheRatioData, readCache, type SpeedData,trackCacheRatio, trackSpeed, triggerUpdate } from "./cache.js";
export { loadProvidersConfig, type ProviderDecl,type ProvidersConfig } from "./config.js";
export { getCachePath, getConfigDir, getProvidersConfigPath, getSecretsPath, getSpeedDir, resolveEnvRef } from "./paths.js";
export { providerById,PROVIDERS } from "./providers/index.js";
export type { KimiCodingData } from "./providers/kimi-coding.js";
export type { MimoData } from "./providers/mimo.js";
export type { MinimaxData } from "./providers/minimax.js";
export type { OpenCodeGoData } from "./providers/opencode-go.js";
export type { TavilyData } from "./providers/tavily.js";
export { INFINITE_WIN, type NormalizedQuotaRow, type QuotaProvider,type QuotaWindow, type QuotaWins } from "./providers/types.js";
export type { ZhipuData } from "./providers/zhipu.js";
export { buildRuntimeProviders } from "./registry.js";
export { getSecret, loadSecrets, type Secrets } from "./secrets.js";
