---
verdict: pass
---

# Subagent 渲染/CPU/内存性能优化

## 背景

实测分析发现 subagents 扩展在 4 个点存在可优化开销。本方案覆盖 P0-P2 四项，按投入产出比排序。每项独立可回退。

## P0: AgentRegistry mtime 缓存（最大收益）

### 现状
`AgentRegistry.discoverAll` 每次 runAgent 被调 3-5 次（buildContext/resolveModelForAgent/getAgentConfig/assertAgentExists）。每次全量 `readdirSync` 7 个目录 + 对每个 `.md` `readFileSync` + `parseAgentFrontmatter`。这是纯同步 IO + CPU，且 hot-reload 场景（执行中途编辑 agent .md）极罕见。

### 方案（文件级 mtime 缓存）
`extensions/subagents/src/registry/agent-registry.ts`：

1. 新增 `private readonly fileCache = new Map<string, { mtimeMs: number; config: AgentConfig }>()`，键为绝对文件路径。
2. `scanDir` 内对每个文件：`fs.statSync(filePath).mtimeMs`，若 `fileCache` 有同路径且 mtimeMs 相同 → 复用 `config`，否则 `readFileSync` + `parseAgentFrontmatter` 并更新缓存。
3. `discoverAll` 开头记录本次扫描到的路径集合，结束时清理 `fileCache` 中不在集合内的条目（处理文件删除）。
4. `cache.clear()` 改为 `cache.clear()` + 不清 `fileCache`（fileCache 跨 discoverAll 保留，靠 mtime 判定失效）。

### 正确性
- 文件内容变 → mtime 变 → 重新解析（hot-reload 语义保留）。
- 文件删除 → 下次 readdir 看不到 → 路径集清理 → 缓存条目移除。
- 目录级 mtime 缓存**不采用**（目录 mtime 在多数 FS 上不随文件内容修改更新，有正确性风险）。

### 改动文件
`src/registry/agent-registry.ts`（~30 行）、`src/__tests__/agent-registry.test.ts`（新增 mtime 缓存回归测试）。

### 风险
低。stat 比 read+parse 便宜 1-2 个数量级。最坏情况退化为全量读（与现状一致）。

## P1a: renderResult 复用 SubagentResultComponent

### 现状
`tools/subagent-tool.ts:76` 每次 `renderSubagentResult` 都 `new SubagentResultComponent`。SDK 的 `updateDisplay`（`tool-execution.js:226`）每次 onUpdate（~150ms 一次）都调 renderResult，累积 GC 压力。SDK 已通过 `context.lastComponent` 传回上次返回的实例，但当前签名忽略了它。

### 方案
`tools/subagent-tool.ts` + `tui/subagent-render.ts`：

1. `renderSubagentResult` 的 context 参数类型追加 `lastComponent?: Component`。
2. 函数体：若 `context.lastComponent instanceof SubagentResultComponent` → 调 `lastComponent.update(details)` + `lastComponent.setExpanded(options.expanded)` 返回它；否则 `new`。
3. `SubagentResultComponent.update()` 已存在（`subagent-render.ts:282`），直接复用。
4. theme 不变（session 内稳定），无需更新。

### 改动文件
`src/tools/subagent-tool.ts`（renderResult context 类型 + 复用逻辑，~8 行）。

### 风险
低。instanceof 检查安全降级。SDK `renderContainer.clear()` 仍重建 Box children，收益在省 new 外壳 + details 引用切换。

## P1b: notifyChange 走 shouldTriggerUpdate 过滤

### 现状
`runtime.ts:423`（sync onEvent）和 `runtime.ts:644`（bg onEvent）每个事件都 `this.notifyChange()`，包括 text_delta/thinking_delta。overlay（`/subagents list`）打开时，每个 delta 都触发 `getAllRecords` 聚合 4 数据源 + 拷贝 100 条 history。而 delta 期间 eventLog 新条目要到 chunk 阈值（100 字符）才产出，中间的 notifyChange 纯属浪费。

### 方案
两处 onEvent 把 `this.notifyChange()` 包进 `if (shouldTriggerUpdate(event))`。与 onUpdate 一致策略（已用 `shouldTriggerUpdate` 过滤）。

### 正确性
- tool/turn/message 边界仍刷新 overlay（用户看实时进度）。
- streaming delta 期间 overlay 冻结，下一个边界（通常几百 ms）补上。
- `updateStateFromEvent` 仍处理所有事件（eventLog 累积不受影响）。

### 改动文件
`src/runtime.ts`（2 处，各 ~2 行）。

### 风险
低。overlay 默认关闭；打开时刷新频率从 ~60/s 降到 tool 边界，体验反而更稳。

## P2: archiveSyncAgent 浅拷贝 eventLog

### 现状
`runtime.ts:253` 归档时 `eventLog: source.eventLog` 直接传数组引用。`_completedAgents` 里的 eventLog 与原 state.eventLog 同一数组。当前 `completeState` 后不再 mutate state.eventLog 所以不出 bug，但任何未来对 state.eventLog 的后续 mutation 会意外改到归档记录。

### 方案
`runtime.ts:253` 改为 `eventLog: source.eventLog.slice()`。浅拷贝（entry 对象本身不可变，`readonly` 字段，共享 entry 引用安全；只需断开数组引用）。

### 改动文件
`src/runtime.ts`（1 行）。

### 风险
极低。成本：20 条 × 100 字符 × 50 上限 = 100KB 一次性，可忽略。

## 验收标准

1. `pnpm --filter @zhushanwen/pi-subagents typecheck` 零错误。
2. `pnpm --filter @zhushanwen/pi-subagents test` 全通过（含新增 mtime 缓存回归测试）。
3. P0 mtime 缓存：新增测试覆盖「文件 mtime 未变复用」+「文件修改后重新解析」+「文件删除后缓存清理」。
4. P1a：现有 `subagent-tool.test.ts` / `subagent-render.test.ts` 不回归。
5. P1b：现有 `runtime-*.test.ts`（eventbus/records/eventlog）不回归。
6. P2：现有 `runtime-records.test.ts` 不回归。

## 非目标

- 不改 eventLog chunking 逻辑（THINKING_CHUNK/TEXT_OUTPUT_CHUNK）。
- 不改 spinner seed-frame 机制。
- 不改 throttle 窗口（150ms）。
- 不动 visibleWidth / pool O(n)（收益不值得）。
