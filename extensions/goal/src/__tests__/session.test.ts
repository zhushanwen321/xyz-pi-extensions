/**
 * session.ts 测试 — reconstructGoalState + isStaleContextError
 *
 * 覆盖：
 * - MF-7: reconstructGoalState 3 条 FR（G-006 entry GC / G-015 强制激活 / G-024 throw→null）
 * - MF-8: isStaleContextError 5 pattern 匹配（G-010）
 *
 * 用 fake SessionPort（内存 entries 数组）。
 */
import { describe, expect, it } from "vitest";

import { createGoalState } from "../engine/goal";
import type { GoalRuntimeState } from "../engine/types";
import {
	ENTRY_TYPE,
	HISTORY_ENTRY_TYPE,
	makeHistoryEntry,
	serializeState,
} from "../persistence";
import type { SessionEntryLike, SessionPort } from "../ports";
import {
	createGoalSession,
	isStaleContextError,
	reconstructGoalState,
	STALE_CONTEXT_PATTERNS,
} from "../session";

// ── Fake SessionPort ─────────────────────────────────

function makeFakeSessionPort(entries: SessionEntryLike[]): SessionPort {
	const port: SessionPort = {
		getEntries: () => entries,
		spliceEntry: (index, count) => {
			entries.splice(index, count);
		},
		getContextUsage: () => null,
		signal: undefined,
	};
	return port;
}

function makeGoalStateEntry(state: GoalRuntimeState): SessionEntryLike {
	return { type: "custom", customType: ENTRY_TYPE, data: serializeState(state) };
}

function makeHistoryEntryWrapper(entry: unknown): SessionEntryLike {
	return { type: "custom", customType: HISTORY_ENTRY_TYPE, data: entry };
}

// ── isStaleContextError（MF-8, FR-8.2 G-010）──────────

describe("isStaleContextError (FR-8.2 G-010)", () => {
	it("5 个 STALE_CONTEXT_PATTERNS 各匹配", () => {
		for (const pattern of STALE_CONTEXT_PATTERNS) {
			const err = new Error(`something ${pattern} happened`);
			expect(isStaleContextError(err)).toBe(true);
		}
	});

	it("大小写混合匹配", () => {
		expect(isStaleContextError(new Error("Context CANCELED"))).toBe(true);
		expect(isStaleContextError(new Error("ABORTED by user"))).toBe(true);
	});

	it("非 stale 错误 → false", () => {
		expect(isStaleContextError(new Error("network timeout"))).toBe(false);
		expect(isStaleContextError(new Error("permission denied"))).toBe(false);
	});

	it("字符串输入（非 Error）", () => {
		expect(isStaleContextError("the context was aborted")).toBe(true);
		expect(isStaleContextError("random error string")).toBe(false);
	});

	it("null/undefined 输入 → false（不抛错）", () => {
		expect(isStaleContextError(null)).toBe(false);
		expect(isStaleContextError(undefined)).toBe(false);
	});
});

// ── reconstructGoalState（MF-7）──────────────────────

