---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 2
  issues_found: 3
  must_fix_count: 0
  low_count: 2
  info_count: 1
---

# Business Logic Review — fix-dual-compact-trigger

**Reviewer**: business-logic-reviewer
**Date**: 2026-05-30
**Scope**: `infinite-context/src/index.ts`, `infinite-context/src/compression-runner.ts`
**Baseline**: spec.md AC-1~AC-6, use-cases.md UC-1/UC-2

---

## 1. AC 逐条验证

### AC-1: 无重复 compact 触发 ✅

**要求**: 压缩完成后，下次 prompt 不触发多余的 `_runAutoCompaction`。

**实现验证**:
- `createBeforeCompactHandler` 在 tree-compact 成功时返回 `{ compaction: { summary, firstKeptEntryId, tokensBefore } }`（L138-147）
- Pi 收到此结果后写入 compaction entry，timestamp 防重入保护生效
- 旧代码返回 `{ cancel: true }` 导致无 entry → 保护失效。新代码不再使用 cancel，问题修复

**结论**: 正确覆盖。

### AC-2: 对话流同步 ✅

**要求**: 压缩期间不发送 LLM 请求，压缩完成后才继续。

**实现验证**:
- `createBeforeCompactHandler` 是 `async` 函数（L117）
- 内部 `await compressForCompaction(...)` 等待压缩完成（L126）
- `compressForCompaction` 内部 `await compactor.triggerCompressionAsync(...)`（compression-runner.ts L73）
- Pi 的 `_runAutoCompaction` await handler → 对话流同步

**结论**: 正确覆盖。

### AC-3: TUI 可渲染压缩状态 ✅

**要求**: 压缩过程中 ic-compact-start/end 气泡和 footer status 正常显示。

**实现验证**:
- `compressForCompaction` 调用 `beforeCompressionUI` 和 `afterCompressionUI`（compression-runner.ts L72-74）
- `beforeCompressionUI` 通过 `pi.sendMessage` 发送气泡 + `ctx.ui.setStatus` 设置 footer（L12-18）
- `triggerCompressionAsync` 使用 `spawn`（异步，非 `spawnSync`），不阻塞事件循环
- TUI 可以在 spawn 期间处理 UI 事件

**结论**: 正确覆盖。

### AC-4: context 事件不判断压缩 ✅

**要求**: `createContextHandler` 中不再调用 `shouldCompress`，不再设置 `needsCompressionRef`。

**实现验证**:
- `createContextHandler` 签名中已移除 `needsCompressionRef` 参数（L48）
- 函数体内无 `shouldCompress` 调用
- git diff 确认移除了原 L68-70 的 `needsCompressionRef.value = ...` 逻辑
- `needsCompression` 变量从工厂函数中完全移除

**结论**: 正确覆盖。

### AC-5: turn_end 不触发压缩 ✅

**要求**: `createTurnEndHandler` 中不再调用 `compressAsync`。

**实现验证**:
- `createTurnEndHandler` 签名中 `compactor` 和 `assembler` 参数已变为 `_compactor`/`_assembler`（未使用前缀）
- 函数体只调用 `tracker.handleTurnEnd`，无压缩逻辑
- git diff 确认移除了原 `if (needsCompressionRef.value) { ... }` 块

**结论**: 正确覆盖。

### AC-6: segments 不足时 Pi 原生 fallback ✅

**要求**: 当 segments 为空或 tree-compact 全部重试失败时，不返回 compaction 结果，让 Pi 用原生方式压缩。

**实现验证**:
- segments < 3 → 返回 `{ cancel: false }`（L121）
- `compressForCompaction` 返回 null（segments=0）→ 返回 `{ cancel: false }`（L130）
- fallbackUsed && errorReason → 返回 `{ cancel: false }`（L134）
- 异常 catch → 返回 `{ cancel: false }`（L150）
- 以上所有路径 Pi 都会执行原生 compact

**结论**: 正确覆盖。

---

## 2. UC 执行路径模拟

### UC-1: 正常压缩流程

**前提**: segments ≥ 3，tree-compact 成功

```
1. Pi emit session_before_compact(event={preparation:{firstKeptEntryId, tokensBefore}})
2. handler: segments.length >= 3 → 继续
3. await compressForCompaction(pi, ctx, segments, compactor)
   → beforeCompressionUI: 发气泡 + set footer status
   → await triggerCompressionAsync: spawn pi 进程
   → afterCompressionUI: 清 status + 发完成气泡
   → 返回 CompactResult{tree, fallbackUsed=false, retryCount=0}
4. result !== null, fallbackUsed=false → 跳过 fallback 检查
5. buildTreeSummary(result.tree) → 生成文本摘要
6. 返回 { compaction: { summary, firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }
7. Pi 写入 compaction entry → timestamp 保护生效
```

**路径验证**: ✅ 与 UC-1 main flow 完全一致。

### UC-1 Alt 4a: 压缩失败（fallback + errorReason）

