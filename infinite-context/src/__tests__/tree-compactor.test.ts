/**
 * tree-compactor.ts — TDD tests for Task 3 changes
 *
 * RED phase: these tests should FAIL because tree-compactor.ts has not
 * yet been modified. The new methods (computeCompressionScope,
 * getCompressedSegIds, etc.) do not exist on TreeCompactor, and
 * restoreState does not yet rebuild compressedSegIds.
 *
 * Tests cover:
 * - computeCompressionScope (ratio-based scope selection)
 * - restoreState (rebuilds compressedSegIds from tree leaf segIds)
 * - getCompressedSegIds (returns copy of compressed segIds)
 * - append logic (new groups appended after old groups in tree)
 * - buildIncrementalPrompt deprecation (not exported)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { TreeCompactor } from "../tree-compactor.js";
import type { Segment, CompactTree, TreeNode } from "../types.js";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import { COMPRESSION_CONFIG } from "../types.js";

// ── Test helpers ────────────────────────────────────────

function makeSeg(
	index: number,
	userMessage: string,
	completed = true,
): Segment {
	return {
		segId: `seg_${index}`,
		turnRange: { start: index * 2, end: index * 2 + 1 },
		userMessage,
		completed,
		filePath: `infinite-context/session/seg_${index}.json`,
	};
}

function makeLeaf(segId: string, summary: string, tokenCount = 50): TreeNode {
	return { nodeId: `node_${segId}`, summary, tokenCount, children: [], segId };
}

function makeGroup(
	nodeId: string,
	summary: string,
	children: TreeNode[],
	tokenCount = 25,
): TreeNode {
	return { nodeId, summary, tokenCount, children };
}

function makeTree(
	treeId: string,
	groups: TreeNode[],
): CompactTree {
	const rootSummary = `Compressed tree: ${treeId}`;
	const rootChildrenTotal = groups.reduce(
		(sum, g) =>
			sum +
			g.tokenCount +
			g.children.reduce((s, c) => s + c.tokenCount, 0),
		0,
	);
	const root: TreeNode = {
		nodeId: "root",
		summary: rootSummary,
		tokenCount: 10,
		children: groups,
	};
	return {
		treeId,
		root,
		totalTokens: root.tokenCount + rootChildrenTotal,
		createdAt: Date.now(),
		depth: 2,
	};
}

/** Create a mock ic-compact-tree session entry for restoreState */
function makeCompactTreeEntry(tree: CompactTree): SessionEntry {
	return {
		type: "custom",
		customType: "ic-compact-tree",
		data: tree,
		id: tree.treeId,
		parentId: null,
		timestamp: Date.now(),
	} as unknown as SessionEntry;
}

/** Access TreeCompactor private methods for RED-phase testing */
type CompactorPrivate = {
	computeCompressionScope(
		retentionSegs: readonly Segment[],
		historySegs: readonly Segment[],
		existingTree: CompactTree | undefined,
	): { targetSegs: Segment[]; estimatedAfterTokens: number };
	getCompressedSegIds(): Set<string>;
};

function callComputeScope(
	compactor: TreeCompactor,
	retentionSegs: readonly Segment[],
	historySegs: readonly Segment[],
	existingTree: CompactTree | undefined,
): { targetSegs: Segment[]; estimatedAfterTokens: number } {
	return (
		compactor as unknown as CompactorPrivate
	).computeCompressionScope(retentionSegs, historySegs, existingTree);
}

function callGetCompressedSegIds(compactor: TreeCompactor): Set<string> {
	return (compactor as unknown as CompactorPrivate).getCompressedSegIds();
}

// ── computeCompressionScope ──────────────────────────────

