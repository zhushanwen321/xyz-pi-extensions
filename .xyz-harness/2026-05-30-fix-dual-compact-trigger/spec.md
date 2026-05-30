---
verdict: pass
---

# Fix Dual Compact Trigger

## Background

infinite-context 扩展有两套独立的压缩机制在并行运行：

1. **Pi 原生自动 compact**：由 `_checkCompaction()` 触发（`agent_end` 后 + `prompt` 前），同步 await 执行
2. **Tree-compact**：由扩展自身管理，`context` 事件设置 flag → `turn_end` 中 fire-and-forget `compressAsync()`

两套机制之间通过 `session_before_compact` 事件协调——当 tree 已存在时返回 `{ cancel: true }` 阻止 Pi 原生 compact。但这种协调方式导致了三个问题。

### 三个已知问题

**问题 1：Cancel 无副作用 → 重复触发**
- `session_before_compact` 返回 `{ cancel: true }` 时，Pi 不写入 compaction entry
- `_checkCompaction` 的防重入保护依赖 compaction entry 时间戳
- 无 entry → 保护失效 → 同一个旧 assistant message 的 usage 在下次 `prompt` 时再次触发 `_runAutoCompaction` → 再次被 cancel → 无效循环

**问题 2：首次压缩时两套竞争**
- tree 不存在时，`session_before_compact` 返回 `{ cancel: false }`
- Pi 原生 compact 正常执行（同步）
- 同时 `turn_end` 中 `compressAsync` 也在后台运行（异步）
- 两套压缩同时跑，结果不确定

**问题 3：异步压缩不阻塞对话流**
- `void compressAsync(...)` 是 fire-and-forget
- 下一个 `context` 事件可能在 tree 更新前触发
- `assembleMessages` 用旧 tree → 压缩未生效

## Functional Requirements

### FR-1：统一压缩触发路径
Tree-compact 应利用 Pi 原生的 compact 流程（`session_before_compact`）作为唯一触发点，不再在 `turn_end` 中自行触发。理由：
- Pi 的 `_runAutoCompaction` 是 await 的，天然保证"对话流同步"
- Pi 在 compact 完成后写入 compaction entry，天然保证防重入
- `session_before_compact` handler 可以是 async 的，内部用 `spawn`（异步子进程）不阻塞事件循环，TUI 可以正常渲染 spinner

### FR-2：在 session_before_compact 中执行 tree-compact 并返回结果
当 tree-compact 成功时，返回 `compaction` 结果给 Pi（而非 `cancel`），让 Pi 写入 entry。这样：
- Pi 的 timestamp 防重入保护正常工作
- 不再有多余的 cancel 循环
- `session_before_compact` handler 内部 await 异步 spawn → 对话同步 + TUI 异步

### FR-3：context 事件只负责组装，不判断压缩
`context` 事件中的 `shouldCompress` 判断和 `needsCompressionRef` 机制应移除。压缩时机完全由 Pi 原生判断（`_checkCompaction` 使用真实的 LLM usage）。

### FR-4：turn_end 不再触发压缩
移除 `turn_end` 中的 `compressAsync` 调用。压缩统一在 `session_before_compact` 中执行。

### FR-5：支持 async spawn + await 模式
`session_before_compact` handler 内部调用 `compactor.triggerCompressionAsync()`（用 `spawn` 而非 `spawnSync`），然后 await 结果。这样：
- 对话流同步：Pi 的 `_runAutoCompaction` await 这个 handler，compact 完成后才继续
- TUI 渲染异步：`spawn` 不阻塞事件循环，`sendMessage`/`setStatus` 的 UI 更新正常渲染

### FR-6：首次压缩时仍允许 Pi 原生 fallback
当 segments 不足（<3）或 tree-compact 失败时，不返回 `compaction` 结果，让 Pi 执行原生 compact 作为 fallback。

## Acceptance Criteria

### AC-1：无重复 compact 触发
压缩完成后，下次 `prompt` 不触发多余的 `_runAutoCompaction`。验证：`prompt` 中的 `_checkCompaction` 返回 false（因为 compaction entry 已写入，timestamp 保护生效）。

### AC-2：对话流同步
压缩期间不发送 LLM 请求。压缩完成后才继续。验证：`session_before_compact` handler 是 await 的，Pi 的 `_runAutoCompaction` 等 handler 完成后才继续。

### AC-3：TUI 可渲染压缩状态
压缩过程中，ic-compact-start/ic-compact-end 气泡和 footer status 正常显示。验证：使用 `spawn`（非 `spawnSync`），事件循环不被阻塞。

### AC-4：context 事件不判断压缩
`createContextHandler` 中不再调用 `shouldCompress`，不再设置 `needsCompressionRef`。

### AC-5：turn_end 不触发压缩
`createTurnEndHandler` 中不再调用 `compressAsync`。

### AC-6：segments 不足时 Pi 原生 fallback
当 segments 为空或 tree-compact 全部重试失败时，不返回 compaction 结果，让 Pi 用原生方式压缩。

## Constraints

- 不修改 Pi 核心代码，只修改 `infinite-context` 扩展
- `session_before_compact` handler 接收 `SessionBeforeCompactEvent`，返回 `SessionBeforeCompactResult`
- 返回 `compaction` 结果时必须提供 `summary`、`firstKeptEntryId`、`tokensBefore`
- `firstKeptEntryId` 从 `event.preparation` 中获取（Pi 已经计算好了）
- `summary` 需要是文本摘要（Pi 会将其作为 compaction summary 写入 session）

## 业务用例

无业务用例（纯技术性 bug 修复）。

## Complexity Assessment

**Low-Medium**：修改集中在 `index.ts` 的 3 个 handler 函数，逻辑简化为主（移除多余机制），新增一个 `session_before_compact` handler 的 compaction 返回逻辑。
