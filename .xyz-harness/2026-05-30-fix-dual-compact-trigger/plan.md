---
verdict: pass
complexity: L1
---

# Fix Dual Compact Trigger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify dual compression mechanisms into Pi's native compact flow, eliminating cancel loops and race conditions.

**Architecture:** The `session_before_compact` handler becomes the sole trigger point for tree-compact. It executes `triggerCompressionAsync` (async spawn, non-blocking event loop) and returns a `CompactionResult` to Pi instead of `{ cancel: true }`. Pi writes the compaction entry, which enables its timestamp-based re-entry guard. The `context` handler stops judging compression timing; the `turn_end` handler stops triggering compression.

**Tech Stack:** TypeScript, Pi Extension API (`SessionBeforeCompactEvent` → `SessionBeforeCompactResult`), existing `TreeCompactor.triggerCompressionAsync`.

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `infinite-context/src/index.ts` | modify | BG1 | Refactor 3 handlers (before_compact, turn_end, context) + remove needsCompressionRef |
| `infinite-context/src/compression-runner.ts` | modify | BG1 | Add `compressForCompaction()` that returns `CompactResult` + UI + builds summary text |
| `infinite-context/src/tree-compactor.ts` | no change | — | No changes needed, `triggerCompressionAsync` already exists and works |
| `infinite-context/src/context-handler.ts` | no change | — | `shouldCompress` method stays (used by `/context-status` command), but no longer called from `context` event handler |

---

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | Add `compressForCompaction()` to compression-runner | backend | — | BG1 |
| 2 | Rewrite `createBeforeCompactHandler` to execute tree-compact and return `CompactionResult` | backend | 1 | BG1 |
| 3 | Clean up `createTurnEndHandler` and `createContextHandler` — remove compression trigger logic | backend | 2 | BG1 |
| 4 | Verify typecheck passes | backend | 3 | BG1 |

---

## Task Details

### Task 1: Add `compressForCompaction()` to compression-runner

**Type:** backend

**Files:**
- Modify: `infinite-context/src/compression-runner.ts`

**Goal:** Extract the shared logic from `compressAsync` into a function that returns `CompactResult` (instead of void), suitable for use in the `session_before_compact` handler.

- [ ] **Step 1: Add `compressForCompaction` function**

Add the following function to `compression-runner.ts`. It reuses `beforeCompressionUI` / `afterCompressionUI` and calls `compactor.triggerCompressionAsync` directly:

```typescript
/**
 * Compression for session_before_compact handler.
 * Returns CompactResult for building CompactionResult to return to Pi.
 * Returns null when segments are empty (caller should fallback to Pi native compact).
 * Uses async spawn (non-blocking event loop) so TUI can render status.
 */
export async function compressForCompaction(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	segments: readonly Segment[],
	compactor: TreeCompactor,
): Promise<CompactResult | null> {
	if (segments.length === 0) return null;
	beforeCompressionUI(pi, ctx, segments.length);
	const result = await compactor.triggerCompressionAsync(pi, segments, compactor.getTree());
	afterCompressionUI(pi, ctx, result);
	return result;
}
```

The existing `compressAsync` retains its original segments=0 early-return behavior (no UI, no compression). It delegates to `compressForCompaction` only for the shared spawn+UI logic:

```typescript
export async function compressAsync(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	segments: readonly Segment[],
	compactor: TreeCompactor,
): Promise<void> {
	if (segments.length === 0) return;
	await compressForCompaction(pi, ctx, segments, compactor);
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd infinite-context && npx tsc --noEmit`
Expected: PASS

---

### Task 2: Rewrite `createBeforeCompactHandler` to execute tree-compact and return `CompactionResult`

**Type:** backend

**Files:**
- Modify: `infinite-context/src/index.ts` (the `createBeforeCompactHandler` function)

**Goal:** Instead of returning `{ cancel: true }` when tree exists, execute tree-compact and return a `CompactionResult` to Pi. When segments are insufficient or compression fails, let Pi fall through to native compact.

- [ ] **Step 1: Rewrite `createBeforeCompactHandler`**

Replace the current implementation with one that:
1. Gets segments from tracker
2. If segments < 3, returns `{ cancel: false }` (let Pi do native compact)
3. Calls `compressForCompaction()` (await, async spawn → non-blocking)
4. On success, builds a text summary from the tree and returns `{ compaction: { summary, firstKeptEntryId, tokensBefore } }`
5. On failure (fallbackUsed with errorReason), returns `{ cancel: false }` (let Pi fallback)
6. On `compressForCompaction` returning null, returns `{ cancel: false }` (let Pi fallback)

The handler signature must match Pi's `ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>`. Pi calls handlers with `(event, ctx)` where `ctx` is `ExtensionContext` — the same context used for UI operations (`sendMessage`, `setStatus`):

