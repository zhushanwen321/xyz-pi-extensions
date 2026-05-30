---
verdict: fail
must_fix: 3
---

# Robustness Review v1 — infinite-context

**审查范围**: `index.ts`, `compression-runner.ts`（含关联 `tree-compactor.ts`）
**审查日期**: 2026-05-30
**审查人**: robustness-reviewer

---

## 摘要

两个文件整体错误处理框架合理（try-catch 包裹、fallback 机制、UI cleanup），但存在 3 个必须修复的问题和 4 个建议改进项。

---

## MUST FIX（必须修复）

### MF-1: `buildTreeSummary` 未处理空 tree / 无 children 的 root

**文件**: `index.ts` L92-L98

```typescript
function buildTreeSummary(tree: CompactTree): string {
	const groupSummaries = tree.root.children.map((group) => {
		const leafCount = group.children.length;
		return `- ${group.summary} (${leafCount} segments)`;
	}).join("\n");
	return `[IC Tree Compact] ${tree.root.children.length} groups, ${tree.totalTokens} tokens, depth ${tree.depth}\n${groupSummaries}`;
}
```

**问题**: 此函数的调用链是 `createBeforeCompactHandler` → `compressForCompaction` → 返回非 null result → `buildTreeSummary(result.tree)`。当 `compressForCompaction` 返回的 `result` 不是 null 且 `fallbackUsed` 但 `errorReason` 为空时（例如 `applyFallback` 在空 segments 外的场景），`result.tree` 可能是一个 children 为空的树（如 `ruleBasedFallback` 传入空数组时 root.children = []）。此时函数本身不会崩溃（map 空数组返回空数组），但会输出 `0 groups, 0 tokens, depth 1\n` 这种无意义的 summary 给 Pi 的 compaction entry。

更关键的是：**调用方没有校验 `result.tree` 的有效性**。如果 `tree.root` 为 `undefined`（虽然类型系统不允许，但运行时 JSON 反序列化可能出现），直接 `.children.map()` 会 throw，而这个 throw 发生在 `createBeforeCompactHandler` 的 try-catch 内——catch 会返回 `{ cancel: false }`，Pi 会执行原生 compact，所以不会崩溃，但**错误日志是 generic 的 `compression error`**，丢失了 "buildTreeSummary failed" 的上下文。

**建议**: 
1. 在 `buildTreeSummary` 入口加防御性检查：`if (!tree.root || !tree.root.children.length) return "[IC Tree Compact] empty tree";`
2. 或者在调用方 `compressForCompaction` 返回前校验 tree 有效性。

### MF-2: `asyncSpawnPi` 超时 kill 后未等待子进程实际退出

**文件**: `tree-compactor.ts` L280-L290

```typescript
const timer = setTimeout(() => {
    if (!child.killed) child.kill("SIGTERM");
}, IC_CONFIG.compressionTimeoutMs);
```

**问题**: `SIGTERM` 后子进程可能不会立即退出（特别是 pi 进程内部有 LLM 调用正在 pending）。`child.kill("SIGTERM")` 仅发送信号，不等待进程退出。后续的 `child.on("close", ...)` 回调会在进程真正退出时触发，所以 Promise 最终会 resolve。这部分是安全的。

**但存在风险**: 如果子进程忽略 SIGTERM（某些信号处理场景），进程会 hang。没有 SIGKILL 的二次超时机制。

**建议**: 添加二次超时：
```typescript
const timer = setTimeout(() => {
    if (!child.killed) {
        child.kill("SIGTERM");
        // 5s 后强制 kill
        setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5000);
    }
}, IC_CONFIG.compressionTimeoutMs);
```

注意这两个 setTimeout 都需要在 `close` 事件中 clearTimeout，避免泄漏。当前只 clear 了一个 timer。

### MF-3: `compressSync` 空段 fallback 构建的 CompactTree 不一致

**文件**: `compression-runner.ts` L69-L73

```typescript
if (segments.length === 0) {
    const fallback = {
        tree: { treeId: "empty", root: { nodeId: "root", summary: "no segments", tokenCount: 0, children: [] }, totalTokens: 0, createdAt: Date.now(), depth: 1 },
        fallbackUsed: true, retryCount: 0, errorReason: "No segments"
    };
    return fallback;
}
```

**问题**: 这个 inline 构造的 `CompactTree` 没有通过 `TreeCompactor` 的 `applyFallback` 方法，绕过了 `pi.appendEntry(COMPACT_TREE_ENTRY_TYPE, tree)` 持久化。而 `compressForCompaction`（async 版本）在空段时直接 `return null`，不走这个路径。两条路径的空段行为不一致：
- `compressForCompaction`: return null → 调用方走 `{ cancel: false }` 让 Pi 原生 compact
- `compressSync`: return fallback → 调用方拿到一个未持久化的 tree，可能导致状态不一致

**建议**: 统一空段处理。`compressSync` 也应该走 `applyFallback`，或者空段时 throw/return 特殊值让调用方统一处理。

---

## SHOULD FIX（建议修复）

