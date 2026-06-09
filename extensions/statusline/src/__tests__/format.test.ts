/**
 * Statusline 渲染逻辑测试
 *
 * 分两部分：
 * 1. 真实数据验证：用实际 provider normalize 输出验证对齐和格式
 * 2. Mock 回归测试：用固定数据防止未来格式变化破坏对齐
 */

import type { NormalizedQuotaRow,QuotaProvider, QuotaWindow } from "@zhushanwen/pi-quota-providers";
import { INFINITE_WIN } from "@zhushanwen/pi-quota-providers";
import { describe, expect,it } from "vitest";

import {
	buildSearchLine,
	buildTokenPlanLines,
	fmtCount,
	fmtDuration,
	fmtResetSec,
	fmtTokens,
	formatCacheRatioPart,
	formatSpeedPart,
	formatWinCol,
	normalizeRows,
	pctColor,
	plainPallet,
	plainThemeFg,
	splitPath,
	tailSessionId,
} from "../format.js";

// ── 辅助：从渲染文本中提取 `·` 的位置 ─────────────────

function dotPositions(line: string): number[] {
	return [...line.matchAll(/·/g)].map((m) => m.index);
}

// ════════════════════════════════════════════════════════
// 1. 基础格式化函数
// ════════════════════════════════════════════════════════

describe("fmtResetSec", () => {
	it("0 或负数返回空串", () => {
		expect(fmtResetSec(0)).toBe("");
		expect(fmtResetSec(-1)).toBe("");
	});

	it("分钟级：90s → 1m", () => {
		expect(fmtResetSec(90)).toBe("1m");
	});

	it("小时级：3661s → 1h1m", () => {
		expect(fmtResetSec(3661)).toBe("1h1m");
	});

	it("天级：90061s → 1d1h", () => {
		expect(fmtResetSec(90061)).toBe("1d1h");
	});
});

describe("fmtDuration", () => {
	it("秒级", () => expect(fmtDuration(5000)).toBe("5s"));
	it("分钟级", () => expect(fmtDuration(65000)).toBe("1m05s"));
	it("小时级", () => expect(fmtDuration(3660000)).toBe("1h01m"));
});

describe("fmtTokens", () => {
	it("< 1K", () => expect(fmtTokens(999)).toBe("999"));
	it("1K+", () => expect(fmtTokens(1500)).toBe("1.5K"));
	it("1M+", () => expect(fmtTokens(1_500_000)).toBe("1.5M"));
});

describe("fmtCount", () => {
	it("< 1K", () => expect(fmtCount(500)).toBe("500"));
	it("1K+", () => expect(fmtCount(1500)).toBe("1.5k"));
});

// ════════════════════════════════════════════════════════
// 1b. pctColor — 颜色边界值
// ════════════════════════════════════════════════════════

describe("pctColor", () => {
	it("< 40% → success", () => expect(pctColor(0)).toBe("success"));
	it("39% → success", () => expect(pctColor(39)).toBe("success"));
	it("40% → accent", () => expect(pctColor(40)).toBe("accent"));
	it("59% → accent", () => expect(pctColor(59)).toBe("accent"));
	it("60% → warning", () => expect(pctColor(60)).toBe("warning"));
	it("79% → warning", () => expect(pctColor(79)).toBe("warning"));
	it("80% → error", () => expect(pctColor(80)).toBe("error"));
	it("100% → error", () => expect(pctColor(100)).toBe("error"));
});

// ════════════════════════════════════════════════════════
// 1c. 路径工具
// ════════════════════════════════════════════════════════

describe("splitPath", () => {
	it("标准绝对路径", () => {
		expect(splitPath("/Users/foo/project")).toEqual(["Users", "foo", "project"]);
	});

	it("相对路径", () => {
		expect(splitPath("foo/bar")).toEqual(["foo", "bar"]);
	});

	it("空串", () => {
		expect(splitPath("")).toEqual([]);
	});

	it("尾部分隔符", () => {
		expect(splitPath("/foo/bar/")).toEqual(["foo", "bar"]);
	});
});

