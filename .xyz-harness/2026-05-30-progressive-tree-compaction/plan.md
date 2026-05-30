---
verdict: pass
complexity: L1
---

# Progressive Tree Compaction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed-retention, all-in-one compression with a progressive engine that dynamically determines which segments to keep (retention window) and how many to compress (scope based on 20-50% ratio target), then appends compressed groups to the existing tree.

**Architecture:** This is a backend-only change to the `infinite-context` extension. The `TreeCompactor` becomes the orchestrator — it receives context usage from `index.ts`, computes retention + scope, then compresses. The retention window logic moves from `SegmentTracker.getRetentionWindow()` (currently fixed at 2 segments) to a dynamic gradient. The `ContextAssembler` learns which segments are compressed so it can strip their original messages from the context.

**Tech Stack:** TypeScript (Pi runtime), no external dependencies.

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `infinite-context/src/types.ts` | modify | BG1 | Replace `RETENTION_CONFIG` with gradient table + compression constants |
| `infinite-context/src/segment-tracker.ts` | modify | BG1 | `getRetentionWindow()` becomes parameterized with usage% |
| `infinite-context/src/tree-compactor.ts` | modify | BG1 | Dynamic retention + scope algorithms, prompt with old tree groups, append-only tree |
| `infinite-context/src/context-handler.ts` | modify | BG1 | Accept compressed segIds, filter corresponding original messages |
| `infinite-context/src/index.ts` | modify | BG1 | Pass context usage to compactor, wire compressed segIds to assembler |

---

## Interface Contracts

### Module: types.ts

#### New constants

| Name | Type | Description |
|------|------|-------------|
| `RETENTION_GRADIENT` | `ReadonlyArray<{usageMax: number, retainCount: number}>` | Gradient table: [50→all, 70→8, 80→4, 90→2, 100→1]. Uses 9999 sentinel for 'all' (avoid Infinity type issue) |
| `COMPRESSION_CONFIG` | `{ratioMin: number, ratioMax: number, perSegmentTokens: number}` | Default 0.2/0.5 ratio, 63 tokens/segment (includes leaf + group overhead) |
| `IContextUsage` | `interface` (new) | `contextWindow: number; usedTokens: number; percent: number` |

#### Removed

| Name | Reason |
|------|--------|
| `RETENTION_CONFIG` (maxSegments, maxTurns) | Replaced by dynamic gradient |

### Module: segment-tracker.ts

#### Class: SegmentTracker

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `getRetentionWindow` (modified) | `(usagePercent: number) -> readonly Segment[]` | Segments to retain | 0%→all segments, 100%→1, no completed→empty | AC-1 |

### Module: tree-compactor.ts

#### Class: TreeCompactor

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `triggerCompression` (modified) | `(pi, ctx, segments, usagePercent, existingTree, onComplete?) -> void` | void | usagePercent < 50→skip, isCompressing→skip, no history→skip | AC-1, AC-2 |
| `computeCompressionScope` (new) | `(retentionSegs[], allSegs[]) -> {targetSegs: Segment[], estimatedAfterTokens: number}` | Scope decision | ratio < 20→add more, ratio > 50→remove last | AC-2 |
| `getCompressedSegIds` (new) | `() -> Set<string>` | segIds of compressed segments | No compression yet→empty set | AC-4 |
| `estimateCompressedTokens` (new) | `(segCount: number) -> number` | Estimated tokens | segCount=0→0 | — |

### Module: context-handler.ts

#### Class: ContextAssembler

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `assembleMessages` (modified) | `(messages, tree, segments, retentionWindow, compressedSegIds?, contextWindow?) -> AssembleResult` | Assembled messages | No compressedSegIds→unchanged behavior | AC-4 |

