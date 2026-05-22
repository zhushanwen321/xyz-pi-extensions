---
verdict: pass
---

# Subagent TUI 渲染统一与优化 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 subagent extension 的 TUI 渲染管线，统一所有模式（single/parallel/chain/background）的 header 格式、状态图标（⏳✅❌）、实时计时每秒刷新、活动流增加 text output

**Architecture:** 全部改动集中在两个文件：`render.ts`（渲染逻辑）和 `index.ts`（工具注册 + renderCall）。使用 pi-tui 现有 API（Text, Container, Spacer, Markdown），通过 `setInterval(1s) + context.invalidate()` 实现实时计时。通过 `ctx.sessionManager.getSessionId()` 获取 session ID 前缀。

**Tech Stack:** TypeScript, pi-tui (Text/Container/Spacer/Markdown), pi-coding-agent ExtensionAPI

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `subagent/src/render.ts` | modify | BG1 | Header 结构重构、状态图标、实时计时、活动流过滤 thinking 并增加 text output |
| `subagent/src/index.ts` | modify | BG2 | 移除 collect_subagent 工具注册、统一 renderCall 格式、renderResult 集成 timer + session ID |
| `tests/` | verify | BG3 | E2E 验证：pi 加载扩展后检查 render 显示 |

## Task List

| # | Task | Type | Depends on | Group |
|---|------|------|-----------|-------|
| 1 | render.ts: 重构 header 结构 + 状态图标 + 实时计时 | backend | — | BG1 |
| 2 | render.ts: 活动流过滤 thinking 并交错显示 text output | backend | — | BG1 |
| 3 | render.ts: 各模式执行顺序可视化 (F4) | backend | — | BG1 |
| 4 | index.ts: 移除 collect_subagent 工具 (F6) | backend | — | BG2 |
| 5 | index.ts: 统一 renderCall 格式 (F7) | backend | — | BG2 |
| 6 | index.ts: renderResult 集成 timer + session ID (F1,F2) | backend | 1,5 | BG2 |
| 7 | 🧪 E2E 验证 + 手动检查 | test | 4,5,6 | BG3 |

## Execution Groups

### BG1: render.ts — 渲染管线重构

**Description:** 重构所有四个 render 模式的核心渲染逻辑。包括统一三层 header、替换为语义状态图标、集成实时计时器、活动流增加 text output 并过滤 thinking block。三个 Task 修改同一个文件，需串行执行。

**Tasks:** Task 1, Task 2, Task 3

**Files (预估):** 1 个文件 modify

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（high） |
| 注入上下文 | spec.md 全量（F1-F5, F8），render.ts 现有代码，pi-tui animation-scan 发现（setInterval + context.invalidate() 模式） |
| 读取文件 | `subagent/src/render.ts` |
| 修改文件 | `subagent/src/render.ts` |

**Execution Flow (BG1 内部):** 串行派遣。每个 Task 走 executor subagent 链，完成后 runner 验证。

Task 1:
  1. executor (read spec.md §F1,F2,F8, render.ts) → 实现三层 header、⏳✅❌○ 图标替换、setInterval(1s) + context.invalidate() 实时计时
  2. spec-compliance (read updated render.ts, spec.md) → 检查 F1/F2/F8 是否全部实现

Task 2:
  1. executor (read updated render.ts, spec.md §F3) → getDisplayItems 增加 text content 过滤 thinking，交错显示 tool call + text
  2. spec-compliance (read updated render.ts, spec.md) → 检查 F3 是否实现

Task 3:
  1. executor (read updated render.ts, spec.md §F4, §F5) → Parallel 表格增加运行中实时更新，Chain 显示编号步骤 + ○/⏳/✅；将 Chain 模式硬编码的 `.slice(-5)` 提取为 `CHAIN_COLLAPSED_ITEM_COUNT = 5` 常量，与 F5 对齐
  2. spec-compliance (read updated render.ts, spec.md) → 检查 F4、F5 是否实现

**设计细节:** 本节详述所有三个 Task 的具体代码模式。

#### 关键模式 1: 实时计时（F2）

