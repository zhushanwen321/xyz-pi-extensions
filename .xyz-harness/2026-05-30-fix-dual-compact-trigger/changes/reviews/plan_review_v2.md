---
review:
  type: plan_review
  round: 2
  timestamp: "2026-05-30T19:00:00"
  target: ".xyz-harness/2026-05-30-fix-dual-compact-trigger/plan.md"
  verdict: pass
  summary: "计划评审第2轮增量审查，3条MUST FIX全部已修复，0条新增问题，通过"

statistics:
  total_issues: 7
  must_fix: 0
  must_fix_resolved: 3
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 1 — compressForCompaction 返回值"
    title: "segments.length=0 时返回 fallback CompactResult 但不调用 beforeCompressionUI，与 compressAsync 行为不一致"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 1 — compressAsync segments=0 行为"
    title: "compressAsync 在 commands.ts 中仍被使用，不能简单 delegate 到 compressForCompaction——compressForCompaction 在 segments=0 时返回 fallback 而非 void，语义不同"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Task 2 — createBeforeCompactHandler 注册改动"
    title: "handler 的 ctx 参数传递说明不完整，Step 2 只说 pass pi as first argument"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 4
    severity: LOW
    location: "plan.md:Interface Contracts"
    title: "buildTreeSummary 是 index.ts 内的私有 helper，未列入 Interface Contracts"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 5
    severity: LOW
    location: "plan.md:Task 1 — compressForCompaction 空 segments 处理"
    title: "treeId 固定为 'empty' 可能在多次调用时产生重复 ID"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
  - id: 6
    severity: LOW
    location: "plan.md:File Structure — context-handler.ts"
    title: "context-handler.ts 标注为 no change，但 shouldCompress 在清理后变为死代码"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "plan.md:Wave Schedule"
    title: "4 个 Task 全部在 Wave 1 串行执行，Wave 编排概念冗余但不造成问题"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v2（增量审查）

## 评审记录
- 评审时间：2026-05-30 19:00
- 评审类型：计划评审（增量审查模式）
- 评审对象：`.xyz-harness/2026-05-30-fix-dual-compact-trigger/plan.md`（修复后版本）
- 上一轮评审：`plan_review_v1.md`（3 条 MUST FIX）

## MUST FIX 修复验证

### Issue #1 — `compressForCompaction` segments=0 返回值 ✅ FIXED

**v1 问题**：segments=0 时返回 fallback CompactResult 对象，但未调用 UI 函数，且与 `compressAsync` 行为不一致。

**v2 修复验证**：

```typescript
// plan.md Task 1 Step 1 — 修复后代码
export async function compressForCompaction(
    pi: ExtensionAPI, ctx: ExtensionContext,
    segments: readonly Segment[], compactor: TreeCompactor,
): Promise<CompactResult | null> {
    if (segments.length === 0) return null;  // ← 修复：返回 null 而非 fallback CompactResult
    beforeCompressionUI(pi, ctx, segments.length);
    const result = await compactor.triggerCompressionAsync(pi, segments, compactor.getTree());
    afterCompressionUI(pi, ctx, result);
    return result;
}
```

- 返回类型从隐式的 `CompactResult`（带 fallbackUsed 标记）改为显式的 `CompactResult | null` ✅
- segments=0 直接返回 `null`，不创建无意义的 fallback 对象 ✅
- segments>0 时才调用 UI 函数（`beforeCompressionUI`/`afterCompressionUI`），时序正确 ✅
- handler 中有对应的 `if (!result)` 检查（Task 2 Step 1 第 4 步），null → `{ cancel: false }` → Pi 原生 compact ✅
- Interface Contracts 表已更新：`CompactResult | null`，edge case 标注 "segments.length=0 → returns null" ✅

**结论**：完全修复，逻辑清晰。

---

### Issue #2 — `compressAsync` segments=0 early return 保留 ✅ FIXED

**v1 问题**：`compressAsync` 如果直接 delegate 到 `compressForCompaction`（返回 fallback CompactResult），会改变 `/tree-compact` 命令的空 session 行为（出现无意义的压缩气泡）。

**v2 修复验证**：

```typescript
// plan.md Task 1 Step 1 — 修复后代码
export async function compressAsync(
    pi: ExtensionAPI, ctx: ExtensionContext,
    segments: readonly Segment[], compactor: TreeCompactor,
): Promise<void> {
    if (segments.length === 0) return;  // ← 修复：保留原始 early return
    await compressForCompaction(pi, ctx, segments, compactor);
}
```