---

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1: dynamic retention | SegmentTracker.getRetentionWindow(usagePercent) | usagePercent→gradient→retentionSegs | Task 2 |
| AC-2: compression scope | TreeCompactor.computeCompressionScope() | retentionSegs→scope selection | Task 3 |
| AC-3: append-only tree | TreeCompactor.onComplete (new tree.append) | LLM output→append to root.children | Task 3 |
| AC-4: filtered context | ContextAssembler.assembleMessages(compressedSegIds) | compressedSegIds→filter messages | Task 4 |
| AC-5: stable ratio | post-implementation verification | N/A | — |
| AC-6: low usage skip | TreeCompactor.triggerCompression(<50) | usagePercent<50→return early | Task 3 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1 Dynamic retention window | adopted | Task 2 |
| AC-2 Dynamic compression scope | adopted | Task 3 |
| AC-3 Append-only tree | adopted | Task 3 |
| AC-4 Context injection includes all nodes | adopted | Task 4 |
| AC-5 Stable compression ratio (±20pp) | adopted | Post-Task 3 verification |
| AC-6 Low usage no compression | adopted | Task 3 |
| FR-1 Retention gradient | adopted | Task 2 |
| FR-2 Compression scope algorithm | adopted | Task 3 |
| FR-3 Append-only tree structure | adopted | Task 3 |
| FR-4 Context injection strategy | adopted | Task 4 |
| FR-5 LLM prompt with old tree groups | adopted | Task 3 |
| FR-6 Compression trigger flow | adopted | Task 5 |
| FR-7 Compression failure handling | adopted | Task 3 |
| C-1 Async fire-and-forget | existing, no change | — |
| C-2 30s timeout | existing, no change | — |
| C-3 Backward compat deserializeState | existing, no change | — |
| C-4 Per-segment estimate tolerance | adopted (documented in constants) | Task 1, Task 3 |

---

## Execution Groups

#### BG1: Compression engine refactor

**Description:** All changes are within the `infinite-context` module, backend-only. The 5 files share a tight dependency chain — types → segment-tracker → tree-compactor → context-handler + index. One group, one wave.

**Tasks:** Task 1, Task 2, Task 3, Task 4, Task 5

**Files (预估):** 5 modify (no new files)

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium） |
| 注入上下文 | spec.md（AC-1~AC-6，FR-1~FR-7），plan.md interface contracts，existing code |
| 读取文件 | `types.ts`, `segment-tracker.ts`, `tree-compactor.ts`, `context-handler.ts`, `index.ts` |
| 修改文件 | 同上 |

**Execution Flow (BG1 internal):** 串行派遣，每个 Task 走完整 subagent 链后再开始下一 Task。

  Task 1 → Task 2 → Task 3 → Task 4 → Task 5

**Dependencies:** 无（BG1 为唯一分组）

**设计细节:** 见下文各 Task 描述。核心算法：

```
computeCompressionScope(retentionSegs, allSegs, existingTree):
  1. targetSegs = allSegs — retentionSegs — activeSegs — already_compressed
  2. Sort by segId ascending (oldest first)
  3. For i from 1 to targetSegs.length:
     segs = targetSegs.slice(0, i)
     estimated = segs.length * perSegmentTokens + existingTree.totalTokens
     denominator = existingTree.totalTokens + sum(digest tokens of segs) + sum(retentionSeg digest tokens) + systemPromptEstimate(4000t)
     ratio = estimated / denominator
     If ratio >= ratioMin: break and return segs
  4. If i === targetSegs.length and ratio < ratioMin: return targetSegs (all)
  5. Return segs
```

---

## Dependency Graph & Wave Schedule

