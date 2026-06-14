---
verdict: pass
complexity: L2
---

# Subagent TUI 增强 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强 subagents 扩展的 TUI：runtime inline widget 展示工具调用流水 + turn 摘要滚动消息；新增 `/subagents list` 全屏两级视图（列表 + 详情）展示所有子 agent 执行情况。

**Architecture:** 事件采集从「覆盖式」（`updateWidgetFromEvent` 折叠为单 `activity` 字段）改为「追加式」——ring buffer 累积 AgentEventLogEntry，renderWidget 投影最近 N 条。/subagents list 通过 `ctx.ui.custom()` overlay 全屏渲染，订阅 runtime 事件总线实现实时刷新。已完成 agent 通过双层留存（BgRecord 扩展 eventLog + 新增 _completedAgents Map）保证详情视图数据源。

**Tech Stack:** TypeScript, Pi Extension API (`@mariozechner/pi-coding-agent`), typebox, pi-tui (`matchesKey`, `Key`, `truncateToWidth`), vitest

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `extensions/subagents/src/types.ts` | modify | types | 新增 AgentEventLogEntry / CompletedAgentRecord；扩展 AgentEvent.tool_start 加 args |
| `extensions/subagents/src/core/event-bridge.ts` | modify | events | tool_execution_start 透传 args 到 AgentEvent |
| `extensions/subagents/src/runtime.ts` | modify | runtime | updateWidgetFromEvent 追加式 + 事件总线 + 留存机制 + sync cancelled 路径 |
| `extensions/subagents/src/tui/format.ts` | modify | format | 新增 extractLabelFromArgs / formatEventLogLine 纯函数 |
| `extensions/subagents/src/tui/agent-widget.ts` | modify | widget | renderWidget 增强：status summary + eventLog 行布局 |
| `extensions/subagents/src/tui/subagents-view.ts` | create | view | 全屏 overlay 组件（renderView + processKey + createSubagentsView） |
| `extensions/subagents/src/commands/config.ts` | modify | commands | /subagents list 子命令解析 + 守卫 |
| `extensions/subagents/src/__tests__/format.test.ts` | modify | test | 新增 extractLabelFromArgs / formatEventLogLine 测试 |
| `extensions/subagents/src/__tests__/event-bridge.test.ts` | modify | test | args 透传测试 |
| `extensions/subagents/src/__tests__/agent-widget.test.ts` | modify | test | renderWidget eventLog 渲染测试 |
| `extensions/subagents/src/__tests__/subagents-view.test.ts` | create | test | renderView + processKey + collectRecords 纯函数测试 |

## Interface Contracts

### Module: types

#### Type: AgentEventLogEntry

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"tool_start" \| "tool_end" \| "turn_end"` | 事件类型 |
| `label` | `string` | 可展示的摘要文本（toolName + args 摘要 / turn 文本摘要） |
| `ts` | `number` | 时间戳（ms epoch，由 updateWidgetFromEvent 内 Date.now() 生成） |
| `status?` | `"running" \| "done" \| "failed"` | tool_end 带状态 |

#### Type: CompletedAgentRecord

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | widget id（run-1 / bg-1-xyz） |
| `agent` | `string` | agent 名 |
| `status` | `"done" \| "failed" \| "cancelled"` | 终态 |
| `eventLog` | `AgentEventLogEntry[]` | 完整事件日志 |
| `turns?` | `number` | 总 turn 数 |
| `totalTokens?` | `number` | 总 token |
| `result?` | `AgentResult` | done 时存在 |
| `error?` | `string` | failed/cancelled 时存在 |
| `startedAt` | `number` | 启动时间 |
| `endedAt?` | `number` | 结束时间 |

#### Interface: BgRecord（扩展）

新增字段：
- `eventLog: AgentEventLogEntry[]`（widget 淡出前转移）
- `agent: string`（opts.agent ?? "default"）

#### Interface: AgentEvent.tool_start（扩展）

新增 `args?: unknown` 字段。

#### Interface: WidgetAgentState（扩展）

新增字段：
- `eventLog: AgentEventLogEntry[]`（ring buffer，MAX_EVENT_LOG_ENTRIES=20）
- `_currentTurnText?: string`（text_delta 累加缓冲，turn_end 时切片后重置）

#### Constants

| Name | Value | Description |
|------|-------|-------------|
| `MAX_EVENT_LOG_ENTRIES` | `20` | eventLog ring buffer 上限 |
| `TURN_SUMMARY_MAX` | `80` | turn 摘要截断长度 |
| `COMPLETED_AGENTS_MAX` | `50` | _completedAgents Map 上限 |
| `STALLED_TIMEOUT_MS` | `5 * 60 * 1000` | widget 超时兜底阈值（5min） |
| `WIDGET_EVENT_LINES` | `11` | inline widget eventLog 最大行数（12 行总量 - 1 行 status summary） |

### Module: tui/format

#### Function: extractLabelFromArgs

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| extractLabelFromArgs | `(toolName: string, args: unknown) => string` | `string` | args=null → toolName；非 read/edit/write/bash → toolName | FR-1.1a |

提取策略（白名单 keys）：
- `read`/`write`/`edit`: `args.path` → 取 basename
- `bash`: `args.command` → 取前 60 字符
- `web_search`/`web_fetch`: `args.query` / `args.url`
- 其他：返回 `toolName`

#### Function: formatEventLogLine

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| formatEventLogLine | `(entry: AgentEventLogEntry, theme: ThemeLike) => string` | `string` | — | FR-2.1 |

格式：
- `tool_start`: `├─ {label}  {theme.fg("warning", "⟳ running")}`
- `tool_end` done: `├─ {label}  {theme.fg("success", "✓")}`
- `tool_end` failed: `├─ {label}  {theme.fg("error", "✗")}`
- `turn_end`: `├─ turn {N}: "{摘要}"`（N 由调用方传，因为 ring buffer 不带 turn 编号）

#### Function: formatStatusSummary

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| formatStatusSummary | `(state: WidgetAgentState, spinnerFrame: number, theme: ThemeLike) => string` | `string` | — | FR-2.1 |

格式：`{spinner} {agent} │ {turns} turns │ {tokens} │ {elapsed}s`

### Module: tui/subagents-view

#### Function: collectRecords

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| collectRecords | `(runtime: SubagentRuntime) => SubagentRecord[]` | `SubagentRecord[]` | cancelled 优先 | FR-3.2 |

合并三个数据源（_bgRecords + widget.agents + _completedAgents）按 id 去重，cancelled 状态优先覆盖其他状态。

#### Type: SubagentRecord（view 内部）

```typescript
interface SubagentRecord {
  id: string;
  agent: string;
  status: BackgroundStatus["status"];  // running | done | failed | cancelled
  eventLog: AgentEventLogEntry[];
  turns?: number;
  totalTokens?: number;
  startedAt: number;
  endedAt?: number;
  result?: AgentResult;
  error?: string;
}
```

#### Type: ViewState

| Field | Type | Description |
|-------|------|-------------|
| `level` | `0 \| 1` | 0=列表，1=详情 |
| `selectedIdx` | `number` | 列表选中索引 |
| `scrollOffset` | `number` | 详情滚动偏移 |
| `disposed` | `boolean` | 视图已关闭 |
| `directId?` | `string` | /subagents list <id> 直接进详情 |

#### Function: renderView

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| renderView | `(records: SubagentRecord[], theme: ThemeLike, width: number, state: ViewState, terminalRows: number) => string[]` | `string[]` | terminalRows<8 → "Terminal too small (need ≥8 rows)" | FR-3.2/3.3/4.1 |

#### Function: processKey

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| processKey | `(data: string, records: SubagentRecord[], state: ViewState, runtime: SubagentRuntime, theme: ThemeLike, done: () => void) => boolean` | `boolean`（是否需要重渲染） | disposed=true → 全部忽略 | FR-3.5 |

按键：
- `j`/↓: 选中下移 / 详情下滚
- `k`/↑: 选中上移 / 详情上滚
- `Enter`: Level 0 → Level 1
- `x`: 取消 running agent（仅 background 有效；非 background 调 notify）
- `q`/`Esc`: Level 1 → Level 0 / Level 0 → 关闭

#### Function: createSubagentsView

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| createSubagentsView | `(runtime: SubagentRuntime, theme: ThemeLike, ctx: ExtensionContext, directId?: string) => Promise<void>` | `Promise<void>` | directId 不存在 → notify + 回退 Level 0 | FR-3.1/3.2/4.1 |

内部实现：
- 检测 `ctx.hasUI`：false → 抛 Error（被 commands/config.ts 捕获并 notify）
- 调 `runtime.getActiveView()`：非空 → close 现有（防叠加，FR-3.1 G-017）
- 调 `runtime.setActiveView({ close: wrappedDone })`
- 调 `ctx.ui.custom()` overlay；返回组件契约（invalidate / render / handleInput / dispose）
- subscribe `runtime.onChange` → `requestRender`
- dispose 时 unsubscribe + `runtime.clearActiveView()`（FR-3.1 G-026）

### Module: runtime

#### Function: updateWidgetFromEvent（修改）

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| updateWidgetFromEvent | `(state, event, startTime) => void` | `void` | event.type=message_end → 只更新 totalTokens | FR-1.1/1.1b/1.3 |

行为变更：
- `tool_start`: push `{ type, label: extractLabelFromArgs(toolName, args), ts, status: "running" }` 到 eventLog（仍更新 activity）
- `tool_end`: push `{ type, label, ts, status: isError ? "failed" : "done" }`（仍更新 activity）
- `turn_end`: push `{ type: "turn_end", label: _currentTurnText.slice(0, 80), ts }`；turns+1；重置 _currentTurnText
- `text_delta`: `_currentTurnText += delta`
- `message_end`: 仅更新 totalTokens（不 push）
- push 后超 MAX_EVENT_LOG_ENTRIES → shift 移除最旧

#### Function: SubagentRuntime.onChange

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| onChange | `(fn: () => void) => () => void` | unsubscribe 函数 | — | FR-3.4 |

#### Function: SubagentRuntime.notifyChange

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| notifyChange | `() => void` | `void` | — | FR-3.4 |

调用点：
- `updateWidgetFromEvent` 末尾
- `startBackground` 的 `.then`/`.catch`
- `cancelBackground`
- （可选）`toggleYolo` / `setSessionAgentModel`（影响配置摘要刷新）

#### SubagentRuntime 新增私有字段

- `_completedAgents = new Map<string, CompletedAgentRecord>()`
- `_changeListeners = new Set<() => void>()`
- `_activeView: { close: () => void } | null = null`

#### SubagentRuntime 新增公共方法

| Method | Signature | Returns | Description | Spec Ref |
|--------|-----------|---------|-------------|----------|
| setActiveView | `(view: { close: () => void }) => void` | `void` | 设置当前 active overlay 句柄 | FR-3.1 G-017 |
| getActiveView | `() => { close: () => void } \| null` | `当前 active view 或 null` | — | FR-3.1 G-017 |
| clearActiveView | `() => void` | `void` | 清除 active overlay 句柄（dispose 时调用） | FR-3.1 G-026 |
| listCompleted | `() => CompletedAgentRecord[]` | `CompletedAgentRecord[]` | 列出已归档的 sync agent | FR-3.0 |
| archiveSyncAgent | `(record: CompletedAgentRecord) => void` | `void` | 归档 sync agent（FIFO 上限 COMPLETED_AGENTS_MAX） | FR-3.0 |
| archiveBackgroundAgent | `(id: string, data: { eventLog: AgentEventLogEntry[]; agent: string }) => void` | `void` | 归档 background agent 到 BgRecord | FR-3.0 |

#### 留存时机（FR-3.0）

`runAgent` 内 `setTimeout(() => this.widget.removeAgent(widgetId), WIDGET_LINGER_MS)` 替换为 `setTimeout(() => this.archiveAndRemove(widgetId, widgetState), WIDGET_LINGER_MS)`：

- sync agent（widgetId.startsWith("run-")）：归档到 `_completedAgents`（FIFO 上限 COMPLETED_AGENTS_MAX）
- background agent（widgetId.startsWith("bg-")）：归档到对应 `_bgRecords.get(widgetId)`

#### sync cancelled 路径（G-025）

`runAgent` 的 catch 块检查 `finalOpts.signal?.aborted`：
- `true` → `widgetState.status = "cancelled"`
- `false` → `widgetState.status = "failed"`

### Module: commands/config

#### 函数: registerSubagentsCommand（修改）

解析优先级调整：
```
args[0] === "list"  → createSubagentsView(args[1])
args[0] === "config" → runConfigWizard
其他 → notify formatConfigSummary
```

- hasUI 守卫：`!ctx.hasUI` → notify "/subagents list requires interactive mode"
- directId 不存在 → notify warning + 回退 Level 0（view 内部处理）

## Spec Coverage Matrix

| Spec AC | 验证手段 | Task |
|---------|---------|------|
| AC-1.1 流水行随事件实时追加 | runtime eventlog test + widget render test | Task 3, 4 |
| AC-1.2 spinner 不中断 | agent-widget render test | Task 4 |
| AC-1.3 widget ≤ 12 行 | agent-widget render test | Task 4 |
| AC-1.4 5s 淡出 | 复用现有 FINISHED_LINGER_MS 逻辑 | 不变 |
| AC-2.1 /subagents list 打开 overlay | createSubagentsView 调用 ctx.ui.custom | Task 8 |
| AC-2.2 合并 sync + background 记录 | collectRecords test | Task 7 |
| AC-2.3 running 优先排序 | collectRecords test | Task 7 |
| AC-2.4 空状态提示 | renderView test | Task 7 |
| AC-2.5 j/k 导航高亮 | renderView test | Task 7 |
| AC-3.1 Enter 进详情 | processKey test | Task 7 |
| AC-3.2 完整 eventLog + result | renderView test | Task 7 |
| AC-3.3 running 实时刷新 | onChange subscribe test | Task 6, 7 |
| AC-3.4 q/Esc 返回 | processKey test | Task 7 |
| AC-4.1 print/RPC 报错 | command handler test | Task 8 |

| Spec FR | Task |
|---------|------|
| FR-1.1 AgentEventLogEntry | Task 1 |
| FR-1.1a event-bridge args 透传 | Task 2 |
| FR-1.1b text_delta 累加 | Task 3 |
| FR-1.2 WidgetAgentState 扩展 | Task 1, 3 |
| FR-1.3 updateWidgetFromEvent 追加式 | Task 3 |
| FR-2.1 widget 布局 | Task 4 |
| FR-2.2 行数限制 | Task 4 |
| FR-3.0 留存机制 | Task 5 |
| FR-3.0a agent 字段 | Task 1, 5 |
| FR-3.1 命令入口 | Task 8 |
| FR-3.2 列表视图 | Task 7 |
| FR-3.3 详情视图 | Task 7 |
| FR-3.4 事件总线 | Task 6 |
| FR-3.5 键盘交互 | Task 7 |
| FR-3.5 G-025 sync cancelled | Task 5 |
| FR-3.5 G-008 stalled 兜底 | Task 4 |
| FR-3.6 hasUI 守卫 | Task 8 |
| FR-4.1 subagents-view.ts | Task 7 |

## 实施任务

### Task 1: 数据模型扩展（types.ts）

**Type:** backend
**Files:**
- Modify: `extensions/subagents/src/types.ts`
- Modify: `extensions/subagents/src/runtime.ts`（添加常量引用）

**Depends on:** —

- [ ] **Step 1: 在 types.ts 顶部添加常量（位于 EXCLUDED_TOOL_NAMES 之后）**

```typescript
// src/types.ts（在 EXCLUDED_TOOL_NAMES 之后添加）