### SF-1: `createBeforeCompactHandler` 中 `result.fallbackUsed && result.errorReason` 判断不充分

**文件**: `index.ts` L119-L122

```typescript
if (result.fallbackUsed && result.errorReason) {
    return { cancel: false };
}
```

这个条件意味着：如果 fallback 使用了但没有 errorReason（`ruleBasedFallback` 成功），会继续走 tree summary 返回给 Pi。这是**有意的设计**——rule-based fallback 也是有效的压缩结果。但如果 fallback tree 的质量很差（比如每个 segment 独立成组），给 Pi 的 compaction entry 可能比 Pi 原生 compact 还差。

**建议**: 考虑在 fallback 时也评估 tree 质量（如 `tree.root.children.length === segments.length` 说明完全没有分组），决定是否让 Pi 原生 compact。

### SF-2: `afterCompressionUI` 未清理 `ctx.ui.setStatus`

**文件**: `compression-runner.ts` L35

```typescript
ctx.ui.setStatus("ic-compact", undefined);
```

如果 `compressForCompaction` 在 `triggerCompressionAsync` 抛出异常时（理论上不会，因为有内部 fallback），`afterCompressionUI` 不会被调用，状态栏残留。

**现状**: `triggerCompressionAsync` 内部有完整的 fallback 机制，不会抛出异常（除非 `pi.appendEntry` 本身失败）。风险很低。

**建议**: 可以在 `compressForCompaction` 中用 try-finally 包裹 `afterCompressionUI`：
```typescript
try {
    const result = await compactor.triggerCompressionAsync(pi, segments, compactor.getTree());
    afterCompressionUI(pi, ctx, result);
    return result;
} catch (err) {
    ctx.ui.setStatus("ic-compact", undefined); // 确保清理
    throw err;
}
```

### SF-3: 日志上下文不足

多处 `console.error` 缺少关键上下文：

- `index.ts` L19: `[infinite-context] session_start error:` — 没有 sessionId
- `index.ts` L31: `[infinite-context] turn_end error:` — 没有 turnIndex
- `index.ts` L48: `[infinite-context] context error:` — 没有 segments 数量

**建议**: 在错误日志中包含操作相关的关键参数，方便排查。

### SF-4: `compressForCompaction` 返回 null 的场景只有空段，但调用方已提前过滤

**文件**: `compression-runner.ts` L58

```typescript
if (segments.length === 0) return null;
```

而 `createBeforeCompactHandler` 中已经有 `if (segments.length < 3) return { cancel: false };`。所以 `compressForCompaction` 的空段检查是冗余的。不是 bug，但可能误导读者以为还有其他返回 null 的场景。

**建议**: 添加注释说明 null 返回是防御性编程。

---

## 六维度评估

### 1. 错误处理: 7/10

- `index.ts` 所有 handler 都有 try-catch 包裹 ✅
- `tree-compactor.ts` 有完整的 retry + fallback 链 ✅
- `asyncSpawnPi` 的 error/close 事件都处理了 ✅
- **扣分**: MF-1 buildTreeSummary 缺少防御性检查、MF-3 不一致的空段处理

### 2. 异常: 7/10

- spawn 超时有处理 ✅
- Promise rejection 在 handler 层被 try-catch 捕获 ✅
- **扣分**: MF-2 SIGTERM 后无 SIGKILL 二次保障

### 3. 日志: 6/10

- 有 `icDebug` 统一 debug 日志 ✅
- 错误日志前缀统一 `[infinite-context]` ✅
- **扣分**: SF-3 关键上下文缺失（sessionId、turnIndex 等）

### 4. Fail-fast: 8/10

- `segments.length < 3` 提前返回 ✅
- `segments.length === 0` 提前返回 ✅
- `fallbackUsed && errorReason` 放弃自定义 compact ✅
- `!result` 检查 null 返回 ✅

### 5. 测试友好: 5/10

- `TreeCompactor` 是 class，可 mock ✅
- `validateTreeOutput` 和 `ruleBasedFallback` 是纯函数，export 了 ✅
- **扣分**: `compressForCompaction` 直接依赖 `compactor.triggerCompressionAsync`，无法注入替代实现。`beforeCompressionUI` / `afterCompressionUI` 也是硬绑定，无法在测试中跳过 UI 副作用

### 6. 调试友好: 8/10

- `IC_DEBUG` 环境变量控制详细日志 ✅
- debug 日志覆盖了 spawn、validate、retry 全流程 ✅
- UI 消息包含 segment count、token 信息 ✅
- compact stats entry 包含 phase/timestamp 便于回溯 ✅

---

## 结论

3 个 MUST FIX 中，MF-2（SIGKILL 二次保障）风险最高——如果 pi 子进程 hang 不退出，会导致 Promise 永远不 resolve，`session_before_compact` handler 永远不返回，Pi 的 compact 流程卡死。虽然 Pi 框架侧可能有全局超时，但不应该依赖外部保障。

MF-1 和 MF-3 是数据一致性问题，不影响运行时稳定性，但会导致边界情况下行为不可预测。