```
BG1 (all tasks, serial)
  Task 1 (types) → Task 2 (segment-tracker) → Task 3 (tree-compactor) → Task 4 (context-handler) → Task 5 (index.ts)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1 | 所有任务串行，每个依赖前一个 |

---

## Tasks

### Task 1: types.ts — Dynamic retention + compression config

**Type:** backend

**Files:**
- Modify: `infinite-context/src/types.ts:70-74`

**Changes:**

1. Remove the old `RETENTION_CONFIG`:

```typescript
// REMOVE:
/** 保留窗口的默认配置 */
export const RETENTION_CONFIG = {
	/** 保留最近多少个已完成段 */
	maxSegments: 2,
	/** 或覆盖最近多少个 turns */
	maxTurns: 8,
} as const;
```

2. Add gradient table + compression constants:

```typescript
// ── Dynamic Retention Window ──────────────────────────

/**
 * 保留窗口梯度表。
 * 根据上下文占用比例决定保留最近多少个已完成段。
 * 保留的段不进入压缩，原文保持在上下文中。
 * 当前活跃段（未完成）始终保留，不计入此表。
 */
export const RETENTION_GRADIENT: ReadonlyArray<{ usageMax: number; retainCount: number }> = [
	{ usageMax: 50, retainCount: 9999 },  // < 50%: large sentinel — all retained, no compression
	{ usageMax: 70, retainCount: 8 },         // 50-70%: 保留 8 段
	{ usageMax: 80, retainCount: 4 },         // 70-80%: 保留 4 段
	{ usageMax: 90, retainCount: 2 },         // 80-90%: 保留 2 段
	{ usageMax: 100, retainCount: 1 },        // > 90%: 保留 1 段
] as const;

// ── Compression Config ───────────────────────────────

/**
 * 压缩算法的配置常量。
 */
export const COMPRESSION_CONFIG = {
	/** 目标压缩比下限（压缩后总大小 / 压缩前总大小 >= this） */
	ratioMin: 0.2,
	/** 目标压缩比上限 */
	ratioMax: 0.5,
	/** 每段的保守预估 token 数（包含 leaf 摘要 ~50t + group 开销 ~13t） */
	perSegmentTokens: 63,
} as const;
```

3. Add context usage type:

```typescript
/** 上下文使用率信息 */
export interface IContextUsage {
	contextWindow: number;
	usedTokens: number;
	percent: number;
}
```

- [ ] **Step 1: Modify types.ts**
  Replace `RETENTION_CONFIG` with `RETENTION_GRADIENT` + `COMPRESSION_CONFIG` + `IContextUsage`. Run tsc to verify.

- [ ] **Step 2: Commit**

  ```bash
  git add infinite-context/src/types.ts
  git commit -m "refactor(ic): replace static RETENTION_CONFIG with dynamic gradient + compression config"
  ```

---

### Task 2: segment-tracker.ts — Parameterize getRetentionWindow

**Type:** backend

**Files:**
- Modify: `infinite-context/src/segment-tracker.ts:143-163` (`getRetentionWindow` method)

**Changes:**

1. Change `getRetentionWindow()` signature from `getRetentionWindow(): readonly Segment[]` to `getRetentionWindow(usagePercent: number): readonly Segment[]`

2. Replace the old logic with gradient lookup:

```typescript
/**
 * 返回 retention window 内的段。
 * @param usagePercent 当前上下文占用百分比（0-100）。
 *   0-50: 所有已完成段（不压缩）
 *   50-70: 最近 8 个已完成段
 *   70-80: 最近 4 个
 *   80-90: 最近 2 个
 *   90+: 最近 1 个
 */