/** FR-1.2: eventLog ring buffer 上限（每 agent） */
export const MAX_EVENT_LOG_ENTRIES = 20;

/** FR-1.1b: turn 摘要最大字符数 */
export const TURN_SUMMARY_MAX = 80;

/** FR-3.0: _completedAgents Map 上限 */
export const COMPLETED_AGENTS_MAX = 50;

/** FR-3.5 G-008: widget stalled 兜底阈值（5min 无新事件） */
export const STALLED_TIMEOUT_MS = 5 * 60 * 1000;

/** FR-2.2: inline widget eventLog 最大行数（12 - 1 行 status summary） */
export const WIDGET_EVENT_LINES = 11;
```

- [ ] **Step 2: 添加 AgentEventLogEntry 类型（位于 AgentEvent union 之前）**

```typescript
// src/types.ts（在 AgentEventType 之前添加）

/**
 * FR-1.1: 事件日志条目。记录每条事件的可展示信息。
 * 与 AgentEvent 不同：ts 由 updateWidgetFromEvent 内 Date.now() 生成；
 * label 已折叠为可展示字符串（toolName + args 摘要 / turn 文本摘要）。
 */
export interface AgentEventLogEntry {
  readonly type: "tool_start" | "tool_end" | "turn_end";
  readonly label: string;
  readonly ts: number;
  readonly status?: "running" | "done" | "failed";
}
```

- [ ] **Step 3: 修改 AgentEvent 的 tool_start variant（添加 args）**

```typescript
// src/types.ts（修改 AgentEvent union 中的 tool_start）

export type AgentEvent =
  | { type: "tool_start"; toolName: string; args?: unknown }  // 新增 args
  | { type: "tool_end"; toolName: string; result?: ToolCallEntry["result"]; isError: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "turn_end" }
  | { type: "message_end"; usage: AgentResult["usage"] }
  | { type: "compaction" }
  | { type: "error"; error: string };
```

- [ ] **Step 4: 添加 CompletedAgentRecord 接口（位于 BackgroundStatus 之后）**

```typescript
// src/types.ts（在 BackgroundStatus 之后添加）

/**
 * FR-3.0: 已完成的 sync agent 归档记录。
 * 留存上限 COMPLETED_AGENTS_MAX，FIFO。
 */
export interface CompletedAgentRecord {
  readonly id: string;
  readonly agent: string;
  status: "done" | "failed" | "cancelled";
  eventLog: AgentEventLogEntry[];
  turns?: number;
  totalTokens?: number;
  result?: AgentResult;
  error?: string;
  startedAt: number;
  endedAt?: number;
}
```

- [ ] **Step 5: 运行类型检查**

Run: `cd extensions/subagents && npx tsc --noEmit`
Expected: PASS（无新增错误）

- [ ] **Step 6: Commit**

```bash
git add extensions/subagents/src/types.ts
git commit -m "feat(subagents): add event log + retention type definitions"
```

---

### Task 2: event-bridge 透传 args

**Type:** backend
**Files:**
- Modify: `extensions/subagents/src/core/event-bridge.ts`
- Modify: `extensions/subagents/src/__tests__/event-bridge.test.ts`

**Depends on:** Task 1

- [ ] **Step 1: 修改 event-bridge.ts 透传 args**

```typescript
// src/core/event-bridge.ts（修改 tool_execution_start case）

case "tool_execution_start": {
  const toolName = raw.toolName ?? "unknown";
  if (raw.toolCallId) pendingTools.set(raw.toolCallId, toolName);
  // FR-1.1a: 透传 args（SDK 原始事件携带 raw.args）
  onEvent({ type: "tool_start", toolName, args: (raw as { args?: unknown }).args });
  break;
}
```

- [ ] **Step 2: 添加 args 透传测试**

在 `extensions/subagents/src/__tests__/event-bridge.test.ts` 末尾添加：

```typescript
it("passes args through to tool_start event", () => {
  const events: AgentEvent[] = [];
  const bridge = createEventBridge((e) => events.push(e));
  const args = { path: "extensions/subagents/src/runtime.ts" };
  bridge.handle({ type: "tool_execution_start", toolCallId: "1", toolName: "read", args } as never);
  expect(events).toEqual([{ type: "tool_start", toolName: "read", args }]);
});
```

- [ ] **Step 3: 运行测试**

Run: `cd extensions/subagents && npx vitest run src/__tests__/event-bridge.test.ts`
Expected: PASS（原有 7 个 + 新增 1 个 = 8 个）

- [ ] **Step 4: Commit**

```bash
git add extensions/subagents/src/core/event-bridge.ts extensions/subagents/src/__tests__/event-bridge.test.ts
git commit -m "feat(subagents): pass tool args through event-bridge"
```

---

### Task 3: format.ts 纯函数（extractLabelFromArgs + formatEventLogLine + formatStatusSummary）

**Type:** backend
**Files:**
- Modify: `extensions/subagents/src/tui/format.ts`
- Modify: `extensions/subagents/src/__tests__/format.test.ts`

**Depends on:** Task 1

- [ ] **Step 1: 添加 TDD 测试到 format.test.ts**

在 `extensions/subagents/src/__tests__/format.test.ts` 末尾添加（先看现有 import 风格）：

```typescript
// src/__tests__/format.test.ts（在末尾添加）

import { extractLabelFromArgs, formatEventLogLine, formatStatusSummary } from "../tui/format.ts";
import type { AgentEventLogEntry } from "../types.ts";

