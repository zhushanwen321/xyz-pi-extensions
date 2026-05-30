/**
 * context-handler.ts — TDD tests for Task 4: compressedSegIds filtering
 *
 * RED phase: these tests should FAIL because context-handler.ts has not yet
 * been modified to accept compressedSegIds or filter compressed segment messages.
 *
 * Tests cover:
 * - assembleMessages with compressedSegIds filters out original messages of compressed segments
 * - assembleMessages without compressedSegIds (backward compatible)
 * - compressedSegIds is reflected in AssembleResult
 * - Filtering works in both "context bloated" and "context not bloated" branches
 */

import { describe, it, expect } from "vitest";
import {
	ContextAssembler,
	type MinimalAgentMessage,
	IC_SUMMARY_CUSTOM_TYPE,
} from "../context-handler.js";
import type { Segment, CompactTree, TreeNode } from "../types.js";

// ── Test helpers ────────────────────────────────────────

function makeUserMsg(text: string): MinimalAgentMessage {
	return { role: "user", content: text };
}

function makeAssistantMsg(text: string): MinimalAgentMessage {
	return { role: "assistant", content: text };
}

function makeSeg(
	index: number,
	userMessage = `User message ${index}`,
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

function makeLeaf(
	segId: string,
	summary: string,
	tokenCount = 50,
): TreeNode {
	return { nodeId: `node_${segId}`, summary, tokenCount, children: [], segId };
}

function makeTree(treeId: string, leaves: TreeNode[]): CompactTree {
	const rootTokenCount = leaves.reduce((sum, l) => sum + l.tokenCount, 0);
	return {
		treeId,
		root: {
			nodeId: `root_${treeId}`,
			summary: `Tree: ${treeId}`,
			tokenCount: rootTokenCount,
			children: leaves,
		},
		totalTokens: rootTokenCount,
		createdAt: Date.now(),
		depth: 2,
	};
}

/**
 * Build a conversation that mirrors segments:
 * each segment = 1 user message + 1 assistant reply
 */
function makeConversation(segCount: number): MinimalAgentMessage[] {
	const messages: MinimalAgentMessage[] = [];
	for (let i = 0; i < segCount; i++) {
		messages.push(makeUserMsg(`User message ${i}`));
		messages.push(makeAssistantMsg(`Assistant reply ${i}`));
	}
	return messages;
}

// ── assembleMessages with compressedSegIds ─────────────

describe("ContextAssembler.assembleMessages — compressedSegIds", () => {
	it("filters out original messages of compressed segments (context bloated path)", () => {
		const assembler = new ContextAssembler();

		// 5 segments, compress the oldest 2 (seg_0, seg_1)
		const segments = [
			makeSeg(0),
			makeSeg(1),
			makeSeg(2),
			makeSeg(3),
			makeSeg(4, "Current msg", false),
		];
		const compressedSegIds = new Set(["seg_0", "seg_1"]);

		// 10 messages: 5 user + 5 assistant
		const messages = makeConversation(5);

		// Tree with summaries for seg_0 and seg_1
		const tree = makeTree("tree_1", [
			makeLeaf("seg_0", "Summary of seg 0"),
			makeLeaf("seg_1", "Summary of seg 1"),
		]);

		// Use a very small context window to force the "bloated" branch
		// where truncation + summary injection happens
		const result = assembler.assembleMessages(
			messages,
			tree,
			segments,
			[], // retention window
			compressedSegIds,
			100, // tiny context window → force bloated path
		);

		// The original messages for seg_0 (user0 + assistant0) and
		// seg_1 (user1 + assistant1) should be filtered out.
		// Only user2, assistant2, user3, assistant3, user4, assistant4 remain.
		const resultTexts = result.messages.map((m) =>
			typeof m.content === "string" ? m.content : "",
		);

		// Compressed segment messages should NOT appear in the result
		expect(resultTexts).not.toContain("User message 0");
		expect(resultTexts).not.toContain("Assistant reply 0");
		expect(resultTexts).not.toContain("User message 1");
		expect(resultTexts).not.toContain("Assistant reply 1");

		// Non-compressed segment messages SHOULD appear
		expect(resultTexts).toContain("User message 2");
		expect(resultTexts).toContain("Assistant reply 2");
	});

	it("filters out original messages of compressed segments (context not bloated path)", () => {
		const assembler = new ContextAssembler();

		// 3 segments, compress the oldest 1 (seg_0)
		const segments = [
			makeSeg(0),
			makeSeg(1),
			makeSeg(2, "Current msg", false),
		];
		const compressedSegIds = new Set(["seg_0"]);

		// 6 messages: 3 user + 3 assistant
		const messages = makeConversation(3);

		// Tree with a small summary → context not bloated
		const tree = makeTree("tree_2", [
			makeLeaf("seg_0", "Summary of seg 0"),
		]);

		// Large context window → no truncation, just summary injection
		const result = assembler.assembleMessages(
			messages,
			tree,
			segments,
			[],
			compressedSegIds,
			1_000_000, // huge context window → not bloated
		);

		const resultTexts = result.messages.map((m) =>
			typeof m.content === "string" ? m.content : "",
		);

		// seg_0 messages filtered out
		expect(resultTexts).not.toContain("User message 0");
		expect(resultTexts).not.toContain("Assistant reply 0");

		// seg_1 and seg_2 messages preserved
		expect(resultTexts).toContain("User message 1");
		expect(resultTexts).toContain("Assistant reply 1");
		expect(resultTexts).toContain("User message 2");
		expect(resultTexts).toContain("Assistant reply 2");

		// Summary injected at the beginning
		expect(result.messages.some((m) => m.customType === IC_SUMMARY_CUSTOM_TYPE)).toBe(true);
	});

	it("returns compressedSegIds in AssembleResult", () => {
		const assembler = new ContextAssembler();

		const segments = [makeSeg(0), makeSeg(1)];
		const compressedSegIds = new Set(["seg_0"]);
		const messages = makeConversation(2);
		const tree = makeTree("tree_3", [makeLeaf("seg_0", "Summary 0")]);

		const result = assembler.assembleMessages(
			messages,
			tree,
			segments,
			[],
			compressedSegIds,
			1_000_000,
		);

		// AssembleResult should include compressedSegIds
		expect(result.compressedSegIds).toBeDefined();
		expect(result.compressedSegIds).toEqual(compressedSegIds);
	});
});

// ── Backward compatibility (no compressedSegIds) ───────

describe("ContextAssembler.assembleMessages — backward compat", () => {
	it("works without compressedSegIds parameter (undefined)", () => {
		const assembler = new ContextAssembler();

		const segments = [makeSeg(0), makeSeg(1), makeSeg(2, "Current", false)];
		const messages = makeConversation(3);
		const tree = makeTree("tree_4", [makeLeaf("seg_0", "Summary 0")]);

		// Call WITHOUT compressedSegIds — should behave as before
		const result = assembler.assembleMessages(
			messages,
			tree,
			segments,
			[],
			// compressedSegIds omitted
			1_000_000,
		);

		// All original messages preserved (no filtering)
		const resultTexts = result.messages.map((m) =>
			typeof m.content === "string" ? m.content : "",
		);

		expect(resultTexts).toContain("User message 0");
		expect(resultTexts).toContain("Assistant reply 0");
		expect(resultTexts).toContain("User message 1");
		expect(resultTexts).toContain("Assistant reply 1");
		expect(resultTexts).toContain("User message 2");
		expect(resultTexts).toContain("Assistant reply 2");

		// compressedSegIds should be undefined in result
		expect(result.compressedSegIds).toBeUndefined();
	});

	it("works with empty compressedSegIds set", () => {
		const assembler = new ContextAssembler();

		const segments = [makeSeg(0), makeSeg(1)];
		const messages = makeConversation(2);
		const tree = makeTree("tree_5", [makeLeaf("seg_0", "Summary 0")]);
		const emptySet = new Set<string>();

		const result = assembler.assembleMessages(
			messages,
			tree,
			segments,
			[],
			emptySet,
			1_000_000,
		);

		// No messages filtered
		const resultTexts = result.messages.map((m) =>
			typeof m.content === "string" ? m.content : "",
		);

		expect(resultTexts).toContain("User message 0");
		expect(resultTexts).toContain("Assistant reply 0");
		expect(resultTexts).toContain("User message 1");
		expect(resultTexts).toContain("Assistant reply 1");
	});

	it("no filtering when tree is undefined (no compression happened)", () => {
		const assembler = new ContextAssembler();

		const segments = [makeSeg(0), makeSeg(1)];
		const messages = makeConversation(2);
		const compressedSegIds = new Set(["seg_0"]);

		// No tree → early return path, compressedSegIds should be ignored
		const result = assembler.assembleMessages(
			messages,
			undefined, // no tree
			segments,
			[],
			compressedSegIds,
		);

		// All messages preserved when no tree
		const resultTexts = result.messages.map((m) =>
			typeof m.content === "string" ? m.content : "",
		);

		expect(resultTexts).toContain("User message 0");
		expect(resultTexts).toContain("Assistant reply 0");
	});
});