getRetentionWindow(usagePercent: number): readonly Segment[] {
	const completedSegments = this.segments.filter((s) => s.completed);
	if (completedSegments.length === 0) return [];

	// 查梯度表（精确匹配：usagePercent=0 → 表第一项, usagePercent > 100 → 表最后一项）
	let retainCount = 1; // 兜底
	for (const entry of RETENTION_GRADIENT) {
		if (usagePercent <= entry.usageMax) {
			retainCount = entry.retainCount;
			break;
		}
	}

	// sentinel 值 9999 = 所有已完成段
	if (retainCount >= 9999 || retainCount >= completedSegments.length) {
		return [...completedSegments];
	}

	return completedSegments.slice(-retainCount);
}
```

3. Remove import of `RETENTION_CONFIG` (or change to import `RETENTION_GRADIENT`).

- [ ] **Step 1: TDD — write failing test**
  In-memory test with mock segments and different usage % values:
  - 30% → all 6 completed segments retained
  - 60% → last 8 (or all if < 8)
  - 75% → last 4
  - 85% → last 2
  - 95% → last 1

- [ ] **Step 2: Implement the change in segment-tracker.ts**
  Replace `getRetentionWindow()` body, update import.

- [ ] **Step 3: Run tests, commit**

  ```bash
  git add infinite-context/src/segment-tracker.ts
  git commit -m "feat(ic): dynamic retention window with usage-based gradient"
  ```

---

### Task 3: tree-compactor.ts — Dynamic retention + scope + prompt

**Type:** backend

**Files:**
- Modify: `infinite-context/src/tree-compactor.ts`

This is the largest change. Key modifications:

**Change A: Remove old retention logic from `triggerCompression()`**

Current lines ~400-430 (filtering retention window). Replace with:

```typescript
triggerCompression(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	segments: readonly Segment[],
	usagePercent: number,  // NEW parameter
	existingTree: CompactTree | undefined,
	onComplete?: (result: CompactResult) => void,
): void {
	if (this.compressing) return;

	// FR-1: 动态保留窗口（已移至 segment-tracker，此处接收 caller 传入的 usagePercent）
	// FR-2: 动态压缩范围
	const retentionCount = this.lookupRetentionCount(usagePercent);
	const completedSegments = segments.filter(s => s.completed);
	const retentionSegs = retentionCount >= completedSegments.length
		? [...completedSegments]
		: completedSegments.slice(-retentionCount);
	const activeSegIds = new Set(segments.filter(s => !s.completed).map(s => s.segId));

	const availableSegs = segments.filter(
		s => !retentionSegs.find(r => r.segId === s.segId) && !activeSegIds.has(s.segId)
	);

	// 已压缩的段不再压缩
	const alreadyCompressed = this.compressedSegIds;
	const historySegments = availableSegs.filter(s => !alreadyCompressed.has(s.segId));

	if (historySegments.length === 0) {
		this.compressing = false;
		return;
	}

	// 计算压缩范围
	const scopeResult = this.computeCompressionScope(retentionSegs, historySegments, existingTree);
	if (scopeResult.targetSegs.length === 0) {
		this.compressing = false;
		return;
	}

	this.currentDigests = buildSegmentDigests(scopeResult.targetSegs, this.ctxCwd);

	this.runCompression(
		pi, ctx, scopeResult.targetSegs, existingTree, 0, onComplete,
	);
}
```

**Change B: Add `computeCompressionScope()` method:**

```typescript
/**
 * FR-2: 动态压缩范围。
 * 从最旧段逐个累加，预估压缩后比例，落在 target 范围内则停止。
 *
 * 预估公式（保守）：
 *   estimatedAfter = segs.length * perSegmentTokens + existingTree.totalTokens || 0
 *   denominator = 当前上下文总大小（树 + 保留段 digest + 新段 digest）
 *   ratio = estimatedAfter / denominator
 */
