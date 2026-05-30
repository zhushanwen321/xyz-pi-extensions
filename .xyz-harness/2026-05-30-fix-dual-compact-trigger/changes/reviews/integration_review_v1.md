---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 4
  issues_found: 3
  must_fix_count: 0
  low_count: 2
  info_count: 1
---

# Integration Review — fix-dual-compact-trigger

**Reviewer**: integration-reviewer
**Date**: 2026-05-30
**Scope**: `index.ts` ↔ `compression-runner.ts` ↔ `tree-compactor.ts` ↔ `commands.ts` 跨模块调用链路
**Baseline**: BLR v1 模拟数据 + UC 执行路径

---

## 1. 调用链路完整性验证

### 1.1 主路径：Pi core → session_before_compact handler → compression-runner → tree-compactor

```
Pi core: _runAutoCompaction
  └─ emit("session_before_compact", event={preparation:{firstKeptEntryId, tokensBefore}})
      │
index.ts: createBeforeCompactHandler(pi, tracker, compactor)
  │  1. tracker.getSegments() → readonly Segment[]
  │  2. segments.length < 3 → { cancel: false }  [Pi 原生 compact]
  │  3. await compressForCompaction(pi, ctx, segments, compactor)
  │     │
compression-runner.ts: compressForCompaction(pi, ctx, segments, compactor)
  │  4. segments.length === 0 → return null  [handler 返回 { cancel: false }]
  │  5. beforeCompressionUI(pi, ctx, segmentCount)
  │     ├─ ctx.getContextUsage()
  │     ├─ pi.appendEntry(IC_COMPACT_STATS_TYPE, {phase:"before",...})
  │     ├─ ctx.ui.setStatus("ic-compact", "...")
  │     └─ pi.sendMessage({customType: IC_COMPACT_START_TYPE, ...})
  │  6. await compactor.triggerCompressionAsync(pi, segments, compactor.getTree())
  │     │
tree-compactor.ts: triggerCompressionAsync(pi, segments, existingTree)
  │  7. runAsyncCompression(pi, segments, existingTree)
  │     ├─ 循环 [0..maxRetryCount]
  │     │  ├─ buildCompressionPrompt(segments, existingTree, lastError)
  │     │  ├─ await asyncSpawnPi(prompt) → {stdout, stderr, errorReason?}
  │     │  ├─ processSpawnResult(...) → TreeNode[] | undefined
  │     │  └─ 成功 → makeTree(validated, segments) → CompactTree
  │     │      ├─ this.tree = tree  [内部状态更新]
  │     │      ├─ pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree)  [持久化]
  │     │      └─ return {tree, fallbackUsed:false, retryCount, rawOutput}
  │     └─ 全部失败 → applyFallback(pi, segments, maxRetryCount, "All attempts failed")
  │         ├─ ruleBasedFallback(segments) → CompactTree
  │         ├─ pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree)
  │         └─ return {tree, fallbackUsed:true, retryCount, errorReason}
  │
  │  8. afterCompressionUI(pi, ctx, result)
  │     ├─ ctx.ui.setStatus("ic-compact", undefined)  [清除 footer]
  │     ├─ pi.appendEntry(IC_COMPACT_STATS_TYPE, {phase:"after",...})
  │     └─ pi.sendMessage({customType: IC_COMPACT_END_TYPE, ...})
  │
  │  9. return result → CompactResult | null
  │
index.ts: handler 继续
  10. !result → { cancel: false }
  11. fallbackUsed && errorReason → { cancel: false }  [Pi 原生 compact]
  12. buildTreeSummary(result.tree) → string
  13. return { compaction: { summary, firstKeptEntryId, tokensBefore } }
      │
Pi core: 收到 compaction 结果
  14. 写入 compaction entry → timestamp 保护生效
  15. 更新 messages → 下次 _checkCompaction 不触发
```

