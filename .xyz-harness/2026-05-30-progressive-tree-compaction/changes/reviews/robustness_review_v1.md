---
verdict: pass
must_fix: 0
reviewer: robustness-review
date: 2026-05-30
scope: 072c755..HEAD (progressive-tree-compaction)
files_reviewed:
  - infinite-context/src/types.ts
  - infinite-context/src/tree-compactor.ts
  - infinite-context/src/context-handler.ts
  - infinite-context/src/segment-tracker.ts
  - infinite-context/src/commands.ts
  - infinite-context/src/index.ts
---

# Robustness Review Report

## Summary

审查了 progressive-tree-compaction 功能的完整 diff，覆盖 6 个核心源文件和 4 个测试文件。代码在错误处理、边界防护、日志和调试友好性方面整体表现良好。发现 0 个必须修复问题，5 个建议改进项（全部为 low 级别）。

---

## A. Error Handling — ✅ Good

### 亮点

1. **三层压缩降级链完整**：`runCompression` → `handleCompressionFailure`（重试）→ `applyFallback`（rule-based fallback），每层都有明确的错误原因传播和状态恢复（`this.compressing = false`）。

2. **spawn 错误和超时全覆盖**：
   - `child.on("error", ...)` 捕获 spawn 异常（L775-779）
   - 30 秒 `setTimeout` 超时机制 + `timedOut` flag 防止永远挂起
   - `clearTimeout(timer)` 在所有 exit path 调用

3. **retry 路径也支持追加模式**（FR-3）：`handleCompressionFailure` 捕获 `currentTree = this.tree`，重试成功时正确区分 append 和新建两种分支（L1002-1050）。

4. **fallback 路径也支持追加模式**：`applyFallback` 中检测 `this.tree` 存在时创建 fallback group 节点追加到已有 children（L1073-1120）。

### 发现

| ID | 级别 | 位置 | 描述 |
|----|------|------|------|
| EH-1 | low | `buildSegmentDigests` catch 块 | 文件读取失败时 `console.error` 记录了完整 err 对象，但生产环境中 err 可能包含敏感路径。建议仅在 debug 模式输出完整 error，生产环境仅输出 `err.message`。当前行为可接受。 |

---

## B. Edge Cases — ✅ Good

### 亮点

1. **`computeCompressionScope` 的 0 分母防护**（重点关注项）：
   ```typescript
   if (denominator <= 0) return { targetSegs: [...historySegs], estimatedAfterTokens: 0 };
   ```
   正确处理了所有分母分量（existingTreeSize + retentionMsgSize + historyTotalDigest + systemPromptEstimate）为 0 的极端情况。由于 `systemPromptEstimate = 4000` 为硬编码常量，实际运行时分母不会为 0，但防御性检查正确。

2. **`RETENTION_GRADIENT` sentinel 值处理**：`retainCount >= 9999` 的判断正确覆盖了 usagePercent < 50 时保留所有段的场景，且 `retainCount >= completedSegments.length` 的附加条件避免了不必要的 slice 操作。

3. **空历史段提前返回**：`historySegments.length === 0` 时正确重置 `this.compressing = false` 并 return（L738-741）。

4. **`triggerCompression` 双重守卫**：`this.compressing` flag + `usagePercent < 50` 的 AC-6 守卫，确保不会重复触发和低负载时浪费资源。

5. **empty root.children 处理**：`buildExistingGroupsSection` 在 `groups.length === 0` 时返回空字符串，不会向 prompt 注入无效内容。

### 发现

