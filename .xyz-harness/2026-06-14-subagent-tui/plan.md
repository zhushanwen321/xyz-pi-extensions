# Subagent TUI 对话流 block 重设计 — 实现计划

> **给 agentic worker：** 必备子技能：使用 subagent-driven-development（推荐）或 executing-plans 来逐任务执行此计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 重新设计 sync + background 模式的对话流执行 block 展示（6 行压缩布局 + 定时器 spinner + 树形连接线 + alt+o 展开），删除已停用的 inline widget 渲染层。

**架构：** event-bridge 增强（新增 thinking_delta 采集）→ 共享 eventLog builder 加 text_output/thinking 切片 → SubagentResultComponent 重写（6 行布局，spinner 定时器存 ToolRenderContext.state）→ background 模式 onUpdate 回流 → widget 渲染层删除。

**技术栈：** TypeScript、@mariozechner/pi-coding-agent（ToolRenderContext）、@mariozechner/pi-tui（Component 契约）、vitest。

**规格说明：** `.xyz-harness/2026-06-14-subagent-tui/spec.md`（v2.2）

**关键参考：** `~/GitApp/pi-ecosystem/pi-subagents/src/tui/render.ts`（`clearLegacyResultAnimationTimer` 定时器模式）

**SDK 关键事实（已验证）：**
- `AssistantMessageEvent`（`@mariozechner/pi-ai/dist/types.d.ts:205-217`）有独立的 `thinking_delta` variant（`{ type: "thinking_delta", contentIndex, delta, partial }`）
- 它嵌在 `AgentEvent.message_update.assistantMessageEvent` 里（`pi-agent-core/dist/types.d.ts:345-347`）
- pi-tui `Component` 接口**没有 destroy 钩子**（仅 render/handleInput/invalidate）—— 定时器必须存 `ToolRenderContext.state`

---

## 文件结构

### 修改的文件

| 文件 | 职责 | 涉及 FR |
|------|------|---------|
| `extensions/subagents/src/types.ts` | `AgentEvent` 加 `thinking_delta` variant；`AgentEventLogEntry.type` 加 `text_output`/`thinking`；常量 | FR-1.1, 1.1a |
| `extensions/subagents/src/core/event-bridge.ts` | `message_update` 提取 thinking_delta | FR-1.1a |
| `extensions/subagents/src/runtime.ts` | `updateWidgetFromEvent` 加 text_output/thinking 切片；`startBackground` 接受 onUpdate；删除 widget 实例化；新增 `resolveModelForAgent` + `_runningAgents` map | FR-1.1b, 1.3, 2.0, 2.5 |
| `extensions/subagents/src/tui/subagent-render.ts` | `SubagentToolDetails` 加 model/thinkingLevel；`buildRenderLines` 重写 6 行布局；Component 加 spinner 帧 | FR-1.2, 2.1, 2.3, 2.4 |
| `extensions/subagents/src/tui/agent-widget.ts` | 删除渲染层，保留 WidgetAgentState 最小字段 | FR-2.0 |
| `extensions/subagents/src/tools/subagent-tool.ts` | `renderResult` 提取为独立函数 + 定时器；background 分支传 onUpdate；details 加 model/thinkingLevel | FR-1.2, 2.1, 2.2, 2.3, 2.5 |
| `extensions/subagents/src/tui/format.ts` | `formatEventLogLine` 支持 text_output/thinking 类型 + ├─ 前缀 | FR-2.1 |
| `extensions/subagents/src/tui/subagents-view.ts` | `getAllRecords` 数据源从 widget 改为 `listRunningAgents()` | FR-2.0 连带 |
| `extensions/subagents/src/index.ts` | 删除 widget 注释 | FR-2.0 |

### 修改的测试

| 测试文件 | 改动 |
|----------|------|
| `src/__tests__/event-bridge.test.ts` | 新增 thinking_delta 映射测试 |
| `src/__tests__/subagent-render.test.ts` | 重写：6 行布局、├─ 连接线、model 行、stats 右对齐、expanded |
| `src/__tests__/agent-widget.test.ts` | **删除**（widget 渲染层删除后整个文件废弃） |
| `src/__tests__/runtime-eventlog.test.ts` | 新增 text_output/thinking 切片测试 |
| `src/__tests__/background.test.ts` | 新增 onUpdate 回流测试 |
| `src/__tests__/subagent-tool.test.ts` | 新增 renderSubagentResult 定时器生命周期测试 |
| `src/__tests__/subagents-view.test.ts` | mock 从 `runtime.widget` 改为 `runtime.listRunningAgents()` |

---

## 任务分解

### 任务 1: types.ts — AgentEvent 扩展 thinking_delta + AgentEventLogEntry 扩展

**文件：**
- 修改：`extensions/subagents/src/types.ts:237-253`（AgentEventType + AgentEvent union）、`:53-58`（AgentEventLogEntry）、`:42` 后（常量）

- [ ] **步骤 1：编写失败的测试**

在 `extensions/subagents/src/__tests__/event-bridge.test.ts` 末尾的 `describe` 块内追加：

```typescript
  it("maps message_update with thinking_delta assistantMessageEvent → thinking_delta", () => {
    const events: AgentEvent[] = [];
    const bridge = createEventBridge((e) => events.push(e));
    bridge.handle({
      type: "message_update",
      message: {} as never,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "analyzing the problem",
        partial: {},
      },
    } as never);
    expect(events).toContainEqual({ type: "thinking_delta", delta: "analyzing the problem" });
  });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/event-bridge.test.ts -t "thinking_delta"`
预期：FAIL —— `thinking_delta` 不在 AgentEvent union 中。

- [ ] **步骤 3：修改 types.ts — 扩展 AgentEventType + AgentEvent union**

在 `extensions/subagents/src/types.ts` 找到 `AgentEventType`（约 237 行），替换为：

```typescript
export type AgentEventType =
  | "tool_start"
  | "tool_end"
  | "text_delta"
  | "thinking_delta"
  | "turn_end"
  | "message_end"
  | "compaction"
  | "error";
```

找到 `AgentEvent` union（约 246 行），替换为：

```typescript
export type AgentEvent =
  | { type: "tool_start"; toolName: string; args?: unknown }
  | { type: "tool_end"; toolName: string; result?: ToolCallEntry["result"]; isError: boolean }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "turn_end" }
  | { type: "message_end"; usage: AgentResult["usage"] }
  | { type: "compaction" }
  | { type: "error"; error: string };
```