**验证结果**: ✅ 链路完整，每一步的参数类型和返回值消费正确。

### 1.2 参数传递类型检查

| 调用点 | 实参类型 | 形参类型 | 匹配 |
|--------|---------|---------|------|
| handler L126: `compressForCompaction(pi, ctx, segments, compactor)` | `(ExtensionAPI, ExtensionContext, readonly Segment[], TreeCompactor)` | `(ExtensionAPI, ExtensionContext, readonly Segment[], TreeCompactor)` | ✅ |
| runner L73: `compactor.triggerCompressionAsync(pi, segments, compactor.getTree())` | `(ExtensionAPI, readonly Segment[], CompactTree \| undefined)` | `(ExtensionAPI, readonly Segment[], CompactTree \| undefined)` | ✅ |
| handler L143-145: `event.preparation.firstKeptEntryId` / `tokensBefore` | `(string, number)` | Pi `CompactionResult` 的 `(string, number)` | ✅ |
| runner → `beforeCompressionUI(pi, ctx, segments.length)` | `(ExtensionAPI, ExtensionContext, number)` | 函数签名一致 | ✅ |
| runner → `afterCompressionUI(pi, ctx, result)` | `(ExtensionAPI, ExtensionContext, CompactResult)` | 函数签名一致 | ✅ |

### 1.3 tree-compactor 内部状态更新路径

`runAsyncCompression` 成功时：
```typescript
this.tree = tree;                              // 内部状态更新
pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree); // 持久化 entry
return { tree, fallbackUsed: false, ... };
```

`applyFallback` 时：
```typescript
const tree = ruleBasedFallback(segments);
pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree); // 持久化 entry
return { tree, fallbackUsed: true, ... };
```

**注意**: `applyFallback` 只写 entry，不更新 `this.tree`。但这是**正确行为**——当 fallback 有 errorReason 时，handler 返回 `{ cancel: false }`，Pi 执行原生 compact，此时 `this.tree` 保留的是上次成功的 tree（或 undefined）。下次 `getTree()` 返回旧 tree 或 undefined，对 context handler 的 `assembleMessages` 没有不良影响。

**验证结果**: ✅ 状态更新路径正确。

---

## 2. 错误传播路径验证

### 2.1 spawn 失败 → 重试 → fallback → handler cancel:false → Pi 原生 compact

```
asyncSpawnPi:
  ├─ child.on("error") → resolve({errorReason: "Spawn error: ..."})
  ├─ setTimeout → child.kill → resolve({errorReason: "Process timed out (...)"})
  └─ close code !== 0 → resolve({errorReason: "Process exited with code ..."})
      │
processSpawnResult:
  ├─ errorReason + stdout → tryValidate → 成功则 return TreeNode[]
  └─ 失败 → return undefined → 重试
      │
runAsyncCompression:
  └─ 所有重试耗尽 → applyFallback(pi, segments, maxRetryCount, "All attempts failed")
      │
handler:
  └─ fallbackUsed && errorReason → { cancel: false }
      │
Pi: 执行原生 compact
```

**验证**: ✅ spawn 失败的任何形式（error/timeout/non-zero-exit）都最终走到 Pi 原生 compact。中间有 partial output recovery 机制（`processSpawnResult` 在有 stdout 时尝试 validate），提供了额外的成功机会。

### 2.2 compressForCompaction 异常 throw → handler catch → cancel:false

```
compressForCompaction 抛出非预期异常
  └─ handler try/catch 捕获
      ├─ console.error("[infinite-context] before_compact compression error:", err)
      └─ return { cancel: false }
          │
Pi: 执行原生 compact
```

**验证**: ✅ 异常不会逃逸到 Pi 核心，不会导致进程崩溃。

### 2.3 异常场景下的 UI 状态一致性

**问题**: 如果 `beforeCompressionUI` 已执行（设置了 footer status 和 start 气泡），但 `triggerCompressionAsync` 抛出异常，`afterCompressionUI` 不会执行，footer status 不会被清除。

