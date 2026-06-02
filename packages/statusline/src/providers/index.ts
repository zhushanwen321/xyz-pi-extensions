/**
 * Provider 注册表
 *
 * 新增 provider 流程：
 *   1. 在 providers/ 下新建 xxx.ts，实现 QuotaProvider 接口
 *   2. 在下面追加一行 import + PROVIDERS.push(...)
 *   3. 在 cache.ts 的 CacheData interface 和 readCacheSync 里加一个字段（兼容老缓存）
 *   4. 如果 provider 需要被特殊显示（如 tavily 在 line 2），在 index.ts 加引用
 */

import { kimiCodingProvider } from "./kimi-coding.js";
import { minimaxProvider } from "./minimax.js";
import { opencodeGoProvider } from "./opencode-go.js";
import type { QuotaProvider } from "./types.js";
import { tavilyProvider } from "./tavily.js";
import { zhipuProvider } from "./zhipu.js";

/**
 * 注册顺序即 statusline 显示顺序。
 * 显示在套餐用量行的 provider（normalize 不返回 null）。
 * tavily 也在列表里但 normalize 返回 null，由 index.ts 单独从 cache 读取 available/total。
 */
export const PROVIDERS: QuotaProvider[] = [
	zhipuProvider,
	opencodeGoProvider,
	kimiCodingProvider,
	minimaxProvider,
	tavilyProvider,
];

/** 通过 id 查 provider（渲染层备用） */
export const providerById = (id: string): QuotaProvider | undefined =>
	PROVIDERS.find((p) => p.id === id);
