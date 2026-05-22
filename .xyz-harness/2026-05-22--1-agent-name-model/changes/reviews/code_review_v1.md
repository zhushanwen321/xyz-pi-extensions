---
verdict: pass
must_fix: 0
---
  total_issues: 6
  must_fix: 2
  must_fix_resolved: 0
  low: 2
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "render.ts:renderSingleCollapsedText L429-L430"
    title: "F1: Single 模式缺少 Line 2——agent+model+elapsed 在 Line 1 上，未分离为 Line 2"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "index.ts:renderResult L550-L554"
    title: "F2: 实时计时器未实现——无 setInterval + context.invalidate()，elapsed 只计算一次"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "index.ts:renderResult L574-L578"
    title: "Chain 模式总体 icon 使用硬编码 icon/color map 而非 renderStatusIcon()"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "render.ts:renderChainCollapsedText L462-L463"
    title: "renderChainCollapsedText 接收预着色 icon: string，内部 step icon 却用 renderStatusIcon——不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: INFO
    location: "index.ts:capturedSessionId L103"
    title: "capturedSessionId 闭包在多 session 场景下存在竞争隐患"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "render.ts:renderStatusIcon L54"
    title: "ThemeColorParam 类型断言可接受，但类型安全性可通过 const 断言改进"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 编码评审 v1

## 评审记录

- 评审时间：2026-05-22 18:30
- 评审类型：编码评审（模式二）
- 评审对象：`subagent/src/render.ts` + `subagent/src/index.ts`（commit d4530d3，base 5ea8f6a）
- 输入文件：`.xyz-harness/2026-05-22--1-agent-name-model/spec.md`、`plan.md`
- 项目约束：`CLAUDE.md`（xyz-pi-extensions）

---

## 检查维度 1：Spec 合规（最高优先级）

### F1: 统一三层 Header 格式

**Spec 要求：**
- Line 1: `⏳|✅|❌` + mode 名 + `#` + sessionID（前 8 位）
- Line 2: agent name + model + thinking level + elapsed（Running 时刷新，Done 时固定）
- Line 3+: 活动流

Spec Running 示例：
```
⏳ single #0196a3b2
  general-purpose  ds-flash/high  3.2s
```

**实现现状：**
```typescript
// render.ts:renderSingleCollapsedText L429-430
let text = `${icon} ${theme.fg("toolTitle", theme.bold("single"))}${theme.fg("accent", idPart)}  ${theme.fg("accent", view.name)}  ${theme.fg("dim", view.model ?? "")}`;
if (durationStr) text += `  ${theme.fg("dim", durationStr)}`;
```

agent name、model、elapsed 全部放在 Line 1，未分离为独立的 Line 2。即显示为一整行而非三层结构。

**问题定位：** `render.ts` L429-430（`renderSingleCollapsedText` 函数）

| 项目 | Spec 期望 | 实现 |
|------|-----------|------|
| Line 1 | `⏳ single #0196a3b2` | `⏳ single #0196a3b2  general-purpose  ds-flash/high  3.2s` |
| Line 2 | `  general-purpose  ds-flash/high  3.2s` | （不存在，合并到 Line 1） |
| Line 2 颜色 | `theme.fg("dim", ...)` | N/A |

**Chain 模式、Parallel 模式的 header 格式正确：** Line 1 = `icon + mode + #id + statusText`，未混入 agent 信息。仅 Single 模式有这个问题。

**修改方向：** 从 `renderSingleCollapsedText` 的 Line 1 中移除 `view.name`、`view.model`、`durationStr`，将其作为 Line 2（带 2 个空格缩进 + dim 颜色）输出。

### F2: 实时计时更新

**Spec 要求：**
- Running 状态的 agent 显示自启动以来的流逝时间，**每秒刷新**
- 实现机制：`setInterval(() => context.invalidate(), 1000)`

**计划设计的关键模式 1：**
```typescript
// 记录启动时间（首次调用时设置）
if (state.startedAt === undefined) {
  state.startedAt = Date.now();
}
// 如果仍在运行（isPartial）且尚未启动定时器 → 启动
if (options.isPartial && !state.interval) {
  state.interval = setInterval(() => context.invalidate(), 1000);
  context.onAbort?.(() => { clearInterval(state.interval); state.interval = undefined; });
}
// 如果已完成或出错 → 固定结束时间并清理定时器
if (!options.isPartial || context.isError) {
  state.endedAt ??= Date.now();
  if (state.interval) { clearInterval(state.interval); state.interval = undefined; }
}
```

