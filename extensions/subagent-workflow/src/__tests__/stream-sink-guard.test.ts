/**
 * streamSink ctx.mode guard — TUI 下禁用避免 widget 噪音。
 *
 * 修复（FR-1/FR-2/AC-1/AC-2）：session_start 注入 streamSink 时必须根据主进程
 * mode 决定是否注入：TUI/json/print → undefined；rpc（GUI/xyz-agent）→ 包装
 * ctx.ui.setWidget。源码断言锁定守卫存在（避免后续重构把守卫去掉）。
 *
 * 类似 subagent-tool-prompt.test.ts 的源码级断言策略：读 index.ts 源码验证
 * 关键 pattern 存在，不 import factory 避免 mock 整个 pi API。
 *
 * 注：SubagentService.initSession 的 streamSink 注入契约已在 subagent-service.test.ts
 * 覆盖（streamSink: undefined → getStreamSink() === null）。本测试专注"守卫在
 * 调用方（index.ts）存在"——这是修复的真正目标。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(join(__dirname, "../index.ts"), "utf-8");

/** 定位 initSession 的 streamSink 注入点上下文（向上 400 字符）。
 *  index.ts 里 streamSink: 出现多次（workflow launcher / initSession / etc.），用
 *  "streamSink: ctx.mode === " 作为精确 anchor 锁定 initSession 那一行。 */
function findStreamSinkContext(src: string): string {
	const idx = src.indexOf('streamSink: ctx.mode === "rpc"');
	if (idx === -1) throw new Error("initSession streamSink injection with ctx.mode guard not found");
	return src.slice(Math.max(0, idx - 400), idx + 200);
}

describe("streamSink ctx.mode guard (FR-1/FR-2/AC-1/AC-2)", () => {
	it("initSession streamSink 字段含 ctx.mode === 'rpc' 三元守卫（FR-1/FR-2/AC-1/AC-2）", () => {
		const ctx = findStreamSinkContext(INDEX_SRC);
		// 守卫必须是三元 ?: undefined 形态（TUI 下 streamSink=undefined）
		expect(ctx).toMatch(/ctx\.mode\s*===\s*["']rpc["']\s*\?[\s\S]{0,200}?:\s*undefined/);
	});

	it("守卫表达式作用于 streamSink 字段构造（非其他变量）", () => {
		// findStreamSinkContext 已经用精确 anchor 锁定 initSession 的 streamSink 注入点
		// （排除 workflow launcher 那处的 streamSink 字段）。存在性即通过。
		const ctx = findStreamSinkContext(INDEX_SRC);
		expect(ctx.length).toBeGreaterThan(0);
	});
});