private computeCompressionScope(
	retentionSegs: readonly Segment[],
	historySegs: readonly Segment[],
	existingTree: CompactTree | undefined,
): { targetSegs: Segment[]; estimatedAfterTokens: number } {
	const { ratioMin, ratioMax, perSegmentTokens } = COMPRESSION_CONFIG;
	const existingTreeSize = existingTree?.totalTokens ?? 0;

	// 分母：树 + 保留段 digest + 历史段 digest + 系统提示词
	const systemPromptEstimate = 4000; // 系统提示词 + CLAUDE.md ≈ 4000 tokens
	const retentionMsgSize = retentionSegs.reduce((sum, s) => sum + s.userMessage.length, 0) / 4;
	const historyTotalDigest = historySegs.reduce((sum, s) => sum + s.userMessage.length, 0) / 4;
	const denominator = existingTreeSize + retentionMsgSize + historyTotalDigest + systemPromptEstimate;

	if (denominator <= 0) return { targetSegs: [...historySegs], estimatedAfterTokens: 0 };

	// 按 segId 排序（最旧的在前）
	const sorted = [...historySegs].sort((a, b) => a.segId.localeCompare(b.segId));

	for (let i = 1; i <= sorted.length; i++) {
		const segs = sorted.slice(0, i);
		// 预估压缩输出（perSegmentTokens=63 已包含 leaf+group 开销，不再单独加 group 估算）
		const estimatedAfter = segs.length * perSegmentTokens + existingTreeSize;
		const ratio = estimatedAfter / denominator;

		if (ratio >= ratioMin) {
			// 落在范围内或超出目标上限 → 返回前 i 段（如果超出 ratioMax 则减一段）
			if (ratio <= ratioMax) {
				return { targetSegs: segs, estimatedAfterTokens: estimatedAfter };
			}
			// 超出上限 → 减一段
			if (i > 1) {
				const prev = sorted.slice(0, i - 1);
				const prevEstimated = (i - 1) * perSegmentTokens + existingTreeSize;
				return { targetSegs: prev, estimatedAfterTokens: prevEstimated };
			}
			// 即使只有 1 段也超上限 → 还是压缩它（接受超限）
			return { targetSegs: segs, estimatedAfterTokens: estimatedAfter };
		}
	}

	// 所有段加完仍未达标 → 接受小于 ratioMin
	const allEstimated = sorted.length * perSegmentTokens + existingTreeSize;
	return { targetSegs: sorted, estimatedAfterTokens: allEstimated };
}
```

**Change C: Add old tree group list to `buildCompressionPrompt()`:**

In `buildCompressionPrompt()`, after building segment digests, add the existing tree groups:

```typescript
// 增量上下文：传递旧树 group 列表（不修改，只告知）
const existingGroupsContext = existingTree
	? buildExistingGroupsSection(existingTree)
	: "";
```

New helper:

```typescript
/**
 * 构建旧树 group 列表，告知 LLM 哪些 group 已存在，不应修改。
 * 新 compressed groups 追加在旧 groups 之后。
 */
function buildExistingGroupsSection(tree: CompactTree): string {
	const groups = tree.root.children
		.map((g, idx) => `  ${g.nodeId}: ${g.summary.slice(0, 150)}`)
		.join("\n");
	return `\n<existing-groups>\nExisting groups in the tree (DO NOT modify these):\n${groups}\n\nAppend your new groups after the existing ones. Do NOT rewrite old groups.\n</existing-groups>\n`;
}
```

**使用单一 prompt 模式：** 废弃 `buildIncrementalPrompt`。当 `existingTree` 存在时，`buildInitialPrompt` 通过 `existingGroupsContext` 告知 LLM 已有 groups（静默不修改），LLM 只考虑新段的 grouping。代码层面在压缩成功后做 append。

```typescript
function buildCompressionPrompt(...): string {
	// ... 构建 segLines 和 otherContext ...
	const existingGroupsContext = existingTree
		? buildExistingGroupsSection(existingTree)
		: "";
	const taskPrompt = buildInitialPrompt(segLines, existingGroupsContext, errorContext);
	return TOOL_CALL_GUARD_PREAMBLE + taskPrompt + TOOL_CALL_GUARD_TRAILER;
}
```

**Change E: Modify `runCompression` close handler to append to existing tree (FR-3):**

当前 `runCompression` 的 close handler（验证通过后）总是创建新 root + 新 tree。改为当 `existingTree` 存在时，将新 groups 追加到现有 root.children：

```typescript
// 在 runCompression 的 close handler 中，校验通过后：
if (existingTree) {
	// 追加模式：保留旧 groups，追加新 groups
	const oldChildren = [...existingTree.root.children];
	const newChildren = result; // validated TreeNode[]
	const rootSummary = `Compressed ${segments.length} segments (appended to existing tree)`;
	const root: TreeNode = {
		nodeId: "root",
		summary: rootSummary,
		tokenCount: computeNodeTokens("root", rootSummary),
		children: [...oldChildren, ...newChildren],
	};
	// ... 后续持久化和回调
} else {
	// 首次压缩：新树
	// ... 现有逻辑不变 ...
}
```

**Change D: Add `getCompressedSegIds()` method and `compressedSegIds` field, restore in `restoreState()`**

```typescript
export class TreeCompactor {
	private compressing = false;
	private tree: CompactTree | undefined;
	private currentProcess: ChildProcess | undefined;
	private currentDigests: SegmentDigest[] = [];
	private ctxCwd = "";
	private compressedSegIds: Set<string> = new Set(); // NEW

