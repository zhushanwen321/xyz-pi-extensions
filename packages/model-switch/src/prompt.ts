/**
 * Model Switch — Prompt 注入格式化
 *
 * 将推荐信息格式化为 ~150-200 tokens 的注入文本。
 * 两种模式：正常推荐 和 粘性覆盖。
 */

import type { ModelPolicy } from "./config";
import type { Recommendation, QuotaSnapshot } from "./advisor";

/**
 * 格式化推荐信息为 system prompt 注入文本。
 *
 * @param rec 推荐结果
 * @param snapshot 套餐用量快照
 * @param config 模型策略配置
 * @param now 当前时间
 * @returns 注入文本（约 150-200 tokens）
 */
export function formatAdvisorPrompt(
	rec: Recommendation,
	snapshot: QuotaSnapshot,
	config: ModelPolicy,
	now: Date,
): string {
	const lines: string[] = [];
	lines.push("[Model Advisor]");
	lines.push(formatStatusLine(config, now));
	lines.push(formatQuotaLine(snapshot));
	lines.push("");

	if (rec.stickyOverride) {
		lines.push(`>>> Budget recommends: ${rec.budgetModel}, BUT staying on ${rec.provider}/${rec.modelId}`);
		lines.push(`Reason: ${rec.reason}`);
		lines.push("Override: use switch_model tool to force switch.");
	} else {
		lines.push(`>>> Recommended: ${rec.provider}/${rec.modelId} (${rec.reason})`);
		lines.push(formatSceneGuide(config, now));
		lines.push("To switch: use switch_model tool");
	}

	return lines.join("\n");
}

// ── 内部格式化 ──────────────────────────────────────────

/**
 * 格式化状态行。
 *
 * 输出示例：
 *   Status: Peak hours (15:23, 3x Z.ai cost until 18:00)
 *   Status: Off-peak hours
 */
function formatStatusLine(config: ModelPolicy, now: Date): string {
	const plan = findPrimaryPlanInfo(config);
	if (!plan?.peak) return "Status: Off-peak hours";

	const h = now.getHours();
	const m = now.getMinutes();
	const isPeak = plan.peak.start <= h && h < plan.peak.end;

	if (!isPeak) return "Status: Off-peak hours";

	const timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
	const endStr = `${String(plan.peak.end).padStart(2, "0")}:00`;
	return `Status: Peak hours (${timeStr}, ${plan.peak.multiplier}x Z.ai cost until ${endStr})`;
}

/**
 * 格式化套餐用量行。
 *
 * 输出示例：
 *   Z.ai: 72% [5h: 1h22m] | opencode-go: rolling 35%, weekly 45%
 */
function formatQuotaLine(snapshot: QuotaSnapshot): string {
	const parts: string[] = [];

	if (snapshot.zai) {
		const resetStr = formatResetSec(snapshot.zai.resetSec);
		parts.push(`Z.ai: ${Math.round(snapshot.zai.pct)}% [5h: ${resetStr}]`);
	}

	if (snapshot.ocg) {
		parts.push(`opencode-go: rolling ${Math.round(snapshot.ocg.rollingPct)}%, weekly ${Math.round(snapshot.ocg.weeklyPct)}%`);
	}

	return parts.join(" | ");
}

/**
 * 格式化场景指引。
 *
 * 输出示例：
 *   Scene guide: coding→glm-5.1(after 18:00)/ds-flash(now) | planning→ds-pro | vision→mimo-v2.5-pro
 */
function formatSceneGuide(config: ModelPolicy, now: Date): string {
	const sceneParts: string[] = [];

	for (const [scene, aliases] of Object.entries(config.scenes)) {
		if (aliases.length === 0) continue;

		if (scene === "coding") {
			// Coding 场景：高峰期显示不同的推荐
			const plan = findPrimaryPlanInfo(config);
			const isPeak = plan?.peak ? plan.peak.start <= now.getHours() && now.getHours() < plan.peak.end : false;

			const models = aliases.map((alias) => {
				const entry = config.models[alias];
				const label = entry ? `${entry.provider}/${entry.modelId}` : alias;
				return isPeak ? `${label}(after ${plan?.peak?.end ?? 18}:00)/${label}(now)` : label;
			});
			sceneParts.push(`${scene}→${models.join("/")}`);
		} else {
			// 其他场景：直接列举模型
			const models = aliases.map((alias) => {
				const entry = config.models[alias];
				return entry ? `${entry.provider}/${entry.modelId}` : alias;
			});
			sceneParts.push(`${scene}→${models.join("/")}`);
		}
	}

	return `Scene guide: ${sceneParts.join(" | ")}`;
}

/**
 * 找到主要套餐的配置信息。
 */
function findPrimaryPlanInfo(config: ModelPolicy): { peak?: { start: number; end: number; multiplier: number } } | undefined {
	const plans = Object.entries(config.plans)
		.filter(([, p]) => p.peak)
		.sort(([, a], [, b]) => a.priority - b.priority);
	if (plans.length === 0) return undefined;
	return plans[0]![1];
}

/**
 * 格式化重置剩余时间。
 *
 * 将秒数转为可读格式（如 "1h22m"）。
 */
function formatResetSec(sec: number): string {
	if (sec <= 0) return "";
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
	if (m > 0) return `${m}m`;
	return "<1m";
}