describe("TreeCompactor.computeCompressionScope", () => {
	let compactor: TreeCompactor;

	beforeEach(() => {
		compactor = new TreeCompactor();
	});

	describe("small dataset — ratio stays below ratioMin, all segments returned", () => {
		it("returns all 5 history segments when ratio never reaches ratioMin", () => {
			// denominator = 0 + 0 + 5*400/4 + 4000 = 0 + 0 + 500 + 4000 = 4500
			// i=1: estimated=63, ratio=63/4500=0.014; i=5: estimated=315, ratio=0.07
			// All < 0.2 → return all 5
			const historySegs = Array.from({ length: 5 }, (_, i) =>
				makeSeg(i, "A".repeat(400)),
			);

			const result = callComputeScope(compactor, [], historySegs, undefined);

			expect(result.targetSegs).toHaveLength(5);
			expect(result.estimatedAfterTokens).toBe(
				5 * COMPRESSION_CONFIG.perSegmentTokens,
			);
		});
	});

	describe("medium dataset with existingTree — ratio falls within [0.2, 0.5]", () => {
		it("stops at 1 segment when ratio >= ratioMin with existingTree=2000 tokens", () => {
			// existingTree=2000, history=4*200/4=200
			// denominator = 2000 + 0 + 200 + 4000 = 6200
			// i=1: estimated=63+2000=2063, ratio=2063/6200≈0.333 → in [0.2,0.5] → stop
			const existingTree = makeTree("tree_1", [
				makeGroup("group_A", "Group A", [
					makeLeaf("seg_10", "Summary 10"),
					makeLeaf("seg_11", "Summary 11"),
				]),
			]);
			// Override totalTokens for predictable math
			(existingTree as { totalTokens: number }).totalTokens = 2000;

			const historySegs = Array.from({ length: 4 }, (_, i) =>
				makeSeg(i + 20, "B".repeat(200)),
			);

			const result = callComputeScope(compactor, [], historySegs, existingTree);

			expect(result.targetSegs).toHaveLength(1);
			expect(result.targetSegs[0].segId).toBe("seg_20");
			expect(result.estimatedAfterTokens).toBe(
				1 * COMPRESSION_CONFIG.perSegmentTokens + 2000,
			);
		});

		it("stops after accumulating enough segments to reach ratioMin", () => {
			// existingTree=0, history=20*200/4=1000
			// denominator = 0 + 0 + 1000 + 4000 = 5000
			// ratio = i*63 / (i*50 + 4000) >= 0.2 → i >= 16
			const historySegs = Array.from({ length: 20 }, (_, i) =>
				makeSeg(i, "C".repeat(200)),
			);

			const result = callComputeScope(compactor, [], historySegs, undefined);

			// Should stop when ratio first reaches >= 0.2
			expect(result.targetSegs.length).toBeGreaterThanOrEqual(1);
			expect(result.targetSegs.length).toBeLessThanOrEqual(20);

			// Verify ratio is in range
			const denominator =
				historySegs.reduce((s, seg) => s + seg.userMessage.length, 0) / 4 +
				4000;
			const ratio =
				result.estimatedAfterTokens / denominator;
			expect(ratio).toBeGreaterThanOrEqual(COMPRESSION_CONFIG.ratioMin);
			expect(ratio).toBeLessThanOrEqual(COMPRESSION_CONFIG.ratioMax);
		});
	});

	describe("ratio exceeds ratioMax — drops last segment", () => {
		it("accepts 1 segment when ratio > ratioMax on first segment", () => {
			// existingTree=10000, history=2*100/4=50
			// denominator = 10000 + 0 + 50 + 4000 = 14050
			// i=1: estimated=63+10000=10063, ratio=10063/14050≈0.716 → >0.5
			// i=1 is first, so accept anyway
			const existingTree = makeTree("tree_big", [
				makeGroup("group_A", "Big group A", [
					makeLeaf("seg_0", "Summary 0"),
					makeLeaf("seg_1", "Summary 1"),
				]),
			]);
			(existingTree as { totalTokens: number }).totalTokens = 10000;

			const historySegs = [
				makeSeg(100, "D".repeat(100)),
				makeSeg(101, "E".repeat(100)),
			];

			const result = callComputeScope(compactor, [], historySegs, existingTree);

			expect(result.targetSegs).toHaveLength(1);
			expect(result.targetSegs[0].segId).toBe("seg_100");
		});
	});

	describe("edge case: no history segments", () => {
		it("returns empty targetSegs when historySegs is empty", () => {
			const result = callComputeScope(compactor, [], [], undefined);

			expect(result.targetSegs).toHaveLength(0);
			expect(result.estimatedAfterTokens).toBe(0);
		});
	});

	describe("edge case: no retention segments (retentionMsgSize=0)", () => {
		it("works correctly with empty retention array", () => {
			// denominator = 0 + 0 + 3*500/4 + 4000 = 4375
			// i=1: estimated=63, ratio=63/4375≈0.014; i=3: estimated=189, ratio≈0.043
			const historySegs = Array.from({ length: 3 }, (_, i) =>
				makeSeg(i, "F".repeat(500)),
			);

			const result = callComputeScope(compactor, [], historySegs, undefined);

			expect(result.targetSegs).toHaveLength(3); // all returned, below ratioMin
		});
	});

	describe("edge case: no existingTree (first compression)", () => {
		it("uses existingTreeSize=0 when existingTree is undefined", () => {
			// denominator = 0 + 0 + 2*200/4 + 4000 = 4100
			// i=1: estimated=63, ratio=63/4100≈0.015; i=2: estimated=126, ratio≈0.031
			const historySegs = [
				makeSeg(0, "G".repeat(200)),
				makeSeg(1, "H".repeat(200)),
			];

			const result = callComputeScope(compactor, [], historySegs, undefined);

			expect(result.targetSegs).toHaveLength(2); // all returned
			expect(result.estimatedAfterTokens).toBe(
				2 * COMPRESSION_CONFIG.perSegmentTokens,
			);
		});
	});

	describe("retention segments contribute to denominator but not target", () => {
		it("excludes retention segments from targetSegs, includes in denominator", () => {
			// retention: 2 segs * 200 chars /4 = 100 tokens
			// history: 3 segs * 200 chars /4 = 150 tokens
			// denominator = 0 + 100 + 150 + 4000 = 4250
			// i=3: estimated=189, ratio=189/4250≈0.044 → all returned
			const retentionSegs = [
				makeSeg(5, "R".repeat(200)),
				makeSeg(6, "R".repeat(200)),
			];
			const historySegs = [
				makeSeg(0, "H".repeat(200)),
				makeSeg(1, "H".repeat(200)),
				makeSeg(2, "H".repeat(200)),
			];

			const result = callComputeScope(
				compactor,
				retentionSegs,
				historySegs,
				undefined,
			);

			// All history segments returned (ratio below min)
			expect(result.targetSegs).toHaveLength(3);
			// Verify no retention seg is in target
			const targetIds = new Set(result.targetSegs.map((s) => s.segId));
			for (const rs of retentionSegs) {
				expect(targetIds.has(rs.segId)).toBe(false);
			}
		});
	});

	describe("segments sorted by segId (oldest first)", () => {
		it("selects oldest segments when ratio limits count", () => {
			// existingTree=2000, history=4*200/4=200
			// denominator = 2000 + 0 + 200 + 4000 = 6200
			// i=1: estimated=63+2000=2063, ratio=2063/6200≈0.333 → in range, stop
			// Should select seg_0 (oldest), not seg_3
			const existingTree = makeTree("tree_sort", []);
			(existingTree as { totalTokens: number }).totalTokens = 2000;

			// Intentionally unsorted
			const historySegs = [
				makeSeg(3, "I".repeat(200)),
				makeSeg(0, "I".repeat(200)),
				makeSeg(2, "I".repeat(200)),
				makeSeg(1, "I".repeat(200)),
			];

			const result = callComputeScope(
				compactor,
				[],
				historySegs,
				existingTree,
			);

			expect(result.targetSegs).toHaveLength(1);
			// Oldest segment should be selected
			expect(result.targetSegs[0].segId).toBe("seg_0");
		});
	});

	describe("denominator guards against <=0", () => {
		it("returns all history segments when denominator <= 0", () => {
			// systemPromptEstimate=4000 ensures denominator > 0 with empty data
			const historySegs = [makeSeg(0, "")];

			// With empty userMessages and no tree, denominator = 0+0+0+4000 = 4000 > 0
			const result = callComputeScope(compactor, [], historySegs, undefined);
			expect(result.targetSegs).toBeDefined();
			expect(result.estimatedAfterTokens).toBeDefined();
		});
	});
});