describe("reconstructGoalState", () => {
	it("无 goal-state entry → state=null", () => {
		const session = createGoalSession();
		const port = makeFakeSessionPort([]);
		reconstructGoalState(session, port);
		expect(session.state).toBeNull();
	});

	it("有 goal-state entry → 恢复 state", () => {
		const session = createGoalSession();
		const state = createGoalState("my objective");
		const port = makeFakeSessionPort([makeGoalStateEntry(state)]);
		reconstructGoalState(session, port);
		expect(session.state).not.toBeNull();
		expect(session.state!.objective).toBe("my objective");
	});

	it("G-006: 多个 goal-state entry → 只保留最新 1 条（splice 其余）", () => {
		const session = createGoalSession();
		const oldState = createGoalState("old");
		const newState = createGoalState("new");
		const entries: SessionEntryLike[] = [
			makeGoalStateEntry(oldState),
			makeGoalStateEntry(newState), // 最新（在后面）
		];
		const port = makeFakeSessionPort(entries);
		reconstructGoalState(session, port);
		// 恢复的是最新的
		expect(session.state!.objective).toBe("new");
		// 旧 entry 被 splice（只剩 1 个 goal-state entry）
		const remaining = entries.filter((e) => e.customType === ENTRY_TYPE);
		expect(remaining).toHaveLength(1);
	});

	it("G-006: goal-history entry 保留最近 20 条（超出 splice）", () => {
		const session = createGoalSession();
		const state = createGoalState("active goal");
		// 插入 25 个 history entry + 1 个 goal-state
		const entries: SessionEntryLike[] = [];
		for (let i = 0; i < 25; i++) {
			entries.push(makeHistoryEntryWrapper({ goalId: `g-${i}`, timestamp: i }));
		}
		entries.push(makeGoalStateEntry(state));
		const port = makeFakeSessionPort(entries);
		reconstructGoalState(session, port);
		// history 应只剩 20 条
		const historyRemaining = entries.filter((e) => e.customType === HISTORY_ENTRY_TYPE);
		expect(historyRemaining).toHaveLength(20);
		// 保留的是最新的 20 条（timestamp 5-24）
		const timestamps = historyRemaining.map((e) => (e.data as { timestamp: number }).timestamp);
		expect(Math.min(...timestamps)).toBe(5);
	});

	it("ADR-002 G-015: blocked 非终态 → 强制 active + reset timeStartedAt", () => {
		const session = createGoalSession();
		const state = createGoalState("blocked goal");
		state.status = "blocked";
		state.timeStartedAt = 1000; // 旧值
		const port = makeFakeSessionPort([makeGoalStateEntry(state)]);
		const before = Date.now();
		reconstructGoalState(session, port);
		const after = Date.now();
		expect(session.state!.status).toBe("active");
		expect(session.state!.timeStartedAt).toBeGreaterThanOrEqual(before);
		expect(session.state!.timeStartedAt).toBeLessThanOrEqual(after);
	});

	// ADR-002：paused 状态已删除，旧 paused entry 重建时强制 active（向前兼容）

	it("G-015: 终态保持终态（不强制激活）", () => {
		const session = createGoalSession();
		const state = createGoalState("completed goal");
		state.status = "complete";
		const port = makeFakeSessionPort([makeGoalStateEntry(state)]);
		reconstructGoalState(session, port);
		expect(session.state!.status).toBe("complete");
	});

	it("G-024: deserialize throw（损坏 data）→ state=null", () => {
		const session = createGoalSession();
		// 缺少必填字段 → deserializeState throw
		const brokenEntry: SessionEntryLike = {
			type: "custom",
			customType: ENTRY_TYPE,
			data: { goalId: "x" }, // 缺大量必填字段
		};
		const port = makeFakeSessionPort([brokenEntry]);
		reconstructGoalState(session, port);
		expect(session.state).toBeNull();
	});

	it("data=undefined 的 entry → 跳过（state=null）", () => {
		const session = createGoalSession();
		const entry: SessionEntryLike = {
			type: "custom",
			customType: ENTRY_TYPE,
			data: undefined,
		};
		const port = makeFakeSessionPort([entry]);
		reconstructGoalState(session, port);
		expect(session.state).toBeNull();
	});

	it("makeHistoryEntry + serializeState 往返一致性", () => {
		// 验证辅助函数本身正确（makeHistoryEntry 用于 history entry 构造）
		const state = createGoalState("roundtrip");
		state.status = "complete";
		const hist = makeHistoryEntry(state, 5);
		expect(hist.goalId).toBe(state.goalId);
		expect(hist.objective).toBe("roundtrip");
		expect(hist.status).toBe("complete");
		expect(hist.completedTasks).toBe(5);
		expect(typeof hist.elapsedSeconds).toBe("number");
		expect(typeof hist.timestamp).toBe("number");
		// serializeState 返回深拷贝（修改返回值不影响原 state）
		const serialized = serializeState(state);
		expect(serialized.objective).toBe("roundtrip");
		serialized.status = "cancelled";
		expect(state.status).toBe("complete"); // 原状态未被修改
	});
});