const fakeTheme = {
  fg(_token: string, text: string): string { return text; },
  bold(text: string): string { return `**${text}**`; },
};

describe("extractLabelFromArgs", () => {
  it("returns toolName when args is null/undefined", () => {
    expect(extractLabelFromArgs("read", null)).toBe("read");
    expect(extractLabelFromArgs("read", undefined)).toBe("read");
  });

  it("extracts path for read/write/edit", () => {
    expect(extractLabelFromArgs("read", { path: "extensions/foo/bar.ts" })).toBe("read bar.ts");
    expect(extractLabelFromArgs("write", { path: "/abs/path/file.md" })).toBe("write file.md");
  });

  it("extracts command for bash (truncated to 60)", () => {
    const long = "x".repeat(80);
    const result = extractLabelFromArgs("bash", { command: long });
    expect(result).toBe(`bash ${"x".repeat(60)}`);
  });

  it("extracts query/url for web_*", () => {
    expect(extractLabelFromArgs("web_search", { query: "monorepo" })).toBe("web_search monorepo");
    expect(extractLabelFromArgs("web_fetch", { url: "https://example.com" })).toBe("web_fetch https://example.com");
  });

  it("returns toolName for unknown tool", () => {
    expect(extractLabelFromArgs("custom_tool", { foo: "bar" })).toBe("custom_tool");
  });
});

describe("formatEventLogLine", () => {
  it("formats tool_start with ⟳ running", () => {
    const entry: AgentEventLogEntry = { type: "tool_start", label: "read foo.ts", ts: 0, status: "running" };
    expect(formatEventLogLine(entry, fakeTheme)).toContain("read foo.ts");
    expect(formatEventLogLine(entry, fakeTheme)).toContain("running");
  });

  it("formats tool_end done with ✓", () => {
    const entry: AgentEventLogEntry = { type: "tool_end", label: "edit bar.ts", ts: 0, status: "done" };
    expect(formatEventLogLine(entry, fakeTheme)).toContain("edit bar.ts");
    expect(formatEventLogLine(entry, fakeTheme)).toContain("✓");
  });

  it("formats tool_end failed with ✗", () => {
    const entry: AgentEventLogEntry = { type: "tool_end", label: "bash npm test", ts: 0, status: "failed" };
    expect(formatEventLogLine(entry, fakeTheme)).toContain("✗");
  });

  it("formats turn_end with turn number and summary", () => {
    const entry: AgentEventLogEntry = { type: "turn_end", label: "Fixed the handler", ts: 0 };
    const result = formatEventLogLine(entry, fakeTheme, 3);
    expect(result).toContain("turn 3");
    expect(result).toContain("Fixed the handler");
  });
});