遵循 Pi bash tool 的已验证模式（bash.ts L418-442）：将 interval ID 存储在 `context.state` 中，用 `!context.state.interval` 做防护，用 `options.isPartial` 判断是否仍在运行。

```typescript
// renderResult 函数签名处
// renderResult(result, options, theme, context)

// 从 context.state 读取/初始化状态
const state = context.state ?? {};
context.state = state;

// 记录启动时间（首次调用时设置）
if (state.startedAt === undefined) {
  state.startedAt = Date.now();
}

// 如果仍在运行（isPartial）且尚未启动定时器 → 启动
if (options.isPartial && !state.interval) {
  state.interval = setInterval(() => {
    context.invalidate(); // 每秒重渲染
  }, 1000);

  // abort 信号到来时清理定时器
  context.onAbort?.(() => {
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  });
}

// 如果已完成或出错 → 固定结束时间并清理定时器
if (!options.isPartial || context.isError) {
  state.endedAt ??= Date.now();
  if (state.interval) {
    clearInterval(state.interval);
    state.interval = undefined;
  }
}

// 计算 elapsed
const elapsed = state.endedAt
  ? ((state.endedAt - state.startedAt) / 1000).toFixed(1)
  : ((Date.now() - state.startedAt) / 1000).toFixed(1);
```

**CRITICAL — 防护条件：**
- 用 `!state.interval` 做启动防护（never用模块级 `isDone` flag）
- 用 `!options.isPartial` 做停止条件
- `context.state` 是 session-safe 的存储位置，不违反 session isolation 约束

#### 关键模式 2: Session ID（header Line 1）

```typescript
// 从 renderResult 的 context 获取
const sessionId = context.sessionManager?.getSessionId?.() ?? "";
const shortId = sessionId.slice(0, 8); // 前 8 位 UUIDv7
// Line 1: "⏳ single #0196a3b2"
```

#### 关键模式 3: 活动流过滤 thinking + text output（F3）

```typescript
// 在 getDisplayItems 中增加 text content 过滤
function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    for (const part of msg.content ?? []) {
      if (part.type === "thinking") continue; // 过滤 thinking
      if (part.type === "text" && part.text?.trim()) {
        items.push({ type: "text", text: part.text });
      }
      if (part.type === "toolCall") {
        items.push({ type: "toolCall", toolCall: part.toolCall });
      }
    }
  }
  return items;
}
```

Text output collapsed 预览：
```typescript
// renderSingleCollapsedText / renderChainCollapsedText 中
const TEXT_PREVIEW_LINES = 3;
for (const item of displayItems) {
  if (item.type === "text") {
    const lines = item.text.split("\n").slice(0, TEXT_PREVIEW_LINES);
    text += "\n  " + theme.fg("dim", lines.join("\n  "));
    if (item.text.split("\n").length > TEXT_PREVIEW_LINES) {
      text += theme.fg("muted", "  ...");
    }
  }
  // toolCall 保持当前 → 格式
}
```

#### Task 1: 重构 header 结构 + 状态图标 + 实时计时

**函数影响范围：**
- `renderSingleCollapsedText()` — header line 1 + 2, 图标替换, elapsed 计算
- `renderParallelTable()` — header line 1 + 2, 图标替换, elapsed 计算
- `renderChainCollapsedText()` — header line 1 + 2, 图标替换, elapsed 计算
- `renderAgentDetail()` — header icon + line 2
- `renderParallelDetail()` — header icon + line 2

**header 常量：**
```typescript
const STATUS_ICONS = {
  running: "⏳",
  succeeded: "✅",
  failed: "❌",
  pending: "○",
} as const;
```

