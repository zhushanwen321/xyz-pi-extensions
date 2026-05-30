/**
 * segment-tracker.ts — getRetentionWindow(usagePercent) TDD tests
 *
 * RED phase: these tests should FAIL because segment-tracker.ts has not yet been modified.
 * The current getRetentionWindow() takes no arguments and uses a fixed RETENTION_CONFIG.
 * Once implementation (GREEN phase) is applied, all tests should pass.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SegmentTracker } from "../segment-tracker.js";
import type { Segment } from "../types.js";

// ── Test helpers ───────────────────────────────────────

/** Create a completed segment with the given index */
function makeCompletedSeg(index: number): Segment {
	return {
		segId: `seg_${index}`,
		turnRange: { start: index * 2, end: index * 2 + 1 },
		userMessage: `User message ${index}`,
		completed: true,
		filePath: `infinite-context/session/seg_${index}.json`,
	};
}

/** Create an active (incomplete) segment */
function makeActiveSeg(index: number): Segment {
	return {
		segId: `seg_${index}`,
		turnRange: { start: index * 2, end: index * 2 },
		userMessage: `Current user message ${index}`,
		completed: false,
		filePath: `infinite-context/session/seg_${index}.json`,
	};
}

// ── getRetentionWindow(usagePercent) ───────────────────