```
1-3. 同上，但所有重试失败
3'. triggerCompressionAsync → applyFallback → CompactResult{fallbackUsed=true, errorReason="All attempts failed"}
4'. result !== null, fallbackUsed && errorReason → true
5'. 返回 { cancel: false }
6'. Pi 执行原生 compact
```

**路径验证**: ✅ 与 UC-1 Alt 4a 一致。

### UC-1 Alt 4b: spawn 超时

```
3''. asyncSpawnPi 内 setTimeout 触发 → child.kill → resolve({errorReason: "Process timed out"})
3''. 重试耗尽 → applyFallback(pi, segments, maxRetryCount, "All attempts failed")
→ 同 Alt 4a 路径
```

**路径验证**: ✅ 超时最终走到 fallback with errorReason。

### UC-2: Segments 不足

```
1. Pi emit session_before_compact
2. handler: segments.length < 3
3. 返回 { cancel: false }
4. Pi 执行原生 compact
```

**路径验证**: ✅ 与 UC-2 完全一致。

---

## 3. 边界条件检查

### segments=0

- `createBeforeCompactHandler` L121: `segments.length < 3` → true → 返回 `{ cancel: false }`
- **不会调用** `compressForCompaction`
- Pi 原生 compact 执行

**结论**: ✅ 安全路径。

### segments=1, segments=2

- 同 segments=0 路径，`< 3` 条件命中 → `{ cancel: false }`

**结论**: ✅ 安全路径。

### segments=3（边界值）

- `< 3` 不满足 → 进入压缩流程
- `triggerCompressionAsync` 在 segments≥1 时正常执行
- 3 个 segments 足够 tree-compact 构建 group

**结论**: ✅ 正确。

### Compression failure（所有重试耗尽）

- `triggerCompressionAsync` → `applyFallback(..., "All attempts failed")`
- `fallbackUsed=true, errorReason="All attempts failed"`
- `result.fallbackUsed && result.errorReason` → true → `{ cancel: false }`

**结论**: ✅ Pi 原生 fallback 生效。

### Spawn timeout

- `asyncSpawnPi` 内 `setTimeout → child.kill → resolve({errorReason: "Process timed out ..."})`
- 重试耗尽后走到 `applyFallback` with errorReason
- 同 compression failure 路径

**结论**: ✅ 安全。

### Spawn error（如 pi 命令不存在）

- `child.on("error")` → resolve({errorReason: "Spawn error: ..."})
- 重试耗尽后同上

**结论**: ✅ 安全。

### 异常 throw（compressForCompaction 抛出非预期异常）

- `try/catch` 捕获 → `console.error` → `{ cancel: false }`

**结论**: ✅ Pi 原生 fallback。

---

## 4. Pi API 使用检查

### `SessionBeforeCompactEvent` 的 `preparation` 字段

- Pi 核心类型定义：`preparation: CompactionPreparation`
- `CompactionPreparation.firstKeptEntryId: string` — UUID
- `CompactionPreparation.tokensBefore: number` — 压缩前 token 数

**代码使用**（L143-145）:
```typescript
firstKeptEntryId: event.preparation.firstKeptEntryId,
tokensBefore: event.preparation.tokensBefore,
```

**验证**: 字段名和类型完全匹配 Pi 核心接口 ✅

### `SessionBeforeCompactResult` 返回类型

Pi 核心定义:
```typescript
interface SessionBeforeCompactResult {
    cancel?: boolean;
    compaction?: CompactionResult;
}
```

Pi 核心的 `CompactionResult`:
```typescript
interface CompactionResult<T = unknown> {
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: T;
}
```

**代码返回值**:
1. `{ cancel: false }` — 匹配 `cancel?: boolean` ✅
2. `{ compaction: { summary, firstKeptEntryId, tokensBefore } }` — 匹配 `CompactionResult` ✅

**命名注意**: Pi 核心的 `CompactionResult` 和扩展的 `CompactResult` 是两个不同类型。代码中 import 使用 `CompactResult`（扩展类型）是正确的，返回给 Pi 时构建的 object literal 符合 Pi 的 `CompactionResult` 接口。TypeScript structural typing 保证类型兼容。

**结论**: ✅ API 使用正确。

### Handler 签名

```typescript
async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => SessionBeforeCompactResult
```

Pi 调用 handler 时传入 `(event, ctx)` — 代码接收 `(event: SessionBeforeCompactEvent, ctx: ExtensionContext)` ✅

---

## 5. 业务数据推演

### 场景 A: 首次压缩，5 segments

```
segments = [seg_0, seg_1, seg_2, seg_3, seg_4] (全部 completed)
tree = undefined (首次)

handler:
  segments.length = 5 >= 3 → 进入压缩
  compressForCompaction(pi, ctx, segments, compactor)
    → beforeCompressionUI: "IC compressing 5 segments..."
    → triggerCompressionAsync:
        → buildCompressionPrompt(segments, undefined, undefined)
        → asyncSpawnPi → spawn pi process
        → 成功 → makeTree → tree = {root: {children: [group1, group2]}, totalTokens: 500, depth: 2}
    → afterCompressionUI: "✅ IC Tree Compact 2 groups, 500 tokens"
    → 返回 CompactResult{tree, fallbackUsed: false, retryCount: 0}

  result !== null → 继续
  fallbackUsed = false → 跳过检查
  buildTreeSummary:
    "[IC Tree Compact] 2 groups, 500 tokens, depth 2\n- group1 summary (2 segments)\n- group2 summary (3 segments)"
  
  返回 { compaction: { summary: "...", firstKeptEntryId: "uuid-xxx", tokensBefore: 15000 } }

Pi:
  写入 compaction entry
  更新 agent.state.messages
  下次 _checkCompaction: timestamp 保护 → 不触发
```

