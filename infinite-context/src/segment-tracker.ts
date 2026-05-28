/**
 * 段索引追踪器（SegmentTracker）
 *
 * 职责：
 * - 检测段边界（user message 到来时创建新段）
 * - 维护段列表和当前活跃段
 * - 通过 appendEntry 持久化段/turn 信息
 * - 写入段原始数据文件（.pi/infinite-context/<sessionId>/seg_N.json）
 * - 提供 retention window 查询
 */

import { writeFileSync, readFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import type { ExtensionAPI, ExtensionContext, CustomEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import type { Segment, SegmentEntryData, TurnEntryData } from "./types";
import { RETENTION_CONFIG } from "./types";

// ── 常量 ──────────────────────────────────────────────

const SEGMENT_ENTRY_TYPE = "ic-segment";
const TURN_ENTRY_TYPE = "ic-turn";
const CONTEXT_DIR_NAME = "infinite-context";

/**
 * Entry GC: 恢复 state 时最多处理最近多少条 turn entries。
 * 旧的 turn entries 不删除（Pi session manager 是 append-only），
 * 但恢复时忽略以控制内存、加速启动。
 * ic-compact-tree entries 永不可丢失。
 */
const MAX_TURN_ENTRIES = 500;

// ── helpers ───────────────────────────────────────────

function isSegmentEntry(entry: SessionEntry): entry is CustomEntry<SegmentEntryData> {
	return entry.type === "custom"
		&& (entry as CustomEntry).customType === SEGMENT_ENTRY_TYPE;
}

function isTurnEntry(entry: SessionEntry): entry is CustomEntry<TurnEntryData> {
	return entry.type === "custom"
		&& (entry as CustomEntry).customType === TURN_ENTRY_TYPE;
}

/** 提取 user message 文本 */
function extractUserText(message: unknown): string {
	if (message === null || message === undefined) return "";
	const msg = message as Record<string, unknown>;
	const content = msg.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part: unknown): part is { type: string; text: string } =>
				typeof part === "object" && part !== null && "text" in part
			)
			.map((part) => part.text)
			.join("");
	}
	return "";
}

/** 提取 toolResults 中的工具调用名称 */
function extractToolCalls(toolResults: unknown[]): string[] {
	const calls: string[] = [];
	for (const result of toolResults) {
		if (typeof result === "object" && result !== null) {
			const r = result as Record<string, unknown>;
			if (typeof r.toolName === "string") {
				calls.push(r.toolName);
			}
			// 兜底：从 toolCallId 提取
			if (calls.length === 0 && typeof r.toolCallId === "string") {
				calls.push(r.toolCallId);
			}
		}
	}
	return calls;
}

// ── SegmentTracker ────────────────────────────────────

export class SegmentTracker {
	// 闭包状态
	private segments: Segment[] = [];
	private currentSegment: Segment | undefined = undefined;
	private nextSegIndex = 0;

	/**
	 * 从 session entries 恢复闭包状态
	 * 在 session_start 事件中调用
	 */
	restoreState(entries: SessionEntry[]): void {
		this.segments = [];
		this.currentSegment = undefined;
		this.nextSegIndex = 0;

		// 先恢复 segments
		for (const entry of entries) {
			if (isSegmentEntry(entry) && entry.data) {
				const data = entry.data;
				const segment: Segment = {
					segId: data.segId,
					turnRange: { ...data.turnRange },
					userMessage: data.userMessage,
					completed: data.completed,
					filePath: data.filePath,
				};
				this.segments.push(segment);

				// 跟踪最大 seg index
				const indexMatch = data.segId.match(/^seg_(\d+)$/);
				if (indexMatch) {
					const index = parseInt(indexMatch[1], 10);
					if (index >= this.nextSegIndex) {
						this.nextSegIndex = index + 1;
					}
				}
			}
		}

		// 设置当前段：最后一个未完成的段
		const lastSegment = this.segments.length > 0
			? this.segments[this.segments.length - 1]
			: undefined;

		if (lastSegment && !lastSegment.completed) {
			this.currentSegment = lastSegment;
		}

		// 从 turn entries 恢复 turnRange（可能比 segment entry 更新）
		// GC: 只恢复最近的 MAX_TURN_ENTRIES 条 turn entries
		// ic-turn 是轮次信息，旧的轮次信息在恢复时丢弃不影响上下文组装（靠 segment entry 恢复段结构）
		const turnEntries = entries.filter(isTurnEntry).slice(-MAX_TURN_ENTRIES);
		for (const entry of turnEntries) {
			const turnData = entry.data;
			if (turnData === undefined) continue;
			const seg = this.segments.find((s) => s.segId === turnData.segId);
			if (seg && turnData.turnIndex > seg.turnRange.end) {
				seg.turnRange.end = turnData.turnIndex;
			}
		}
	}