describe("formatStatusSummary", () => {
  it("includes spinner, agent, turns, tokens, elapsed", () => {
    const state = { id: "1", agent: "worker", status: "running" as const, turns: 3, totalTokens: 12000, elapsedSeconds: 45 };
    const result = formatStatusSummary(state, 0, fakeTheme);
    expect(result).toContain("worker");
    expect(result).toContain("3 turns");
    expect(result).toContain("12.0k");
    expect(result).toContain("45s");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd extensions/subagents && npx vitest run src/__tests__/format.test.ts`
Expected: FAIL（"format.extractLabelFromArgs is not a function" 等）

- [ ] **Step 3: 在 format.ts 添加实现**

```typescript
// src/tui/format.ts（顶部 import 改为）

// 在现有 import 之后添加
import type { AgentEventLogEntry, WidgetAgentState } from "../types.ts";

// 现有内容（formatConfigSummary 等）保留在下方

/** SPINNER 帧序列（与 agent-widget.ts 一致） */
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TOKEN_THOUSAND = 1000;
const TOKEN_MILLION = 1000000;
const BASH_CMD_MAX = 60;

/** Theme 接口（duck-typed，避免依赖 Pi 运行时） */
export interface ThemeLike {
  fg(token: string, text: string): string;
  bold(text: string): string;
}

/**
 * FR-1.1a: 从 tool args 提取可展示 label。
 * 白名单 keys: read/write/edit → path (basename); bash → command; web_* → query/url。
 */
export function extractLabelFromArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== "object") return toolName;
  const a = args as Record<string, unknown>;

  if (toolName === "read" || toolName === "write" || toolName === "edit") {
    if (typeof a.path === "string") {
      return `${toolName} ${basename(a.path)}`;
    }
  }
  if (toolName === "bash") {
    if (typeof a.command === "string") {
      const cmd = a.command.length > BASH_CMD_MAX ? a.command.slice(0, BASH_CMD_MAX) : a.command;
      return `${toolName} ${cmd}`;
    }
  }
  if (toolName === "web_search") {
    if (typeof a.query === "string") return `${toolName} ${a.query}`;
  }
  if (toolName === "web_fetch") {
    if (typeof a.url === "string") return `${toolName} ${a.url}`;
  }
  return toolName;
}

function basename(p: string): string {
  const m = p.match(/[^/\\]+$/);
  return m ? m[0] : p;
}

/**
 * FR-2.1: 格式化事件日志条目为单行展示。
 * turnNumber 是当前 turn 数（可选，turn_end 时传）。
 */
export function formatEventLogLine(
  entry: AgentEventLogEntry,
  theme: ThemeLike,
  turnNumber?: number,
): string {
  if (entry.type === "turn_end") {
    return `├─ turn ${turnNumber ?? "?"}: "${entry.label}"`;
  }
  if (entry.type === "tool_start") {
    return `├─ ${entry.label}  ${theme.fg("warning", "⟳ running")}`;
  }
  // tool_end
  const icon = entry.status === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
  return `├─ ${entry.label}  ${icon}`;
}

/**
 * FR-2.1: inline widget 第 1 行 status summary。
 */
export function formatStatusSummary(
  state: WidgetAgentState,
  spinnerFrame: number,
  _theme: ThemeLike,
): string {
  const spinner = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
  const turns = state.turns ?? 0;
  const tokens = formatTokens(state.totalTokens ?? 0);
  const elapsed = state.elapsedSeconds ?? 0;
  return `${spinner} ${state.agent} │ ${turns} turns │ ${tokens} │ ${elapsed}s`;
}

/** 格式化 token 数（12345 → "12.3k"） */
function formatTokens(n: number): string {
  if (n >= TOKEN_MILLION) return `${(n / TOKEN_MILLION).toFixed(1)}M token`;
  if (n >= TOKEN_THOUSAND) return `${(n / TOKEN_THOUSAND).toFixed(1)}k token`;
  return `${n} token`;
}
```

（注意：`format.ts` 当前 33 行，只有 `formatConfigSummary`。需要添加 import 在顶部）

- [ ] **Step 4: 运行测试确认通过**

Run: `cd extensions/subagents && npx vitest run src/__tests__/format.test.ts`
Expected: PASS

- [ ] **Step 5: 运行 typecheck**

Run: `cd extensions/subagents && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add extensions/subagents/src/tui/format.ts extensions/subagents/src/__tests__/format.test.ts
git commit -m "feat(subagents): add event log formatting helpers"
```

---

### Task 4: updateWidgetFromEvent 改为追加式

**Type:** backend
**Files:**
- Modify: `extensions/subagents/src/runtime.ts`
- Create: `extensions/subagents/src/__tests__/runtime-eventlog.test.ts`

**Depends on:** Task 1, 2, 3

- [ ] **Step 1: 创建测试文件 runtime-eventlog.test.ts**

```typescript
// src/__tests__/runtime-eventlog.test.ts
import { describe, expect, it } from "vitest";

import { updateWidgetFromEvent } from "../runtime.ts";  // 需 export
import type { WidgetAgentState } from "../tui/agent-widget.ts";
import { MAX_EVENT_LOG_ENTRIES } from "../types.ts";

function makeWidgetState(overrides: Partial<WidgetAgentState> = {}): WidgetAgentState {
  return {
    id: "run-1",
    agent: "worker",
    status: "running",
    ...overrides,
  } as WidgetAgentState;
}

describe("updateWidgetFromEvent — append mode", () => {
  it("tool_start pushes eventLog entry with label and running status", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "tool_start", toolName: "read", args: { path: "foo/bar.ts" } }, Date.now());
    expect(s.eventLog).toHaveLength(1);
    expect(s.eventLog![0].type).toBe("tool_start");
    expect(s.eventLog![0].label).toBe("read bar.ts");
    expect(s.eventLog![0].status).toBe("running");
  });

  it("tool_end pushes entry with done status", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "tool_start", toolName: "read" }, Date.now());
    updateWidgetFromEvent(s, { type: "tool_end", toolName: "read", isError: false }, Date.now());
    expect(s.eventLog).toHaveLength(2);
    expect(s.eventLog![1].type).toBe("tool_end");
    expect(s.eventLog![1].status).toBe("done");
  });

  it("tool_end failed pushes entry with failed status", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "tool_end", toolName: "bash", isError: true }, Date.now());
    expect(s.eventLog![0].status).toBe("failed");
  });

  it("turn_end slices _currentTurnText and resets it", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "text_delta", delta: "Hello " }, Date.now());
    updateWidgetFromEvent(s, { type: "text_delta", delta: "world" }, Date.now());
    updateWidgetFromEvent(s, { type: "turn_end" }, Date.now());
    expect(s.eventLog).toHaveLength(1);
    expect(s.eventLog![0].type).toBe("turn_end");
    expect(s.eventLog![0].label).toBe("Hello world");
    expect(s._currentTurnText).toBe("");
  });

  it("turn_end truncates label to TURN_SUMMARY_MAX", () => {
    const s = makeWidgetState();
    const longText = "x".repeat(200);
    updateWidgetFromEvent(s, { type: "text_delta", delta: longText }, Date.now());
    updateWidgetFromEvent(s, { type: "turn_end" }, Date.now());
    expect(s.eventLog![0].label).toHaveLength(80);
  });

  it("message_end does NOT push eventLog entry (only updates totalTokens)", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(
      s,
      { type: "message_end", usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0 } },
      Date.now(),
    );
    expect(s.eventLog ?? []).toHaveLength(0);
    expect(s.totalTokens).toBe(300);
  });

  it("ring buffer evicts oldest entry when exceeding MAX_EVENT_LOG_ENTRIES", () => {
    const s = makeWidgetState();
    for (let i = 0; i < MAX_EVENT_LOG_ENTRIES + 5; i++) {
      updateWidgetFromEvent(s, { type: "tool_start", toolName: "read" }, Date.now());
    }
    expect(s.eventLog).toHaveLength(MAX_EVENT_LOG_ENTRIES);
  });

  it("preserves activity field for backward compat", () => {
    const s = makeWidgetState();
    updateWidgetFromEvent(s, { type: "tool_start", toolName: "read" }, Date.now());
    expect(s.activity).toBe("read");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd extensions/subagents && npx vitest run src/__tests__/runtime-eventlog.test.ts`
Expected: FAIL（`updateWidgetFromEvent` 未 export + 行为未实现）

- [ ] **Step 3: 修改 runtime.ts**

```typescript
// src/runtime.ts（修改 import + function）

// 顶部 import 区域添加
import {
  type AgentEventLogEntry,
  COMPLETED_AGENTS_MAX,
  type CompletedAgentRecord,
  MAX_EVENT_LOG_ENTRIES,
  STALLED_TIMEOUT_MS,
  TURN_SUMMARY_MAX,
  WIDGET_EVENT_LINES,
} from "./types.ts";
import { extractLabelFromArgs } from "./tui/format.ts";

// export updateWidgetFromEvent（从 module-level 改为 exported）
export function updateWidgetFromEvent(
  state: WidgetAgentState,
  event: { type: string; toolName?: string; args?: unknown; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }; delta?: string; isError?: boolean },
  startTime: number,
): void {
  // 类型扩展：eventLog 和 _currentTurnText 初始为 []
  const s = state as WidgetAgentState & {
    eventLog: AgentEventLogEntry[];
    _currentTurnText?: string;
    turns: number;
    totalTokens: number;
    elapsedSeconds: number;
  };
  if (!s.eventLog) s.eventLog = [];

  switch (event.type) {
    case "tool_start": {
      const label = extractLabelFromArgs(event.toolName ?? "working", event.args);
      s.activity = event.toolName ?? "working";
      s.eventLog.push({ type: "tool_start", label, ts: Date.now(), status: "running" });
      break;
    }
    case "tool_end": {
      const label = extractLabelFromArgs(event.toolName ?? "working", event.args);
      s.activity = "thinking…";
      s.eventLog.push({ type: "tool_end", label, ts: Date.now(), status: event.isError ? "failed" : "done" });
      break;
    }
    case "text_delta": {
      // FR-1.1b: 累加 delta 供 turn_end 切片
      s._currentTurnText = (s._currentTurnText ?? "") + (event.delta ?? "");
      break;
    }
    case "turn_end": {
      // FR-1.1b: 切片生成摘要，重置缓冲
      const summary = (s._currentTurnText ?? "").slice(0, TURN_SUMMARY_MAX);
      s.eventLog.push({ type: "turn_end", label: summary, ts: Date.now() });
      s._currentTurnText = "";
      s.turns = (s.turns ?? 0) + 1;
      break;
    }
    case "message_end": {
      if (event.usage) {
        s.totalTokens = (s.totalTokens ?? 0) + event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
      }
      break;
    }
    default:
      break;
  }

  // Ring buffer: 超上限移除最旧
  while (s.eventLog.length > MAX_EVENT_LOG_ENTRIES) {
    s.eventLog.shift();
  }
  s.elapsedSeconds = Math.floor((Date.now() - startTime) / MS_PER_SECOND);
}
```

同时修改 `WidgetAgentState` import 类型断言（runtime.ts 顶部）：

```typescript
// src/runtime.ts（修改 WidgetAgentState import 处的类型断言）
// 原来：const widgetState: WidgetAgentState = { id, agent, status: "running", elapsedSeconds: 0 };
// 改为：
const widgetState = {
  id: widgetId,
  agent: opts.agent ?? "default",
  status: "running" as const,
  elapsedSeconds: 0,
  eventLog: [] as AgentEventLogEntry[],
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd extensions/subagents && npx vitest run src/__tests__/runtime-eventlog.test.ts`
Expected: PASS（8 个测试）

- [ ] **Step 5: 运行 typecheck**

Run: `cd extensions/subagents && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add extensions/subagents/src/runtime.ts extensions/subagents/src/__tests__/runtime-eventlog.test.ts
git commit -m "feat(subagents): append event log entries in updateWidgetFromEvent"
```

---

### Task 5: 增强 inline widget 渲染

**Type:** backend
**Files:**
- Modify: `extensions/subagents/src/tui/agent-widget.ts`
- Modify: `extensions/subagents/src/__tests__/agent-widget.test.ts`

**Depends on:** Task 3, 4

- [ ] **Step 1: 添加 widget 渲染测试到 agent-widget.test.ts**

在 `extensions/subagents/src/__tests__/agent-widget.test.ts` 末尾添加：

```typescript
// src/__tests__/agent-widget.test.ts（在末尾添加）

import { STALLED_TIMEOUT_MS, type AgentEventLogEntry } from "../types.ts";

describe("renderWidget — eventLog scrolling", () => {
  it("shows status summary + recent eventLog entries", () => {
    const state: WidgetAgentState = {
      id: "1", agent: "worker", status: "running", turns: 2, totalTokens: 5000, elapsedSeconds: 30,
      eventLog: [
        { type: "tool_start", label: "read foo.ts", ts: 0, status: "running" },
        { type: "tool_end", label: "edit bar.ts", ts: 0, status: "done" },
        { type: "turn_end", label: "Fixed X", ts: 0 },
      ],
    };
    const lines = renderWidget([state], 0);
    expect(lines[0]).toContain("worker");
    expect(lines[0]).toContain("2 turns");
    expect(lines[1]).toContain("read foo.ts");
    expect(lines[1]).toContain("running");
    expect(lines.some((l) => l.includes("edit bar.ts") && l.includes("✓"))).toBe(true);
    expect(lines.some((l) => l.includes("turn") && l.includes("Fixed X"))).toBe(true);
  });

  it("limits total lines to MAX_WIDGET_LINES (12)", () => {
    const state: WidgetAgentState = {
      id: "1", agent: "worker", status: "running", turns: 0, totalTokens: 0, elapsedSeconds: 0,
      eventLog: Array.from({ length: 50 }, (_, i) => ({
        type: "tool_start" as const, label: `tool-${i}`, ts: 0, status: "running" as const,
      })),
    };
    const lines = renderWidget([state], 0);
    expect(lines.length).toBeLessThanOrEqual(12);
  });

  it("shows ⚠ possibly stalled when last event older than STALLED_TIMEOUT_MS", () => {
    const state: WidgetAgentState = {
      id: "1", agent: "worker", status: "running", turns: 1, totalTokens: 100, elapsedSeconds: 600,
      eventLog: [{ type: "tool_start", label: "old tool", ts: Date.now() - STALLED_TIMEOUT_MS - 1000, status: "running" }],
    };
    const lines = renderWidget([state], 0);
    expect(lines.some((l) => l.includes("stalled"))).toBe(true);
  });

  it("distributes lines across multiple running agents", () => {
    const states: WidgetAgentState[] = [
      { id: "1", agent: "a", status: "running", turns: 0, eventLog: Array.from({ length: 5 }, (_, i) => ({ type: "tool_start" as const, label: `t${i}`, ts: 0, status: "running" as const })) },
      { id: "2", agent: "b", status: "running", turns: 0, eventLog: Array.from({ length: 5 }, (_, i) => ({ type: "tool_start" as const, label: `u${i}`, ts: 0, status: "running" as const })) },
    ];
    const lines = renderWidget(states, 0);
    // 每 agent 至少 1 行 eventLog
    expect(lines.length).toBeLessThanOrEqual(12);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd extensions/subagents && npx vitest run src/__tests__/agent-widget.test.ts`
Expected: FAIL（新测试失败，原有 7 个仍 PASS）

- [ ] **Step 3: 修改 renderWidget 实现**

```typescript
// src/tui/agent-widget.ts（修改 renderWidget）

// 顶部 import 添加
import { formatEventLogLine, formatStatusSummary } from "./format.ts";
import type { ThemeLike } from "./format.ts";
import { STALLED_TIMEOUT_MS } from "../types.ts";

const fakeTheme: ThemeLike = {
  fg: (_t, s) => s,  // 测试用 stub
  bold: (s) => s,
};

export function renderWidget(
  agents: WidgetAgentState[],
  spinnerFrame: number,
): string[] {
  const running = agents.filter((a) => a.status === "running");
  const finished = agents.filter((a) => a.status !== "running");

  if (running.length === 0 && finished.length === 0) return [];

  const lines: string[] = [];

  // Running agents: 第 1 行 status summary + 后续行 eventLog
  // 多 agent 分配策略（FR-2.2）：
  // - 每个 running agent 至少占 2 行（status + 至少 1 行 eventLog）
  // - 剩余行数按 agent 顺序轮流分配
  // - 超过 3 个 running 时只显示 status summary
  if (running.length <= 3) {
    const summaryLines = 12;  // 总量
    const perAgentSummary = running.length;  // 每 agent 1 行
    const perAgentEvent = Math.max(1, Math.floor((summaryLines - perAgentSummary) / running.length));
    let remainingLines = summaryLines - perAgentSummary;

    for (const a of running) {
      lines.push(formatStatusSummary(a, spinnerFrame, fakeTheme));
      const eventLines = Math.min(perAgentEvent, Math.floor(remainingLines / running.length), WIDGET_EVENT_LINES);
      const eventLog = a.eventLog ?? [];
      // 取最近 N 条（按时间正序）
      const recent = eventLog.slice(-eventLines);
      // turn_end 编号 = entry 之前发生的 turn_end 数 + 1（1-indexed）
      let turnCountBefore = Math.max(0, (a.turns ?? 0) - (eventLog.filter((e) => e.type === "turn_end").length - (eventLog.length - recent.length)));
      for (const entry of recent) {
        lines.push(formatEventLogLine(entry, fakeTheme, entry.type === "turn_end" ? turnCountBefore : turnCountBefore));
        if (entry.type === "turn_end") turnCountBefore++;
      }
      remainingLines -= recent.length;

      // FR-3.5 G-008: stalled 兜底
      const lastEntry = eventLog[eventLog.length - 1];
      if (lastEntry && Date.now() - lastEntry.ts > STALLED_TIMEOUT_MS) {
        lines.push(`  ⚠ ${a.agent} possibly stalled (no events for 5min)`);
      }
    }

    lines.splice(MAX_WIDGET_LINES);  // 硬截断
  } else {
    // > 3 个 running agent：只显示 status
    for (const a of running) {
      lines.push(formatStatusSummary(a, spinnerFrame, fakeTheme));
    }
    lines.splice(MAX_WIDGET_LINES);
  }

  // Finished agents（保持现有逻辑）
  const now = Date.now();
  for (const a of finished) {
    if (a.finishedAt && now - a.finishedAt > FINISHED_LINGER_MS) continue;
    const icon = a.status === "done" ? "✓" : a.status === "cancelled" ? "■" : "✗";
    const summary = a.summary ? `: ${truncate(a.summary, SUMMARY_MAX)}` : "";
    lines.push(`${icon} ${a.agent}${summary}`);
  }

  return lines.slice(0, MAX_WIDGET_LINES);
}
```

注意：renderWidget 在测试中以纯函数调用，theme 是 stub（`fakeTheme` fg 返回原文本）。但 `formatStatusSummary` 接收 theme 但当前实现不用 theme（只 fg 文本，不调 theme）——检查后若不调 theme，stub 也能 work。`formatEventLogLine` 调 `theme.fg("warning"|"success"|"error", text)`，fakeTheme stub 返回 text。

- [ ] **Step 4: 运行测试确认通过**

Run: `cd extensions/subagents && npx vitest run src/__tests__/agent-widget.test.ts`
Expected: PASS

- [ ] **Step 5: 运行 typecheck**

Run: `cd extensions/subagents && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add extensions/subagents/src/tui/agent-widget.ts extensions/subagents/src/__tests__/agent-widget.test.ts
git commit -m "feat(subagents): render event log in inline widget"
```

---

### Task 6: 事件总线 onChange/notifyChange

**Type:** backend
**Files:**
- Modify: `extensions/subagents/src/runtime.ts`
- Create: `extensions/subagents/src/__tests__/runtime-eventbus.test.ts`

**Depends on:** Task 1

- [ ] **Step 1: 创建测试文件 runtime-eventbus.test.ts**

```typescript
// src/__tests__/runtime-eventbus.test.ts
import { describe, expect, it, vi } from "vitest";

import { SubagentRuntime } from "../runtime.ts";
import type { ModelRegistryLike } from "../resolution/model-resolver.ts";

const fakeRegistry: ModelRegistryLike = {
  find: vi.fn(),
  getAll: vi.fn(() => []),
} as never;

function makeRuntime(): SubagentRuntime {
  return new SubagentRuntime({ cwd: "/tmp", homeDir: "/tmp", agentDir: "/tmp/.pi/agent" });
}

describe("SubagentRuntime — event bus", () => {
  it("onChange subscribes and returns unsubscribe", () => {
    const rt = makeRuntime();
    const fn = vi.fn();
    const unsub = rt.onChange(fn);
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("notifyChange invokes all subscribers", () => {
    const rt = makeRuntime();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    rt.onChange(fn1);
    rt.onChange(fn2);
    rt.notifyChange();
    expect(fn1).toHaveBeenCalledTimes(1);
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it("unsubscribe stops invocation", () => {
    const rt = makeRuntime();
    const fn = vi.fn();
    const unsub = rt.onChange(fn);
    rt.notifyChange();
    unsub();
    rt.notifyChange();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd extensions/subagents && npx vitest run src/__tests__/runtime-eventbus.test.ts`
Expected: FAIL（`rt.onChange` is not a function）

- [ ] **Step 3: 在 SubagentRuntime 添加事件总线**

```typescript
// src/runtime.ts（在 SubagentRuntime 类内添加）

private readonly _changeListeners = new Set<() => void>();
private _activeView: { close: () => void } | null = null;

/** FR-3.4: 订阅 runtime 数据变更 */
onChange(fn: () => void): () => void {
  this._changeListeners.add(fn);
  return () => this._changeListeners.delete(fn);
}

/** FR-3.4: 通知所有订阅者 */
notifyChange(): void {
  for (const fn of this._changeListeners) fn();
}
```

并在以下位置调用 `notifyChange()`：
- `updateAgent` 被调用的地方（`runAgent` 内 widget.updateAgent 后、`startBackground` 的 .then/.catch 内）
- `cancelBackground` 内
- `toggleYolo` / `setSessionAgentModel` / `setSessionCategoryModel` 内（可选，配置摘要刷新）

```typescript
// src/runtime.ts（runAgent 内 updateAgent 后追加 notifyChange）

// sync runAgent
this.widget.updateAgent(widgetState);
this.notifyChange();
```

```typescript
// src/runtime.ts（startBackground 的 .then/.catch）

.then((result) => {
  // ... 现有逻辑 ...
  this.notifyChange();
})
.catch((err) => {
  // ... 现有逻辑 ...
  this.notifyChange();
});
```

```typescript
// src/runtime.ts（cancelBackground）

cancelBackground(id: string): boolean {
  const r = this._bgRecords.get(id);
  if (!r || r.status !== "running") return false;
  r.controller?.abort();
  r.status = "cancelled";
  r.endedAt = Date.now();
  this.notifyChange();
  return true;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd extensions/subagents && npx vitest run src/__tests__/runtime-eventbus.test.ts`
Expected: PASS

- [ ] **Step 5: 运行 typecheck + 现有测试**

```bash
cd extensions/subagents && npx tsc --noEmit
cd extensions/subagents && npx vitest run
```
Expected: PASS（全部 2198+ 行测试通过）

- [ ] **Step 6: Commit**

```bash
git add extensions/subagents/src/runtime.ts extensions/subagents/src/__tests__/runtime-eventbus.test.ts
git commit -m "feat(subagents): add runtime event bus for overlay subscription"
```

---

### Task 7: 留存机制（BgRecord + _completedAgents + sync cancelled 路径）

**Type:** backend
**Files:**
- Modify: `extensions/subagents/src/runtime.ts`
- Create: `extensions/subagents/src/__tests__/runtime-records.test.ts`

**Depends on:** Task 1, 4

- [ ] **Step 1: 创建测试文件 runtime-records.test.ts**

```typescript
// src/__tests__/runtime-records.test.ts
import { describe, expect, it, vi } from "vitest";

import { SubagentRuntime } from "../runtime.ts";
import { COMPLETED_AGENTS_MAX } from "../types.ts";

function makeRuntime(): SubagentRuntime {
  return new SubagentRuntime({ cwd: "/tmp", homeDir: "/tmp", agentDir: "/tmp/.pi/agent" });
}

describe("SubagentRuntime — record retention", () => {
  it("_completedAgents initially empty", () => {
    const rt = makeRuntime();
    expect(rt.listCompleted().length).toBe(0);
  });

  it("archives sync agent after widget linger", async () => {
    vi.useFakeTimers();
    const rt = makeRuntime();
    // 模拟 widget linger 完成
    rt.archiveSyncAgent({
      id: "run-1", agent: "worker", status: "done", startedAt: Date.now(), endedAt: Date.now(),
      eventLog: [],
      turns: 3,
    });
    expect(rt.listCompleted()).toHaveLength(1);
    expect(rt.listCompleted()[0].id).toBe("run-1");
    vi.useRealTimers();
  });

  it("archives background agent to BgRecord.eventLog + agent", () => {
    const rt = makeRuntime();
    rt.archiveBackgroundAgent("bg-1", {
      eventLog: [{ type: "tool_start", label: "read foo.ts", ts: 0, status: "running" }],
      agent: "reviewer",
    });
    const record = rt.getBackground("bg-1");
    expect(record?.eventLog).toHaveLength(1);
    expect(record?.agent).toBe("reviewer");
  });

  it("FIFO eviction when _completedAgents exceeds COMPLETED_AGENTS_MAX", () => {
    const rt = makeRuntime();
    for (let i = 0; i < COMPLETED_AGENTS_MAX + 5; i++) {
      rt.archiveSyncAgent({
        id: `run-${i}`, agent: "x", status: "done", startedAt: i, endedAt: i, eventLog: [],
      });
    }
    expect(rt.listCompleted().length).toBe(COMPLETED_AGENTS_MAX);
    expect(rt.listCompleted()[0].id).toBe(`run-5`);  // 5 个被驱逐
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd extensions/subagents && npx vitest run src/__tests__/runtime-records.test.ts`
Expected: FAIL

- [ ] **Step 3: 在 runtime.ts 实现留存逻辑**

```typescript
// src/runtime.ts（添加方法到 SubagentRuntime 类）

import type { AgentEventLogEntry, CompletedAgentRecord } from "./types.ts";

// 内部 BgRecord 扩展（在文件顶部 interface 处）
interface BgRecord {
  readonly id: string;
  status: BackgroundStatus["status"];
  result?: AgentResult;
  error?: string;
  startedAt: number;
  endedAt?: number;
  controller?: AbortController;
  // FR-3.0: 留存 eventLog + agent
  eventLog?: AgentEventLogEntry[];
  agent?: string;
}

// 类内字段
private readonly _completedAgents = new Map<string, CompletedAgentRecord>();

/** FR-3.0: 列出已完成的 sync agent */
listCompleted(): CompletedAgentRecord[] {
  return [...this._completedAgents.values()];
}

/** FR-3.0: 归档 sync agent（widget linger 到期时调用） */
archiveSyncAgent(record: CompletedAgentRecord): void {
  if (this._completedAgents.size >= COMPLETED_AGENTS_MAX) {
    const firstKey = this._completedAgents.keys().next().value;
    if (firstKey !== undefined) this._completedAgents.delete(firstKey);
  }
  this._completedAgents.set(record.id, record);
  this.notifyChange();
}

/** FR-3.0: 归档 background agent（widget linger 到期时调用） */
archiveBackgroundAgent(id: string, data: { eventLog: AgentEventLogEntry[]; agent: string }): void {
  const r = this._bgRecords.get(id);
  if (!r) return;
  r.eventLog = data.eventLog;
  r.agent = data.agent;
  this.notifyChange();
}
```

修改 `runAgent` 内 setTimeout 回调为归档版本：

```typescript
// src/runtime.ts（runAgent 内 setTimeout 调用替换）

// 替换前：
setTimeout(() => this.widget.removeAgent(widgetId), WIDGET_LINGER_MS);

// 替换后（FR-3.0 + FR-3.5 G-025 cancelled 路径）：
setTimeout(() => {
  if (widgetId.startsWith("bg-")) {
    // background agent：归档到 BgRecord
    this.archiveBackgroundAgent(widgetId, {
      eventLog: widgetState.eventLog ?? [],
      agent: widgetState.agent,
    });
  } else {
    // sync agent：归档到 _completedAgents
    this.archiveSyncAgent({
      id: widgetId,
      agent: widgetState.agent,
      status: widgetState.status,
      eventLog: widgetState.eventLog ?? [],
      turns: widgetState.turns,
      totalTokens: widgetState.totalTokens,
      result: widgetState.result,
      error: widgetState.summary,
      startedAt: widgetState.startedAt ?? Date.now() - (widgetState.elapsedSeconds ?? 0) * 1000,
      endedAt: widgetState.finishedAt,
    });
  }
  this.widget.removeAgent(widgetId);
}, WIDGET_LINGER_MS);
```

修改 catch 块（FR-3.5 G-025）：

```typescript
// src/runtime.ts（runAgent 的 catch 块）

} catch (err) {
  // FR-3.5 G-025: 用户主动 abort → cancelled；其他 → failed
  widgetState.status = finalOpts.signal?.aborted ? "cancelled" : "failed";
  widgetState.summary = err instanceof Error ? err.message : String(err);
  widgetState.finishedAt = Date.now();
  this.widget.updateAgent(widgetState);
  this.notifyChange();
  setTimeout(() => {
    if (widgetId.startsWith("bg-")) {
      this.archiveBackgroundAgent(widgetId, {
        eventLog: widgetState.eventLog ?? [],
        agent: widgetState.agent,
      });
    } else {
      this.archiveSyncAgent({
        id: widgetId,
        agent: widgetState.agent,
        status: widgetState.status,
        eventLog: widgetState.eventLog ?? [],
        turns: widgetState.turns,
        totalTokens: widgetState.totalTokens,
        result: undefined,
        error: widgetState.summary,
        startedAt: Date.now() - (widgetState.elapsedSeconds ?? 0) * 1000,
        endedAt: widgetState.finishedAt,
      });
    }
    this.widget.removeAgent(widgetId);
  }, WIDGET_LINGER_MS);

  for (const h of this.hooks) {
    if (h.onError) h.onError(err instanceof Error ? err : new Error(String(err)), finalOpts);
  }
  throw err;
}
```

修改 startBackground（添加 `agent` 字段持久化 FR-3.0a + notifyChange）：

```typescript
// src/runtime.ts（startBackground 内）

const record: BgRecord = {
  id, status: "running", startedAt: Date.now(), controller,
  agent: opts.agent ?? "default",  // FR-3.0a
};
this._bgRecords.set(id, record);
this.notifyChange();
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd extensions/subagents && npx vitest run src/__tests__/runtime-records.test.ts`
Expected: PASS

- [ ] **Step 5: 运行全量测试 + typecheck**

```bash
cd extensions/subagents && npx tsc --noEmit
cd extensions/subagents && npx vitest run
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add extensions/subagents/src/runtime.ts extensions/subagents/src/__tests__/runtime-records.test.ts
git commit -m "feat(subagents): add completed agent record retention"
```

---

### Task 8: SubagentsView 全屏视图组件

**Type:** backend
**Files:**
- Create: `extensions/subagents/src/tui/subagents-view.ts`
- Create: `extensions/subagents/src/__tests__/subagents-view.test.ts`

**Depends on:** Task 3, 6, 7

- [ ] **Step 1: 创建测试文件 subagents-view.test.ts**

```typescript
// src/__tests__/subagents-view.test.ts
import { describe, expect, it, vi } from "vitest";

import {
  collectRecords,
  formatDetailView,
  formatListView,
  processKey,
  sortRecords,
  type SubagentRecord,
  type ViewState,
} from "../tui/subagents-view.ts";

const fakeTheme = {
  fg(_t: string, text: string): string { return text; },
  bold(text: string): string { return `**${text}**`; },
};

function makeRecord(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
  return {
    id: "run-1", agent: "worker", status: "running", startedAt: Date.now() - 30000,
    eventLog: [], turns: 2, totalTokens: 5000, ...overrides,
  };
}

describe("collectRecords", () => {
  it("merges widget + bg + completed by id with cancelled priority", () => {
    // 测试去重逻辑（不直接调 runtime，用 mock）
    const records: SubagentRecord[] = [
      { id: "run-1", agent: "worker", status: "running", eventLog: [], startedAt: 1 },
      { id: "bg-1", agent: "scout", status: "cancelled", eventLog: [], startedAt: 2 },
    ];
    const merged = collectRecords(records, [], []);  // 接受 (widget, bg, completed) 三个输入
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.id === "bg-1")?.status).toBe("cancelled");
  });

  it("cancelled overrides running when same id", () => {
    const widget = [makeRecord({ id: "x", status: "running" })];
    const completed = [makeRecord({ id: "x", status: "cancelled" })];
    const merged = collectRecords(widget, [], completed);
    expect(merged.find((r) => r.id === "x")?.status).toBe("cancelled");
  });
});

describe("sortRecords", () => {
  it("sorts running first, then failed, cancelled, done; within group by startedAt desc", () => {
    const records: SubagentRecord[] = [
      makeRecord({ id: "1", status: "done", startedAt: 100 }),
      makeRecord({ id: "2", status: "running", startedAt: 50 }),
      makeRecord({ id: "3", status: "failed", startedAt: 200 }),
      makeRecord({ id: "4", status: "cancelled", startedAt: 150 }),
    ];
    const sorted = sortRecords(records);
    expect(sorted.map((r) => r.id)).toEqual(["2", "3", "4", "1"]);
  });
});

describe("formatListView", () => {
  it("shows empty state when no records", () => {
    const lines = formatListView([], fakeTheme, 80, 0);
    expect(lines.some((l) => l.includes("No subagent"))).toBe(true);
  });

  it("shows header + rows", () => {
    const records = [
      makeRecord({ id: "run-3", agent: "worker", status: "done", turns: 5, totalTokens: 23000 }),
      makeRecord({ id: "bg-1", agent: "researcher", status: "running", turns: 2, totalTokens: 8000 }),
    ];
    const lines = formatListView(records, fakeTheme, 80, 0);
    expect(lines.some((l) => l.includes("Subagents"))).toBe(true);
    expect(lines.some((l) => l.includes("run-3"))).toBe(true);
    expect(lines.some((l) => l.includes("bg-1"))).toBe(true);
  });

  it("highlights selected row", () => {
    const records = [makeRecord({ id: "1" }), makeRecord({ id: "2" })];
    const lines = formatListView(records, fakeTheme, 80, 1);
    expect(lines.some((l) => l.includes("**2**"))).toBe(true);  // fakeTheme.bold wraps
  });
});

describe("formatDetailView", () => {
  it("shows header with id + agent + status", () => {
    const record = makeRecord({ id: "bg-1", agent: "scout", status: "running" });
    const lines = formatDetailView(record, fakeTheme, 80, 0);
    expect(lines.some((l) => l.includes("bg-1"))).toBe(true);
    expect(lines.some((l) => l.includes("scout"))).toBe(true);
  });

  it("shows event log", () => {
    const record = makeRecord({
      eventLog: [
        { type: "tool_start", label: "read foo", ts: 0, status: "running" },
        { type: "turn_end", label: "summary", ts: 0 },
      ],
    });
    const lines = formatDetailView(record, fakeTheme, 80, 0);
    expect(lines.some((l) => l.includes("read foo"))).toBe(true);
    expect(lines.some((l) => l.includes("summary"))).toBe(true);
  });

  it("shows 'Terminal too small' when terminalRows < 8", () => {
    const record = makeRecord();
    const lines = formatDetailView(record, fakeTheme, 80, 0, 5);
    expect(lines.some((l) => l.includes("Terminal too small"))).toBe(true);
  });
});

describe("processKey", () => {
  function makeState(): ViewState {
    return { level: 0, selectedIdx: 0, scrollOffset: 0, disposed: false };
  }
  const records = [makeRecord({ id: "1" }), makeRecord({ id: "2" })];

  it("j moves selectedIdx down", () => {
    const state = makeState();
    processKey("j", records, state, fakeTheme, null, () => {}, null);
    expect(state.selectedIdx).toBe(1);
  });

  it("k moves selectedIdx up", () => {
    const state = { ...makeState(), selectedIdx: 1 };
    processKey("k", records, state, fakeTheme, null, () => {}, null);
    expect(state.selectedIdx).toBe(0);
  });

  it("Enter at level 0 goes to level 1", () => {
    const state = makeState();
    const result = processKey("\r", records, state, fakeTheme, null, () => {}, null);
    expect(state.level).toBe(1);
    expect(result).toBe(true);
  });

  it("q at level 0 calls done", () => {
    const state = makeState();
    const done = vi.fn();
    processKey("q", records, state, fakeTheme, null, done, null);
    expect(done).toHaveBeenCalled();
  });

  it("q at level 1 returns to level 0", () => {
    const state = { ...makeState(), level: 1 };
    processKey("q", records, state, fakeTheme, null, () => {}, null);
    expect(state.level).toBe(0);
  });

  it("Esc at level 1 returns to level 0", () => {
    const state = { ...makeState(), level: 1 };
    processKey("\x1b", records, state, fakeTheme, null, () => {}, null);
    expect(state.level).toBe(0);
  });

  it("x on running background agent calls cancelBackground", () => {
    const state = makeState();
    const records2 = [makeRecord({ id: "bg-1", status: "running" })];
    const cancel = vi.fn();
    processKey("x", records2, state, fakeTheme, { id: "bg-1" } as never, () => {}, { cancelBackground: cancel } as never);
    expect(cancel).toHaveBeenCalledWith("bg-1");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd extensions/subagents && npx vitest run src/__tests__/subagents-view.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 subagents-view.ts**

```typescript
// src/tui/subagents-view.ts
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

import type { AgentEventLogEntry, AgentResult, BackgroundStatus, CompletedAgentRecord } from "../types.ts";
import type { SubagentRuntime } from "../runtime.ts";
import { formatEventLogLine, formatTokens, type ThemeLike } from "./format.ts";
import { type WidgetAgentState } from "./agent-widget.ts";

// ── Types ─────────────────────────────────────────────────────

export interface SubagentRecord {
  readonly id: string;
  readonly agent: string;
  status: BackgroundStatus["status"];
  eventLog: AgentEventLogEntry[];
  turns?: number;
  totalTokens?: number;
  startedAt: number;
  endedAt?: number;
  result?: AgentResult;
  error?: string;
}

export interface ViewState {
  level: 0 | 1;
  selectedIdx: number;
  scrollOffset: number;
  disposed: boolean;
}

const STATUS_PRIORITY: Record<BackgroundStatus["status"], number> = {
  running: 0,
  failed: 1,
  cancelled: 2,
  done: 3,
};

const HEADER_LINES = 3;
const FOOTER_LINES = 2;
const MIN_TERMINAL_ROWS = 8;

// ── Data merge ────────────────────────────────────────────────

/**
 * FR-3.2: 合并 widget + bg + completed 数据源。
 * - widget 来自 widget.agents（实时运行中 + 5s 内完成）
 * - bg 来自 runtime.listBackground()（含已完成 bg）
 * - completed 来自 runtime.listCompleted()（sync 归档）
 * cancelled 状态优先（cancelled 是用户主动行为，widget 可能误报 running/failed）。
 */
export function collectRecords(
  widget: SubagentRecord[],
  bg: SubagentRecord[],
  completed: SubagentRecord[],
): SubagentRecord[] {
  const byId = new Map<string, SubagentRecord>();
  // 合并顺序：bg/completed 先（终态权威），widget 后（实时可能更新 running 状态）
  for (const r of [...bg, ...completed]) {
    byId.set(r.id, r);
  }
  for (const r of widget) {
    const existing = byId.get(r.id);
    if (!existing) {
      byId.set(r.id, r);
    } else if (existing.status === "cancelled" && r.status !== "cancelled") {
      // cancelled 优先：保留 existing
      continue;
    } else {
      // widget 优先：覆盖
      byId.set(r.id, r);
    }
  }
  return sortRecords([...byId.values()]);
}

export function sortRecords(records: SubagentRecord[]): SubagentRecord[] {
  return [...records].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 99;
    const pb = STATUS_PRIORITY[b.status] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.startedAt - a.startedAt;  // 同状态按 startedAt 降序
  });
}

// ── Format helpers ────────────────────────────────────────────

function statusIcon(status: BackgroundStatus["status"], theme: ThemeLike): string {
  switch (status) {
    case "done": return theme.fg("success", "✓");
    case "running": return theme.fg("warning", "⟳");
    case "failed": return theme.fg("error", "✗");
    case "cancelled": return theme.fg("muted", "■");
  }
}

function formatRecordRow(record: SubagentRecord, theme: ThemeLike, width: number, selected: boolean): string {
  const icon = statusIcon(record.status, theme);
  const turns = record.turns ?? 0;
  const tokens = record.totalTokens ? formatTokens(record.totalTokens) : "-";
  const line = `${icon} ${record.id.padEnd(12)} ${record.agent.padEnd(12)} ${record.status.padEnd(10)} ${turns} turns ${tokens}`;
  return selected ? theme.bold(line) : line;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 5);  // HH:MM
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

// ── List view (Level 0) ───────────────────────────────────────

export function formatListView(
  records: SubagentRecord[],
  theme: ThemeLike,
  _width: number,
  selectedIdx: number,
): string[] {
  if (records.length === 0) {
    return [
      "┌─ Subagents ─────────────────────────────┐",
      "│  No subagent executions in this session. │",
      "│                                          │",
      "│  q 退出                                  │",
      "└──────────────────────────────────────────┘",
    ];
  }

  const lines: string[] = [];
  lines.push("┌─ Subagents ───────────────────────────────────────────────┐");
  lines.push("│  ID            Agent        Status       Turns  Tokens    │");
  records.forEach((r, i) => {
    lines.push("│  " + formatRecordRow(r, theme, 60, i === selectedIdx));
  });
  lines.push("│                                                              │");
  lines.push("│  j/k 导航 · Enter 详情 · x 取消 · q 退出                    │");
  lines.push("└──────────────────────────────────────────────────────────────┘");
  return lines;
}

// ── Detail view (Level 1) ─────────────────────────────────────

export function formatDetailView(
  record: SubagentRecord,
  theme: ThemeLike,
  width: number,
  scrollOffset: number,
  terminalRows: number = 30,
): string[] {
  if (terminalRows < MIN_TERMINAL_ROWS) {
    return [`Terminal too small (need ≥${MIN_TERMINAL_ROWS} rows)`];
  }

  const lines: string[] = [];
  const header = `┌─ ${record.id} ${record.agent} (${record.status})`;
  lines.push(header);
  const turns = record.turns ?? 0;
  const tokens = record.totalTokens ? formatTokens(record.totalTokens) : "0";
  const elapsed = record.endedAt
    ? formatDuration(record.endedAt - record.startedAt)
    : formatDuration(Date.now() - record.startedAt);
  lines.push(`│  ${turns} turns │ ${tokens} │ ${elapsed} │ started ${formatTime(record.startedAt)}`);
  lines.push("│");

  // Event log
  lines.push("│  Event log:");
  const eventLogLines: string[] = [];
  let turnNumber = 0;
  for (const entry of record.eventLog) {
    if (entry.type === "turn_end") turnNumber++;
    eventLogLines.push("│  " + formatEventLogLine(entry, theme, turnNumber));
  }
  if (eventLogLines.length === 0) eventLogLines.push("│  (no events recorded)");

  // Apply scroll
  const visibleFrom = scrollOffset;
  const visibleTo = Math.min(eventLogLines.length, visibleFrom + (terminalRows - HEADER_LINES - FOOTER_LINES - 5));
  for (let i = visibleFrom; i < visibleTo; i++) {
    lines.push(eventLogLines[i]);
  }

  // Result section
  if (record.result || record.error) {
    lines.push("│");
    lines.push("│  Result:");
    const resultText = record.error ?? record.result?.text ?? "";
    const resultLines = resultText.split("\n").slice(0, 10);
    for (const l of resultLines) lines.push("│  " + l);
  }

  lines.push("│");
  lines.push("│  j/k 滚动 · q 返回");
  lines.push("└" + "─".repeat(width - 2));
  return lines;
}

// ── Keyboard handling ─────────────────────────────────────────

export function processKey(
  data: string,
  records: SubagentRecord[],
  state: ViewState,
  _theme: ThemeLike,
  selectedRecord: SubagentRecord | null,
  done: () => void,
  runtime: SubagentRuntime | null,
): boolean {
  if (state.disposed) return false;

  if (state.level === 0) {
    if (data === "j" || data === "\x1b[B") {  // down arrow
      if (state.selectedIdx < records.length - 1) { state.selectedIdx++; return true; }
      return false;
    }
    if (data === "k" || data === "\x1b[A") {  // up arrow
      if (state.selectedIdx > 0) { state.selectedIdx--; return true; }
      return false;
    }
    if (data === "\r" || data === "\n") {  // Enter
      if (records.length > 0) { state.level = 1; state.scrollOffset = 0; return true; }
      return false;
    }
    if (data === "x") {
      if (selectedRecord && selectedRecord.id.startsWith("bg-") && runtime) {
        runtime.cancelBackground(selectedRecord.id);
        return true;
      }
      return false;
    }
    if (data === "q" || data === "\x1b") {  // q or Esc
      state.disposed = true;
      done();
      return false;
    }
  } else {
    // Level 1 (detail)
    const record = selectedRecord;
    if (!record) return false;
    if (data === "j" || data === "\x1b[B") {
      state.scrollOffset++;
      return true;
    }
    if (data === "k" || data === "\x1b[A") {
      if (state.scrollOffset > 0) { state.scrollOffset--; return true; }
      return false;
    }
    if (data === "x") {
      if (record.id.startsWith("bg-") && runtime) {
        runtime.cancelBackground(record.id);
        return true;
      }
      return false;
    }
    if (data === "q" || data === "\x1b") {
      state.level = 0;
      state.scrollOffset = 0;
      return true;
    }
  }
  return false;
}

// ── Overlay factory ───────────────────────────────────────────

/**
 * FR-3.1/3.2/3.3/3.4/3.5/4.1: 全屏两级视图。
 * 仿 WorkflowsView.ts:118-139 的 overlay 契约。
 */
export function createSubagentsView(
  runtime: SubagentRuntime,
  theme: ThemeLike,
  ctx: ExtensionContext,
  directId?: string,
): Promise<void> {
  if (!ctx.hasUI) {
    return Promise.reject(new Error("/subagents list requires interactive mode"));
  }

  // FR-3.1 G-017: 防 overlay 叠加
  const active = runtime.getActiveView();
  if (active) active.close();

  return ctx.ui.custom<void>((_tui: unknown, _theme: unknown, _kb: unknown, done: () => void) => {
    // FR-3.1 G-002: directId 不存在 → 通知 + 回退 Level 0
    const allRecords = getAllRecords(runtime);
    if (directId && !allRecords.find((r) => r.id === directId)) {
      ctx.ui.notify(`Subagent '${directId}' not found`, "warning");
      directId = undefined;
    }

    const state: ViewState = {
      level: directId ? 1 : 0,
      selectedIdx: 0,
      scrollOffset: 0,
      disposed: false,
    };
    if (directId) {
      const idx = allRecords.findIndex((r) => r.id === directId);
      if (idx >= 0) state.selectedIdx = idx;
    }

    const cache = { width: undefined as number | undefined, lines: undefined as string[] | undefined };
    const tui = _tui as { requestRender(): void; terminal: { rows: number } };
    const requestRender = () => tui.requestRender();

    const unsubscribe = runtime.onChange(() => {
      if (!state.disposed) requestRender();
    });

    const wrappedDone = () => {
      if (state.disposed) return;
      state.disposed = true;
      unsubscribe();
      // FR-3.1 G-026: 清理 _activeView
      runtime.clearActiveView();
      done();
    };

    runtime.setActiveView({ close: wrappedDone });

    return {
      invalidate(): void {
        cache.width = undefined;
        cache.lines = undefined;
      },
      render(width: number): string[] {
        if (cache.lines && cache.width === width) return cache.lines;
        const records = getAllRecords(runtime);
        const selected = records[state.selectedIdx] ?? null;
        const raw = state.level === 0
          ? formatListView(records, theme, width, state.selectedIdx)
          : selected
            ? formatDetailView(selected, theme, width, state.scrollOffset, tui.terminal.rows)
            : ["(no record selected)"];
        const termHeight = tui.terminal.rows;
        const lines = raw.length < termHeight
          ? [...raw, ...Array.from({ length: termHeight - raw.length }, () => "")]
          : raw;
        cache.width = width;
        cache.lines = lines;
        return lines;
      },
      handleInput(data: string): void {
        if (state.disposed) return;
        const records = getAllRecords(runtime);
        const selected = records[state.selectedIdx] ?? null;
        const changed = processKey(data, records, state, theme, selected, wrappedDone, runtime);
        if (changed) {
          cache.width = undefined;
          cache.lines = undefined;
          requestRender();
        }
      },
    };
  }, {
    overlay: true,
    overlayOptions: { anchor: "center" as const, width: "100%", maxHeight: "100%", margin: 0 },
  });
}

/** 从 runtime 提取所有 records（合并三数据源） */
function getAllRecords(runtime: SubagentRuntime): SubagentRecord[] {
  const widgetRecords: SubagentRecord[] = runtime.widget.listAgents().map((a) => ({
    id: a.id,
    agent: a.agent,
    status: a.status,
    eventLog: a.eventLog ?? [],
    turns: a.turns,
    totalTokens: a.totalTokens,
    startedAt: a.finishedAt ? a.finishedAt - (a.elapsedSeconds ?? 0) * 1000 : Date.now() - (a.elapsedSeconds ?? 0) * 1000,
    endedAt: a.finishedAt,
  }));
  const bgRecords: SubagentRecord[] = runtime.listBackground().map((b) => ({
    id: b.id,
    agent: b.agent ?? "default",
    status: b.status,
    eventLog: b.eventLog ?? [],
    turns: undefined,
    totalTokens: undefined,
    startedAt: b.startedAt,
    endedAt: b.endedAt,
    result: b.result,
    error: b.error,
  }));
  const completedRecords: SubagentRecord[] = runtime.listCompleted();
  return collectRecords(widgetRecords, bgRecords, completedRecords);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd extensions/subagents && npx vitest run src/__tests__/subagents-view.test.ts`
Expected: PASS

- [ ] **Step 5: 运行 typecheck**

Run: `cd extensions/subagents && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add extensions/subagents/src/tui/subagents-view.ts extensions/subagents/src/__tests__/subagents-view.test.ts
git commit -m "feat(subagents): add full-screen subagents view with two-level navigation"
```

---

### Task 9: /subagents list 命令入口

**Type:** backend
**Files:**
- Modify: `extensions/subagents/src/commands/config.ts`
- Modify: `extensions/subagents/src/commands/list.ts`（可选拆分）

**Depends on:** Task 8

- [ ] **Step 1: 修改 commands/config.ts 添加 list 子命令**

```typescript
// src/commands/config.ts（修改 handler）

import { createSubagentsView } from "../tui/subagents-view.ts";

export function registerSubagentsCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents", {
    description: "Subagents 配置: /subagents [config [category] | list [<id>]]",
    handler: async (argsStr: string, ctx: ExtensionCommandContext) => {
      const rt = getRuntime();
      if (!rt) {
        ctx.ui.notify("Subagents runtime 未初始化", "error");
        return;
      }

      const args = argsStr.trim().split(/\s+/).filter(Boolean);

      // FR-3.1: list 子命令（解析优先级最高）
      if (args[0] === "list") {
        if (!ctx.hasUI) {
          ctx.ui.notify("/subagents list requires interactive mode", "error");
          return;
        }
        const directId = args[1];
        try {
          await createSubagentsView(rt, ctx.ui.theme as never, ctx as never, directId);
        } catch (err) {
          ctx.ui.notify(err instanceof Error ? err.message : String(err), "error");
        }
        return;
      }

      // /subagents（无参数）→ 显示摘要
      if (args.length === 0 || (args.length === 1 && args[0] !== "config")) {
        ctx.ui.notify(formatConfigSummary(rt.globalConfig, rt.sessionState.yoloMode));
        return;
      }

      // /subagents config [category]
      const wizardArgs = args.slice(1);
      await runConfigWizard(
        {
          select: (title, options) => ctx.ui.select(title, options),
          input: (title, placeholder) => ctx.ui.input(title, placeholder),
          notify: (msg) => ctx.ui.notify(msg),
        },
        wizardArgs,
        rt.globalConfig,
        process.env.HOME || process.env.USERPROFILE || ctx.cwd,
        ctx.modelRegistry as never,
        { onToggleYolo: () => rt.toggleYolo() },
      );
    },
  });
}
```

- [ ] **Step 2: 手动验证命令解析**

启动 Pi 测试：
```bash
pi install npm:@zhushanwen/pi-subagents  # 或 local symlink
```

验证：
- `/subagents` → 显示配置摘要（不变）
- `/subagents config` → 启动配置向导（不变）
- `/subagents list` → 全屏视图
- `/subagents list bad-id` → notify warning + 回退 Level 0
- print 模式（`pi -p`）下 `/subagents list` → notify "requires interactive mode"

- [ ] **Step 3: 运行全量测试 + typecheck**

```bash
cd extensions/subagents && npx tsc --noEmit
cd extensions/subagents && npx vitest run
```
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add extensions/subagents/src/commands/config.ts
git commit -m "feat(subagents): wire /subagents list command"
```

---

### Task 10: 文档同步 + 集成验证

**Type:** docs
**Files:**
- Modify: `CLAUDE.md`（包清单添加 list 命令说明）
- Modify: `.xyz-harness/2026-06-14-subagent-tui/clarification.md`（标注 spec 已实施）

**Depends on:** Task 1-9

- [ ] **Step 1: 更新 CLAUDE.md 中 subagents 包说明**

在 `CLAUDE.md` 的「extensions/subagents/」行（如有）后追加说明：

```markdown
| `extensions/subagents/` | `@zhushanwen/pi-subagents` | 进程内 agent 执行运行时（agent 发现、模型解析、并发控制） | `/subagents list` 全屏视图 |
```

- [ ] **Step 2: 跑全量项目 typecheck + lint + test**

```bash
cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/feat-subagent-enhance
npx tsc --noEmit
pnpm -r lint
pnpm -r test
```
Expected: 全部通过

- [ ] **Step 3: 更新 .xyz-harness spec 状态**

在 `.xyz-harness/2026-06-14-subagent-tui/clarification.md` 顶部添加：

```markdown
> ✅ 实施完成（YYYY-MM-DD）：所有 9 个 task 已 commit。详见 plan.md。
```

- [ ] **Step 4: 提交 + 推送**

```bash
git add -A
git commit -m "docs(subagents): update CLAUDE.md for /subagents list command"
```

---

## 风险与权衡

### 已知风险

1. **WidgetAgentState 字段扩展破坏向后兼容**：serializeState / deserializeState 不在本次范围，但若未来需要持久化 widgetState，旧 session 反序列化可能丢 eventLog。当前不持久化 widget 状态，所以无影响。

2. **sync cancelled 路径依赖 SDK 的 error/stopReason 区分**：当前 event-bridge.ts 在 stopReason=aborted 时产生 error 事件，runAgent catch 块据此设 status=cancelled。但 SDK 内部对 aborted vs error 的处理可能不一致——若 SDK 在 abort 时不发 stopReason=aborted，路径会失效。验证方法：本地跑 `subagent` 调用 + 外部 AbortController.abort()，观察 status。

3. **ctx.ui.custom() 契约**：spec FR-4.1 假设 Pi SDK 真实支持 `{ invalidate, render, handleInput, dispose? }` 契约（参考 WorkflowsView.ts）。如果未来 SDK 改变契约，需同步更新。如 spec clarification.md A3 已确认此契约成立。

### 长期方案 vs 短期方案

- **长期方案（采用）**：eventLog ring buffer + 事件总线 + 双层留存，是正确的架构——事件流是 subagent 的核心数据通道，扩展 eventLog 自然
- **短期方案（拒绝）**：直接在 updateWidgetFromEvent 内部用 console.log 输出——掩盖问题且无法回溯

### YAGNI 检查

- 没有实现"事件导出到 JSON 文件"功能（spec Q3 明确不持久化）
- 没有实现"按 agent 名过滤"（spec 未要求）
- 没有修改 WIDGET_LINGER_MS 时机（保持 5s 不变）

---

## 自我审查

### 1. 规格覆盖

| 章节 | Task 覆盖 |
|------|----------|
| FR-1.1 AgentEventLogEntry | Task 1 ✅ |
| FR-1.1a event-bridge args | Task 2 ✅ |
| FR-1.1b text_delta | Task 3 ✅ |
| FR-1.2 WidgetAgentState 扩展 | Task 1, 3 ✅ |
| FR-1.3 updateWidgetFromEvent 追加 | Task 3 ✅ |
| FR-2.1 widget 布局 | Task 4 ✅ |
| FR-2.2 行数限制 | Task 4 ✅ |
| FR-3.0 留存机制 | Task 7 ✅ |
| FR-3.0a agent 字段 | Task 7 ✅ |
| FR-3.1 命令入口 | Task 9 ✅ |
| FR-3.2 列表视图 | Task 8 ✅ |
| FR-3.3 详情视图 | Task 8 ✅ |
| FR-3.4 事件总线 | Task 6 ✅ |
| FR-3.5 键盘交互 | Task 8 ✅ |
| FR-3.5 G-025 sync cancelled | Task 7 ✅ |
| FR-3.5 G-008 stalled 兜底 | Task 4 ✅ |
| FR-3.6 hasUI 守卫 | Task 9 ✅ |
| FR-4.1 subagents-view.ts | Task 8 ✅ |
| AC-1 运行时滚动消息 | Task 3, 4 ✅ |
| AC-2 全屏列表视图 | Task 8 ✅ |
| AC-3 全屏详情视图 | Task 8 ✅ |
| AC-4 hasUI 守卫 | Task 9 ✅ |

### 2. 占位符扫描

无 TBD/TODO/类似任务 N。命令、文件路径、代码块均具体。

### 3. 类型一致性

- `AgentEventLogEntry` 在 types.ts 定义 → format.ts/runtime.ts/agent-widget.ts/subagents-view.ts 引用
- `CompletedAgentRecord` 在 types.ts 定义 → runtime.ts 持有 Map
- `SubagentRecord` 在 subagents-view.ts 定义（view 内部，简化 BgRecord/WidgetAgentState/CompletedAgentRecord 共有字段）
- `ViewState` 在 subagents-view.ts 定义
- `BgRecord` 内部接口（在 runtime.ts 私有，扩展 eventLog + agent）— 不导出，对外通过 `listBackground` 返回的 `BackgroundStatus` 接口（已有）保持兼容
- `WidgetAgentState` 扩展 eventLog/_currentTurnText（运行时私有字段，不在 serialize 路径上）

### 4. 跨 Task 引用

Task 1 输出 → Task 2/3/4/6/7/8 输入
Task 3 输出 → Task 4/5 输入
Task 6 输出 → Task 7 输入
Task 7 输出 → Task 8 输入

依赖关系图：
```
Task 1 → Task 2 → Task 3 → Task 4
                  ↘
                    Task 6 → Task 7 → Task 8 → Task 9 → Task 10
                  Task 7 ↗
```

Task 5 依赖 Task 1, 4（独立流，但与 Task 3 共享 updateWidgetFromEvent 的修改）

---

## 执行交接

**计划已完成并保存到 `.xyz-harness/2026-06-14-subagent-tui/plan.md`。两种执行方式：**

**1. Subagent 驱动（推荐）** — 派遣独立 subagent 逐任务执行（每个 task 一个 fresh subagent + 两阶段审查：spec compliance + code quality）。上下文隔离，适合 9 个 task 的中型规模。

**2. 内联执行** — 当前会话内逐 task 执行，typecheck + vitest 作为检查点。

**选择哪种方式？**