**renderSingleCollapsedText 新 header：**
```typescript
// 从 context 获取 session ID
// (context 需要作为参数传入或通过闭包)
function renderSingleCollapsedText(
  view: AgentResultView,
  theme: Theme,
  sessionShortId?: string,
  elapsed?: string,
): string {
  const icon = view.status === "running" ? "⏳"
    : view.status === "failed" ? "❌" : "✅";
  const iconColor = view.status === "running" ? "warning"
    : view.status === "failed" ? "error" : "success";

  const idPart = sessionShortId ? ` #${sessionShortId}` : "";

  // Line 1: "⏳ single #0196a3b2"
  const line1 = `${theme.fg(iconColor, icon)} ${theme.fg("toolTitle", theme.bold("single"))}${theme.fg("accent", idPart)}`;

  // Line 2: "  general-purpose  ds-flash/high  3.2s"
  const timeStr = view.status === "running" ? (elapsed ?? "") : formatDuration(view.duration.durationMs ?? 0);
  const modelStr = view.model ? `${view.model}/${view.thinkingLevel ?? ""}` : "";
  const headerParts = [view.agent ?? view.agentName ?? "", modelStr, timeStr].filter(Boolean);
  const line2 = theme.fg("dim", "  " + headerParts.join("  "));

  // Line 3+: activity stream (existing logic with added text output)
  const activityLines = buildActivityLines(view, theme, false /* collapsed */);

  return [line1, line2, ...activityLines].join("\n");
}
```

**renderParallelTable 新 header：**
```typescript
function renderParallelTable(
  summary: ParallelSummaryView,
  theme: Theme,
  sessionShortId?: string,
): string {
  const icon = summary.isDone ? (summary.failedCount > 0 ? "❌" : "✅") : "⏳";
  const iconColor = summary.isDone ? (summary.failedCount > 0 ? "error" : "success") : "warning";

  const idPart = sessionShortId ? ` #${sessionShortId}` : "";
  const statusStr = summary.isDone
    ? `${summary.successCount}/${summary.totalCount} succeeded`
    : `${summary.doneCount}/${summary.totalCount} done, ${summary.totalCount - summary.doneCount} running`;

  const totalElapsed = formatDuration(summary.totalDurationMs ?? 0);
  // Line 1: "⏳ parallel #0196a3b2  2/4 done, 2 running  8.3s"
  const line1 = `${theme.fg(iconColor, icon)} ${theme.fg("toolTitle", theme.bold("parallel"))}${theme.fg("accent", idPart)}  ${theme.fg("dim", statusStr)}  ${theme.fg("muted", totalElapsed)}`;

  // Line 2: "  ds-flash/high" (shared model)
  const line2 = theme.fg("dim", "  " + (summary.resolvedModel ?? ""));

  // Table rows (existing logic)
  const rows = summary.agents.map(a => buildTableRow(a, theme));
  return [line1, line2, ...rows].join("\n");
}
```

**renderChainCollapsedText 新 header：**
```typescript
function renderChainCollapsedText(
  views: AgentResultView[],
  details: SubagentDetails,
  icon: string,
  theme: Theme,
  sessionShortId?: string,
): string {
  const iconColor = icon === "✓" ? "success" : icon === "✗" ? "error" : "warning";
  const successCount = views.filter(v => v.status === "succeeded").length;
  const idPart = sessionShortId ? ` #${sessionShortId}` : "";

  // Line 1: "⏳ chain #0196a3b2  1/3 done, 1 running  6.1s"
  const runningCount = views.filter(v => v.status === "running").length;
  const statusStr = runningCount > 0
    ? `${successCount}/${views.length} done, ${runningCount} running`
    : `${successCount}/${views.length} succeeded`;
  const line1 = `${theme.fg(iconColor, icon)} ${theme.fg("toolTitle", theme.bold("chain"))}${theme.fg("accent", idPart)}  ${theme.fg("dim", statusStr)}`;

  // Line 2: "  ds-flash/high" (shared model)
  const line2 = theme.fg("dim", "  " + (details.resolvedModel ?? ""));

  // Step lines (existing logic with icon changes)
  const stepLines = views.map((v, i) => {
    const stepIcon = v.status === "pending" ? "○"
      : v.status === "running" ? "⏳"
      : v.status === "failed" ? "❌" : "✅";
    return `${theme.fg("dim", `Step ${details.results[i]?.step ?? i + 1}:`)} ${stepIcon} ${theme.fg("accent", v.agent)}  ...`;
  });

  return [line1, line2, ...stepLines].join("\n");
}
```

---

### BG2: index.ts — 工具注册 + renderCall 统一 + renderResult 集成

**Description:** 移除 collect_subagent 工具注册，统一 renderCall 格式，在 renderResult 中集成 timer + session ID 并传递给 render.ts 的函数。三个 Task 修改同一文件，需串行执行。

**Tasks:** Task 4, Task 5, Task 6

**Files (预估):** 1 个文件 modify

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（medium） |
| 注入上下文 | spec.md §F1, F2, F6, F7, index.ts 当前源代码，timer 模式参考（plan.md 关键模式 1），session ID 模式参考（plan.md 关键模式 2） |
| 读取文件 | `subagent/src/index.ts`, `subagent/src/spawn.ts`（仅 Task 4） |
| 修改文件 | `subagent/src/index.ts` |

**Execution Flow (BG2 内部):** 串行派遣。

Task 4:
  1. executor (read index.ts, spawn.ts, spec.md §F6) → 移除 collect_subagent 工具注册代码块，清理相关类型（CollectSubagentParams）。确认 spawnManager.getActiveJobs/getJobEvents/getSessionJobFiles 仅被 collect_subagent 使用。
  2. spec-compliance (read updated index.ts, spec.md) → 检查 F6 实现

Task 5:
  1. executor (read updated index.ts, spec.md §F1, F7) → 更新 renderCall 函数为新格式（⏳ + 模式 + session ID + agent/model/thinking）
  2. spec-compliance (read updated index.ts) → 检查 renderCall 格式是否统一

Task 6 (depends on Task 5 + BG1 Task 1):
  1. executor (read updated index.ts, render.ts, spec.md §F1, F2) → 在 renderResult 中集成：
     a) 用 `context.state` 存储 startTime 和 interval ID
     b) 用 `setInterval` + `context.invalidate()` 实现每秒刷新
     c) 用 `context.sessionManager?.getSessionId?.()` 获取 session ID（前 8 位）
     d) 将 sessionShortId 和 elapsed 传递给 render 函数：`renderSingleCollapsedText(view, theme, sessionShortId, elapsed)`、`renderParallelTable(summary, theme, sessionShortId)`、`renderChainCollapsedText(views, details, icon, theme, sessionShortId)`
     e) 注意处理 `context.state.interval` 的清理（abort/complete）
  2. executor (read updated index.ts, render.ts, spec.md) → 验证 renderResult 的 context.state API 可用性。若 `context.state` 或 `context.sessionManager?.getSessionId?.()` 不可用，需 fallback 方案：从 execute 返回的 details 中传递 session ID 和 startTime
  3. spec-compliance (read updated index.ts, render.ts) → 检查 F1、F2 是否在 renderResult 中正确实现

**设计细节:**

#### Task 4: 移除 collect_subagent 工具

移除以下代码块（约 100 行）：
```typescript
// 删除 CollectSubagentParams 定义：
const CollectSubagentParams = Type.Object({...});