**实际影响**: handler 的 catch 返回 `{ cancel: false }`，Pi 继续执行原生 compact。原生 compact 完成后 Pi 的 UI 会刷新，footer status 会被覆盖。TUI 模式下这是一个短暂的视觉残留，不会造成功能问题。

**严重度**: LOW — 视觉残留，无功能影响。

---

## 3. 状态一致性验证

### 3.1 tree 状态更新

| 场景 | `this.tree` | `appendEntry` | handler 返回 | Pi 行为 |
|------|------------|---------------|-------------|---------|
| 首次成功 | 新 tree ✅ | ✅ | compaction ✅ | 写入 compaction entry |
| 二次成功 | 新 tree ✅ | ✅ | compaction ✅ | 写入 compaction entry |
| 重试耗尽 + fallback + errorReason | 不更新（保留旧 tree 或 undefined） | ✅ | cancel:false | 原生 compact |
| 重试耗尽 + fallback 无 errorReason | 不更新 | ✅ | compaction ✅ | 写入 compaction entry |
| 异常 throw | 不更新 | 未写入 | cancel:false | 原生 compact |

**验证**: ✅ 所有路径的 tree 状态和 entry 写入一致。

### 3.2 compaction entry 写入（timestamp 保护）

Pi 核心在收到 `{ compaction: { summary, firstKeptEntryId, tokensBefore } }` 后写入 compaction entry，该 entry 的 timestamp 用于下次 `_checkCompaction` 的防重入判断。

旧代码返回 `{ cancel: true }` → Pi 不写入任何 entry → timestamp 保护失效 → 下次 prompt 触发重复 compact。

新代码返回 `{ compaction: ... }` → Pi 写入 entry → timestamp 保护生效 → 问题修复。

**验证**: ✅ compaction entry 写入路径正确。

### 3.3 session_start 恢复

```typescript
// index.ts
createSessionStartHandler(tracker, compactor)
  → tracker.restoreState(entries)  // 从 entries 恢复段状态
  → compactor.restoreState(entries) // 从 entries 恢复 tree
```

`compactor.restoreState` 从后往前扫描 entries，取最新的 `COMPACT_TREE_ENTRY_TYPE` entry 作为 `this.tree`。

handler 成功路径会通过 `runAsyncCompression` 或 `applyFallback` 写入 `COMPACT_TREE_ENTRY_TYPE` entry。这些 entry 在 session 恢复时会被正确读取。

**验证**: ✅ 恢复路径正确。

---

## 4. commands.ts 调用链路

### 4.1 /tree-compact 命令

```typescript
// commands.ts L38
await compressAsync(pi, ctx, allSegments, compactor);
```

`compressAsync` 内部委托给 `compressForCompaction`：

```typescript
// compression-runner.ts L87
export async function compressAsync(pi, ctx, segments, compactor): Promise<void> {
  if (segments.length === 0) return;
  await compressForCompaction(pi, ctx, segments, compactor);
}
```

**调用链**: `commands.ts` → `compressAsync` → `compressForCompaction` → `compactor.triggerCompressionAsync`

**验证**:
- `compressAsync` 是 fire-and-forget 语义（返回 void），commands.ts 用 `await` 等待完成 ✅
- `compressForCompaction` 返回 `CompactResult | null`，`compressAsync` 忽略返回值 ✅
- segments.length === 0 的 early return 在两个函数中都有，`compressAsync` 的检查在 `compressForCompaction` 之前，不冗余但无害 ✅
- 命令路径不经过 `createBeforeCompactHandler`，不受本次变更影响 ✅

**结论**: ✅ commands.ts 调用链路不受影响。

### 4.2 命令触发和 session_before_compact 触发的隔离性

`/tree-compact` 命令是用户手动触发，`session_before_compact` 是 Pi 自动触发。两者共享 `compactor` 实例（同一闭包），但不会并发：