	/**
	 * 处理 turn_end 事件
	 *
	 * 检测段边界：
	 * 1. 如果 message.role === "user"，标记前段完成并创建新段
	 * 2. 更新当前段的 turnRange
	 * 3. 追加 turn 信息
	 * 4. 写入段文件
	 */
	handleTurnEnd(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		turnIndex: number,
		message: unknown,
		toolResults: unknown[],
	): void {
		const msg = message as Record<string, unknown> | null;
		const isUserMessage = msg !== null && msg.role === "user";

		if (isUserMessage) {
			// 标记前段完成
			if (this.currentSegment && !this.currentSegment.completed) {
				this.currentSegment.completed = true;
				pi.appendEntry(SEGMENT_ENTRY_TYPE, this.toEntryData(this.currentSegment));
			}

			// 创建新段
			const segId = `seg_${this.nextSegIndex}`;
			this.nextSegIndex++;

			const sessionId = ctx.sessionManager.getSessionId();
			const filePath = `${CONTEXT_DIR_NAME}/${sessionId}/${segId}.json`;

			const newSegment: Segment = {
				segId,
				turnRange: { start: turnIndex, end: turnIndex },
				userMessage: extractUserText(message),
				completed: false,
				filePath,
			};

			this.segments.push(newSegment);
			this.currentSegment = newSegment;

			pi.appendEntry(SEGMENT_ENTRY_TYPE, this.toEntryData(newSegment));
		}

		// 更新当前段的 turnRange
		if (this.currentSegment) {
			if (turnIndex > this.currentSegment.turnRange.end) {
				this.currentSegment.turnRange.end = turnIndex;
			}

			// 追加 turn 信息
			const turnData: TurnEntryData = {
				turnIndex,
				segId: this.currentSegment.segId,
				toolCalls: extractToolCalls(toolResults),
			};
			pi.appendEntry(TURN_ENTRY_TYPE, turnData);

			// 写入段文件
			this.writeSegmentFile(ctx, this.currentSegment);

			// 追加 turn 数据到段文件
			this.appendTurnToSegFile(ctx, this.currentSegment, { turnIndex, message, toolResults });
		}
	}

	/** 返回只读段列表 */
	getSegments(): readonly Segment[] {
		return this.segments;
	}

	/** 返回当前活跃段（未完成） */
	getCurrentSegment(): Segment | undefined {
		return this.currentSegment;
	}

	/**
	 * 返回 retention window 内的段
	 * 规则：取最后 maxSegments 个已完成段（或覆盖最近 maxTurns turns 的段）
	 * 不包含当前活跃段
	 */
	getRetentionWindow(): readonly Segment[] {
		const completedSegments = this.segments.filter((s) => s.completed);
		if (completedSegments.length === 0) return [];

		// 策略 1：最近 maxSegments 个已完成段
		const byCount = completedSegments.slice(-RETENTION_CONFIG.maxSegments);

		// 策略 2：覆盖最近 maxTurns turns 的段
		const latestTurnEnd = Math.max(
			...completedSegments.map((s) => s.turnRange.end),
		);
		const cutoffTurn = latestTurnEnd - RETENTION_CONFIG.maxTurns + 1;
		const byTurns = completedSegments.filter(
			(s) => s.turnRange.end >= cutoffTurn,
		);

		// 取两者中段数较多的（更宽松的窗口）
		return byCount.length >= byTurns.length ? byCount : byTurns;
	}

	// ── 内部方法 ──────────────────────────────────────

	private toEntryData(segment: Segment): SegmentEntryData {
		return {
			segId: segment.segId,
			turnRange: { ...segment.turnRange },
			userMessage: segment.userMessage,
			completed: segment.completed,
			filePath: segment.filePath,
		};
	}

	private writeSegmentFile(ctx: ExtensionContext, segment: Segment): void {
		const segDir = join(ctx.cwd, ".pi", "infinite-context", ctx.sessionManager.getSessionId());
		if (!existsSync(segDir)) {
			mkdirSync(segDir, { recursive: true });
		}
		const data = {
			segId: segment.segId,
			turnRange: segment.turnRange,
			userMessage: segment.userMessage,
			timestamp: Date.now(),
		};
		writeFileSync(join(segDir, `${segment.segId}.json`), JSON.stringify(data, null, 2));
	}

	private appendTurnToSegFile(ctx: ExtensionContext, segment: Segment | undefined, turnData: { turnIndex: number; message: unknown; toolResults: unknown[] }): void {
		if (!segment) return;
		const segDir = join(ctx.cwd, ".pi", "infinite-context", ctx.sessionManager.getSessionId());
		const segFile = join(segDir, `${segment.segId}.json`);
		if (!existsSync(segFile)) return;
		try {
			const content = readFileSync(segFile, "utf-8");
			const data = JSON.parse(content) as Record<string, unknown>;
			if (!Array.isArray(data.turns)) data.turns = [];
			(data.turns as unknown[]).push({
				turnIndex: turnData.turnIndex,
				message: turnData.message,
				toolResults: turnData.toolResults,
			});
			writeFileSync(segFile, JSON.stringify(data, null, 2));
		} catch {
			// 文件不存在或解析失败，静默忽略
		}
	}
}