- `compressAsync` 保留了 segments=0 的 early return（`return` void），不调 UI ✅
- 仅在 segments>0 时才 delegate 到 `compressForCompaction` ✅
- commands.ts 的 `/tree-compact` 行为不受影响（空 session → 静默返回） ✅
- plan 文字明确说明："The existing `compressAsync` retains its original segments=0 early-return behavior (no UI, no compression)" ✅

**结论**：完全修复，commands.ts 行为不变。

---

### Issue #3 — Task 2 Step 2 handler 参数变化说明 ✅ FIXED

**v1 问题**：Step 2 只说 "pass pi as first argument"，未说明 handler 从 `() => {...}` 变为 `(event, ctx) => {...}`，也未解释 `ctx` 的来源和类型。

**v2 修复验证**：

1. **Step 1 补充了详细说明**：

   > Note: `ctx` comes from Pi's emit call — `this._extensionRunner.emit({ type: "session_before_compact", ... })` passes the current `ExtensionContext` to each handler. This is the same `ctx` used in all other handlers.

   明确说明了 `ctx` 来自 Pi 的 emit 调用，类型是 `ExtensionContext`，与所有其他 handler 一致 ✅

2. **handler 签名代码清晰**：

   ```typescript
   return async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => { ... }
   ```

   参数列表 `(event, ctx)` 与 Pi emit 传入的 `(event, ctx)` 一一对应 ✅

3. **Step 2 展示了注册变更 diff**：

   ```typescript
   // Old:
   pi.on("session_before_compact", createBeforeCompactHandler(tracker, compactor));
   // New:
   pi.on("session_before_compact", createBeforeCompactHandler(pi, tracker, compactor));
   ```

   旧版 handler 是无参数闭包 `() => {...}`，新版接收 `(event, ctx)` —— 这个变化通过 Step 1 的代码 + Step 2 的注册 diff 共同传达，执行者不会误解 ✅

4. **`ctx` 传递链完整**：handler 的 `ctx` → `compressForCompaction(pi, ctx, ...)` → UI 函数 `beforeCompressionUI(pi, ctx, ...)` ✅

**结论**：完全修复。v1 建议的 "handler 通过闭包捕获 pi，参数列表 (event, ctx) 与 Pi emit 一致，ctx 直接传给 compressForCompaction" 已在 Step 1 的 Note 中完整覆盖。

---

## 回归检查

修复未引入新问题：

| 检查点 | 结果 |
|--------|------|
| `compressForCompaction` null 返回值在 handler 中被正确处理 | ✅ Task 2 Step 1 有 `if (!result)` 检查 |
| `compressAsync` 对 commands.ts 无行为变更 | ✅ segments=0 early return 保留 |
| handler 注册签名与 Pi emit 一致 | ✅ `(event, ctx)` 参数明确 |
| Interface Contracts 表与代码一致 | ✅ 返回类型、edge case 已更新 |
| `buildTreeSummary` 已加入 Interface Contracts（v1 Issue #4 LOW） | ✅ 已列入 Module: index.ts 表 |
| 硬编码 `treeId: "empty"` 问题（v1 Issue #5 LOW） | ✅ 已消除（segments=0 返回 null，不再创建 fallback tree） |

---

## LOW/INFO 状态更新

| # | 状态 | 说明 |
|---|------|------|
| 4 (LOW) | resolved | `buildTreeSummary` 已列入 Interface Contracts 表 |
| 5 (LOW) | resolved | fallback tree 的 `treeId: "empty"` 问题已消除（不再创建 fallback tree） |
| 6 (LOW) | open | `context-handler.ts` 的 `shouldCompress` 在 Task 3 后无调用方，标注仍为 "no change, used by /context-status command"——实际 `/context-status` 命令不调用 `shouldCompress`。不阻塞，可后续清理 |
| 7 (INFO) | open | Wave 编排冗余，不造成问题 |

---

## 结论

**通过。** 第 1 轮的 3 条 MUST FIX 全部修复，无回归。修复方案干净：`compressForCompaction` segments=0 → null（简单明确），`compressAsync` 保留 early return（行为不变），handler 参数传递说明完整。

### Summary

计划评审完成，第2轮增量审查，3条MUST FIX全部resolved，0条新增MUST FIX，通过。Plan 可进入编码阶段。
