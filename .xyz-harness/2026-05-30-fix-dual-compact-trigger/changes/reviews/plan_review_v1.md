---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-30T18:30:00"
  target: ".xyz-harness/2026-05-30-fix-dual-compact-trigger/plan.md"
  verdict: fail
  summary: "计划评审第1轮，3条MUST FIX，需修改后重审"

statistics:
  total_issues: 7
  must_fix: 3
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 1 — compressForCompaction 返回值"
    title: "segments.length=0 时返回 fallback CompactResult 但不调用 beforeCompressionUI，与 compressAsync 行为不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task 3 — compressAsync 保留为 wrapper"
    title: "compressAsync 在 commands.ts 中仍被使用，不能简单 delegate 到 compressForCompaction——compressForCompaction 在 segments=0 时返回 fallback 而非 void，语义不同"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Task 2 — createBeforeCompactHandler"
    title: "handler 的 ctx 参数缺失——当前注册行 `pi.on(\"session_before_compact\", createBeforeCompactHandler(tracker, compactor))` 返回的函数签名是 `() => {...}`，但 Pi 实际调用时传入 `(event, ctx)`，plan 中新函数签名正确但需确认 ctx 传递"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Task 2 — buildTreeSummary"
    title: "buildTreeSummary 是 index.ts 内的私有 helper，未列入 Interface Contracts"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md:Task 1 — compressForCompaction 空 segments 处理"
    title: "segments.length=0 时返回硬编码 fallback tree 是合理防御，但 treeId 固定为 \"empty\" 可能在多次调用时产生重复 ID"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "plan.md:File Structure — context-handler.ts"
    title: "File Structure 标注 context-handler.ts 为 \"no change\"，但 spec AC-4 要求 context handler 不再调用 shouldCompress。虽然实际改动在 index.ts 的 handler wrapper，但标注应更精确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "plan.md:Wave Schedule"
    title: "4 个 Task 全部在 Wave 1 串行执行，与单个 Execution Group (BG1) 等价。Wave 编排在此场景下是冗余概念，但不造成问题"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-30 18:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-30-fix-dual-compact-trigger/plan.md`（+ spec.md、e2e-test-plan.md、use-cases.md、non-functional-design.md）

## 1. spec 完整性

**目标明确性：✅ 通过**
- 一句话：统一双轨压缩为 Pi 原生 compact 单路径，消除 cancel 循环和竞争条件
- 背景清晰描述了三个具体问题，每个有因果链

**范围合理性：✅ 通过**
- 范围明确：只改 infinite-context 扩展，不动 Pi 核心
- 四个 handler 的改动边界清晰

**验收标准可量化：⚠️ 部分通过**
- AC-1~AC-6 都是可验证的行为断言，e2e-test-plan.md 有对应测试场景
- 但 AC-2（对话流同步）和 AC-3（TUI 可渲染）在 e2e-test-plan 中靠"观察"验证，缺乏自动化断言。作为 L1 级别的 bug fix 可接受

**待决议项：无** — spec 中无 `[待决议]` 标记

## 2. plan 可行性

### Task 拆分

| 维度 | 评估 |
|------|------|
| 粒度 | 4 个 task，每个独立且边界清晰。Task 1 增加函数，Task 2 改 handler，Task 3 清理，Task 4 验证 |
| 依赖关系 | 1→2→3→4 串行，依赖正确。Task 2 依赖 Task 1 的 `compressForCompaction` |
| 工作量 | 合理。核心改动约 80 行新增/修改，主要是重构而非新功能 |
| 覆盖度 | 见下方 spec-plan 一致性分析 |

### 关键可行性问题

**Pi API 类型验证（已通过）：**

通过阅读 Pi 源码（`agent-session.ts`、`types.ts`、`compaction.ts`）验证：

| Plan 中使用的类型/字段 | Pi 源码实际 | 一致性 |
|----------------------|-----------|--------|
| `SessionBeforeCompactEvent` | `{ type, preparation, branchEntries, customInstructions?, signal }` | ✅ |
| `SessionBeforeCompactResult` | `{ cancel?: boolean, compaction?: CompactionResult }` | ✅ |
| `CompactionResult` | `{ summary, firstKeptEntryId, tokensBefore, details? }` | ✅ |
| `event.preparation.firstKeptEntryId` | `CompactionPreparation.firstKeptEntryId: string` | ✅ |
| `event.preparation.tokensBefore` | `CompactionPreparation.tokensBefore: number` | ✅ |

**Pi 消费路径验证（已通过）：**

`_runAutoCompaction` 中：
1. await emit `session_before_compact`
2. 如果 `result?.cancel` → emit `compaction_end { aborted: true }` → return false（不写 entry）**← 这就是 bug 根因**
3. 如果 `result?.compaction` → 用其字段 → `appendCompaction(..., fromExtension=true)` → 写入 entry ✅
4. 否则 → 执行原生 `compact()` → 写入 entry ✅

Plan 的方案（返回 `{ compaction }` 而非 `{ cancel: true }`）完全正确。

**handler 调用签名验证（已通过）：**

Pi 的 `emit()` 调用 handler 时传入 `(event, ctx)`。Plan 中新 handler 签名 `async (event: SessionBeforeCompactEvent, ctx: ExtensionContext)` 与之一致。

## 3. spec 与 plan 一致性

逐条覆盖：

| Spec 需求 | Plan Task | 覆盖 |
|-----------|-----------|------|
| FR-1: 统一压缩到 session_before_compact | Task 2 (rewrite handler) + Task 3 (remove turn_end/context triggers) | ✅ |
| FR-2: 返回 compaction 而非 cancel | Task 2 | ✅ |
| FR-3: context 事件不判断压缩 | Task 3 (remove needsCompressionRef + shouldCompress call) | ✅ |
| FR-4: turn_end 不触发压缩 | Task 3 (remove compressAsync call) | ✅ |
| FR-5: async spawn + await | Task 1 (compressForCompaction uses triggerCompressionAsync) + Task 2 (await it) | ✅ |
| FR-6: 首次/失败时 Pi fallback | Task 2 (segments<3 → cancel:false, error → cancel:false) | ✅ |
| AC-1: 无重复触发 | Task 2 (返回 compaction → Pi 写 entry → timestamp 保护生效) | ✅ |
| AC-2: 对话流同步 | Task 1 + Task 2 (await async handler → Pi await handler) | ✅ |
| AC-3: TUI 可渲染 | Task 1 (spawn 不阻塞事件循环) | ✅ |
| AC-4: context 不判断压缩 | Task 3 | ✅ |
| AC-5: turn_end 不触发 | Task 3 | ✅ |
| AC-6: segments 不足 fallback | Task 2 | ✅ |

**未覆盖项：无。** 所有 FR 和 AC 都有对应 Task。

**Plan 中超出 spec 的内容：** `buildTreeSummary` helper —— 这是实现细节，不是额外功能，合理。

## 4. Execution Groups 合理性

- **分组：** 单一 group BG1，4 个 task 全部关联，无法拆分。合理。
- **文件数：** 2 个 modify（index.ts + compression-runner.ts），≤ 10。✅
- **串行编排：** 1→2→3→4 正确反映了依赖关系。✅
- **Subagent 配置：** Agent、model、注入上下文、文件列表、修改文件列表齐全。✅

## 5. 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Task 1 | **`compressForCompaction` 在 segments=0 时跳过 UI 但返回 fallback tree。** 当前 `compressAsync` 在 segments=0 时 `return`（不调 UI，不压缩），而 plan 的 `compressForCompaction` 在 segments=0 时返回一个硬编码 fallback CompactResult（带 `fallbackUsed: true, errorReason: "No segments"`）。但这个 fallback tree 不会被写入 compaction entry——因为调用方 `createBeforeCompactHandler` 会检查 `result.fallbackUsed && result.errorReason`，对这种情况返回 `{ cancel: false }`。**真正的问题**：`compressForCompaction` 的 segments=0 路径调用了 `beforeCompressionUI`/`afterCompressionUI`（plan 中代码在 if 检查之后才调 UI 函数，segments=0 直接 return，不调 UI），但 return 了一个带 `fallbackUsed: true` 的 result。`afterCompressionUI` 未被调用，但 `createBeforeCompactHandler` 中检测到 `fallbackUsed && errorReason` 后走 `{ cancel: false }` 路径，Pi 执行原生 compact，不会用到这个 result。**实际影响**：代码逻辑不会出错，但 `compressForCompaction` 的 segments=0 路径产生了无意义的 CompactResult 对象，且 if/return 结构与 `compressAsync` 原版不一致。**建议**：统一处理——segments=0 时直接在 `createBeforeCompactHandler` 层面判断（已有 `segments.length < 3` 检查），`compressForCompaction` 不需要 segments=0 的 fallback 分支。 | 移除 `compressForCompaction` 中的 segments=0 fallback，改为在调用前由 handler 检查（handler 已有此逻辑）。或者保留但注释说明是防御性代码 |
| 2 | MUST FIX | plan.md:Task 1 Step 1 + Task 3 Step 5 | **`compressAsync` 改为 delegate 到 `compressForCompaction` 后，commands.ts 的行为会改变。** commands.ts 中 `/tree-compact` 命令调用 `await compressAsync(pi, ctx, allSegments, compactor)`。当前 `compressAsync` 在 segments=0 时直接 return（不调 UI，不返回值）。改为 delegate 到 `compressForCompaction` 后，segments=0 时会返回 fallback CompactResult（带 UI 气泡显示 `0 groups, 0 tokens`），然后 `compressAsync` 丢弃结果。用户在空 session 执行 `/tree-compact` 时会看到无意义的压缩气泡。**建议**：保留 `compressAsync` 的原始逻辑（segments=0 直接 return），仅提取共享路径到新函数。或者 `compressAsync` 内部在调用 `compressForCompaction` 前检查 segments=0。 | `compressAsync` 保持 segments=0 的 early return，只在 segments>0 时调 `compressForCompaction` |
| 3 | MUST FIX | plan.md:Task 2 — `createBeforeCompactHandler` 注册改动 | **handler 需要传入 `pi` 但 plan 的 Step 2 "Update registration" 漏掉了当前代码中 handler 的实际参数传递问题。** 当前代码：`createBeforeCompactHandler(_tracker, compactor)` 返回 `() => {...}`（无参数的闭包）。新代码需要 `(event, ctx)` 参数。Plan Step 1 中的代码正确（用了参数），但 **Step 2 只说"pass pi as first argument"，没提到 `ctx` 参数**。实际 Pi emit 传入 `(event, ctx)`，而 handler 返回的闭包通过参数接收这两个值——plan 的代码是对的（`async (event, ctx) => {...}`），但 Step 2 的文字描述不完整，容易让执行者误解。此外，当前 `compressForCompaction` 需要 `ctx: ExtensionContext` 参数（UI 操作用），但 handler 的 `ctx` 就可以满足——**需确认 handler 中的 `ctx` 就是 `ExtensionContext`**。查看 Pi 源码确认：emit 调用时传入的 ctx 就是 `ExtensionContext`。**所以代码正确，但 step 描述需修正**。 | Step 2 文字补充说明：handler 通过闭包捕获 `pi`，参数列表 `(event, ctx)` 与 Pi emit 一致，ctx 直接传给 `compressForCompaction` |
| 4 | LOW | plan.md:Interface Contracts | `buildTreeSummary` 是 `index.ts` 中的私有 helper，但未列入 Interface Contracts 表格。虽然它不是跨模块接口，但作为 spec-plan 一致性追踪的一部分，建议补充（即使标注为 private）。 | 补充到 Interface Contracts 或注明"internal helper" |
| 5 | LOW | plan.md:Task 1 | fallback tree 的 `treeId: "empty"` 是固定字符串。如果因某种原因多次创建 fallback tree（虽然当前场景不太可能），会造成 ID 冲突。`ruleBasedFallback` 和 `makeTree` 都用 `tree_${Date.now()}` 生成唯一 ID。 | 改为 `tree_${Date.now()}` 或直接复用 `ruleBasedFallback` |
| 6 | LOW | plan.md:File Structure | `context-handler.ts` 标注为 "no change" 并说明 `shouldCompress` method stays (used by commands)。但 `shouldCompress` 实际上只被 `index.ts` 的 `createContextHandler` 调用（`assembler.shouldCompress(...)`），不被 commands.ts 使用。commands.ts 不 import `ContextAssembler.shouldCompress`。清理后 `shouldCompress` 方法将无人调用，但作为 public method 保留不会导致编译错误——只是死代码。 | 精确标注：`shouldCompress` 在 Task 3 后变为死代码（无调用方），可选择在后续 cleanup 中移除 |
| 7 | INFO | plan.md:Wave Schedule | 4 个 Task 全部串行在 Wave 1，Wave 编排概念在此场景下无实际意义（等同于无 Wave 的简单串行）。不造成问题，只是冗余。 | 无需修改 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### MUST FIX 问题详细分析

#### Issue #1 & #2：`compressForCompaction` 与 `compressAsync` 的 segments=0 处理

**问题本质**：plan 将 `compressForCompaction` 设计为 `compressAsync` 的"有返回值版本"，但两者对 segments=0 的语义不同：
- `compressAsync`（原版）：segments=0 → 直接 return void，不调 UI
- `compressForCompaction`（plan 版）：segments=0 → return 硬编码 fallback CompactResult

让 `compressAsync` delegate 到 `compressForCompaction` 会改变 `compressAsync` 的 segments=0 行为，影响 `/tree-compact` 命令的用户体验。

**修复方向**：
```typescript
export async function compressForCompaction(
  pi: ExtensionAPI, ctx: ExtensionContext,
  segments: readonly Segment[], compactor: TreeCompactor,
): Promise<CompactResult | null> {
  if (segments.length === 0) return null;
  beforeCompressionUI(pi, ctx, segments.length);
  const result = await compactor.triggerCompressionAsync(pi, segments, compactor.getTree());
  afterCompressionUI(pi, ctx, result);
  return result;
}