- [ ] **步骤 4：修改 types.ts — 扩展 AgentEventLogEntry.type**

找到 `AgentEventLogEntry`（约 53 行），替换为：

```typescript
export interface AgentEventLogEntry {
  readonly type: "tool_start" | "tool_end" | "turn_end" | "text_output" | "thinking";
  readonly label: string;
  readonly ts: number;
  readonly status?: "running" | "done" | "failed";
}
```

- [ ] **步骤 5：修改 types.ts — 追加切片常量**

在 `WIDGET_EVENT_LINES` 常量（约 42 行）后追加：

```typescript
/** FR-1.1b: text_output 切片阈值（累计字符数达此值产生一条 log entry） */
export const TEXT_OUTPUT_CHUNK = 100;
/** FR-1.1a: thinking 切片阈值 */
export const THINKING_CHUNK = 100;
```

- [ ] **步骤 6：修改 event-bridge.ts — 提取 thinking_delta**

在 `extensions/subagents/src/core/event-bridge.ts` 找到 `message_update` case（约 59 行）。替换为：

```typescript
      case "message_update": {
        const ame = raw.assistantMessageEvent;
        // text_delta：从 AssistantMessageEvent.delta 提取
        const textDelta = ame?.delta;
        if (textDelta) onEvent({ type: "text_delta", delta: textDelta });
        // FR-1.1a: thinking_delta —— SDK 独立事件类型（pi-ai types.d.ts:209）
        if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
          onEvent({ type: "thinking_delta", delta: ame.delta });
        }
        break;
      }
```

- [ ] **步骤 7：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/event-bridge.test.ts`
预期：PASS（全部）

- [ ] **步骤 8：运行 tsc**

运行：`cd extensions/subagents && npx tsc --noEmit`
预期：无错误

- [ ] **步骤 9：提交**

```bash
git add extensions/subagents/src/types.ts extensions/subagents/src/core/event-bridge.ts extensions/subagents/src/__tests__/event-bridge.test.ts
git commit -m "feat(subagents): extract thinking_delta + extend event log types (FR-1.1, FR-1.1a)"
```

---

### 任务 2: runtime.ts — updateWidgetFromEvent 加 text_output + thinking 切片

**文件：**
- 修改：`extensions/subagents/src/runtime.ts:569-625`（updateWidgetFromEvent）
- 修改：`extensions/subagents/src/tui/agent-widget.ts:26-46`（WidgetAgentState 加 _currentThinking）
- 测试：`extensions/subagents/src/__tests__/runtime-eventlog.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `extensions/subagents/src/__tests__/runtime-eventlog.test.ts` 末尾追加。先确认文件顶部的 import（若缺少则补）：

```typescript
import { updateWidgetFromEvent } from "../runtime.ts";
import type { WidgetAgentState } from "../tui/agent-widget.ts";
import { TEXT_OUTPUT_CHUNK, THINKING_CHUNK } from "../types.ts";
```

追加 describe 块：

```typescript
describe("updateWidgetFromEvent — text_output + thinking slicing", () => {
  it("emits text_output entry when accumulated text reaches TEXT_OUTPUT_CHUNK", () => {
    const state: WidgetAgentState = { id: "t1", agent: "worker", status: "running", eventLog: [] };
    updateWidgetFromEvent(state, { type: "text_delta", delta: "x".repeat(TEXT_OUTPUT_CHUNK) }, Date.now());
    const entries = state.eventLog!.filter((e) => e.type === "text_output");
    expect(entries).toHaveLength(1);
    expect(entries[0].label.length).toBeLessThanOrEqual(100);
  });

  it("emits thinking entry when accumulated thinking reaches THINKING_CHUNK", () => {
    const state: WidgetAgentState = { id: "t2", agent: "worker", status: "running", eventLog: [] };
    updateWidgetFromEvent(state, { type: "thinking_delta", delta: "y".repeat(THINKING_CHUNK) }, Date.now());
    const entries = state.eventLog!.filter((e) => e.type === "thinking");
    expect(entries).toHaveLength(1);
  });

  it("flushes residual text_output on turn_end", () => {
    const state: WidgetAgentState = { id: "t3", agent: "worker", status: "running", eventLog: [] };
    updateWidgetFromEvent(state, { type: "text_delta", delta: "short partial" }, Date.now());
    updateWidgetFromEvent(state, { type: "turn_end" }, Date.now());
    const entries = state.eventLog!.filter((e) => e.type === "text_output");
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  it("flushes residual thinking on turn_end", () => {
    const state: WidgetAgentState = { id: "t4", agent: "worker", status: "running", eventLog: [] };
    updateWidgetFromEvent(state, { type: "thinking_delta", delta: "partial thought" }, Date.now());
    updateWidgetFromEvent(state, { type: "turn_end" }, Date.now());
    const entries = state.eventLog!.filter((e) => e.type === "thinking");
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/runtime-eventlog.test.ts -t "text_output"`
预期：FAIL —— 当前 updateWidgetFromEvent 不产生 text_output/thinking entry。

- [ ] **步骤 3：WidgetAgentState 加 _currentThinking 字段**

在 `extensions/subagents/src/tui/agent-widget.ts` 找到 `WidgetAgentState` 接口（约 26 行），在 `_currentTurnText?: string;` 后追加：

```typescript
  /** FR-1.1a: thinking delta 累加缓冲（切片后重置） */
  _currentThinking?: string;
```

- [ ] **步骤 4：修改 updateWidgetFromEvent — 加 text_output/thinking 切片**

在 `extensions/subagents/src/runtime.ts` 顶部 import 区，确认从 types.ts import 了 `TEXT_OUTPUT_CHUNK, THINKING_CHUNK`（若无则补到现有 import 语句中）。

找到 `updateWidgetFromEvent` 的 `text_delta` case（约 597 行），替换为：

```typescript
    case "text_delta": {
      s._currentTurnText = (s._currentTurnText ?? "") + (event.delta ?? "");
      // FR-1.1b: 节流切片——累计达 TEXT_OUTPUT_CHUNK 产生一条 text_output log entry
      if ((s._currentTurnText ?? "").length >= TEXT_OUTPUT_CHUNK) {
        s.eventLog.push({ type: "text_output", label: s._currentTurnText!.slice(0, 100), ts: Date.now() });
        s._currentTurnText = "";
      }
      break;
    }
    case "thinking_delta": {
      s._currentThinking = (s._currentThinking ?? "") + (event.delta ?? "");
      if ((s._currentThinking ?? "").length >= THINKING_CHUNK) {
        s.eventLog.push({ type: "thinking", label: s._currentThinking!.slice(0, 100), ts: Date.now() });
        s._currentThinking = "";
      }
      break;
    }
```

