/**
 * 速度计算纯函数
 *
 * 从 cache.ts 提取，不依赖 fs 或 Pi SDK。
 */

/** 每条记录存储 [outputTokens, durationMs] */
export type SpeedRecord = [number, number];

const MS_PER_SEC = 1000;
const SPEED_RECORD_FIELDS = 2;

/** 加权平均速度：sum(tokens) / sum(duration) * 1000 */
export function avgSpeed(entries: SpeedRecord[]): number {
	let totalTokens = 0;
	let totalDuration = 0;
	for (const entry of entries) {
		if (!Array.isArray(entry) || entry.length < SPEED_RECORD_FIELDS) continue;
		totalTokens += entry[0];
		totalDuration += entry[1];
	}
	return totalDuration > 0
		? Math.round((totalTokens / totalDuration) * MS_PER_SEC)
		: 0;
}