	/** RESTORE: rebuild compressedSegIds from leaf segIds in existing tree */
	restoreState(entries: SessionEntry[]): void {
		this.tree = undefined;
		this.compressedSegIds.clear();

		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (isCompactTreeEntry(entry) && entry.data) {
				this.tree = entry.data as CompactTree;
				// Rebuild compressedSegIds from tree leaf segIds
				this.collectCompressedSegIds(this.tree.root);
				return;
			}
		}
	}

	/** BFS collect all leaf segIds from tree */
	private collectCompressedSegIds(node: TreeNode): void {
		if (node.segId) {
			this.compressedSegIds.add(node.segId);
		}
		for (const child of node.children) {
			this.collectCompressedSegIds(child);
		}
	}

	// NEW method
	getCompressedSegIds(): Set<string> {
		return new Set(this.compressedSegIds);
	}
```

In `onComplete` callback or after `runCompression` succeeds, add the compressed segIds:

```typescript
// After successful compression (in the close handler of runCompression):
this.tree = tree;
this.compressing = false;

// Track which segments were compressed
for (const seg of segments) {
	this.compressedSegIds.add(seg.segId);
}
```

**Change E: Add `lookupRetentionCount()` helper:**

```typescript
/**
 * 查梯度表，返回保留段数
 */