找到 `turn_end` case（约 601 行），替换为：

```typescript
    case "turn_end": {
      // FR-1.1b: flush 残留的 text/thinking 缓冲
      if (s._currentTurnText) {
        s.eventLog.push({ type: "text_output", label: s._currentTurnText.slice(0, 100), ts: Date.now() });
        s._currentTurnText = "";
      }
      if (s._currentThinking) {
        s.eventLog.push({ type: "thinking", label: s._currentThinking.slice(0, 100), ts: Date.now() });
        s._currentThinking = "";
      }
      const summary = (s._currentTurnText ?? "").slice(0, TURN_SUMMARY_MAX);
      s.eventLog.push({ type: "turn_end", label: summary, ts: Date.now() });
      s._currentTurnText = "";
      s.turns = (s.turns ?? 0) + 1;
      break;
    }
```

- [ ] **步骤 5：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/runtime-eventlog.test.ts`
预期：PASS

- [ ] **步骤 6：提交**

```bash
git add extensions/subagents/src/runtime.ts extensions/subagents/src/tui/agent-widget.ts extensions/subagents/src/__tests__/runtime-eventlog.test.ts
git commit -m "feat(subagents): add text_output + thinking event log slicing (FR-1.1b)"
```

---

### 任务 3: subagent-render.ts — SubagentToolDetails 扩展 + buildRenderLines 重写

**文件：**
- 修改：`extensions/subagents/src/tui/subagent-render.ts`（全文重写核心部分）
- 修改：`extensions/subagents/src/tui/format.ts:89-103`（formatEventLogLine）
- 测试：`extensions/subagents/src/__tests__/subagent-render.test.ts`（全文重写）

- [ ] **步骤 1：编写失败的测试（全文替换测试文件）**

将 `extensions/subagents/src/__tests__/subagent-render.test.ts` 全文替换为：

```typescript
// src/__tests__/subagent-render.test.ts
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";

import { buildRenderLines, SubagentResultComponent, type SubagentToolDetails, type ThemeLike } from "../tui/subagent-render.ts";

const passthroughTheme: ThemeLike = {
  bg(_color: string, text: string): string { return text; },
  fg(_color: string, text: string): string { return text; },
  bold(text: string): string { return text; },
};

function makeDetails(overrides: Partial<SubagentToolDetails> = {}): SubagentToolDetails {
  return {
    eventLog: [],
    status: "running",
    agent: "worker",
    turns: 0,
    totalTokens: 0,
    elapsedSeconds: 0,
    model: "anthropic/claude-sonnet-4.5",
    thinkingLevel: "medium",
    ...overrides,
  };
}

describe("buildRenderLines — 压缩视图（6 行）", () => {
  it("第1行：spinner + agent + model + thinking", () => {
    const lines = buildRenderLines(makeDetails({ agent: "reviewer", model: "zhipu/glm-4.6", thinkingLevel: "high" }), 80, passthroughTheme);
    expect(lines[0]).toContain("reviewer");
    expect(lines[0]).toContain("zhipu/glm-4.6");
    expect(lines[0]).toContain("thinking: high");
  });

  it("第1行：无 thinkingLevel 时不显示 thinking 段", () => {
    const lines = buildRenderLines(makeDetails({ thinkingLevel: undefined }), 80, passthroughTheme);
    expect(lines[0]).not.toContain("thinking:");
  });

  it("第1行：done 显示 ✓", () => {
    const lines = buildRenderLines(makeDetails({ status: "done" }), 80, passthroughTheme);
    expect(lines[0]).toContain("✓");
  });

  it("第1行：failed 显示 ✗", () => {
    const lines = buildRenderLines(makeDetails({ status: "failed" }), 80, passthroughTheme);
    expect(lines[0]).toContain("✗");
  });

  it("滚动区行带 ├─ 连接线", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [
        { type: "tool_end", label: "read auth.ts", ts: 0, status: "done" },
        { type: "text_output", label: "scanning files", ts: 0 },
      ],
    }), 80, passthroughTheme);
    const scrollLines = lines.slice(1, 5);
    expect(scrollLines.some((l) => l.includes("├─"))).toBe(true);
  });

  it("tool_end 带 ✓ 或 ✗", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [
        { type: "tool_end", label: "read ok", ts: 0, status: "done" },
        { type: "tool_end", label: "bash fail", ts: 0, status: "failed" },
      ],
    }), 80, passthroughTheme);
    expect(lines.some((l) => l.includes("read ok") && l.includes("✓"))).toBe(true);
    expect(lines.some((l) => l.includes("bash fail") && l.includes("✗"))).toBe(true);
  });

  it("tool_start 无 ⏳ 标记", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [{ type: "tool_start", label: "read foo.ts", ts: 0, status: "running" }],
    }), 80, passthroughTheme);
    const toolLine = lines.find((l) => l.includes("read foo.ts"));
    expect(toolLine).toBeDefined();
    expect(toolLine!).not.toContain("⏳");
  });

  it("只显示最近 4 条事件", () => {
    const eventLog = Array.from({ length: 8 }, (_, i) => ({
      type: "tool_end" as const, label: `tool-${i}`, ts: i, status: "done" as const,
    }));
    const lines = buildRenderLines(makeDetails({ eventLog }), 80, passthroughTheme);
    const scrollLines = lines.filter((l) => l.includes("├─"));
    expect(scrollLines).toHaveLength(4);
    expect(scrollLines[0]).toContain("tool-4");
    expect(scrollLines[3]).toContain("tool-7");
  });

  it("thinking 行显示", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [{ type: "thinking", label: "analyzing the structure", ts: 0 }],
    }), 80, passthroughTheme);
    expect(lines.some((l) => l.includes("analyzing the structure"))).toBe(true);
  });

  it("最后一行 stats 右对齐", () => {
    const lines = buildRenderLines(makeDetails({ turns: 3, totalTokens: 12300, elapsedSeconds: 45 }), 80, passthroughTheme);
    const lastLine = lines[lines.length - 1];
    expect(lastLine).toContain("3 turns");
    expect(lastLine).toContain("12.3k");
    expect(lastLine).toContain("45s");
    expect(lastLine.startsWith(" ")).toBe(true);
  });

  it("固定 6 行（事件不足时空行填充）", () => {
    const lines = buildRenderLines(makeDetails({
      eventLog: [{ type: "tool_end", label: "only one", ts: 0, status: "done" }],
    }), 80, passthroughTheme);
    expect(lines).toHaveLength(6);
  });
});