describe("tailSessionId", () => {
	it("正常路径截取末尾 12 字符", () => {
		// abc123def456.json → pop → abc123def456.json → slice(-12) → 3def456.json
		expect(tailSessionId("/path/to/abc123def456.json", 12)).toBe("3def456.json");
	});

	it("undefined 返回空串", () => {
		expect(tailSessionId(undefined, 12)).toBe("");
	});

	it("空串返回空串", () => {
		expect(tailSessionId("", 12)).toBe("");
	});

	it("路径短于 n 字符时返回全名", () => {
		expect(tailSessionId("file.json", 12)).toBe("file.json");
	});
});

// ════════════════════════════════════════════════════════
// 2. formatWinCol — 列对齐核心
// ════════════════════════════════════════════════════════

describe("formatWinCol", () => {
	it("有限百分比 + 有 reset", () => {
		const result = formatWinCol("5h", { pct: 7, resetSec: 120 }, plainPallet, plainThemeFg);
		expect(result).toBe("5h    7%       2m");
	});

	it("有限百分比 + 无 reset", () => {
		const result = formatWinCol("wk", { pct: 42, resetSec: null }, plainPallet, plainThemeFg);
		// reset 列补 RESET_COL_W 空格
		expect(result).toBe("wk   42%         ");
	});

	it("无限（pct=null）", () => {
		const result = formatWinCol("mh", INFINITE_WIN, plainPallet, plainThemeFg);
		// ∞ padStart(4) 右对齐 + "  " + "--" padStart(7)
		expect(result).toBe("mh     ∞       --");
	});

	it("100% 满格", () => {
		const result = formatWinCol("5h", { pct: 100, resetSec: 1800 }, plainPallet, plainThemeFg);
		expect(result).toBe("5h  100%      30m");
	});

	it("0%", () => {
		const result = formatWinCol("5h", { pct: 0, resetSec: 5400 }, plainPallet, plainThemeFg);
		expect(result).toBe("5h    0%    1h30m");
	});

	it("∞ 列和有限列总字符宽度一致", () => {
		const infinite = formatWinCol("5h", INFINITE_WIN, plainPallet, plainThemeFg);
		const finite = formatWinCol("5h", { pct: 7, resetSec: 120 }, plainPallet, plainThemeFg);
		expect(infinite.length).toBe(finite.length);
	});

	it("resetSec=0 与 resetSec=null 同宽", () => {
		const zero = formatWinCol("5h", { pct: 50, resetSec: 0 }, plainPallet, plainThemeFg);
		const nul = formatWinCol("5h", { pct: 50, resetSec: null }, plainPallet, plainThemeFg);
		expect(zero.length).toBe(nul.length);
		expect(zero).toBe(nul); // 都是空格填充
	});

	it("浮点 pct 四舍五入", () => {
		const down = formatWinCol("5h", { pct: 7.4, resetSec: 0 }, plainPallet, plainThemeFg);
		const up = formatWinCol("5h", { pct: 7.5, resetSec: 0 }, plainPallet, plainThemeFg);
		expect(down).toContain("  7%");
		expect(up).toContain("  8%");
	});
});

// ════════════════════════════════════════════════════════
// 2b. formatWinCol 边界场景补充
// ════════════════════════════════════════════════════════

describe("formatWinCol 边界", () => {
	it("resetSec=0 与 resetSec=null 完全相同（都填空格）", () => {
		const zero = formatWinCol("5h", { pct: 50, resetSec: 0 }, plainPallet, plainThemeFg);
		const nul = formatWinCol("5h", { pct: 50, resetSec: null }, plainPallet, plainThemeFg);
		expect(zero).toBe(nul);
	});

	it("浮点 pct 四舍五入", () => {
		const down = formatWinCol("5h", { pct: 7.4, resetSec: 0 }, plainPallet, plainThemeFg);
		const up = formatWinCol("5h", { pct: 7.5, resetSec: 0 }, plainPallet, plainThemeFg);
		expect(down).toContain("  7%");
		expect(up).toContain("  8%");
	});

	it("负数 pct 原样显示", () => {
		const result = formatWinCol("5h", { pct: -1, resetSec: 0 }, plainPallet, plainThemeFg);
		expect(result).toContain("-1%");
	});
});

