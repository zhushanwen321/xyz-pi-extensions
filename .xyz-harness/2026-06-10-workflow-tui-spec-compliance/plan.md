---
verdict: pass
complexity: L1
---

# Workflow TUI View Spec Compliance Fixes

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 WorkflowsView 三层导航中 7 处 spec/UX 不一致项，使 TUI 渲染输出符合 spec FR-2/3/4/6 的要求并改善视觉质量。

**Architecture:** 纯渲染层修复，不涉及 orchestrator/state/agent-pool 等运行时逻辑。改动集中在 `WorkflowsView.ts` 的 3 个 renderLevel 函数和 `format.ts` 的工具函数。

**Tech Stack:** TypeScript, pi-tui (ANSI 拼接), vitest

---

## Spec 不一致清单

| # | Spec Ref | 严重程度 | 问题 | 实际 | 期望 |
|---|----------|---------|------|------|------|
| 1 | FR-4.1 | **major** | Level 2 状态行多了一行 bold agent name，缺少 elapsed | 3行：`bold(name)` → `● status · model` → `N tok · M calls` | 2行：`● status · model` → `N tok · M calls · elapsed` |
| 2 | FR-6.3 | minor | `s` 键在 Level 0/1 也可用 | processKey level 0/1 分支有 `data === "s"` | `s` 仅 Level 2 |
| 3 | FR-4.7 | minor | output 超 100KB 无截断 | OUTPUT_TRUNCATE_BYTES 常量未使用 | render 层截断 + `(truncated)` |
| 4 | FR-2.3 | minor | sidebar 无标题行 | 直接显示 phase 列表 | 第一行 `Phases` 标题 |
| 5 | AC-5 | minor | phase 行无序号、长名称无 truncate | `❯ ● PhaseName done/total` | `<序号> PhaseName done/total` + truncateToWidth |
| 6 | UX | minor | 空 phase name 显示双空格 | `❯ ●  0/3`（name 为空串） | `❯ ● (unnamed) 0/3` |
| 7 | FR-3.1 | minor | Level 0 右侧 title 显示选中 phase 但内容平铺所有 | title `Review · 3 agents` 但列出所有 phase agents | title `All phases · N agents` 与平铺内容一致 |

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `extensions/workflow/src/interface/views/WorkflowsView.ts` | modify | BG1 | renderLevel0/1/2 + processKey 修复 |
| `extensions/workflow/src/interface/views/format.ts` | modify | BG1 | formatTokenStat 加 elapsed 参数 |
| `extensions/workflow/src/__tests__/workflows-view.test.ts` | modify | BG1 | 覆盖 5 项修复的回归测试 |

## Interface Contracts

### Module: format.ts

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| formatTokenStat | `(usage?, toolCalls?, elapsed?) → string` | string | elapsed="-" when no startedAt | FR-4.1 |
| truncateToWidth | (pi-tui 内置) | string | phase name > SIDEBAR_WIDTH | AC-5 |

### Module: WorkflowsView.ts

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| renderLevel2 状态行 | 内联渲染 | string[] | — | FR-4.1 |
| processKey (s key) | data string → boolean | boolean | level 0/1 忽略 "s" | FR-6.3 |
| Outcome 截断 | 内联渲染 | string[] | content > 100KB | FR-4.7 |
| sidebar 标题行 | 内联渲染 | string | — | FR-2.3 |
| phase 行格式 | 内联渲染 | string | phase name 超长 | AC-5 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| AC-5 (sidebar 格式) | renderLevel0/1 sidebar + truncateToWidth | phase list → left panel | Task 3 |
| AC-11 (统计行) | formatTokenStat + elapsed | node.result → status line | Task 1 |
| AC-20 (footer) | processKey s key guard | keyboard → action | Task 2 |
| FR-4.7 (output 截断) | renderLevel2 outcome | node.result.content → lines | Task 4 |
| FR-2.3 (sidebar 标题) | renderLevel0/1 sidebar | phase groups → title | Task 3 |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| FR-4.1 Level 2 状态行格式 | adopted | Task 1 |
| FR-6.3 s 键仅 Level 2 | adopted | Task 2 |
| FR-2.3 sidebar Phases 标题 | adopted | Task 3 |
| AC-5 phase 行序号+truncate | adopted | Task 3 |
| FR-4.7 100KB output 截断 | adopted | Task 4 |

---

## Tasks

### Task 1: 修复 Level 2 状态行格式 (FR-4.1)

**Type:** frontend