describe("buildRenderLines — 展开视图", () => {
  it("expanded=true 时显示全部 eventLog + result", () => {
    const eventLog = Array.from({ length: 8 }, (_, i) => ({
      type: "tool_end" as const, label: `tool-${i}`, ts: i, status: "done" as const,
    }));
    const lines = buildRenderLines(makeDetails({
      status: "done", eventLog, result: "All done.",
    }), 80, passthroughTheme, { expanded: true });
    expect(lines.filter((l) => l.includes("├─")).length).toBeGreaterThanOrEqual(8);
    expect(lines.some((l) => l.includes("All done."))).toBe(true);
  });
});

describe("SubagentResultComponent", () => {
  it("renders with background", () => {
    const comp = new SubagentResultComponent(makeDetails({ turns: 2, totalTokens: 5000, elapsedSeconds: 30 }), passthroughTheme);
    const lines = comp.render(80);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("update + re-render", () => {
    const comp = new SubagentResultComponent(makeDetails({ agent: "worker" }), passthroughTheme);
    comp.update(makeDetails({ agent: "reviewer", turns: 5 }));
    const lines = comp.render(80);
    expect(lines[0]).toContain("reviewer");
  });

  it("truncates long lines to width", () => {
    const longLabel = "A".repeat(10_000);
    const comp = new SubagentResultComponent(
      makeDetails({ eventLog: [{ type: "text_output", label: longLabel, ts: 0 }] }),
      passthroughTheme,
    );
    const width = 60;
    const lines = comp.render(width);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  it("always renders 6 lines in compact mode", () => {
    const comp = new SubagentResultComponent(
      makeDetails({ eventLog: [{ type: "tool_end", label: "only one", ts: 0, status: "done" }] }),
      passthroughTheme,
    );
    const lines = comp.render(80);
    expect(lines).toHaveLength(6);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/subagent-render.test.ts`
预期：FAIL —— buildRenderLines 签名不匹配、布局未实现。

- [ ] **步骤 3：重写 subagent-render.ts 核心**

将 `extensions/subagents/src/tui/subagent-render.ts` 全文替换为：

```typescript
// src/tui/subagent-render.ts
//
// Subagent tool result 对话流渲染（FR-2.1 ~ FR-2.4）。
// 6 行压缩布局：status + 滚动区(4) + stats。
// spinner 定时器由 subagent-tool.ts 的 renderSubagentResult 管理（存 ToolRenderContext.state）。

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { AgentEventLogEntry } from "../types.ts";

// ============================================================
// Types
// ============================================================

export interface SubagentToolDetails {
  eventLog: AgentEventLogEntry[];
  status: "running" | "done" | "failed" | "cancelled";
  agent: string;
  turns: number;
  totalTokens: number;
  elapsedSeconds: number;
  result?: string;
  error?: string;
  backgroundId?: string;
  /** FR-1.2: "provider/modelId"（来自 ResolvedModel） */
  model?: string;
  /** FR-1.2: thinking level */
  thinkingLevel?: string;
}

export interface ThemeLike {
  bg(color: string, text: string): string;
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface RenderOptions {
  expanded?: boolean;
  spinnerFrame?: number;
}

// ============================================================
// Spinner
// ============================================================

const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function statusGlyph(status: SubagentToolDetails["status"], frame: number, theme: ThemeLike): string {
  switch (status) {
    case "running": return theme.fg("accent", RUNNING_FRAMES[frame % RUNNING_FRAMES.length]);
    case "done": return theme.fg("success", "✓");
    case "failed": return theme.fg("error", "✗");
    case "cancelled": return theme.fg("muted", "■");
  }
}

// ============================================================
// Format helpers
// ============================================================

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

function formatScrollLine(entry: AgentEventLogEntry, theme: ThemeLike): string {
  const prefix = theme.fg("dim", "├─ ");
  switch (entry.type) {
    case "tool_start": return `${prefix}${entry.label}`;
    case "tool_end": {
      const icon = entry.status === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
      return `${prefix}${entry.label} ${icon}`;
    }
    case "text_output": return `${prefix}${entry.label}`;
    case "thinking": return `${prefix}${theme.fg("dim", entry.label)}`;
    case "turn_end": return `${prefix}${theme.fg("dim", "turn end")}`;
    default: return `${prefix}${entry.label}`;
  }
}

// ============================================================
// buildRenderLines
// ============================================================

export function buildRenderLines(
  details: SubagentToolDetails,
  width: number,
  theme: ThemeLike,
  options: RenderOptions = {},
): string[] {
  if (options.expanded) return buildExpandedLines(details, theme, options.spinnerFrame ?? 0);
  return buildCompactLines(details, width, theme, options.spinnerFrame ?? 0);
}

function buildCompactLines(details: SubagentToolDetails, width: number, theme: ThemeLike, frame: number): string[] {
  const lines: string[] = [];

  // 第 1 行：spinner + agent + model + thinking
  const glyph = statusGlyph(details.status, frame, theme);
  const modelPart = details.model ? ` │ ${details.model}` : "";
  const thinkingPart = details.thinkingLevel ? ` │ thinking: ${details.thinkingLevel}` : "";
  lines.push(`${glyph} ${details.agent}${modelPart}${thinkingPart}`);

  // 第 2-5 行：滚动区（最近 4 条）
  const recent = (details.eventLog ?? []).slice(-4);
  for (const entry of recent) {
    lines.push(formatScrollLine(entry, theme));
  }
  while (lines.length < 5) lines.push(""); // 空行填充

  // 第 6 行：stats 右对齐
  const stats = `${details.turns} turns │ ${formatTokens(details.totalTokens)} │ ${details.elapsedSeconds}s`;
  const padNeeded = Math.max(0, width - visibleWidth(stats) - 2);
  lines.push(" ".repeat(padNeeded) + theme.fg("dim", stats));

  return lines;
}

function buildExpandedLines(details: SubagentToolDetails, theme: ThemeLike, frame: number): string[] {
  const lines: string[] = [];
  const glyph = statusGlyph(details.status, frame, theme);
  const modelPart = details.model ? ` │ ${details.model}` : "";
  const thinkingPart = details.thinkingLevel ? ` │ thinking: ${details.thinkingLevel}` : "";
  lines.push(`${glyph} ${details.agent}${modelPart}${thinkingPart}`);

  let turnNumber = 0;
  for (const entry of details.eventLog ?? []) {
    if (entry.type === "turn_end") {
      turnNumber++;
      lines.push(theme.fg("dim", `── turn ${turnNumber} ──`));
      continue;
    }
    lines.push(formatScrollLine(entry, theme));
  }

  if (details.status === "done" && details.result) {
    lines.push("");
    for (const l of details.result.split("\n")) lines.push(l);
  }
  if (details.status === "failed" && details.error) {
    lines.push("");
    lines.push(theme.fg("error", `Error: ${details.error}`));
  }
  return lines;
}

// ============================================================
// Component
// ============================================================

export class SubagentResultComponent {
  private _details: SubagentToolDetails;
  private _theme: ThemeLike;
  private _spinnerFrame = 0;
  private _expanded = false;

  constructor(details: SubagentToolDetails, theme: ThemeLike) {
    this._details = details;
    this._theme = theme;
  }

  update(details: SubagentToolDetails): void {
    this._details = details;
  }

  setSpinnerFrame(frame: number): void {
    this._spinnerFrame = frame;
  }

  setExpanded(expanded: boolean): void {
    this._expanded = expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines = buildRenderLines(this._details, width, this._theme, {
      expanded: this._expanded,
      spinnerFrame: this._spinnerFrame,
    });
    return lines.map((line) => this.applyBg(line, width));
  }

  private applyBg(text: string, width: number): string {
    const bgFn = this.getBgFn();
    const contentWidth = Math.max(1, width - 2);
    const truncated = visibleWidth(text) > contentWidth ? truncateToWidth(text, contentWidth) : text;
    const padNeeded = Math.max(0, contentWidth - visibleWidth(truncated));
    const padded = ` ${truncated}${" ".repeat(padNeeded)} `;
    return bgFn ? bgFn(padded) : padded;
  }

  private getBgFn(): ((text: string) => string) | undefined {
    switch (this._details.status) {
      case "running": return (t: string) => this._theme.bg("toolPendingBg", t);
      case "done": return (t: string) => this._theme.bg("toolSuccessBg", t);
      case "failed":
      case "cancelled": return (t: string) => this._theme.bg("toolErrorBg", t);
    }
  }
}
```

- [ ] **步骤 4：更新 format.ts 的 formatEventLogLine**

在 `extensions/subagents/src/tui/format.ts` 找到 `formatEventLogLine`（约 89 行），替换为：

```typescript
export function formatEventLogLine(
  entry: AgentEventLogEntry,
  theme: ThemeLike,
  turnNumber?: number,
): string {
  if (entry.type === "turn_end") {
    return `├─ turn ${turnNumber ?? "?"}: "${entry.label}"`;
  }
  if (entry.type === "tool_start") {
    return `├─ ${entry.label}`;
  }
  if (entry.type === "tool_end") {
    const icon = entry.status === "failed" ? theme.fg("error", "✗") : theme.fg("success", "✓");
    return `├─ ${entry.label} ${icon}`;
  }
  if (entry.type === "thinking") {
    return `├─ ${theme.fg("dim", entry.label)}`;
  }
  // text_output
  return `├─ ${entry.label}`;
}
```

- [ ] **步骤 5：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/subagent-render.test.ts`
预期：PASS

- [ ] **步骤 6：运行 tsc（subagent-tool.ts 可能报错，记下留给任务 4）**

运行：`cd extensions/subagents && npx tsc --noEmit 2>&1 | head -20`
预期：subagent-tool.ts 引用旧的 `createRenderResult` 会报错 —— 正常，任务 4 修复。

- [ ] **步骤 7：提交**

```bash
git add extensions/subagents/src/tui/subagent-render.ts extensions/subagents/src/tui/format.ts extensions/subagents/src/__tests__/subagent-render.test.ts
git commit -m "feat(subagents): rewrite buildRenderLines to 6-line compact + expanded layout (FR-2.1, FR-2.4)"
```

---

### 任务 4: subagent-tool.ts — renderResult 定时器 + context 参数 + details 加 model

**文件：**
- 修改：`extensions/subagents/src/tools/subagent-tool.ts`（renderResult 提取为 renderSubagentResult 函数、background 分支传 onUpdate、buildDetails 加 model）

- [ ] **步骤 1：编写失败的测试**

在 `extensions/subagents/src/__tests__/subagent-tool.test.ts` 顶部 import 区追加：

```typescript
import { renderSubagentResult, initialToolState } from "../tools/subagent-tool.ts";
```

在文件末尾追加：

```typescript
describe("renderSubagentResult — spinner timer lifecycle", () => {
  const fakeTheme = { bg: (_c: string, t: string) => t, fg: (_c: string, t: string) => t, bold: (t: string) => t };

  it("starts timer when status=running", () => {
    const state = initialToolState();
    const context = { state, invalidate() {} };
    renderSubagentResult(
      { content: [{ type: "text", text: "" }], details: { eventLog: [], status: "running", agent: "w", turns: 0, totalTokens: 0, elapsedSeconds: 0 } },
      { expanded: false },
      fakeTheme,
      context,
    );
    expect(state.timer).toBeDefined();
    if (state.timer) clearInterval(state.timer);
  });

  it("clears timer when status=done", () => {
    const state = initialToolState();
    state.timer = setInterval(() => {}, 99999);
    const context = { state, invalidate() {} };
    renderSubagentResult(
      { content: [{ type: "text", text: "ok" }], details: { eventLog: [], status: "done", agent: "w", turns: 1, totalTokens: 100, elapsedSeconds: 5 } },
      { expanded: false },
      fakeTheme,
      context,
    );
    expect(state.timer).toBeUndefined();
  });

  it("does not crash without details (fallback)", () => {
    const state = initialToolState();
    const context = { state, invalidate() {} };
    const comp = renderSubagentResult(
      { content: [{ type: "text", text: "plain" }] },
      { expanded: false },
      fakeTheme,
      context,
    );
    expect(comp).toBeDefined();
    expect(state.timer).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/subagent-tool.test.ts -t "renderSubagentResult"`
预期：FAIL —— `renderSubagentResult` / `initialToolState` 未导出。

- [ ] **步骤 3：在 subagent-tool.ts 提取 renderSubagentResult + 定时器逻辑**

在 `extensions/subagents/src/tools/subagent-tool.ts` 的 import 区确认有：

```typescript
import { SubagentResultComponent, type SubagentToolDetails } from "../tui/subagent-render.ts";
```

在 `registerSubagentTool` 函数**之前**新增：

```typescript
/** FR-2.3: spinner 定时器 state（ToolDefinition 的 TState） */
export interface SubagentToolState {
  timer?: ReturnType<typeof setInterval>;
  frame: number;
}

export function initialToolState(): SubagentToolState {
  return { frame: 0 };
}

/**
 * FR-2.3: renderResult 逻辑——管理 spinner 定时器生命周期。
 * running 时启动 setInterval(250ms) → context.invalidate()；done/failed 时 clearInterval。
 * 定时器存 context.state（pi-tui Component 无 destroy 钩子，state 是唯一销毁点）。
 */
export function renderSubagentResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded: boolean },
  theme: { bg(color: string, text: string): string; fg(color: string, text: string): string; bold(text: string): string },
  context: { state: SubagentToolState; invalidate(): void },
): SubagentResultComponent {
  const details = result.details as SubagentToolDetails | undefined;
  if (!details) {
    return new SubagentResultComponent(
      { eventLog: [], status: "done", agent: "default", turns: 0, totalTokens: 0, elapsedSeconds: 0 },
      theme,
    );
  }

  const comp = new SubagentResultComponent(details, theme);
  comp.setExpanded(options.expanded);

  if (details.status === "running") {
    if (!context.state.timer) {
      context.state.timer = setInterval(() => {
        context.state.frame = (context.state.frame + 1) % 10;
        comp.setSpinnerFrame(context.state.frame);
        context.invalidate();
      }, 250);
      context.state.timer.unref?.();
    }
    comp.setSpinnerFrame(context.state.frame);
  } else {
    if (context.state.timer) {
      clearInterval(context.state.timer);
      context.state.timer = undefined;
    }
  }

  return comp;
}
```

- [ ] **步骤 4：替换 registerSubagentTool 内的 renderResult 字段**

在 `extensions/subagents/src/tools/subagent-tool.ts` 找到 `renderResult` 字段（约 92 行），替换为：

```typescript
    renderResult(
      result: AgentToolResult<SubagentToolDetails>,
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: { state: SubagentToolState; invalidate(): void },
    ) {
      return renderSubagentResult(result, options, theme, context);
    },
```

删除对旧 `createRenderResult` 的 import（文件顶部，约 24 行 —— 若有 `import { createRenderResult }` 则删除该行）。

- [ ] **步骤 5：buildDetails 加 model/thinkingLevel**

在 sync 分支找到 `const startTime = Date.now();`（约 197 行）后追加 model 解析：

```typescript
      // FR-1.2: 解析 model/thinkingLevel（resolveModelForAgent 在任务 5 实现）
      const resolved = rt.resolveModelForAgent?.(params.agent);
      const resolvedModelId = resolved?.model.id;
      const resolvedThinkingLevel = resolved?.thinkingLevel;
```

找到 `buildDetails`（约 206 行），替换为：

```typescript
      const buildDetails = (status: SubagentToolDetails["status"]): SubagentToolDetails => ({
        eventLog: [...eventLog],
        status,
        agent: agentName,
        turns,
        totalTokens,
        elapsedSeconds: Math.floor((Date.now() - startTime) / MS_PER_SECOND),
        model: resolvedModelId,
        thinkingLevel: resolvedThinkingLevel,
      });
```

- [ ] **步骤 6：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/subagent-tool.test.ts -t "renderSubagentResult"`
预期：PASS

- [ ] **步骤 7：提交**

```bash
git add extensions/subagents/src/tools/subagent-tool.ts extensions/subagents/src/__tests__/subagent-tool.test.ts
git commit -m "feat(subagents): spinner timer lifecycle in renderResult (FR-2.3, FR-1.2)"
```

---

### 任务 5: runtime.ts — startBackground onUpdate + resolveModelForAgent

**文件：**
- 修改：`extensions/subagents/src/types.ts:179-182`（BackgroundOptions）
- 修改：`extensions/subagents/src/runtime.ts:408-490`（startBackground）、新增 resolveModelForAgent
- 修改：`extensions/subagents/src/tools/subagent-tool.ts:170-194`（background 分支）
- 测试：`extensions/subagents/src/__tests__/background.test.ts`

- [ ] **步骤 1：编写失败的测试**

先查看 `extensions/subagents/src/__tests__/background.test.ts` 顶部的 runtime 工厂函数名（通常是 `createTestRuntime` 或类似）。

运行：`cd extensions/subagents && head -30 src/__tests__/background.test.ts`

在文件末尾追加（`createTestRuntime` 替换为实际函数名）：

```typescript
describe("startBackground onUpdate callback (FR-2.5)", () => {
  it("invokes onUpdate with running details during execution", async () => {
    const rt = createTestRuntime();
    const updates: Array<{ status: string; turns: number }> = [];
    const handle = rt.startBackground({
      task: "test task",
      agent: "worker",
      onUpdate: (d) => updates.push({ status: d.status, turns: d.turns }),
    });
    expect(handle.id).toMatch(/^bg-/);
    await new Promise((r) => setTimeout(r, 200));
    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0].status).toBe("running");
    rt.cancelBackground(handle.id);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts -t "onUpdate"`
预期：FAIL —— BackgroundOptions 不接受 onUpdate。

- [ ] **步骤 3：修改 BackgroundOptions 类型**

在 `extensions/subagents/src/types.ts` 找到 `BackgroundOptions`（约 179 行），替换为：

```typescript
export interface BackgroundOptions extends RunAgentOptions {
  /** 任务完成（成功/失败/取消）时回调 */
  onComplete?: (status: BackgroundStatus) => void;
  /** FR-2.5: 执行中事件回流（使对话流 block 实时刷新） */
  onUpdate?: (details: {
    eventLog: AgentEventLogEntry[];
    status: "running" | "done" | "failed" | "cancelled";
    turns: number;
    totalTokens: number;
    elapsedSeconds: number;
  }) => void;
}
```

- [ ] **步骤 4：修改 startBackground — 注入 onUpdate 拦截器**

在 `extensions/subagents/src/runtime.ts` 顶部 import 区确认有 `AgentEventLogEntry`（从 types.ts，若无则补）。

找到 `startBackground` 内的 `this.runAgent({ ...opts, signal })`（约 426 行），替换为：

```typescript
    const signal = opts.signal ?? controller.signal;
    const userOnUpdate = opts.onUpdate;
    const userOnEvent = opts.onEvent;
    const bgStartTime = Date.now();
    const bgState: WidgetAgentState = { id, agent: opts.agent ?? "default", status: "running", eventLog: [] };
    let bgTurns = 0;
    let bgTokens = 0;
    this.runAgent({
      ...opts,
      signal,
      onEvent: (event) => {
        userOnEvent?.(event);
        // FR-1.3/2.5: 共享 eventLog 构建 + 推送 onUpdate
        updateWidgetFromEvent(bgState, event, bgStartTime);
        if (event.type === "turn_end") bgTurns = bgState.turns ?? bgTurns;
        if (event.type === "message_end" && event.usage) {
          bgTokens += event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite;
        }
        userOnUpdate?.({
          eventLog: [...(bgState.eventLog ?? [])],
          status: "running",
          turns: bgTurns,
          totalTokens: bgTokens,
          elapsedSeconds: Math.floor((Date.now() - bgStartTime) / 1000),
        });
      },
    })
```

- [ ] **步骤 5：修改 subagent-tool.ts background 分支传 onUpdate**

在 `extensions/subagents/src/tools/subagent-tool.ts` 找到 background 分支（约 170 行），替换为：

```typescript
      // ── Mode 2: background ──────────────────────────────
      if (params.wait === false) {
        const agentName = params.agent ?? "default";
        const resolved = rt.resolveModelForAgent?.(params.agent);
        const handle = rt.startBackground({
          task: params.task,
          agent: params.agent,
          signal,
          onUpdate: (bgDetails) => {
            onUpdate?.({
              content: [{ type: "text" as const, text: `[subagent] ${bgDetails.turns} turns | ${bgDetails.totalTokens} tokens | ${bgDetails.elapsedSeconds}s` }],
              details: {
                eventLog: bgDetails.eventLog,
                status: bgDetails.status,
                agent: agentName,
                turns: bgDetails.turns,
                totalTokens: bgDetails.totalTokens,
                elapsedSeconds: bgDetails.elapsedSeconds,
                backgroundId: handle.id,
                model: resolved?.model.id,
                thinkingLevel: resolved?.thinkingLevel,
              },
            });
          },
        });
        const details: SubagentToolDetails = {
          eventLog: [],
          status: "running",
          agent: agentName,
          turns: 0,
          totalTokens: 0,
          elapsedSeconds: 0,
          backgroundId: handle.id,
          model: resolved?.model.id,
          thinkingLevel: resolved?.thinkingLevel,
        };
        return {
          content: [{ type: "text" as const, text: `Started background subagent ${handle.id}. Call this tool again with backgroundId="${handle.id}" to check its result.` }],
          details,
        };
      }
```

- [ ] **步骤 6：添加 resolveModelForAgent 到 runtime**

先确认 resolution 目录结构：

运行：`ls extensions/subagents/src/resolution/`

在 `extensions/subagents/src/runtime.ts` 的 `SubagentRuntime` 类内（约 396 行 `createManagedSession` 前）追加。import 路径以实际 resolution 目录为准：

```typescript
  /** FR-1.2: 解析 agent 的 model + thinkingLevel（供 tool 构建 details） */
  resolveModelForAgent(agentName?: string): ResolvedModel | undefined {
    if (!this.modelRegistry) return undefined;
    const agent = agentName
      ? (this.agentRegistry.find(agentName) ?? this.builtinRegistry.find(agentName))
      : undefined;
    return resolveModel({
      agent,
      sessionState: this.sessionState,
      globalConfig: this.globalConfig,
      modelRegistry: this.modelRegistry,
    });
  }
```

在 runtime.ts 顶部 import 区追加（路径以 `ls` 结果为准，通常是 `./resolution/model-resolver.ts`）：

```typescript
import { resolveModel } from "./resolution/model-resolver.ts";
```

若 `resolveModel` 的参数签名不同，读 `resolution/model-resolver.ts` 的导出函数签名并调整上述调用的参数对象。

- [ ] **步骤 7：运行测试确认通过**

运行：`cd extensions/subagents && npx vitest run src/__tests__/background.test.ts`
预期：PASS

- [ ] **步骤 8：运行 tsc**

运行：`cd extensions/subagents && npx tsc --noEmit`
预期：无错误

- [ ] **步骤 9：提交**

```bash
git add extensions/subagents/src/types.ts extensions/subagents/src/runtime.ts extensions/subagents/src/tools/subagent-tool.ts extensions/subagents/src/__tests__/background.test.ts
git commit -m "feat(subagents): background onUpdate回流 + resolveModelForAgent (FR-2.5, FR-1.2)"
```

---

### 任务 6: 删除 inline widget 渲染层 + 修复 getAllRecords 数据源

**文件：**
- 修改：`extensions/subagents/src/tui/agent-widget.ts`（精简为只剩 WidgetAgentState）
- 修改：`extensions/subagents/src/runtime.ts`（删 widget 字段/方法，加 _runningAgents map）
- 修改：`extensions/subagents/src/index.ts`（删注释）
- 修改：`extensions/subagents/src/tui/subagents-view.ts`（getAllRecords 数据源）
- 删除：`extensions/subagents/src/__tests__/agent-widget.test.ts`

- [ ] **步骤 1：精简 agent-widget.ts**

将 `extensions/subagents/src/tui/agent-widget.ts` 全文替换为：

```typescript
// src/tui/agent-widget.ts
//
// FR-2.0: inline widget 渲染层已删除。
// 仅保留 WidgetAgentState 作为 running agent 状态载体（/subagents list 数据源）。

import type { AgentEventLogEntry } from "../types.ts";

export interface WidgetAgentState {
  readonly id: string;
  readonly agent: string;
  status: "running" | "done" | "failed" | "cancelled";
  turns?: number;
  totalTokens?: number;
  elapsedSeconds?: number;
  activity?: string;
  summary?: string;
  finishedAt?: number;
  eventLog?: AgentEventLogEntry[];
  _currentTurnText?: string;
  _currentThinking?: string;
}
```

- [ ] **步骤 2：runtime.ts — 删除 AgentWidgetManager，加 _runningAgents map**

在 `extensions/subagents/src/runtime.ts`：

a) 修改 import（约 13 行）—— 将：
```typescript
import { AgentWidgetManager, type WidgetAgentState, type WidgetUI } from "./tui/agent-widget.ts";
```
替换为：
```typescript
import type { WidgetAgentState } from "./tui/agent-widget.ts";
```

b) 删除 widget 字段（约 100 行 `readonly widget = new AgentWidgetManager();`），替换为：

```typescript
  /** FR-2.0: running agent 状态 map（替代 AgentWidgetManager） */
  private readonly _runningAgents = new Map<string, WidgetAgentState>();

  /** 暴露给 /subagents list 的 running agent 快照 */
  listRunningAgents(): WidgetAgentState[] {
    return [...this._runningAgents.values()];
  }
```

c) 删除 `attachWidgetUI` 方法（约 136-138 行）。

d) 全局替换（在 runAgent 内，约 280/290/308/324/354/369 行）：
- `this.widget.updateAgent(widgetState)` → `this._runningAgents.set(widgetState.id, widgetState)`
- `this.widget.removeAgent(widgetId)` → `this._runningAgents.delete(widgetId)`

e) startBackground 的 `.then`/`.catch`（约 431/467 行）：
- `this.widget.listAgents().find((a) => a.id.startsWith("run-"))?.eventLog ?? []` → `bgState.eventLog ?? []`（任务 5 步骤 4 新增的 bgState）

- [ ] **步骤 3：subagents-view.ts getAllRecords 数据源切换**

在 `extensions/subagents/src/tui/subagents-view.ts` 找到 `getAllRecords`（约 404 行），找到：

```typescript
  const widgetRecords: SubagentRecord[] = runtime.widget.listAgents().map((a) => ({
```

替换为：

```typescript
  const widgetRecords: SubagentRecord[] = runtime.listRunningAgents().map((a) => ({
```

- [ ] **步骤 4：index.ts 删除 widget 注释**

在 `extensions/subagents/src/index.ts` 删除约 35-37 行的三行注释：

```typescript
    // widget UI 不再附加：subagent 进度通过 renderResult 渲染在对话流中。
    // widget tracker 仍保留（供 /subagents list 获取 running agents 数据）。
    // 不调用 attachWidgetUI() → render() 始终 no-op → 无 spinner/淡出动画。
```

- [ ] **步骤 5：删除 agent-widget.test.ts**

```bash
rm extensions/subagents/src/__tests__/agent-widget.test.ts
```

- [ ] **步骤 6：修复 subagents-view.test.ts 的 mock**

运行：`cd extensions/subagents && npx vitest run src/__tests__/subagents-view.test.ts 2>&1 | head -30`

若有 `runtime.widget` 的 mock 引用，替换为 `runtime.listRunningAgents` 的 mock。例如：

```typescript
// 旧：
mockRuntime.widget = { listAgents: () => [] };
// 新：
mockRuntime.listRunningAgents = () => [];
```

- [ ] **步骤 7：运行全部测试**

运行：`cd extensions/subagents && npx vitest run`
预期：全 PASS

- [ ] **步骤 8：运行 tsc**

运行：`cd extensions/subagents && npx tsc --noEmit`
预期：无错误

- [ ] **步骤 9：提交**

```bash
git add -A extensions/subagents/
git commit -m "refactor(subagents): delete inline widget render layer, replace with _runningAgents map (FR-2.0)"
```

---

### 任务 7: 端到端验证

**文件：** 无代码改动，纯验证

- [ ] **步骤 1：全部测试**

运行：`cd extensions/subagents && npx vitest run`
预期：全 PASS

- [ ] **步骤 2：tsc**

运行：`cd extensions/subagents && npx tsc --noEmit`
预期：无错误

- [ ] **步骤 3：AC 对照**

逐项确认 spec AC-1 ~ AC-4：

- AC-1（sync 压缩视图）：buildRenderLines 产出固定 6 行 ✓
- AC-2（background 压缩视图）：startBackground 接受 onUpdate，block 实时刷新 ✓
- AC-3（alt+o 展开）：renderSubagentResult 读 options.expanded ✓
- AC-4（widget 删除）：agent-widget.ts 仅剩 WidgetAgentState，agent-widget.test.ts 已删 ✓

- [ ] **步骤 4：最终提交（若有遗漏修复）**

```bash
git add -A
git commit -m "test(subagents): e2e verification pass for TUI block redesign" --allow-empty
```

---

## 自我审查

### 规格覆盖

| Spec FR | 对应任务 | 状态 |
|---------|---------|------|
| FR-1.1 AgentEventLogEntry type 扩展 | 任务 1 步骤 4 | ✅ |
| FR-1.1a event-bridge thinking_delta | 任务 1 步骤 6 | ✅ |
| FR-1.1b text_output/thinking 切片 | 任务 2 步骤 4 | ✅ |
| FR-1.2 SubagentToolDetails model/thinkingLevel | 任务 3 步骤 3 + 任务 4 步骤 5 + 任务 5 步骤 5 | ✅ |
| FR-1.3 事件采集统一（bg onUpdate） | 任务 5 步骤 4 | ✅ |
| FR-2.0 删除 widget 渲染层 | 任务 6 | ✅ |
| FR-2.1 6 行压缩布局 | 任务 3 步骤 3 | ✅ |
| FR-2.2 alt+o 展开 | 任务 3 步骤 3（buildExpandedLines）+ 任务 4 步骤 3（options.expanded） | ✅ |
| FR-2.3 spinner 定时器 | 任务 4 步骤 3 | ✅ |
| FR-2.4 背景色 theme token | 任务 3 步骤 3（getBgFn） | ✅ |
| FR-2.5 background 实时刷新 | 任务 5 步骤 4-5 | ✅ |

### 占位符扫描

- 任务 5 步骤 6 的 `resolveModel` import 路径要求实施时 `ls resolution/` 确认——这是合理的实现时确认（路径未硬编码），**不算占位符**。
- 任务 5 步骤 1 的 `createTestRuntime` 标注"替换为实际函数名"——同上，步骤 1 已给出 `head -30` 确认命令。
- 所有代码步骤都含完整代码块，无 "TODO"/"类似任务 N"。

### 类型一致性

- `SubagentToolState`（任务 4 定义）→ renderSubagentResult context 参数 ✓
- `WidgetAgentState._currentThinking`（任务 2 步骤 3 定义）→ updateWidgetFromEvent 使用 ✓
- `buildRenderLines(details, width, theme, options)` 签名（任务 3 定义）→ SubagentResultComponent.render ✓
- `renderSubagentResult`（任务 4 导出）→ renderResult 字段 + 测试 ✓
- `BackgroundOptions.onUpdate`（任务 5 步骤 3 定义）→ startBackground + subagent-tool 调用 ✓
- `ThemeLike`（任务 3 导出）→ 测试 import ✓

无类型不一致。