| ID | 级别 | 位置 | 描述 |
|----|------|------|------|
| EC-1 | low | `context-handler.ts` AC-4 消息跳过逻辑 | 跳过逻辑假设 messages 中 user/assistant 严格交替（每个 user 后跟 assistant）。如果 messages 中出现连续的 user 消息（tool result 后跟 user），`lastWasUser` 状态机可能无法正确配对。实际 Pi session 中这种排列不常见，且测试已覆盖基本场景。建议增加注释说明假设前提。 |
| EC-2 | low | `computeCompressionScope` 循环边界 | 当 `sorted.length === 0`（空历史段）时，循环体不执行，直接返回 `{ targetSegs: [], estimatedAfterTokens: 0 }`。调用方在 `triggerCompression` 中已做 `historySegments.length === 0` 检查，不会到达此处，但 `computeCompressionScope` 作为 public 方法本身缺少对空数组的防护注释。 |

---

## C. Logging — ✅ Good

### 亮点

1. **关键路径有充足日志**：
   - `buildSegmentDigests` 文件读取失败：`console.error("[infinite-context] buildSegmentDigests file read error:", err)`
   - `applyFallback` 降级：`console.error("[infinite-context] LLM compression failed, using rule-based fallback")`
   - 事件处理器顶层 catch：`console.error("[infinite-context] turn_end error:", err)` 等

2. **统一前缀**：所有日志使用 `[infinite-context]` 前缀，便于 grep 和过滤。

3. **错误信息包含上下文**：
   - JSON 解析失败输出前 200 字符：`jsonStr.slice(0, 200)`
   - 校验失败包含 nodeId 和具体原因：`Node ${nodeId} references unknown segId: ${segId}`
   - fallback 包含段数量：`Fallback compression of ${segments.length} segments`

### 发现

无。

---

## D. Fail-fast — ✅ Good

### 亮点

1. **AC-6 守卫**（重点关注项）：`usagePercent < 50` 在 `triggerCompression` 最早期返回（L711），避免不必要的段过滤和摘要构建。

2. **`this.compressing` 互斥锁**：在方法入口检查，防止并发压缩。

3. **`restoreState` 从后向前扫描**：`for (let i = entries.length - 1; ...)` 取最后一个有效 entry 后立即 return，不做多余遍历。

4. **`triggerCompression` 的多层守卫**：
   - 守卫 1：`this.compressing` → 已在压缩中
   - 守卫 2：`usagePercent < 50` → AC-6
   - 守卫 3：`historySegments.length === 0` → 无需压缩
   - 顺序正确，每个守卫都在合适的时机返回。

### 发现

无。

---

## E. Testability — ✅ Good

### 亮点

1. **`computeCompressionScope` 为独立 public 方法**：不依赖 `this` 的任何 mutable state（只读 `COMPRESSION_CONFIG`），可独立测试。测试文件中有 10+ 个 test case 覆盖。

2. **`getCompressedSegIds()` 返回拷贝**：`new Set(this.compressedSegIds)` 防止测试代码修改内部状态。

3. **`restoreState` + `getCompressedSegIds` 测试覆盖完整**：测试文件 `tree-compactor.test.ts` 有 8 个 test case 覆盖 restore 场景（空 entries、多 entries 取最后一个、empty root.children 等）。

4. **mock 设计合理**：`makeSegment`、`makeCompactTreeEntry` helper 函数简化测试构造。

### 发现

| ID | 级别 | 位置 | 描述 |
|----|------|------|------|
| TE-1 | low | `triggerCompression` 测试依赖 `spawn` mock | `AC-6` 测试通过 cast `as never` 绕过类型系统访问私有属性。可接受（TypeScript 测试中常见模式），但理想情况应提供 `setCompressing(v: boolean)` 的 test-only 方法。 |

---

## F. Debugability — ✅ Good

### 亮点

1. **校验错误消息包含完整上下文**：
   - JSON 解析失败：输出原始内容前 200 字符
   - 节点校验失败：包含 nodeId、实际值、期望值
   - summary 长度不足：输出实际长度 + 最小要求 + 前 100 字符

2. **压缩结果包含丰富元数据**：`CompactResult` 包含 `fallbackUsed` 和 `retryCount`，`onComplete` 回调通知用户。

3. **`CompactTree` 有 `treeId` + `createdAt`**：便于追踪压缩历史。