// ════════════════════════════════════════════════════════
// 3b. buildTokenPlanLines 空数据
// ════════════════════════════════════════════════════════

describe("buildTokenPlanLines 空数据", () => {
	it("空 cache 返回空数组", () => {
		const providers: QuotaProvider[] = [{
			id: "test", label: "test", category: "token-plan",
			fetch: async () => null, normalize: () => ({ label: "test", wins: [INFINITE_WIN, INFINITE_WIN, INFINITE_WIN] }),
		}];
		expect(buildTokenPlanLines({}, providers, plainPallet, plainThemeFg)).toEqual([]);
	});

	it("空 providers 返回空数组", () => {
		expect(buildTokenPlanLines({ test: {} }, [], plainPallet, plainThemeFg)).toEqual([]);
	});

	it("search-tool 类型的 provider 不出现", () => {
		const providers: QuotaProvider[] = [{
			id: "tavily", label: "tavily", category: "search-tool",
			fetch: async () => null, normalize: () => null,
		}];
		expect(buildTokenPlanLines({ tavily: {} }, providers, plainPallet, plainThemeFg)).toEqual([]);
	});

	it("单行全 ∞ 对齐不变", () => {
		const providers: QuotaProvider[] = [{
			id: "test", label: "test-plan", category: "token-plan",
			fetch: async () => null, normalize: () => ({ label: "t", wins: [INFINITE_WIN, INFINITE_WIN, INFINITE_WIN] }),
		}];
		const lines = buildTokenPlanLines({ test: {} }, providers, plainPallet, plainThemeFg);
		expect(lines).toHaveLength(1);
		const dots = dotPositions(lines[0]!);
		expect(dots).toHaveLength(2);
		expect(dots[0]).toBe(dots[1]! - 20); // 每个 cell 格式一致
	});

	it("超长 label 会撑宽但同长 label 间对齐", () => {
		const providers: QuotaProvider[] = [
			{ id: "a", label: "short", category: "token-plan", fetch: async () => null,
				normalize: () => ({ label: "s", wins: [{ pct: 10, resetSec: 100 }, { pct: 20, resetSec: 200 }, { pct: 30, resetSec: 300 }] }) },
			{ id: "b", label: "another-one", category: "token-plan", fetch: async () => null,
				normalize: () => ({ label: "v", wins: [{ pct: 50, resetSec: 0 }, INFINITE_WIN, INFINITE_WIN] }) },
		];
		const lines = buildTokenPlanLines({ a: {}, b: {} }, providers, plainPallet, plainThemeFg);
		expect(lines).toHaveLength(2);
		// 两个 label 都 <= 19，padEnd(19) 保证等宽
		expect(lines[0]!.length).toBe(lines[1]!.length);
	});
});

// ════════════════════════════════════════════════════════
// 3. buildTokenPlanLines — 整行渲染和列对齐
// ════════════════════════════════════════════════════════