private lookupRetentionCount(usagePercent: number): number {
	for (const entry of RETENTION_GRADIENT) {
		if (usagePercent <= entry.usageMax) {
			return entry.retainCount;
		}
	}
	return 1; // 兜底
}
```

- [ ] **Step 1: TDD — write failing tests for `computeCompressionScope`**
  Test scenarios:
  - 10 segments, retention: 2 (oldest 3 outside ratio → compress first 3)
  - Ratio < 20% after all segments → accept all
  - Ratio > 50% on first segment → compress just that one

- [ ] **Step 2: Implement changes A-E in tree-compactor.ts**

- [ ] **Step 3: Run tests, commit**

  ```bash
  git add infinite-context/src/tree-compactor.ts
  git commit -m "feat(ic): dynamic compression scope, prompt with old tree groups, append-only tree"
  ```

---

### Task 4: context-handler.ts — Add compressedSegIds for AC-4 context filtering

**Type:** backend

**Files:**
- Modify: `infinite-context/src/context-handler.ts`

**Changes:**

1. Add `compressedSegIds` parameter to `assembleMessages()` (optional `Set<string>`):

```typescript
assembleMessages(
	messages: MinimalAgentMessage[],
	tree: CompactTree | undefined,
	segments: readonly Segment[],
	retentionWindow: readonly Segment[],
	compressedSegIds?: Set<string>,  // NEW: optional
	contextWindow: number = DEFAULT_CONTEXT_WINDOW,
): AssembleResult {
```

2. After filtering out old ic-summary/ic-recall-prompt messages, remove original messages of compressed segments.

Strategy: compressed segments are always the oldest segments (FR-2: from most distant). Messages are in chronological order. We count user messages belonging to compressed segIds, then skip the first N user messages (with their assistant replies) from the filtered messages array:

```typescript
// After removing old ic-summary/ic-recall messages:
let filtered = messages.filter(
	(msg) => !isIcSummary(msg) && !isIcRecallPrompt(msg),
);

// AC-4: filter out original messages of compressed segments
if (compressedSegIds && compressedSegIds.size > 0 && tree) {
	// Count how many user messages belong to compressed segments
	const userMsgCount = segments
		.filter(s => compressedSegIds.has(s.segId))
		.length;

	// Skip the first N user messages + their assistant replies
	let toSkip = 0;
	let userCount = 0;
	for (const msg of filtered) {
		if (userCount >= userMsgCount) break;
		toSkip++;
		if (msg.role === "user") {
			userCount++;
		}
	}
	filtered = filtered.slice(toSkip);
}
```

3. Add `compressedSegIds` to `AssembleResult` for monitoring:

```typescript
export interface AssembleResult {
	messages: MinimalAgentMessage[];
	treeContextTokens: number;
	compressedNodeCount: number;
	compressedSegIds?: Set<string>;  // NEW
}
```

- [ ] **Step 1: Add `compressedSegIds` parameter, filtering logic, and AssembleResult field**

- [ ] **Step 2: Run type check**

- [ ] **Step 3: Commit**

  ```bash
  git add infinite-context/src/context-handler.ts
  git commit -m "feat(ic): filter compressed segment messages from context (AC-4)"
  ```

---

### Task 5: index.ts — Wire context usage + compressed segIds

**Type:** backend

**Files:**
- Modify: `infinite-context/src/index.ts`

**Changes:**

1. In `createTurnEndHandler`: pass `usagePercent` to `triggerCompression()`:

```typescript
function createTurnEndHandler(
	pi: ExtensionAPI,
	tracker: SegmentTracker,
	compactor: TreeCompactor,
	assembler: ContextAssembler,
	needsCompressionRef: { value: boolean },
) {
	return (event: { turnIndex: number; message: unknown; toolResults: unknown[] }, ctx: ExtensionContext) => {
		try {
			tracker.handleTurnEnd(pi, ctx, event.turnIndex, event.message, event.toolResults);

			if (!compactor.isCompressing() && needsCompressionRef.value) {
				needsCompressionRef.value = false;
				const segments = tracker.getSegments();
				const contextUsage = ctx.getContextUsage();
				const usagePercent = contextUsage?.percent ?? 100;
				compactor.triggerCompression(
					pi, ctx, segments, usagePercent, compactor.getTree(), onCompleteFactory(ctx),
				);
			}
		} catch (err) { ... }
	};
}
```

2. In `createContextHandler`: pass `compressedSegIds` to `assembleMessages()`:

```typescript
function createContextHandler(...) {
	return (event: ContextEvent, ctx: ExtensionContext) => {
		// ...
		const result: AssembleResult = assembler.assembleMessages(
			event.messages as unknown as MinimalAgentMessage[],
			tree, segments, retentionWindow,
			compactor.getCompressedSegIds(),  // NEW
			contextWindow,
		);
		// ...
	};
}
```

3. Pass `usagePercent` to `tracker.getRetentionWindow()`:

```typescript
const contextUsage = ctx.getContextUsage();
const usagePercent = contextUsage?.percent ?? 100;
const retentionWindow = tracker.getRetentionWindow(usagePercent);
```

- [ ] **Step 1: Update index.ts with the three wiring changes**

- [ ] **Step 2: Run type check, commit**

  ```bash
  git add infinite-context/src/index.ts
  git commit -m "feat(ic): wire context usage and compressed segIds through index.ts"
  ```

---

## e2e Test Plan

See `e2e-test-plan.md`.