**Files:**
- Modify: `extensions/workflow/src/interface/views/WorkflowsView.ts` renderLevel2()
- Modify: `extensions/workflow/src/interface/views/format.ts` formatTokenStat()

- [ ] **Step 1: 修改 formatTokenStat 增加 elapsed 参数**

`format.ts` 中 `formatTokenStat` 新增可选 `elapsed` 参数：

```typescript
export function formatTokenStat(
  usage?: { input: number; output: number },
  toolCalls?: ToolCallEntry[],
  elapsed?: string,
): string {
  const tokens = usage ? usage.input + usage.output : 0;
  const tools = toolCalls?.length ?? 0;
  const base = `${tokens} tok · ${tools} tool calls`;
  return elapsed ? `${base} · ${elapsed}` : base;
}
```

- [ ] **Step 2: 修改 renderLevel2 状态行**

将 Level 2 右侧前 3 行替换为 2 行（去掉 bold name 行，加 elapsed）：

```typescript
// 原来 3 行:
// rightLines.push(theme.bold(node.agent));
// rightLines.push(`${statusDotStr(node.status, theme)} ${node.status} · ${node.model}`);
// rightLines.push(theme.fg("dim", formatTokenStat(node.result?.usage, node.result?.toolCalls)));

// 改为 2 行:
const elapsed = formatElapsed(node.startedAt, node.completedAt ? new Date(node.completedAt).getTime() : Date.now());
rightLines.push(`${statusDotStr(node.status, theme)} ${node.status} · ${node.model}`);
rightLines.push(theme.fg("dim", formatTokenStat(node.result?.usage, node.result?.toolCalls, elapsed)));
```

- [ ] **Step 3: 更新现有测试中 formatTokenStat 的调用签名（如有）**

检查 `format.test.ts` 中 formatTokenStat 测试用例，补充 elapsed 参数的测试。

- [ ] **Step 4: 运行测试验证**

Run: `cd extensions/workflow && npx vitest run`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "fix: Level 2 status line format per FR-4.1 (2 lines with elapsed)"
```

### Task 2: 限制 s 键仅 Level 2 可用 (FR-6.3)

**Type:** frontend

**Files:**
- Modify: `extensions/workflow/src/interface/views/WorkflowsView.ts` processKey()

- [ ] **Step 1: 删除 Level 0/1 的 s 键处理**

`processKey` 函数中，level 0/1 分支末尾的 `if (data === "s")` 删除：

```typescript
// 删除这段（约 L273）：
// if (data === "s") { saveTraceToFile(instance, ctx); return false; }
```

`s` 键处理只在 `state.level === 2` 分支保留（已有）。

- [ ] **Step 2: 运行测试**

Run: `cd extensions/workflow && npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "fix: restrict s key to Level 2 only (FR-6.3)"
```

### Task 3: sidebar 加标题行 + phase 序号 + truncate (FR-2.3, AC-5)

**Type:** frontend

**Files:**
- Modify: `extensions/workflow/src/interface/views/WorkflowsView.ts` renderLevel0() + renderLevel1()

- [ ] **Step 1: renderLevel0 sidebar 添加标题行和序号**

Level 0 和 Level 1 左侧 sidebar 渲染逻辑中：

```typescript
// 在 for 循环前添加标题行:
leftLines.push(theme.fg("muted", "Phases"));
leftLines.push("─".repeat(SIDEBAR_WIDTH));

