/**
 * types.ts — Retention gradient, compression config, IContextUsage
 *
 * RED phase: these tests should FAIL because types.ts has not yet been modified.
 * Once implementation (GREEN phase) is applied, all tests should pass.
 */

import { describe, it, expect } from "vitest";
import {
	RETENTION_GRADIENT,
	COMPRESSION_CONFIG,
} from "../types.js";

import type { IContextUsage } from "../types.js";

// ── RETENTION_GRADIENT ──────────────────────────────────

describe("RETENTION_GRADIENT", () => {
	it("is a readonly array with 5 tiers", () => {
		expect(Array.isArray(RETENTION_GRADIENT)).toBe(true);
		expect(RETENTION_GRADIENT).toHaveLength(5);
	});

	it("tier 0: usageMax=50 → retainCount=9999 (keep all)", () => {
		expect(RETENTION_GRADIENT[0]).toEqual({
			usageMax: 50,
			retainCount: 9999,
		});
	});

	it("tier 1: usageMax=70 → retainCount=8", () => {
		expect(RETENTION_GRADIENT[1]).toEqual({
			usageMax: 70,
			retainCount: 8,
		});
	});

	it("tier 2: usageMax=80 → retainCount=4", () => {
		expect(RETENTION_GRADIENT[2]).toEqual({
			usageMax: 80,
			retainCount: 4,
		});
	});

	it("tier 3: usageMax=90 → retainCount=2", () => {
		expect(RETENTION_GRADIENT[3]).toEqual({
			usageMax: 90,
			retainCount: 2,
		});
	});

	it("tier 4: usageMax=100 → retainCount=1", () => {
		expect(RETENTION_GRADIENT[4]).toEqual({
			usageMax: 100,
			retainCount: 1,
		});
	});

	it("has monotonically increasing usageMax and decreasing retainCount", () => {
		for (let i = 1; i < RETENTION_GRADIENT.length; i++) {
			expect(RETENTION_GRADIENT[i].usageMax).toBeGreaterThan(
				RETENTION_GRADIENT[i - 1].usageMax,
			);
			expect(RETENTION_GRADIENT[i].retainCount).toBeLessThan(
				RETENTION_GRADIENT[i - 1].retainCount,
			);
		}
	});
});

// ── COMPRESSION_CONFIG ──────────────────────────────────

describe("COMPRESSION_CONFIG", () => {
	it("contains ratioMin, ratioMax, and perSegmentTokens", () => {
		expect(COMPRESSION_CONFIG).toHaveProperty("ratioMin");
		expect(COMPRESSION_CONFIG).toHaveProperty("ratioMax");
		expect(COMPRESSION_CONFIG).toHaveProperty("perSegmentTokens");
	});

	it("ratioMin defaults to 0.2", () => {
		expect(COMPRESSION_CONFIG.ratioMin).toBe(0.2);
	});

	it("ratioMax defaults to 0.5", () => {
		expect(COMPRESSION_CONFIG.ratioMax).toBe(0.5);
	});

	it("perSegmentTokens defaults to 63", () => {
		expect(COMPRESSION_CONFIG.perSegmentTokens).toBe(63);
	});

	it("ratioMin < ratioMax", () => {
		expect(COMPRESSION_CONFIG.ratioMin).toBeLessThan(
			COMPRESSION_CONFIG.ratioMax,
		);
	});
});

// ── IContextUsage interface ─────────────────────────────

describe("IContextUsage", () => {
	it("accepts a valid IContextUsage object (compile-time shape check)", () => {
		const usage: IContextUsage = {
			contextWindow: 200_000,
			usedTokens: 150_000,
			percent: 75,
		};

		expect(usage).toEqual({
			contextWindow: 200_000,
			usedTokens: 150_000,
			percent: 75,
		});
	});

	it("accepts zero usage", () => {
		const usage: IContextUsage = {
			contextWindow: 128_000,
			usedTokens: 0,
			percent: 0,
		};

		expect(usage.percent).toBe(0);
	});

	it("percent is derived from usedTokens / contextWindow * 100", () => {
		const usage: IContextUsage = {
			contextWindow: 100,
			usedTokens: 80,
			percent: 80,
		};

		expect(usage.percent).toBeCloseTo(
			(usage.usedTokens / usage.contextWindow) * 100,
		);
	});
});

// ── RETENTION_CONFIG removed ────────────────────────────

describe("RETENTION_CONFIG (removed)", () => {
	it("should NOT be exported from types.ts", async () => {
		// Dynamic import so TS doesn't trip on the nonexistent export at parse time.
		// If RETENTION_CONFIG is still exported, this will resolve; otherwise it throws.
		const mod = await import("../types.js");
		expect("RETENTION_CONFIG" in mod).toBe(false);
	});
});