```typescript
function createBeforeCompactHandler(
	pi: ExtensionAPI,
	tracker: SegmentTracker,
	compactor: TreeCompactor,
) {
	return async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
		const segments = tracker.getSegments();

		// Not enough segments for meaningful tree compression → let Pi handle
		if (segments.length < 3) {
			return { cancel: false };
		}

		try {
			const result = await compressForCompaction(pi, ctx, segments, compactor);

			// No result (empty segments) → let Pi handle
			if (!result) {
				return { cancel: false };
			}

			// If fallback was used with error, let Pi do native compact
			if (result.fallbackUsed && result.errorReason) {
				return { cancel: false };
			}

			// Build text summary from tree for Pi's compaction entry
			const summary = buildTreeSummary(result.tree);

			return {
				compaction: {
					summary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
				},
			};
		} catch (err) {
			console.error("[infinite-context] before_compact compression error:", err);
			return { cancel: false };
		}
	};
}
```

Note: `ctx` comes from Pi's emit call — `this._extensionRunner.emit({ type: "session_before_compact", ... })` passes the current `ExtensionContext` to each handler. This is the same `ctx` used in all other handlers.

The `buildTreeSummary` helper generates a text summary from the tree:

```typescript
function buildTreeSummary(tree: CompactTree): string {
	const groupSummaries = tree.root.children.map((group) => {
		const leafCount = group.children.length;
		return `- ${group.summary} (${leafCount} segments)`;
	}).join("\n");
	return `[IC Tree Compact] ${tree.root.children.length} groups, ${tree.totalTokens} tokens, depth ${tree.depth}\n${groupSummaries}`;
}
```

- [ ] **Step 2: Update the `pi.on("session_before_compact", ...)` registration**

The registration line needs to pass `pi` as the first argument:

```typescript
// Old:
pi.on("session_before_compact", createBeforeCompactHandler(tracker, compactor));
// New:
pi.on("session_before_compact", createBeforeCompactHandler(pi, tracker, compactor));
```

- [ ] **Step 3: Verify typecheck**

Run: `cd infinite-context && npx tsc --noEmit`
Expected: PASS

---

### Task 3: Clean up `createTurnEndHandler` and `createContextHandler` — remove compression trigger logic

**Type:** backend

**Files:**
- Modify: `infinite-context/src/index.ts` (`createTurnEndHandler`, `createContextHandler`, extension factory)

**Goal:** Remove `needsCompressionRef` mechanism entirely. `context` handler only assembles messages. `turn_end` handler only records turns.

- [ ] **Step 1: Remove `needsCompressionRef` from extension factory**

In the `infiniteContextExtension` function, remove:
```typescript
const needsCompression = { value: false };
```

And remove it from the argument lists of `createTurnEndHandler` and `createContextHandler`.

- [ ] **Step 2: Simplify `createTurnEndHandler`**

Remove the `needsCompressionRef` parameter and the compression trigger block:

```typescript
function createTurnEndHandler(
	pi: ExtensionAPI,
	tracker: SegmentTracker,
	compactor: TreeCompactor,
	assembler: ContextAssembler,
) {
	return (event: { turnIndex: number; message: unknown; toolResults: unknown[] }, ctx: ExtensionContext) => {
		try {
			tracker.handleTurnEnd(pi, ctx, event.turnIndex, event.message, event.toolResults);
		} catch (err) {
			console.error("[infinite-context] turn_end error:", err);
		}
	};
}
```

- [ ] **Step 3: Simplify `createContextHandler`**

Remove `needsCompressionRef` parameter and the `shouldCompress` call:

```typescript
function createContextHandler(
	pi: ExtensionAPI,
	tracker: SegmentTracker,
	compactor: TreeCompactor,
	assembler: ContextAssembler,
) {
	return (event: ContextEvent, ctx: ExtensionContext) => {
		try {
			tracker.syncFromMessages(pi, ctx, event.messages);

			const segments = tracker.getSegments();
			const retentionWindow = tracker.getRetentionWindow();
			const tree = compactor.getTree();

			const contextUsage = ctx.getContextUsage();
			const contextWindow = contextUsage?.contextWindow ?? IC_CONFIG.defaultContextWindow;

			const result: AssembleResult = assembler.assembleMessages(
				event.messages as unknown as MinimalAgentMessage[],
				tree, segments, retentionWindow,
				contextWindow,
			);

			return { messages: result.messages as ContextEvent["messages"] };
		} catch (err) {
			console.error("[infinite-context] context error:", err);
			return undefined;
		}
	};
}
```

- [ ] **Step 4: Update registration calls in factory**

```typescript
pi.on("turn_end", createTurnEndHandler(pi, tracker, compactor, assembler));
pi.on("context", createContextHandler(pi, tracker, compactor, assembler));
```