describe("SegmentTracker.getRetentionWindow(usagePercent)", () => {
	let tracker: SegmentTracker;

	beforeEach(() => {
		tracker = new SegmentTracker();
		// No entries to restore — we test in-memory behavior via restoreState
	});

	describe("gradient lookup — 10 completed segments", () => {
		beforeEach(() => {
			// Simulate 10 completed segments (seg_0 .. seg_9)
			const segments: Segment[] = Array.from({ length: 10 }, (_, i) => makeCompletedSeg(i));
			// Use restoreState with empty entries, then manually populate
			tracker.restoreState([]);

			// We need to populate segments directly since restoreState needs entries.
			// Access via a type-assertion on the private field for test setup.
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(tracker as Record<string, unknown>).segments = segments;
		});

		it("usagePercent=30 (< 50%) → retains all 10 completed segments", () => {
			const result = tracker.getRetentionWindow(30);
			expect(result).toHaveLength(10);
			expect(result.map((s) => s.segId)).toEqual(
				Array.from({ length: 10 }, (_, i) => `seg_${i}`),
			);
		});

		it("usagePercent=60 (50-70%) → retains last 8 completed segments", () => {
			const result = tracker.getRetentionWindow(60);
			expect(result).toHaveLength(8);
			expect(result.map((s) => s.segId)).toEqual([
				"seg_2", "seg_3", "seg_4", "seg_5",
				"seg_6", "seg_7", "seg_8", "seg_9",
			]);
		});

		it("usagePercent=75 (70-80%) → retains last 4 completed segments", () => {
			const result = tracker.getRetentionWindow(75);
			expect(result).toHaveLength(4);
			expect(result.map((s) => s.segId)).toEqual([
				"seg_6", "seg_7", "seg_8", "seg_9",
			]);
		});

		it("usagePercent=85 (80-90%) → retains last 2 completed segments", () => {
			const result = tracker.getRetentionWindow(85);
			expect(result).toHaveLength(2);
			expect(result.map((s) => s.segId)).toEqual(["seg_8", "seg_9"]);
		});

		it("usagePercent=95 (> 90%) → retains last 1 completed segment", () => {
			const result = tracker.getRetentionWindow(95);
			expect(result).toHaveLength(1);
			expect(result[0].segId).toBe("seg_9");
		});

		it("usagePercent=50 (exact tier boundary) → retains all (9999 sentinel)", () => {
			const result = tracker.getRetentionWindow(50);
			expect(result).toHaveLength(10);
		});
	});

	describe("boundary: usagePercent=0", () => {
		beforeEach(() => {
			const segments: Segment[] = Array.from({ length: 10 }, (_, i) => makeCompletedSeg(i));
			tracker.restoreState([]);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(tracker as Record<string, unknown>).segments = segments;
		});

		it("usagePercent=0 → retains all completed segments (falls into first tier)", () => {
			const result = tracker.getRetentionWindow(0);
			expect(result).toHaveLength(10);
			expect(result.map((s) => s.segId)).toEqual(
				Array.from({ length: 10 }, (_, i) => `seg_${i}`),
			);
		});
	});

	describe("boundary: usagePercent=100", () => {
		beforeEach(() => {
			const segments: Segment[] = Array.from({ length: 10 }, (_, i) => makeCompletedSeg(i));
			tracker.restoreState([]);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(tracker as Record<string, unknown>).segments = segments;
		});

		it("usagePercent=100 → retains last 1 completed segment", () => {
			const result = tracker.getRetentionWindow(100);
			expect(result).toHaveLength(1);
			expect(result[0].segId).toBe("seg_9");
		});
	});

	describe("fewer completed segments than retainCount", () => {
		beforeEach(() => {
			// Only 3 completed segments, but gradient says retain 8
			const segments: Segment[] = Array.from({ length: 3 }, (_, i) => makeCompletedSeg(i));
			tracker.restoreState([]);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(tracker as Record<string, unknown>).segments = segments;
		});

		it("returns all completed segments when fewer than retainCount", () => {
			const result = tracker.getRetentionWindow(60); // 60% → retain 8, but only 3 exist
			expect(result).toHaveLength(3);
			expect(result.map((s) => s.segId)).toEqual(["seg_0", "seg_1", "seg_2"]);
		});
	});

	describe("active segment is always retained", () => {
		beforeEach(() => {
			// 5 completed + 1 active
			const segments: Segment[] = [
				...Array.from({ length: 5 }, (_, i) => makeCompletedSeg(i)),
				makeActiveSeg(5),
			];
			tracker.restoreState([]);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(tracker as Record<string, unknown>).segments = segments;
		});

		it("active segment is included in retention window at usagePercent=95", () => {
			// At 95%, only 1 completed segment retained + active segment
			const result = tracker.getRetentionWindow(95);
			// The retention window should contain the active segment (seg_5)
			// and the last 1 completed segment (seg_4)
			const segIds = result.map((s) => s.segId);
			expect(segIds).toContain("seg_5"); // active segment
			expect(segIds).toContain("seg_4"); // last completed
			expect(result).toHaveLength(2);
		});

		it("active segment is included in retention window at usagePercent=75", () => {
			// At 75%, last 4 completed segments retained + active segment
			const result = tracker.getRetentionWindow(75);
			const segIds = result.map((s) => s.segId);
			expect(segIds).toContain("seg_5"); // active segment
			expect(segIds).toContain("seg_1");
			expect(segIds).toContain("seg_2");
			expect(segIds).toContain("seg_3");
			expect(segIds).toContain("seg_4");
			expect(result).toHaveLength(5);
		});
	});

	describe("no completed segments", () => {
		it("returns empty when only active segments exist", () => {
			const segments: Segment[] = [makeActiveSeg(0)];
			tracker.restoreState([]);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(tracker as Record<string, unknown>).segments = segments;

			// With no completed segments, the result should be empty
			// (active segment handling is a separate concern)
			const result = tracker.getRetentionWindow(50);
			expect(result).toHaveLength(0);
		});
	});

	describe("exact tier boundaries", () => {
		beforeEach(() => {
			const segments: Segment[] = Array.from({ length: 10 }, (_, i) => makeCompletedSeg(i));
			tracker.restoreState([]);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			(tracker as Record<string, unknown>).segments = segments;
		});

		it("usagePercent=70 → retains last 8 (exactly at tier 1 boundary)", () => {
			const result = tracker.getRetentionWindow(70);
			expect(result).toHaveLength(8);
		});

		it("usagePercent=80 → retains last 4 (exactly at tier 2 boundary)", () => {
			const result = tracker.getRetentionWindow(80);
			expect(result).toHaveLength(4);
		});

		it("usagePercent=90 → retains last 2 (exactly at tier 3 boundary)", () => {
			const result = tracker.getRetentionWindow(90);
			expect(result).toHaveLength(2);
		});
	});
});