// 删除 registerTool 调用块：
pi.registerTool({
  name: "collect_subagent",
  ...
});

// 验证 spawnManager 的方法是否仅被 collect_subagent 使用
// 检查 index.ts 中 getActiveJobs/getJobEvents/getSessionJobFiles 的引用
// 如果仅被 collect_subagent 使用，这些方法可标记保留（Constraints 要求保留 cleanup）
```

更新 `subagent` tool 的 description 中 collect_subagent 相关文案：
```
// 当前 in description:
"Use collect_subagent only to list active background jobs or check on a running job's status"
// 改为: 移除该行，更新为
"Background results are automatically injected into the conversation when the subagent completes"
```

同时更新 `promptGuidelines` 中 collect_subagent 引用。

#### Task 5: 统一 renderCall 格式

```typescript
renderCall(args, theme, context) {
  const scope: AgentScope = args.agentScope ?? "user";
  const complexity = args.taskComplexity as string | undefined;
  const modelStr = args.model || (complexity ? `auto:${complexity}` : "?");
  const thinking = args.thinkingLevel as string | undefined;
  const modelDisplay = thinking
    ? theme.fg("dim", ` ${modelStr}/${thinking}`)
    : theme.fg("dim", ` ${modelStr}`);
  const bg = args.background ? theme.fg("warning", " [bg]") : "";

  // 获取 session ID
  const sessionId = context.sessionManager?.getSessionId?.() ?? "";
  const shortId = sessionId.slice(0, 8);
  const idPart = shortId ? ` #${shortId}` : "";

  // 解析模式
  const hasChain = (args.chain?.length ?? 0) > 0;
  const hasTasks = (args.tasks?.length ?? 0) > 0;
  let mode = "single";
  let modeLabel = args.agent ?? "...";
  let count = 1;
  if (hasChain) {
    mode = "chain";
    modeLabel = `${args.chain!.length} steps`;
    count = args.chain!.length;
  } else if (hasTasks) {
    mode = "parallel";
    modeLabel = `${args.tasks!.length} tasks`;
    count = args.tasks!.length;
  }

  // Line 1: "⏳ single #0196a3b2" or "⏳ chain #0196a3b2" or "⏳ parallel #0196a3b2"
  const line1 = `${theme.fg("warning", "⏳")} ${theme.fg("toolTitle", theme.bold(mode))}${theme.fg("accent", idPart)}${bg}`;

  // Line 2: "  agent-name  model/thinking  [scope]"
  const agents = args.chain?.map(s => s.agent).join(", ")
    ?? args.tasks?.map(t => t.agent).join(", ")
    ?? args.agent ?? "...";
  const line2 = theme.fg("dim", `  ${agents}  ${modelDisplay}`)
    + theme.fg("muted", ` [${scope}]`);

  // Task preview
  let text = line1 + "\n" + line2;
  const taskText = args.task ?? args.chain?.[0]?.task ?? args.tasks?.[0]?.task;
  if (taskText) {
    const preview = taskText.length > 60 ? `${taskText.slice(0, 60)}...` : taskText;
    text += `\n  ${theme.fg("dim", preview)}`;
  }

  return new Text(text, 0, 0);
}
```

---

### BG3: 🧪 E2E 验证

**Description:** 手动验证所有模式的渲染效果符合 spec AC 要求

**Tasks:** Task 6

**Files (预估):** 0 个文件修改（仅手动验证）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择（low） |
| 注入上下文 | spec.md AC1-AC6 验收标准，要求输出验证结果表 |
| 读取文件 | 不需要读取源文件 |
| 修改/创建文件 | 无 |

**Execution Flow:** 单一 subagent 输出验证 checklist。

**设计细节:** 无代码改动，仅验证 checklist。

---

## Dependency Graph & Wave Schedule

```
BG1 (render.ts changes) ──┐
                            ├──→ BG2 Task 6 (renderResult integration, depends on BG1 Task 1)
BG2 Task 4-5 (index.ts) ───┘
                            └──→ BG3 (verification, depends on BG2 Task 6)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | BG1, BG2(T4-5) | 并行：BG1 改 render.ts，BG2 Task 4-5 改 index.ts（不同文件） |
| Wave 2 | BG2(T6) | 依赖 BG1 Task 1（render.ts header 函数）和 BG2 Task 5（renderCall 完成）完成后，执行 BG2 Task 6（renderResult 集成） |
| Wave 3 | BG3 | 验证，等待所有 Task 完成 |

**注意：** BG2 Task 6 需要 `render.ts` 中更新后的函数签名（带 `sessionShortId` 可选参数），所以必须在 BG1 Task 1 之后执行。但 BG1 连续执行 Task 1→2→3，BG2 Task 6 在 BG1 Task 1 完成后即可启动（不需要等 BG1 Task 2-3）。

**并行约束:**
- Wave 1 中 BG1 和 BG2 可以并行（修改不同文件）
- 同一文件不允许多个 subagent 同时修改

---

## E2E Test Plan

见 `e2e-test-plan.md`

## Test Cases

见 `test_cases_template.json`