export async function compressAsync(
  pi: ExtensionAPI, ctx: ExtensionContext,
  segments: readonly Segment[], compactor: TreeCompactor,
): Promise<void> {
  await compressForCompaction(pi, ctx, segments, compactor);
}
```

`createBeforeCompactHandler` 中：segments<3 直接 `{ cancel: false }`（已有），`compressForCompaction` 返回 null 时也 `{ cancel: false }`。

#### Issue #3：Task 2 Step 2 描述不精确

当前 handler 是无参数闭包 `() => {...}`，新 handler 需要接收 `(event, ctx)`。Plan Step 1 的代码是对的，但 Step 2 的文字只说 "pass pi as first argument"，遗漏了 handler 从 `() => {...}` 变为 `(event, ctx) => {...}` 这个关键变化。

### 结论

需修改后重审。3 条 MUST FIX 中：
- Issue #1 & #2 是同一个根因（compressForCompaction 的边界条件设计），可一起修
- Issue #3 是文档描述问题，代码本身正确，补充说明即可

### Summary

计划评审完成，第1轮，3条MUST FIX（2条代码逻辑边界条件 + 1条文档描述不精确），需修改后重审。Plan 的核心方案（返回 `compaction` 而非 `cancel`）经 Pi 源码验证完全正确，API 类型一致，spec 覆盖完整。
