/**
 * Provider 抽象契约
 *
 * 设计要点：
 * - 每个 provider 自带 fetch + normalize，自包含；新增 provider 只需新建文件 + 注册
 * - normalize 返回归一化行（含 label 和三窗口），label 可基于 raw 数据动态生成
 * - fetch 失败 / 无 token 返回 null，框架会保留旧值（Promise.allSettled 模式）
 */

/** 归一化的配额窗口。pct=null 表示无限/未订阅。resetSec=null 表示无限。 */
export interface QuotaWindow {
	pct: number | null;
	resetSec: number | null;
}

export const INFINITE_WIN: QuotaWindow = { pct: null, resetSec: null };

/** 三个窗口的位置：5h、week、month。 */
export type QuotaWins = [QuotaWindow, QuotaWindow, QuotaWindow];

/** 归一化结果：可直接渲染的一行。 */
export interface NormalizedQuotaRow {
	/** 实际显示名（可由 raw 数据动态生成，如 Z.ai-pro） */
	label: string;
	wins: QuotaWins;
}

/**
 * Provider 实现需要遵守的契约。
 *
 * - `id`: 在 CacheData 上的 key，**新增字段后须更新 readCacheSync 的旧值兼容**。
 * - `label`: 默认显示名（fallback）；normalize 返回的对象里若带 label 则优先使用。
 * - `fetch()`: 拉取原始数据。失败/无凭证返回 null。
 * - `normalize(raw)`: 把原始数据归一化为单行。无法解析返回 null（不显示该行）。
 */
export interface QuotaProvider<T = unknown> {
	id: string;
	label: string;
	fetch(): Promise<T | null>;
	normalize(raw: T): NormalizedQuotaRow | null;
}