- **session_before_compact handler**: Pi 的 `_runAutoCompaction` 调用前会暂停 LLM 请求，handler 是 await 的，不会和命令并发
- **/tree-compact 命令**: 用户在对话中输入命令时，Pi 不会同时触发 auto compaction

因此 `compactor.triggerCompressionAsync` 不会被两个路径同时调用，`this.tree` 的并发更新不构成风险。

**验证**: ✅ 隔离性正确。

---

## 5. BLR UC 路径交叉验证

### 5.1 UC-1 主路径（场景 A：首次压缩，5 segments）

按照 BLR 的模拟数据走一遍实际代码路径：

```
segments = [seg_0..seg_4], tree = undefined

handler:
  tracker.getSegments() → [seg_0..seg_4]  // 5 segments
  segments.length = 5 >= 3 → 进入压缩
  compressForCompaction(pi, ctx, segments, compactor)
    segments.length = 5 ≠ 0 → 继续
    beforeCompressionUI(pi, ctx, 5)
      → ctx.ui.setStatus("ic-compact", "IC compressing 5 segments...")
      → pi.sendMessage({customType: "ic-compact-start", content: "5 segments, ..."})
    compactor.triggerCompressionAsync(pi, [seg_0..seg_4], undefined)
      → runAsyncCompression(pi, [seg_0..seg_4], undefined)
        → buildCompressionPrompt([seg_0..seg_4], undefined, undefined)
        → asyncSpawnPi(prompt) → {stdout: "...", errorReason: undefined}
        → processSpawnResult → extractAssistantText → validateTreeOutput → TreeNode[]
        → makeTree(validated, [seg_0..seg_4]) → CompactTree{treeId, root, totalTokens, ...}
        → this.tree = tree ✅
        → pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree) ✅
        → return {tree, fallbackUsed: false, retryCount: 0}
    afterCompressionUI(pi, ctx, result)
      → ctx.ui.setStatus("ic-compact", undefined) ✅
      → pi.sendMessage({customType: "ic-compact-end", ...}) ✅
      → pi.appendEntry(IC_COMPACT_STATS_TYPE, {phase:"after",...}) ✅
    return result → CompactResult{tree, fallbackUsed:false}

  !result → false
  fallbackUsed && errorReason → false (fallbackUsed=false)
  buildTreeSummary(tree) → "[IC Tree Compact] 2 groups, 500 tokens, depth 2\n- ..."
  
  return {
    compaction: {
      summary: "[IC Tree Compact] 2 groups, 500 tokens, depth 2\n- ...",
      firstKeptEntryId: event.preparation.firstKeptEntryId,  // Pi 传入
      tokensBefore: event.preparation.tokensBefore,          // Pi 传入
    }
  }

Pi: 收到 compaction → 写入 entry → timestamp 保护
```

**交叉验证结果**: ✅ 与 BLR 推演完全一致，每个模块的接口调用正确。

### 5.2 UC-1 Alt 4a（fallback + errorReason）

```
runAsyncCompression: 所有重试失败
  → applyFallback(pi, segments, 1, "All attempts failed")
    → ruleBasedFallback(segments) → CompactTree（每段一个 leaf node）
    → pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree)  ✅ entry 写入
    → return {tree, fallbackUsed:true, retryCount:1, errorReason:"All attempts failed"}

  afterCompressionUI(pi, ctx, result)
    → ctx.ui.setStatus("ic-compact", undefined)  ✅
    → pi.sendMessage({customType:"ic-compact-end", details:{fallbackUsed:true, errorReason:"..."}})  ✅

  return result → CompactResult{fallbackUsed:true, errorReason:"All attempts failed"}

handler:
  fallbackUsed && errorReason → true
  return { cancel: false }

Pi: 执行原生 compact
```

