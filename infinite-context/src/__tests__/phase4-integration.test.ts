/**
 * Phase 4 (Test) — Integration tests for Progressive Tree Compaction
 *
 * Covers test cases from test_cases_template.json that require
 * cross-module verification beyond existing unit tests.
 */

import { describe, it, expect } from "vitest";
import { TreeCompactor, ruleBasedFallback, validateTreeOutput } from "../tree-compactor.js";
import type { Segment, CompactTree, TreeNode } from "../types.js";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";

/** Summaries need to be long enough for validateTreeOutput (leaf >= 120, group >= 80) */
const LONG_LEAF_SUMMARY =
	"This is a long leaf summary that must exceed one hundred twenty characters in total " +
	"so that the validateTreeOutput validation passes. This is padding padding padding padding.";
const LONG_GROUP_SUMMARY =
	"This is a long group summary that must exceed eighty characters so validateTreeOutput passes. Padding.";

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

function makeTree(treeId: string, groups: TreeNode[]): CompactTree {
	const root: TreeNode = {
		nodeId: "root",
		summary: `Compressed tree: ${treeId}`,
		tokenCount: 10,
		children: groups,
	};
	return {
		root,
		depth: 2,
		totalTokens: 100,
		treeId,
		createdAt: Date.now(),
	};
}

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

function isError(r: TreeNode[] | { reason: string }): r is { reason: string } {
	return "reason" in r;
}

// ── TC-3-01: Append after multiple compressions ───────

describe("TC-3-01: Tree append — old groups unchanged", () => {
	it("restoreState picks last tree entry with correct groups", () => {
		const compactor = new TreeCompactor();

		const tree = makeTree("tree_latest", [
			makeGroup("group_C", "Summary C", [
				makeLeaf("seg_3", "Segment 3"),
			]),
			makeGroup("group_D", "Summary D", [
				makeLeaf("seg_4", "Segment 4"),
				makeLeaf("seg_5", "Segment 5"),
			]),
		]);
		compactor.restoreState([makeCompactTreeEntry(tree)]);

		const restored = compactor.getTree()!;
		expect(restored.root.children).toHaveLength(2);
		expect(restored.root.children[0].nodeId).toBe("group_C");
		expect(restored.root.children[1].nodeId).toBe("group_D");
		expect(restored.depth).toBe(2);
	});

	it("restoreState picks last of multiple entries", () => {
		const compactor = new TreeCompactor();

		const oldTree = makeTree("tree_old", [
			makeGroup("group_A", "Old A", [makeLeaf("seg_0", "S0")]),
		]);
		const newTree = makeTree("tree_new", [
			makeGroup("group_B", "New B", [makeLeaf("seg_1", "S1")]),
		]);
		compactor.restoreState([makeCompactTreeEntry(oldTree), makeCompactTreeEntry(newTree)]);

		const restored = compactor.getTree()!;
		expect(restored.root.children).toHaveLength(1);
		expect(restored.root.children[0].nodeId).toBe("group_B");
	});
});

// ── TC-3-02/TC-3-03: validateTreeOutput guards ─────────

describe("TC-3-02: Prompt guards — validateTreeOutput on tree output", () => {
	it("rejects output with missing nodeId", () => {
		const segments = [makeSeg(0, "test")];
		const json = JSON.stringify([
			{
				nodeId: "",
				summary: LONG_GROUP_SUMMARY,
				children: [
					{ nodeId: "leaf_0", summary: LONG_LEAF_SUMMARY, segId: "seg_0", children: [] },
				],
			},
		]);
		const result = validateTreeOutput(json, segments);
		expect(isError(result)).toBe(true);
	});

	it("rejects output with non-array top-level", () => {
		const segments = [makeSeg(0, "test")];
		const result = validateTreeOutput('{"not":"an array"}', segments);
		expect(isError(result)).toBe(true);
	});

	it("rejects output referencing invalid segId", () => {
		const segments = [makeSeg(0, "test")];
		const json = JSON.stringify([
			{
				nodeId: "group_0",
				summary: LONG_GROUP_SUMMARY,
				children: [
					{ nodeId: "leaf_x", summary: LONG_LEAF_SUMMARY, segId: "seg_X", children: [] },
				],
			},
		]);
		const result = validateTreeOutput(json, segments);
		expect(isError(result)).toBe(true);
	});
});

describe("TC-3-03: Initial tree validation", () => {
	it("accepts valid group+leaf tree from JSON", () => {
		const segments = [makeSeg(0, "test"), makeSeg(1, "test 2")];
		const json = JSON.stringify([
			{
				nodeId: "group_0",
				summary: LONG_GROUP_SUMMARY,
				children: [
					{ nodeId: "node_seg_0", summary: LONG_LEAF_SUMMARY, segId: "seg_0", children: [] },
					{ nodeId: "node_seg_1", summary: LONG_LEAF_SUMMARY, segId: "seg_1", children: [] },
				],
			},
		]);
		const result = validateTreeOutput(json, segments);
		expect(isError(result)).toBe(false);
		if (!isError(result)) {
			expect(Array.isArray(result)).toBe(true);
			expect(result.length).toBe(1);
		}
	});
});

// ── TC-6-02: Rule-based fallback summary length ─────

describe("TC-6-02: Rule-based fallback summary length", () => {
	it("produces leaf summaries via fallbackSummary helper", () => {
		const segments = [
			makeSeg(0, "First user message content for segment zero."),
			makeSeg(1, "Second user message content for segment one."),
			makeSeg(2, "Third user message content for segment two."),
		];

		const tree = ruleBasedFallback(segments);
		expect(tree.root.children.length).toBeGreaterThanOrEqual(1);

		for (const child of tree.root.children) {
			if (child.children.length > 0) {
				for (const leaf of child.children) {
					expect(typeof leaf.summary).toBe("string");
					expect(leaf.summary.length).toBeGreaterThan(0);
					expect(leaf.segId).toBeDefined();
				}
			} else {
				// Single segment is a leaf directly under root
				expect(typeof child.summary).toBe("string");
				expect(child.summary.length).toBeGreaterThan(0);
				expect(child.segId).toBeDefined();
			}
		}
	});

	it("handles single segment", () => {
		const segments = [makeSeg(0, "Single segment message")];
		const tree = ruleBasedFallback(segments);
		// Single segment: leaf directly under root
		expect(tree.root.children).toHaveLength(1);
		const leaf = tree.root.children[0];
		expect(leaf.segId).toBe("seg_0");
		expect(typeof leaf.summary).toBe("string");
		expect(leaf.summary.length).toBeGreaterThan(0);
	});

	it("handles empty segments array", () => {
		const tree = ruleBasedFallback([]);
		expect(tree.root.children).toHaveLength(0);
	});
});