- [ ] **Step 5: Remove unused import**

`compressAsync` is no longer imported in `index.ts` (only used by commands.ts if needed). Remove:
```typescript
import { compressAsync } from "./compression-runner";
```

If `compressAsync` is still used by commands.ts, keep the import in compression-runner.ts but remove from index.ts.

- [ ] **Step 6: Verify typecheck**

Run: `cd infinite-context && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "fix: unify compression into session_before_compact handler"
```

---

### Task 4: Verify typecheck passes

**Type:** backend

**Files:** None (verification only)

- [ ] **Step 1: Run full typecheck**

Run: `cd /path/to/xyz-pi-extensions && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 2: Run ESLint**

Run: `npm run lint`
Expected: 0 errors

---

## Interface Contracts

### Module: compression-runner

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `compressForCompaction` | `(pi, ctx, segments, compactor) => Promise<CompactResult \| null>` | `CompactResult \| null` | segments.length=0 → returns null | AC-2, AC-3 |
| `compressAsync` | `(pi, ctx, segments, compactor) => Promise<void>` | `void` | delegates to compressForCompaction | — |

### Module: index.ts (handlers)

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| `createBeforeCompactHandler` | `(pi, tracker, compactor) => async (event, ctx) => SessionBeforeCompactResult` | `{ cancel }` or `{ compaction }` | segments<3 → cancel:false; error → cancel:false; success → compaction result | AC-1, AC-2, AC-6 |
| `createTurnEndHandler` | `(pi, tracker, compactor, assembler) => (event, ctx) => void` | `void` | no compression logic | AC-5 |
| `createContextHandler` | `(pi, tracker, compactor, assembler) => (event, ctx) => { messages }` | `{ messages }` or `undefined` | no shouldCompress call | AC-4 |
| `buildTreeSummary` | `(tree: CompactTree) => string` | `string` | — | AC-1 |

### Data: CompactResult (existing)

| Field | Type | Description |
|-------|------|-------------|
| tree | CompactTree | The compressed tree |
| fallbackUsed | boolean | Whether rule-based fallback was used |
| retryCount | number | Number of LLM retries |
| errorReason | string \| undefined | Error if fallback was used |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-1: 无重复 compact 触发 | `createBeforeCompactHandler` → returns `{ compaction }` | Pi writes entry → timestamp guard works | Task 2 |
| AC-2: 对话流同步 | `createBeforeCompactHandler` (async) → Pi awaits handler | Pi `_runAutoCompaction` awaits handler → handler awaits `compressForCompaction` → handler awaits `triggerCompressionAsync` (spawn) | Task 1, 2 |
| AC-3: TUI 可渲染压缩状态 | `compressForCompaction` → `beforeCompressionUI`/`afterCompressionUI` | spawn (non-blocking) → events reach TUI | Task 1 |
| AC-4: context 不判断压缩 | `createContextHandler` (simplified) | No `shouldCompress` call | Task 3 |
| AC-5: turn_end 不触发压缩 | `createTurnEndHandler` (simplified) | No `compressAsync` call | Task 3 |
| AC-6: segments 不足时 fallback | `createBeforeCompactHandler` → segments<3 → `{ cancel: false }` | Pi executes native compact | Task 2 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1: 无重复 compact 触发 | adopted | Task 2 |
| AC-2: 对话流同步 | adopted | Task 1, 2 |
| AC-3: TUI 可渲染压缩状态 | adopted | Task 1 |
| AC-4: context 不判断压缩 | adopted | Task 3 |
| AC-5: turn_end 不触发压缩 | adopted | Task 3 |
| AC-6: segments 不足时 fallback | adopted | Task 2 |

## Execution Groups

#### BG1: Compact Handler Refactor

**Description:** All changes are in the infinite-context extension's handler functions. The 4 tasks form a single cohesive unit: add helper → rewrite handler → clean up → verify.

**Tasks:** Task 1, Task 2, Task 3, Task 4

**Files (预估):** 2 个文件（2 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（medium） |
| 注入上下文 | Task 描述 + spec AC-1~AC-6 + Pi API 类型定义 |
| 读取文件 | `infinite-context/src/index.ts`, `infinite-context/src/compression-runner.ts`, `infinite-context/src/tree-compactor.ts`, `infinite-context/src/context-handler.ts`, `infinite-context/src/types.ts` |
| 修改/创建文件 | `infinite-context/src/index.ts`, `infinite-context/src/compression-runner.ts` |

**Execution Flow (BG1 内部):** 串行，按 Task 1→2→3→4 顺序执行。

**Dependencies:** 无

## Dependency Graph & Wave Schedule

```
Task 1 → Task 2 → Task 3 → Task 4
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | Task 1, 2, 3, 4 | 全部串行，单一 group |