// for 循环中添加序号和 truncate:
for (let i = 0; i < phases.length; i++) {
  const pg = phases[i];
  const isSelected = i === state.phaseIdx;
  const pointer = isSelected ? "❯ " : "  ";
  const dot = statusDotStr(pg.doneCount === pg.nodes.length ? "completed" : "running", theme);
  const label = `${i + 1} ${pg.name || "(unnamed)"} ${pg.doneCount}/${pg.nodes.length}`;
  const truncated = visibleLen(label) > SIDEBAR_WIDTH - 4
    ? truncateToWidth(label, SIDEBAR_WIDTH - 5) + ELLIPSIS
    : label;
  leftLines.push(`${pointer}${dot} ${truncated}`);
}
```

注意需要 import `truncateToWidth` from `@mariozechner/pi-tui`（format.ts 已有 import，检查 WorkflowsView.ts 是否需要新增）。

实际上 truncateToWidth 已在 format.ts 导出但 WorkflowsView.ts 未直接 import。两种方案：
- A) 在 format.ts 新增 `formatPhaseLine(pg, idx, isSelected, theme, width)` 函数
- B) 在 WorkflowsView.ts 中 import truncateToWidth

选 A — 保持渲染逻辑集中在 format.ts：

```typescript
// format.ts 新增:
export function formatPhaseLine(
  pg: PhaseGroup,
  idx: number,
  isSelected: boolean,
  theme: ThemeLike,
  maxWidth: number,
): string {
  const pointer = isSelected ? "❯ " : "  ";
  const dot = statusDotStr(pg.doneCount === pg.nodes.length ? "completed" : "running", theme);
  const label = `${idx + 1} ${pg.name || "(unnamed)"} ${pg.doneCount}/${pg.nodes.length}`;
  const budget = maxWidth - 4; // pointer(2) + dot(1) + space(1)
  const truncated = visibleLen(label) > budget
    ? truncateToWidth(label, budget - 1) + ELLIPSIS
    : label;
  return `${pointer}${dot} ${truncated}`;
}
```

WorkflowsView.ts renderLevel0 和 renderLevel1 中替换 phase 循环体为调用 `formatPhaseLine`。

- [ ] **Step 2: 运行测试**

Run: `cd extensions/workflow && npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "fix: sidebar title + phase index + truncate (FR-2.3, AC-5)"
```

### Task 4: 实现 100KB output 截断 (FR-4.7)

**Type:** frontend

**Files:**
- Modify: `extensions/workflow/src/interface/views/WorkflowsView.ts` renderLevel2() Outcome section

- [ ] **Step 1: 在 Outcome 渲染中添加截断检查**

renderLevel2 Outcome 部分的 `node.result.content` 处理中：

```typescript
// 原来:
// } else if (node.result?.content) {
//   const allLines = node.result.content.split("\n");
//   const tail = allLines.slice(-5);
//   rightLines.push(...tail.map((l) => `  ${l.slice(0, mainWidth - 4)}`));
// }

// 改为:
} else if (node.result?.content) {
  const raw = node.result.content;
  if (Buffer.byteLength(raw, "utf8") > OUTPUT_TRUNCATE_BYTES) {
    const truncated = raw.slice(0, OUTPUT_TRUNCATE_BYTES);
    const allLines = truncated.split("\n");
    const tail = allLines.slice(-5);
    rightLines.push(...tail.map((l) => `  ${l.slice(0, mainWidth - 4)}`));
    rightLines.push(theme.fg("dim", "  (truncated)"));
  } else {
    const allLines = raw.split("\n");
    const tail = allLines.slice(-5);
    rightLines.push(...tail.map((l) => `  ${l.slice(0, mainWidth - 4)}`));
  }
}
```

需要确保 `OUTPUT_TRUNCATE_BYTES` 已 import（当前 WorkflowsView.ts 已有 `import { ... OUTPUT_TRUNCATE_BYTES ... } from "./format.js"` — 验证 import 列表）。

- [ ] **Step 2: 运行测试**

Run: `cd extensions/workflow && npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "fix: truncate output over 100KB in Level 2 Outcome (FR-4.7)"
```

### Task 5: 全量验证 + 推送

**Type:** backend

**Files:** 无新文件

- [ ] **Step 1: 全量类型检查**

Run: `cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace/fix-workflow-test && pnpm --filter @zhushanwen/pi-workflow typecheck`
Expected: 0 errors

- [ ] **Step 2: 全量测试**

Run: `cd extensions/workflow && npx vitest run`
Expected: 全部 PASS

- [ ] **Step 3: 全量 lint**

Run: `cd extensions/workflow && npx eslint src/`
Expected: 0 errors (warnings OK)

- [ ] **Step 4: Push**

```bash
git push origin fix-workflow-test
```

---

## Execution Groups

#### BG1: Spec Compliance Fixes

**Description:** 5 个独立的渲染层修复，都作用于 interface/views/ 目录

**Tasks:** Task 1, Task 2, Task 3, Task 4, Task 5

**Files (预估):** 3 个文件（2 modify + 1 modify test）

**Dependencies:** 无

**Execution Flow (BG1 内部):** 串行（文件重叠）

  Task 1 → Task 2 → Task 3 → Task 4 → Task 5

## Dependency Graph & Wave Schedule

```
Task 1 → Task 2 → Task 3 → Task 4 → Task 5
```

| Wave | Tasks | 说明 |
|------|-------|------|
| Wave 1 | Task 1-5 | 串行执行，文件重叠无法并行 |
