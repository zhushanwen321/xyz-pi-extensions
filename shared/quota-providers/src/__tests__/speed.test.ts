/**
 * quota-providers 速度计算测试
 *
 * 测试 avgSpeed 纯函数（无 fs/Pi SDK 依赖）。
 */

import { describe, it, expect } from "vitest";
import { avgSpeed } from "../speed.js";

describe("avgSpeed", () => {
	it("空数组返回 0", () => {
		expect(avgSpeed([])).toBe(0);
	});

	it("单条记录：1000 tokens / 1000ms = 1000 t/s", () => {
		expect(avgSpeed([[1000, 1000]])).toBe(1000);
	});

	it("多条记录加权平均", () => {
		// (1000+3000)/(500+3000) * 1000 = 4000/3500 * 1000 = 1142.857 → round → 1143
		expect(avgSpeed([[1000, 500], [3000, 3000]])).toBe(1143);
	});

	it("duration=0 的记录参与计算", () => {
		// [1000, 0] 的 tokens 被计入但 duration=0 不影响分母
		// totalTokens=1500, totalDuration=1000, 1500/1000*1000=1500
		expect(avgSpeed([[1000, 0], [500, 1000]])).toBe(1500);
	});

	it("旧格式（纯数字）被跳过", () => {
		expect(avgSpeed([1000 as unknown as [number, number]])).toBe(0);
	});

	it("全 duration=0 返回 0", () => {
		expect(avgSpeed([[100, 0], [200, 0]])).toBe(0);
	});

	it("大数精度：1M tokens / 100s = 10000 t/s", () => {
		expect(avgSpeed([[1_000_000, 100_000]])).toBe(10_000);
	});
});