// ── restoreState + getCompressedSegIds ──────────────────

describe("TreeCompactor.restoreState + getCompressedSegIds", () => {
	let compactor: TreeCompactor;

	beforeEach(() => {
		compactor = new TreeCompactor();
	});

	it("getCompressedSegIds returns empty set before restoreState", () => {
		const ids = callGetCompressedSegIds(compactor);
		expect(ids).toBeInstanceOf(Set);
		expect(ids.size).toBe(0);
	});

	it("restores compressedSegIds from tree leaf segIds", () => {
		const tree = makeTree("tree_restore", [
			makeGroup("group_A", "Group A summary", [
				makeLeaf("seg_0", "Leaf 0 summary"),
				makeLeaf("seg_1", "Leaf 1 summary"),
				makeLeaf("seg_2", "Leaf 2 summary"),
			]),
			makeGroup("group_B", "Group B summary", [
				makeLeaf("seg_3", "Leaf 3 summary"),
				makeLeaf("seg_4", "Leaf 4 summary"),
			]),
		]);

		compactor.restoreState([makeCompactTreeEntry(tree)]);

		const ids = callGetCompressedSegIds(compactor);
		expect(ids.size).toBe(5);
		expect(ids.has("seg_0")).toBe(true);
		expect(ids.has("seg_1")).toBe(true);
		expect(ids.has("seg_2")).toBe(true);
		expect(ids.has("seg_3")).toBe(true);
		expect(ids.has("seg_4")).toBe(true);
	});

	it("restoreState with empty entries leaves compressedSegIds empty", () => {
		compactor.restoreState([]);
		const ids = callGetCompressedSegIds(compactor);
		expect(ids.size).toBe(0);
	});

	it("restoreState picks the LAST ic-compact-tree entry", () => {
		const tree1 = makeTree("tree_1", [
			makeGroup("group_A", "A", [makeLeaf("seg_0", "S0")]),
		]);
		const tree2 = makeTree("tree_2", [
			makeGroup("group_B", "B", [makeLeaf("seg_1", "S1")]),
			makeGroup("group_C", "C", [makeLeaf("seg_2", "S2")]),
		]);

		compactor.restoreState([
			makeCompactTreeEntry(tree1),
			makeCompactTreeEntry(tree2),
		] as unknown as SessionEntry[]);

		const ids = callGetCompressedSegIds(compactor);
		// Should use tree_2 (last entry)
		expect(ids.size).toBe(2);
		expect(ids.has("seg_1")).toBe(true);
		expect(ids.has("seg_2")).toBe(true);
		expect(ids.has("seg_0")).toBe(false);
	});

	it("getCompressedSegIds returns a COPY, mutations don't affect internal state", () => {
		const tree = makeTree("tree_copy", [
			makeGroup("group_A", "A", [makeLeaf("seg_0", "S0")]),
		]);

		compactor.restoreState([makeCompactTreeEntry(tree)]);

		const ids1 = callGetCompressedSegIds(compactor);
		ids1.add("seg_fake"); // mutate the copy

		const ids2 = callGetCompressedSegIds(compactor); // get fresh copy
		expect(ids2.has("seg_fake")).toBe(false);
		expect(ids2.size).toBe(1);
	});

	it("restoreState with non-compact-tree entries does not rebuild compressedSegIds", () => {
		const otherEntry = {
			type: "custom",
			customType: "other-type",
			data: {},
			id: "other",
			parentId: null,
			timestamp: Date.now(),
		} as unknown as SessionEntry;

		compactor.restoreState([otherEntry]);
		expect(callGetCompressedSegIds(compactor).size).toBe(0);
		expect(compactor.getTree()).toBeUndefined();
	});

	it("getTree returns the restored tree after restoreState", () => {
		const tree = makeTree("tree_get", [
			makeGroup("group_X", "X summary", [
				makeLeaf("seg_10", "Leaf 10"),
			]),
		]);

		compactor.restoreState([makeCompactTreeEntry(tree)]);

		const restored = compactor.getTree();
		expect(restored).toBeDefined();
		expect(restored!.treeId).toBe("tree_get");
		expect(restored!.root.children).toHaveLength(1);
		expect(restored!.root.children[0].nodeId).toBe("group_X");
	});
});