4. **append 模式的 summary 标注来源**：`(appended, session ...)`, `(retry+append)`, `(retry)`, `Fallback compression` — 4 种场景 4 种标注，便于日志追踪。

### 发现

| ID | 级别 | 位置 | 描述 |
|----|------|------|------|
| DB-1 | low | `applyFallback` 中 `group_fallback_${Date.now()}` | 在高并发场景下 `Date.now()` 可能碰撞（同一 ms 内两次 fallback），但 `triggerCompression` 的 `this.compressing` 互斥锁保证了串行执行，实际不会碰撞。 |

---

## Special Focus Areas

### 1. AC-6 守卫（usagePercent < 50）— ✅

`triggerCompression` L711: `if (usagePercent < 50) return;`
- 位置正确：在 `this.compressing = true` 之前（未设置 flag 就返回）
- 测试覆盖：`tree-compactor.test.ts` L601-633 验证了 < 50 时不触发、>= 50 时触发

### 2. computeCompressionScope 的 0 分母防护 — ✅

`computeCompressionScope` L671: `if (denominator <= 0) return { targetSegs: [...historySegs], estimatedAfterTokens: 0 };`
- `systemPromptEstimate = 4000` 硬编码保证实际不为 0
- 防御性检查覆盖了理论上的零值
- 返回所有历史段作为 target（保守策略，不会丢失数据）

### 3. compressedSegIds 在 restoreState 中的正确重建 — ✅

`restoreState` L795-798:
```typescript
this.compressedSegIds.clear();
// ... find last ic-compact-tree entry ...
this.collectCompressedSegIds(this.tree.root);
```
- 先 clear 再重建，避免脏状态
- `collectCompressedSegIds` 递归遍历所有叶节点收集 segId
- 测试覆盖：L353-377 验证了恢复后 Set 内容与树叶节点一致
- 多 group append 场景也测试覆盖：L532-551

### 4. retry/fallback 路径的 append 逻辑 — ✅

- **retry 路径**（`handleCompressionFailure`）：L997 捕获 `currentTree = this.tree`，重试成功后正确区分 append 和新建
- **fallback 路径**（`applyFallback`）：L1085 检测 `this.tree` 存在时创建 fallback group 追加到已有 children
- 所有路径都在完成后 `this.compressedSegIds.add(seg.segId)`，保证 compressedSegIds 与实际压缩段同步

### 5. context-handler 中 compressedSegIds Set 的使用 — ✅

`assembleMessages` 接受 `compressedSegIds?: Set<string> | number`，通过 instanceof 检测实现向后兼容（L164-170）。
- `effectiveCompressedSegIds` 仅在同时满足 `Set 非空 + tree 存在` 时启用消息过滤
- 调用方 `index.ts` 传入 `compactor.getCompressedSegIds()` 返回的拷贝
- 消息过滤逻辑基于 user 消息计数 + 状态机跳过配对消息

---

## Issue Summary

| ID | 级别 | 维度 | 描述 | 建议 |
|----|------|------|------|------|
| EH-1 | low | Error Handling | buildSegmentDigests catch 输出完整 err | 可接受，非阻塞 |
| EC-1 | low | Edge Cases | AC-4 消息跳过假设 user/assistant 交替 | 增加注释说明假设 |
| EC-2 | low | Edge Cases | computeCompressionScope 空数组路径 | 增加注释或 guard |
| TE-1 | low | Testability | triggerCompression 测试用 `as never` | 可接受 |
| DB-1 | low | Debugability | fallback nodeId 用 Date.now() | 互斥锁保证安全 |

---

## Verdict: **PASS** (0 must-fix)

代码在 6 个健壮性维度上表现良好。重点关注项（AC-6 守卫、0 分母防护、compressedSegIds 重建、retry/fallback append、context-handler Set 使用）全部正确实现并有测试覆盖。5 个建议改进项均为 low 级别，不阻塞合并。