**实现现状：**
```typescript
// index.ts L550-554
const elapsed = view.status === "running" && view.duration.durationMs === undefined
  ? formatDuration(Date.now() - view.duration.startTime)
  : undefined;
```

`renderResult(result, { expanded }, theme, _context)` — 第四个参数 `_context` 被完全忽略（下划线前缀）。没有 `setInterval`，没有 `context.invalidate()` 调用，没有 `context.isError` / `options.isPartial` 检查。elapsed 只在 render 调用瞬间计算一次，**不会每秒刷新**。

**影响：** 用户看到 elapsed 为固定值，所有实时计时功能失效。这是静态渲染和动态渲染的根本区别。

**修改方向：** 在 renderResult 中实现 spec 和 plan 规定的 timer 模式：
1. 接收真实的 `context` 参数（移除 `_` 前缀）
2. 使用 `context.state` 存储 startTime 和 interval ID
3. 在 `options.isPartial && !state.interval` 时启动 `setInterval(() => context.invalidate(), 1000)`
4. 在 abort 时 `context.onAbort` 清理 interval
5. 在 completed/error 时固定 elapsed 并清理 interval

### F3: 活动流优化

**Spec 要求：** 活动流交错显示 tool call + text output，过滤 thinking block，collapsed 时文本预览 3 行。

**实现检查：**

| 检查项 | 状态 |
|--------|------|
| `part.type === "thinking"` 过滤 | ✅ `getDisplayItems` L253 |
| text output 包含在 items 中 | ✅ `part.type === "text"` push |
| `TEXT_PREVIEW_LINES = 3` 常量定义 | ✅ render.ts L18 |
| Collapsed 预览 3 行 | ✅ `renderSingleCollapsedText` L439-442 |
| Expanded 显示全部 text | ✅ `renderAgentDetail` L398-399 |

**结果：** ✅ 通过。活动流符合 spec F3 要求。

### F4: 执行顺序可视化

**Spec 要求：**

| 模式 | 要求 | 实现 |
|------|------|------|
| Single | 无顺序信息 | ✅ |
| Parallel | 表格展示所有 agent，运行时实时更新 | ✅ `renderParallelTable` 显示 agent name + icon + duration + turns |
| Chain | 编号步骤 + ○/⏳/✅ | ✅ `renderChainCollapsedText` 显示 `Step ${stepNum}:` + `renderStatusIcon` |

额外发现：
- Parallel Running agent 显示 `last @ HH:MM:SS` 时间戳 ✅
- Chain Running agent 显示实时 elapsed（但无 real-time refresh——参见 Issue #2）
- Chain Pending agent 使用 `renderStatusIcon` 渲染正确的状态图标 ✅

**结果：** ✅ 通过。但 F2 缺失影响 Chain/Parallel 的实时 elapsed 显示。

### F5: CHAIN_COLLAPSED_ITEM_COUNT 常量

**Spec 要求：** `CHAIN_COLLAPSED_ITEM_COUNT = 5`

**实现：**
```typescript
export const CHAIN_COLLAPSED_ITEM_COUNT = 5; // render.ts L17
```

用于 `renderChainCollapsedText` L487：`view.toolCalls.slice(-CHAIN_COLLAPSED_ITEM_COUNT)` ✅

**结果：** ✅ 通过。硬编码的 `.slice(-5)` 已替换为具名常量。

### F6: collect_subagent 完全移除

**Spec 要求：**

| 移除项 | 状态 |
|--------|------|
| `collect_subagent` 工具注册 | ✅ 已移除（diff 显示整个注册块被删除） |
| `CollectSubagentParams` 类型定义 | ✅ 已删除 |
| Description 中对 collect_subagent 的引用 | ✅ 两处引用均已移除 |
| tool description 中背景任务文案 | ✅ 已替换为 "automatically injected" |

**保留项（spec 要求保留）：**

| 保留项 | 状态 |
|--------|------|
| background job cleanup | ✅ `spawnManager.cleanupAllJobs()` 保留 |
| session_shutdown cleanup | ✅ `pi.on("session_shutdown", ...)` 保留 |

**结果：** ✅ 通过。移除范围精确，未伤及 cleanup 逻辑。

### F7: renderCall 统一格式

**Spec 要求：** renderCall 也使用新 icon + 格式。