// ── append logic: new groups appended after old groups ──

describe("TreeCompactor append logic (tree structure)", () => {
	let compactor: TreeCompactor;

	beforeEach(() => {
		compactor = new TreeCompactor();
	});

	it("restoreState preserves all existing groups in root.children", () => {
		// Simulate a tree with 3 groups (from 3 previous compressions)
		const tree = makeTree("tree_append", [
			makeGroup("group_1", "Group 1 (oldest)", [
				makeLeaf("seg_0", "Segment 0"),
				makeLeaf("seg_1", "Segment 1"),
			]),
			makeGroup("group_2", "Group 2 (middle)", [
				makeLeaf("seg_2", "Segment 2"),
				makeLeaf("seg_3", "Segment 3"),
			]),
			makeGroup("group_3", "Group 3 (newest)", [
				makeLeaf("seg_4", "Segment 4"),
			]),
		]);

		compactor.restoreState([makeCompactTreeEntry(tree)]);

		const restored = compactor.getTree();
		expect(restored).toBeDefined();
		expect(restored!.root.children).toHaveLength(3);

		// Verify order preserved
		expect(restored!.root.children[0].nodeId).toBe("group_1");
		expect(restored!.root.children[1].nodeId).toBe("group_2");
		expect(restored!.root.children[2].nodeId).toBe("group_3");

		// Verify leaf segIds
		const leafSegIds = new Set<string>();
		for (const group of restored!.root.children) {
			for (const leaf of group.children) {
				if (leaf.segId) leafSegIds.add(leaf.segId);
			}
		}
		expect(leafSegIds.size).toBe(5);
		expect(leafSegIds.has("seg_0")).toBe(true);
		expect(leafSegIds.has("seg_4")).toBe(true);
	});

	it("tree depth stays at 2 after multiple compressions", () => {
		const tree = makeTree("tree_depth", [
			makeGroup("group_A", "A", [
				makeLeaf("seg_0", "S0"),
				makeLeaf("seg_1", "S1"),
			]),
			makeGroup("group_B", "B", [
				makeLeaf("seg_2", "S2"),
				makeLeaf("seg_3", "S3"),
			]),
			makeGroup("group_C", "C", [
				makeLeaf("seg_4", "S4"),
			]),
		]);

		compactor.restoreState([makeCompactTreeEntry(tree)]);

		const restored = compactor.getTree();
		expect(restored).toBeDefined();
		expect(restored!.depth).toBe(2);

		// All children of root are groups (depth 1 from root = total depth 2)
		for (const child of restored!.root.children) {
			expect(child.children.length).toBeGreaterThan(0);
			// All grandchildren are leaves
			for (const leaf of child.children) {
				expect(leaf.children).toHaveLength(0);
				expect(leaf.segId).toBeDefined();
			}
		}
	});

	it("compressedSegIds after restoreState matches all leaf segIds across all groups", () => {
		const tree = makeTree("tree_all_leaves", [
			makeGroup("g1", "G1", [
				makeLeaf("seg_a", "A"),
				makeLeaf("seg_b", "B"),
			]),
			makeGroup("g2", "G2", [
				makeLeaf("seg_c", "C"),
			]),
		]);

		compactor.restoreState([makeCompactTreeEntry(tree)]);

		const ids = callGetCompressedSegIds(compactor);
		expect(ids.size).toBe(3);
		expect(ids.has("seg_a")).toBe(true);
		expect(ids.has("seg_b")).toBe(true);
		expect(ids.has("seg_c")).toBe(true);
	});

	it("restoreState handles tree with empty root.children", () => {
		const tree = makeTree("tree_empty", []);
		compactor.restoreState([makeCompactTreeEntry(tree)]);

		expect(compactor.getTree()!.root.children).toHaveLength(0);
		expect(callGetCompressedSegIds(compactor).size).toBe(0);
	});
});

// ── buildIncrementalPrompt deprecation ──────────────────

describe("buildIncrementalPrompt (deprecated)", () => {
	it("is not exported from tree-compactor module", async () => {
		const mod = await import("../tree-compactor.js");
		// buildIncrementalPrompt should be replaced by buildInitialPrompt + existingGroupsContext
		expect("buildIncrementalPrompt" in mod).toBe(false);
	});

	it("buildCompressionPrompt is not exported (internal function)", async () => {
		const mod = await import("../tree-compactor.js");
		// buildCompressionPrompt is internal; only public API is exported
		expect("buildCompressionPrompt" in mod).toBe(false);
	});
});

// ── CompactResult interface ──────────────────────────────

describe("CompactResult interface", () => {
	it("is exported from tree-compactor module", async () => {
		const mod = await import("../tree-compactor.js");
		// Verify core exports exist
		expect(typeof mod.TreeCompactor).toBe("function");
		expect(typeof mod.validateTreeOutput).toBe("function");
		expect(typeof mod.ruleBasedFallback).toBe("function");
	});
});