describe("buildTokenPlanLines — 真实数据对齐验证", () => {
	/** 从截图推断的真实 provider normalize 输出 */
	const realProviders: QuotaProvider[] = [
		{
			id: "zhipu",
			label: "zhipu-coding-plan",
			category: "token-plan",
			fetch: async () => null,
			normalize(): NormalizedQuotaRow {
				return {
					label: "Z.ai-pro",
					wins: [{ pct: 4, resetSec: 15660 }, INFINITE_WIN, INFINITE_WIN],
				};
			},
		},
		{
			id: "opencode-go",
			label: "opencode-go",
			category: "token-plan",
			fetch: async () => null,
			normalize(): NormalizedQuotaRow {
				return {
					label: "opencode-go",
					wins: [
						{ pct: 7, resetSec: 120 },
						{ pct: 42, resetSec: 396000 },
						{ pct: 71, resetSec: 1872600 },
					],
				};
			},
		},
		{
			id: "kimi-coding",
			label: "kimi-coding-plan",
			category: "token-plan",
			fetch: async () => null,
			normalize(): NormalizedQuotaRow {
				return {
					label: "kimi-coding",
					wins: [
						{ pct: 0, resetSec: 2280 },
						{ pct: 70, resetSec: 52680 },
						INFINITE_WIN,
					],
				};
			},
		},
		{
			id: "minimax",
			label: "minimax-token-plan",
			category: "token-plan",
			fetch: async () => null,
			normalize(): NormalizedQuotaRow {
				return {
					label: "minimax-token",
					wins: [
						{ pct: 98, resetSec: 2220 },
						{ pct: 10, resetSec: 361440 },
						INFINITE_WIN,
					],
				};
			},
		},
	];

	// 用假 cache 数据（只要 key 存在就行，normalize 不读 raw）
	const cache: Record<string, unknown> = {
		zhipu: { dummy: true },
		"opencode-go": { dummy: true },
		"kimi-coding": { dummy: true },
		minimax: { dummy: true },
	};

	it("所有行使用 providers.json 的 label（非 normalize 返回的 label）", () => {
		const lines = buildTokenPlanLines(cache, realProviders, plainPallet, plainThemeFg);
		expect(lines[0]).toMatch(/^zhipu-coding-plan\s/);
		expect(lines[1]).toMatch(/^opencode-go\s/);
		expect(lines[2]).toMatch(/^kimi-coding-plan\s/);
		expect(lines[3]).toMatch(/^minimax-token-plan\s/);
	});

	it("所有行的 `·` 分隔符位置一致", () => {
		const lines = buildTokenPlanLines(cache, realProviders, plainPallet, plainThemeFg);
		const positions = lines.map(dotPositions);
		// 所有行的 · 位置应该相同
		for (let i = 1; i < positions.length; i++) {
			expect(positions[i], `Row ${i} dot positions mismatch`).toEqual(positions[0]);
		}
	});

	it("所有行总长度一致（ASCII plain 模式下）", () => {
		const lines = buildTokenPlanLines(cache, realProviders, plainPallet, plainThemeFg);
		const lengths = lines.map((l) => l.length);
		for (let i = 1; i < lengths.length; i++) {
			expect(lengths[i], `Row ${i} length ${lengths[i]} !== Row 0 length ${lengths[0]}`).toBe(lengths[0]);
		}
	});

	it("输出快照", () => {
		const lines = buildTokenPlanLines(cache, realProviders, plainPallet, plainThemeFg);
		for (const line of lines) {
			// 确保无 ANSI 转义
			expect(line).not.toMatch(/\x1b\[/);
		}
		// 肉眼可检查的快照
		expect(lines).toMatchInlineSnapshot(`
			[
			  "zhipu-coding-plan  5h    4%    4h21m · wk     ∞       -- · mh     ∞       --",
			  "opencode-go        5h    7%       2m · wk   42%    4d14h · mh   71%   21d16h",
			  "kimi-coding-plan   5h    0%      38m · wk   70%   14h38m · mh     ∞       --",
			  "minimax-token-plan 5h   98%      37m · wk   10%     4d4h · mh     ∞       --",
			]
		`);
	});
});

// ════════════════════════════════════════════════════════
// 4. buildSearchLine — Tavily 显示
// ════════════════════════════════════════════════════════

describe("buildSearchLine", () => {
	const searchProviders: QuotaProvider[] = [
		{
			id: "tavily",
			label: "tavily",
			category: "search-tool",
			fetch: async () => null,
			normalize: () => null,
		},
	];

	it("有 planUsage/planLimit 时优先使用（API 调用次数）", () => {
		const cache = {
			tavily: { planUsage: 892, planLimit: 5000, available: 4, total: 5 },
		};
		const result = buildSearchLine(cache, searchProviders, plainPallet, plainThemeFg);
		expect(result).toContain("892");
		expect(result).toContain("5000");
		expect(result).toContain("18%");
		expect(result).not.toContain("4/5");
	});

	it("无 planUsage/planLimit 时 fallback 到 available/total（key 数量）", () => {
		const cache = {
			tavily: { available: 4, total: 5 },
		};
		const result = buildSearchLine(cache, searchProviders, plainPallet, plainThemeFg);
		expect(result).toContain("4/5");
		expect(result).toContain("80%");
	});

	it("total <= 0 时不显示", () => {
		const cache = {
			tavily: { planUsage: 0, planLimit: 0, available: 4, total: 0 },
		};
		const result = buildSearchLine(cache, searchProviders, plainPallet, plainThemeFg);
		expect(result).toBe("");
	});

	it("无数据时不显示", () => {
		const cache = {};
		const result = buildSearchLine(cache, searchProviders, plainPallet, plainThemeFg);
		expect(result).toBe("");
	});

	it("百分比计算精度（used=1, total=3 → 33%）", () => {
		const cache = { tavily: { planUsage: 1, planLimit: 3 } };
		const result = buildSearchLine(cache, searchProviders, plainPallet, plainThemeFg);
		expect(result).toContain("33%");
	});

	it("多 search-tool 用 | 分隔", () => {
		const providers: QuotaProvider[] = [
			{ id: "tavily", label: "tavily", category: "search-tool", fetch: async () => null, normalize: () => null },
			{ id: "other", label: "other", category: "search-tool", fetch: async () => null, normalize: () => null },
		];
		const cache = {
				tavily: { planUsage: 100, planLimit: 1000 },
				other: { planUsage: 50, planLimit: 500 },
			};
		const result = buildSearchLine(cache, providers, plainPallet, plainThemeFg);
		expect(result).toContain(" | ");
		expect(result).toContain("tavily");
		expect(result).toContain("other");
	});

	it("used=0 时仍显示", () => {
		const cache = { tavily: { planUsage: 0, planLimit: 5000 } };
		const result = buildSearchLine(cache, searchProviders, plainPallet, plainThemeFg);
		expect(result).toContain("0/5000");
		expect(result).toContain("0%");
	});
});

// ════════════════════════════════════════════════════════
// 5. normalizeRows — label 优先级
// ════════════════════════════════════════════════════════

describe("normalizeRows", () => {
	it("优先使用 provider.label（来自 providers.json）", () => {
		const providers: QuotaProvider[] = [{
			id: "test",
			label: "configured-label",
			category: "token-plan",
			fetch: async () => null,
			normalize: () => ({ label: "dynamic-label", wins: [INFINITE_WIN, INFINITE_WIN, INFINITE_WIN] }),
		}];
		const rows = normalizeRows({ test: {} }, providers);
		expect(rows[0]?.name).toBe("configured-label");
	});

	it("provider.label 缺失时 fallback 到 normalize 返回的 label", () => {
		const providers: QuotaProvider[] = [{
			id: "test",
			label: "",
			category: "token-plan",
			fetch: async () => null,
			normalize: () => ({ label: "dynamic-label", wins: [INFINITE_WIN, INFINITE_WIN, INFINITE_WIN] }),
		}];
		const rows = normalizeRows({ test: {} }, providers);
		expect(rows[0]?.name).toBe("dynamic-label");
	});

	it("normalize 返回 null 时跳过该 provider", () => {
		const providers: QuotaProvider[] = [{
			id: "test",
			label: "test",
			category: "token-plan",
			fetch: async () => null,
			normalize: () => null,
		}];
		const rows = normalizeRows({ test: {} }, providers);
		expect(rows).toHaveLength(0);
	});

	it("normalize 抛异常时不影响其他 provider", () => {
		const providers: QuotaProvider[] = [
			{
				id: "bad",
				label: "bad",
				category: "token-plan",
				fetch: async () => null,
				normalize: () => { throw new Error("boom"); },
			},
			{
				id: "good",
				label: "good",
				category: "token-plan",
				fetch: async () => null,
				normalize: () => ({ label: "good", wins: [INFINITE_WIN, INFINITE_WIN, INFINITE_WIN] }),
			},
		];
		const rows = normalizeRows({ bad: {}, good: {} }, providers);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("good");
	});

	it("search-tool 类型的 provider 被过滤", () => {
		const providers: QuotaProvider[] = [{
			id: "tavily", label: "tavily", category: "search-tool",
			fetch: async () => null,
			normalize: () => ({ label: "tavily", wins: [INFINITE_WIN, INFINITE_WIN, INFINITE_WIN] }),
		}];
		const rows = normalizeRows({ tavily: {} }, providers);
		expect(rows).toHaveLength(0);
	});

	it("cache 中无对应 key 时跳过", () => {
		const providers: QuotaProvider[] = [{
			id: "test", label: "test", category: "token-plan",
			fetch: async () => null,
			normalize: () => ({ label: "test", wins: [INFINITE_WIN, INFINITE_WIN, INFINITE_WIN] }),
		}];
		const rows = normalizeRows({ other: {} }, providers);
		expect(rows).toHaveLength(0);
	});
});

// ════════════════════════════════════════════════════════
// 6. Mock 数据回归测试 — 边界场景
// ════════════════════════════════════════════════════════

describe("回归：边界百分比和 reset 时间对齐", () => {
	const p = plainPallet;
	const fg = plainThemeFg;

	it("pct=0% 和 pct=100% 与 ∞ 对齐", () => {
		const zero = formatWinCol("5h", { pct: 0, resetSec: 0 }, p, fg);
		const full = formatWinCol("5h", { pct: 100, resetSec: 0 }, p, fg);
		const inf = formatWinCol("5h", INFINITE_WIN, p, fg);
		expect(zero.length).toBe(full.length);
		expect(zero.length).toBe(inf.length);
	});

	it("resetSec=null 与有 resetSec 对齐", () => {
		const noReset = formatWinCol("wk", { pct: 50, resetSec: null }, p, fg);
		const hasReset = formatWinCol("wk", { pct: 50, resetSec: 3600 }, p, fg);
		expect(noReset.length).toBe(hasReset.length);
	});

	it("多行组合对齐：全 ∞ / 全有限 / 混合", () => {
		const scenarios: Array<{ pct: number | null; resetSec: number | null }> = [
			{ pct: null, resetSec: null },
			{ pct: 0, resetSec: 30 },
			{ pct: 50, resetSec: 3600 },
			{ pct: 99, resetSec: 86400 },
			{ pct: 100, resetSec: null },
		];
		const results = scenarios.map((w) =>
			formatWinCol("5h", w as QuotaWindow, p, fg),
		);
		const lengths = results.map((r) => r.length);
		for (let i = 1; i < lengths.length; i++) {
			expect(lengths[i], `scenario ${i} length mismatch`).toBe(lengths[0]);
		}
	});
});

// ════════════════════════════════════════════════════════
// 7. formatSpeedPart — buildLine2 速度部分
// ════════════════════════════════════════════════════════

describe("formatSpeedPart", () => {
	it("current + day 都有", () => {
		const result = formatSpeedPart({ current: 127, day: 85 }, plainPallet);
		expect(result).toBe("│ speed 127t/s · day 85t/s");
	});

	it("只有 current", () => {
		const result = formatSpeedPart({ current: 50, day: 0 }, plainPallet);
		expect(result).toBe("│ speed 50t/s");
	});

	it("只有 day", () => {
		const result = formatSpeedPart({ current: 0, day: 30 }, plainPallet);
		expect(result).toBe("│ speed day 30t/s");
	});

	it("都为 0 时返回空串", () => {
		expect(formatSpeedPart({ current: 0, day: 0 }, plainPallet)).toBe("");
	});

	it("负数不显示", () => {
		expect(formatSpeedPart({ current: -1, day: -1 }, plainPallet)).toBe("");
	});
});

// 8. formatCacheRatioPart — buildLine2 缓存命中率部分
// ════════════════════════════════════════════════════════

describe("formatCacheRatioPart", () => {
	it("current + day 都有", () => {
		const result = formatCacheRatioPart({ current: 85, day: 72 }, plainPallet);
		expect(result).toBe("│ cache 85% · day 72%");
	});

	it("只有 current", () => {
		const result = formatCacheRatioPart({ current: 50, day: null }, plainPallet);
		expect(result).toBe("│ cache 50%");
	});

	it("只有 day", () => {
		const result = formatCacheRatioPart({ current: null, day: 30 }, plainPallet);
		expect(result).toBe("│ cache day 30%");
	});

	it("都为 null 时返回空串", () => {
		expect(formatCacheRatioPart({ current: null, day: null }, plainPallet)).toBe("");
	});
});