**推演结果**: ✅ 完整流程正确。

### 场景 B: 二次压缩，8 segments + 已有 tree

```
segments = [seg_0..seg_7], tree = {root: {children: [g1, g2]}, totalTokens: 500}

handler:
  segments.length = 8 >= 3 → 进入
  compressForCompaction:
    → triggerCompressionAsync(segments, existingTree)
    → buildCompressionPrompt 包含已有 tree 信息
    → 成功 → 新 tree = {root: {children: [g1, g2, g3]}, totalTokens: 800}
  
  返回 { compaction: { summary: "...", firstKeptEntryId: "uuid-yyy", tokensBefore: 22000 } }
```

**推演结果**: ✅ 增量压缩正确。

### 场景 C: LLM 压缩失败，fallback 成功（无 errorReason）

```
triggerCompressionAsync:
  → 所有重试失败
  → applyFallback(pi, segments, maxRetryCount, "All attempts failed")
  → CompactResult{tree: ruleBasedResult, fallbackUsed: true, errorReason: "All attempts failed"}

handler:
  fallbackUsed && errorReason → true
  返回 { cancel: false }

Pi: 执行原生 compact
```

**推演结果**: ✅ Fallback 路径正确。

---

## 6. 发现的问题

### INFO-1: fallbackUsed=true 但 errorReason=undefined 的 fallback 没有被拦截

**位置**: `createBeforeCompactHandler` L133-135

```typescript
if (result.fallbackUsed && result.errorReason) {
    return { cancel: false };
}
```

当 `fallbackUsed=true, errorReason=undefined` 时（如 `runAsyncCompression` 中 segments=0 的 `applyFallback(pi, segments, 0)` 无 errorReason），此条件为 false，会走到返回 compaction 结果的路径。

**实际影响**: 无。因为 `compressForCompaction` 在 `segments.length === 0` 时返回 `null`（L67），不会到达 `triggerCompressionAsync`。而 `segments.length < 3` 在 handler 层已经拦截。segments ≥ 3 时 `triggerCompressionAsync` 内的 `segments.length === 0` 不可达。

**严重度**: INFO — 当前无实际影响，但逻辑依赖调用链上游的防御。如果未来 `compressForCompaction` 的 segments=0 early return 被移除，此处会产生非预期行为。

### LOW-1: turn_end handler 的未使用参数保留

**位置**: `createTurnEndHandler` L33-34

```typescript
_compactor: TreeCompactor,
_assembler: ContextAssembler,
```

这两个参数不再使用，仅以 `_` 前缀保留。虽然不违反规范，但在工厂函数调用点 `createTurnEndHandler(pi, tracker, compactor, assembler)` 仍传入这些参数。这可能是为了保持调用签名的一致性，但也可以考虑直接删除参数和调用点对应的传参。

**实际影响**: 无功能影响，轻微的接口噪音。

### LOW-2: `compressAsync` 仍被 commands.ts 使用，但不再是自动触发路径

**位置**: `compression-runner.ts` L80-87, `commands.ts` L38

`compressAsync` 现在委托给 `compressForCompaction`。`commands.ts` 的 `/tree-compact` 命令使用 `compressAsync`（fire-and-forget 语义）。这在功能上是正确的，但 `compressAsync` 和 `compressForCompaction` 的命名区别仅在于返回类型（void vs CompactResult|null），语义差异不如命名表达的那么清晰。

**实际影响**: 无功能影响，命名可以更清晰（如考虑将 `compressAsync` 重命名为 `compressForCommand`）。

---

## 7. 审查总结

| 维度 | 评估 |
|------|------|
| AC 覆盖 | 6/6 AC 完全覆盖 |
| UC 路径 | UC-1（含 2 个 alt path）和 UC-2 全部路径验证通过 |
| 边界条件 | segments=0/1/2/3、failure、timeout、spawn error、异常 throw 全部安全 |
| Pi API 使用 | `SessionBeforeCompactEvent.preparation` 字段正确使用，返回值符合 `SessionBeforeCompactResult` 接口 |
| 类型安全 | TypeScript strict typing 通过，无 any，类型区分正确（Pi CompactionResult vs 扩展 CompactResult） |
| 数据推演 | 3 个场景（首次压缩、二次压缩、fallback）全部推演正确 |

**Verdict**: **PASS** — 所有 AC 正确覆盖，边界条件处理安全，Pi API 使用正确。发现的 3 个问题均为 INFO/LOW 级别，无功能影响。
