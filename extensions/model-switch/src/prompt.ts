/**
 * Model Switch — Prompt 注入格式化
 *
 * 将推荐信息格式化为 ~150-200 tokens 的注入文本。
 */

import type { ModelPolicy, Recommendation, QuotaSnapshot } from "./types";

// ── 时间常量 ────────────────────────────────────────────

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
const PAD_LENGTH = 2;

/**
 * 格式化推荐信息为 system prompt 注入文本。
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

function formatStatusLine(config: ModelPolicy, now: Date): string {
	const plan = findPrimaryPlanPeak(config);
	if (!plan) return "Status: Off-peak hours";

	const h = now.getHours();
	const m = now.getMinutes();
	const isPeak = plan.start <= h && h < plan.end;

	if (!isPeak) return "Status: Off-peak hours";

	const timeStr = `${String(h).padStart(PAD_LENGTH, "0")}:${String(m).padStart(PAD_LENGTH, "0")}`;
	const endStr = `${String(plan.end).padStart(PAD_LENGTH, "0")}:00`;
	return `Status: Peak hours (${timeStr}, ${plan.multiplier}x Z.ai cost until ${endStr})`;
}

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

function formatSceneGuide(config: ModelPolicy, now: Date): string {
	const sceneParts: string[] = [];

	for (const [scene, aliases] of Object.entries(config.scenes)) {
		if (aliases.length === 0) continue;

		if (scene === "coding") {
			const plan = findPrimaryPlanPeak(config);
			const isPeak = plan ? plan.start <= now.getHours() && now.getHours() < plan.end : false;

			const models = aliases.map((alias) => {
				const entry = config.models[alias];
				const label = entry ? `${entry.provider}/${entry.modelId}` : alias;
				return isPeak ? `${label}(after ${plan?.end ?? 18}:00)/${label}(now)` : label;
			});
			sceneParts.push(`${scene}\u2192${models.join("/")}`);
		} else {
			const models = aliases.map((alias) => {
				const entry = config.models[alias];
				return entry ? `${entry.provider}/${entry.modelId}` : alias;
			});
			sceneParts.push(`${scene}\u2192${models.join("/")}`);
		}
	}

	return `Scene guide: ${sceneParts.join(" | ")}`;
}

function findPrimaryPlanPeak(config: ModelPolicy): { start: number; end: number; multiplier: number } | undefined {
	const plans = Object.entries(config.plans)
		.filter(([, p]) => p.peak)
		.sort(([, a], [, b]) => a.priority - b.priority);
	return plans[0]?.[1]?.peak;
}

function formatResetSec(sec: number): string {
	if (sec <= 0) return "";
	const h = Math.floor(sec / SECONDS_PER_HOUR);
	const m = Math.floor((sec % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
	if (h > 0) return `${h}h${m.toString().padStart(PAD_LENGTH, "0")}m`;
	if (m > 0) return `${m}m`;
	return "<1m";
}