**实现检查：**
| 模式 | Line 1 | 符合? |
|------|--------|-------|
| Single | `⏳ single #id  agent-name  model [scope]` | ✅ |
| Parallel | `⏳ parallel #id (N tasks)  agents  model [scope]` | ✅ |
| Chain | `⏳ chain #id (N steps)  agents  model [scope]` | ✅ |

所有模式统一使用 `headerPrefix`（`⏳` + warning color）✅
不再使用旧的 `theme.bold("subagent ")` 前缀 ✅
Session ID 通过 `idPart()` 获取（前 8 位）✅

**结果：** ✅ 通过。

### F8: 状态语义化

**Spec 要求：**
| 状态 | Icon | Theme Token |
|------|------|-------------|
| Running | ⏳ | warning |
| Succeeded | ✅ | success |
| Failed | ❌ | error |
| Pending | ○ | muted |

**实现：**
```typescript
const STATUS_ICONS: Record<string, string> = {
  running: "\u23F3",
  succeeded: "\u2705",
  failed: "\u274C",
  pending: "\u25CB",   // ○
};
const STATUS_COLORS: Record<string, string> = {
  running: "warning",
  succeeded: "success",
  failed: "error",
  pending: "muted",
};
```

在所有 render 函数中被调用：
- `renderAgentDetail` ✅（chain/parallel detail 中的 per-agent icon）
- `renderSingleCollapsedText` ✅
- `renderChainCollapsedText`（per-step icon）✅
- `renderParallelTable`（per-agent icon）✅
- `renderParallelDetail`（overall + per-agent icon）✅

**但是：** `renderChainCollapsedText` 的 `icon: string` 参数（总体 icon）由调用者（index.ts）传入，调用者使用硬编码 icon/color map 而非 `renderStatusIcon()`。这导致总体 icon 的颜色策略与内部 icon 不一致（见 Issue #3）。

**结果：** ✅ 通过，但有 LOW 问题（硬编码重复）。

---

## 检查维度 2：代码质量

### 可读性

| 检查项 | 评价 |
|--------|------|
| 命名 | ✅ `STATUS_ICONS`、`STATUS_COLORS`、`renderStatusIcon`、`CHAIN_COLLAPSED_ITEM_COUNT` 命名清晰 |
| 函数长度 | ✅ `renderSingleCollapsedText` ~40行，`renderChainCollapsedText` ~30行，均在 80 行上限内 |
| 注释 | ✅ "为什么" 类注释存在（如 render.ts L1-7 block comment，`// Unified Line 1`） |
| 一致性 | ⚠️ `renderChainCollapsedText` 接受预着色 `icon: string`，而其他 render 函数用 `renderStatusIcon` 内部渲染——此不一致可能被质疑 |

### 错误处理

| 检查项 | 评价 |
|--------|------|
| renderResult 空 result | ✅ `if (!details || details.results.length === 0)` 检查 |
| renderResult 未知 mode | ✅ fallback 到 `result.content[0]` |
| renderStatusIcon 未知 status | ✅ fallback 到 running icon + muted color |
| renderAgentDetail 空 output | ✅ `"(no output)"` 提示 |

**结果：** ✅ 错误处理充分。

### 边界条件

- `renderSingleCollapsedText(view.toolCalls.slice(-COLLAPSED_ITEM_COUNT))` — 当 toolCalls 长度 < 10 时，slice 返回全部 ✅
- `skipped` 计算 — 当 `view.toolCalls.length <= COLLAPSED_ITEM_COUNT` 时，skipped = 0，不会展示 "earlier items" ✅
- chain 视图 `toShow.slice(-5)` 同样正确处理边界 ✅
- `view.status === "running" && view.duration.durationMs === undefined` 作为计算 elapsed 的判断条件 ✅

**结果：** ✅ 边界条件处理正确。

---

## 检查维度 3：架构合规

### CLAUDE.md 约束检查

| 约束 | 检查 |
|------|------|
| 颜色通过 `theme.fg("token", text)` 使用语义 token | ✅ `renderStatusIcon` 使用 `theme.fg(color, icon)` |
| 不硬编码 ANSI | ✅ 所有颜色通过 theme API |
| renderCall/renderResult 返回 `new Text(string, 0, 0)` | ✅ |
| 展开/折叠：`options.expanded` 控制 | ✅ renderResult 中 `if (expanded)` 分支 |
| 状态通过 session_start 重建的闭包变量 | ⚠️ `capturedSessionId` 共享（Issue #5） |
| 单文件 ≤ 1000 行 | ✅ render.ts ~600行，index.ts ~280行 |
| 函数 ≤ 80 行 | ✅ 最大 ~40 行 |
| 禁止 `any` | ✅ 使用 `Record<string, string>` 和具体类型 |
| import 顺序 | ✅ Node 内置 → npm → 内部 |