**交叉验证结果**: ✅ fallback 路径的 entry 写入、UI 清理、handler 返回值全部正确。

### 5.3 UC-2（segments 不足）

```
tracker.getSegments() → [] 或 [seg_0] 或 [seg_0, seg_1]

handler:
  segments.length < 3 → true
  return { cancel: false }

Pi: 执行原生 compact
```

**交叉验证结果**: ✅ 最简路径，不进入压缩逻辑，无副作用。

---

## 6. 发现的问题

### INFO-1: compressAsync 的 segments.length === 0 检查冗余

**位置**: `compression-runner.ts` L84-85 + L65-66

```typescript
// compressAsync
export async function compressAsync(...): Promise<void> {
  if (segments.length === 0) return;        // ← 检查 1
  await compressForCompaction(pi, ctx, segments, compactor);
}

// compressForCompaction
export async function compressForCompaction(...): Promise<CompactResult | null> {
  if (segments.length === 0) return null;   // ← 检查 2（同一条件）
  ...
}
```

两层都检查了 `segments.length === 0`。`compressForCompaction` 的检查已经足够保护。`compressAsync` 的额外检查避免了不必要的函数调用开销，但代码阅读时需要确认两层逻辑的一致性。

**严重度**: INFO — 无功能影响，轻微的防御冗余。

### LOW-1: 异常路径 footer status 未清除

**位置**: `index.ts` handler L148-150 + `compression-runner.ts` L72-76

当 `beforeCompressionUI` 已执行（设置 footer status）后，`triggerCompressionAsync` 抛出异常（非重试耗尽，而是未预期的 throw），`afterCompressionUI` 不会被调用。footer status "IC compressing N segments..." 会残留在 TUI 底部。

Pi 原生 compact 完成后 UI 刷新会覆盖，但中间有视觉残留。

**严重度**: LOW — 视觉残留，无功能影响。可通过在 handler catch 中调用 `ctx.ui.setStatus("ic-compact", undefined)` 修复。

### LOW-2: turn_end handler 未使用参数的传参开销

**位置**: `index.ts` L164

```typescript
pi.on("turn_end", createTurnEndHandler(pi, tracker, compactor, assembler));
```

`compactor` 和 `assembler` 作为实参传入，但 `createTurnEndHandler` 内部以 `_compactor` 和 `_assembler` 接收后未使用。JS 层面无性能影响（传引用），但接口上有噪音。

BLR LOW-1 已记录此问题。集成审查确认：由于 turn_end handler 不再调用任何压缩逻辑，这两个参数可以安全删除，不影响集成链路。

**严重度**: LOW — 无功能影响，建议清理。

---

## 7. 审查总结

| 维度 | 评估 |
|------|------|
| 主调用链路 | Pi → handler → compressForCompaction → triggerCompressionAsync → makeTree/applyFallback，链路完整 |
| 参数类型传递 | 4 个调用点全部类型匹配，无隐式转换 |
| 错误传播 | spawn 失败/timeout/error → 重试 → fallback → cancel:false → Pi 原生 compact，全路径安全 |
| 异常防护 | handler catch 兜底，不会逃逸到 Pi 核心 |
| 状态一致性 | tree 内部状态 + appendEntry 持久化在所有路径上一致 |
| timestamp 保护 | handler 返回 compaction → Pi 写入 entry → 保护生效 |
| commands.ts | /tree-compact 命令通过 compressAsync → compressForCompaction 委托，不受本次变更影响 |
| BLR 交叉验证 | 3 个 UC 路径（主路径、fallback、segments 不足）全部与代码实际执行一致 |
| 并发安全 | 手动命令和自动 compact 不会并发，共享 compactor 实例无风险 |

**Verdict**: **PASS** — 跨模块调用链路完整，接口参数类型匹配，错误传播路径正确，状态一致性在所有执行路径上一致，commands.ts 不受影响。3 个问题均为 INFO/LOW 级别，无功能影响。