### 分层检查

- `index.ts` 只做注册胶水 ✅（无业务逻辑）
- 渲染逻辑在 `render.ts` ✅
- `render.ts` 不依赖 `index.ts`、`spawn.ts`、`model.ts` ✅

---

## 检查维度 4：安全和性能

- **setInterval (1s) 性能：** 当前未实现（Issue #2），实现后需确保只启动一个 interval ✅
- **collapse/expand 性能：** slice 操作 O(N)，N = agent 的活动条目数，量级很小 ✅
- **无安全漏洞**（无输入注入路径、无未校验输入）✅

---

## 检查维度 5：集成验证

### Hook/Event/Plugin 组件

规格外：subagent extension 是工具（tool），不是 hook 组件。无 hook/event/plugin 注册路径需要追溯。✅

### 新增数据字段

- `sessionShortId`：由 `capturedSessionId` → `sessionShortId()` 函数提供，消费者为 `renderAgentDetail`、`renderSingleCollapsedText`、`renderChainCollapsedText`、`renderParallelTable`、`renderParallelDetail`。所有消费者已更新 ✅
- `elapsed`：由 renderResult 计算，消费者为 `renderSingleCollapsedText`。所有消费者已更新 ✅

### 移除数据字段

- `CollectSubagentParams`：已移除，无遗留消费者 ✅
- `formatUsageStats` 导入：已移除（不再在 index.ts 中直接使用，通过 `aggregateUsageFromViews` 间接使用）✅
- `* as fs` 导入：已移除 ✅

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改方向 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | `render.ts:renderSingleCollapsedText` L429-430 | **F1: agent+model+elapsed 在 Line 1 而非 Line 2**，违反 spec 三层 Header 结构。agent name、model、elapsed 应放在 Line 2（dim 颜色，2 空格缩进） | 分离 Line 1 和 Line 2：Line 1 = `icon + "single" + #id`，Line 2 = `  view.name + model + elapsed`（dim 颜色） |
| 2 | **MUST FIX** | `index.ts:renderResult` L550-554 | **F2: 实时计时器未实现**。`_context` 被忽略，无 `setInterval + context.invalidate()`。elapsed 只在 render 瞬间计算，不会每秒刷新 | 参照 plan 关键模式 1：使用 `context.state` 存储 timer 状态，`setInterval(() => context.invalidate(), 1000)` 实现实时刷新，`context.onAbort` 清理 |
| 3 | LOW | `index.ts:renderResult` L574-578 | **Chain 总体 icon 硬编码**。`iconMap`/`colorMap` 重复了 `render.ts` 中 `STATUS_ICONS`/`STATUS_COLORS` 的逻辑 | 替换为 `renderStatusIcon(overallStatus, theme)` |
| 4 | LOW | `render.ts:renderChainCollapsedText` L462 | **`icon: string` 参数不一致**。函数签名接收预着色 icon string，而内部 step icon 使用 `renderStatusIcon()`，导致 icon 着色策略不统一 | 改为内部使用 `renderStatusIcon()` 计算总体 icon，移除 `icon` 参数，或改为传原始 status string |
| 5 | INFO | `index.ts:L103` | **`capturedSessionId` 共享于多 session**。模块级 const 对象被所有 session 共享，多 session 场景下有数据竞争隐患 | 当前单 session 使用安全。后续需迁移到 `ctx.sessionManager` |
| 6 | INFO | `render.ts:L54` | **`ThemeColorParam` 类型断言**。`(STATUS_COLORS[status] ?? "muted") as ThemeColorParam`——STATUS_COLORS 的 Record 类型丢掉了具体 literal 值 | 可考虑用 `as const satisfies Record<string, ThemeColorParam>` 来保留类型信息（纯风格） |

---

## 结论

**需修改后重审。** 存在 2 条 MUST FIX 问题，涉及 spec 合规（F1: header 分层）和功能缺失（F2: 实时计时器）。

F1 问题虽不直接导致功能错误，但属于 spec 明确要求的 display format，且代码审查的第一优先级是 spec compliance。F2 问题直接导致实时计时这一核心功能不可用。

其余 LOW/INFO 问题可与非阻塞部分一起修复或延迟处理。

### Summary

编码评审完成，第1轮，2条MUST FIX，需修改后重审。
