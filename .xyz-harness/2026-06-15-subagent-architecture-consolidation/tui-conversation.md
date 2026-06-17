# TUI 展示规格 — 对话流 Block（Single + Orchestration）

> 展示层规格。定义对话流中 tool 输出的背景色 block 如何渲染。
> 核心契约：**只读 AnyToolDetails，产出 string[]。不执行 agent、不解析 model、不计数。**
>
> 源：subagent-tui FR-2 + orchestration FR-O6.3/6.4 + impeccable 设计审查

---

## 1. Single subagent 对话流 block（6 行 compact）

### 第 1 行 — status（信息内聚，inline stats）

```
⠹ worker (anthropic/claude-sonnet-4.5 · thinking medium) · 2 turns · 8.2k · 12s
^^^^ ^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^ ^^^^^^^^^^^^^^^^^^^^^^
accent bold  dim 括号(model · thinking)                     dim · 分隔 stats
```

**格式**：`{glyph} {bold(agent)}{meta}{stats}`

- `glyph`：running → seed-frame spinner（accent）；done → `✓`（success）；failed → `✗`（error）；cancelled → `■`（muted）
- `agent`：**bold**（视觉焦点，借鉴 pi-subagents）
- `meta`：dim 括号 `(model · thinking level)`。无 thinking 则 `(model)`。无 model 则省略括号
- `stats`：dim `· N turns · Nk · Ns`。**各字段 > 0 才显示**（全零隐藏，不显示 `0 turns · 0 · 0s`）

**窄终端截断**：保留 `{glyph} {agent}`，从右截断 meta/stats。

### 第 2 行 — 实时活动行（P1#3，仅 running 且 currentActivity 存在时）

```
⎿ read auth.ts                    ← dim 实时活动（tool 执行中）
```

- **仅 running 时显示**，terminal 态（done/failed/cancelled）无此行，回归原布局
- dim 整行，图标按 `currentActivity.type` 选（与 eventLog 图标体系统一）：
  - `tool`（eventLog 最后一条 tool_start，未配对 tool_end）→ `› {tool label}`
  - `thinking`（_currentThinking streaming 缓冲非空）→ `· {reasoning 片段}`
  - `text`（_currentTurnText streaming 缓冲非空）→ `> {text 片段}`
- 优先级：tool > thinking > text（tool 执行中时不显示 streaming）
- **不计入滚动区配额**（COMPACT_SCROLL_LINES=4），是独立的「正在做什么」锚点
- 让 streaming 期间用户始终看到「当前活动」，弥补 tool_start 边界事件之间的视觉空白
- 数据来自 `executionStateToDetails` 投影的 `currentActivity` 字段（HANDOFF 架构分析 #3）

### 第 3-6 行 — 滚动区（最近 4 条事件）

```
› read auth.ts ✓
› bash grep -r catch src/auth/ ✗
· I'll scan the error handling patterns...
· analyzing session.ts:42 for uncaught...
```

- **每条以类型图标开头**（替换原 `├─ ` 前缀），图标后接 1 个空格再接内容。用类型图标代替统一连接符，让 thinking / tool / output 在压缩视图里一眼可辨：
  - `tool_start` → `› {toolName} {args摘要}`（无标记）
  - `tool_end` → `› {toolName} {args摘要} {✓|✗}`
  - `text_output` → `> {文本片段}`（normal 色）
  - `thinking` → `· {reasoning 片段}`（整行 dim，含 `·` 图标，SDK 支持时）
  - `turn_end` → **不显示**在滚动区
- **单行，不换行**：每条始终压成一行，超出截断加 `…`
- 截断：每条 ≤ ~50 可见字符 + `…`（用 truncLine，保留 ANSI 背景色）

### 第 6 行 — 提示

- running → `Press Ctrl+O for live detail`（accent 色）
- done/failed/cancelled → 空行（保持 6 行高度稳定）

### 背景色

| 状态 | theme token | 色 |
|------|------------|---|
| running | `toolPendingBg` | 黄 |
| done | `toolSuccessBg` | 绿 |
| failed/cancelled | `toolErrorBg` | 红 |

### spinner 设计（seed-frame，事件驱动）

**不用 setInterval**。spinner 帧由 `detailsSeed(details)` 选择：

```typescript
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
// seed = turns + totalTokens + elapsedSeconds + eventLog.length（单调增长）
// frame = RUNNING_FRAMES[abs(seed) % 10]
// 每次 onUpdate（真实事件）触发重绘 → seed 变化 → spinner 自然换帧
// 静默期（无事件）seed 不变 → spinner 冻结 → 换取滚动体验
```

无 seed 可用时回退静态 `●`。

---

## 2. Expanded view（Ctrl+O 切换）

```
⠹ worker (anthropic/claude-sonnet-4.5 · thinking medium) · 2 turns · 8.2k · 12s

── turn 1 ──
› read auth.ts ✓
· I'll scan the error handling patterns...
── turn 2 ──
› bash grep -r catch src/auth/ ✗
· analyzing session.ts:42...

Authentication module complete with proper error handling.
```

- 图标与压缩视图一致：`›` 工具 / `·` thinking（dim）/ `>` text_output。turn 分隔 `── turn N ──` 保持 dim
- Ctrl+O 是 Pi 内置全局 toggle（`ToolRenderContext.expanded`，keybindings.ts:85）。**不是 alt+o**（G-047 已验证 Pi 源码）
- expanded：完整 eventLog（无 4 行限制）+ turn 分隔 + 完整 result/error
- 超终端高度 → 进原生 scrollback。**对话流 block 不支持 in-block j/k scroll**（G-047：ToolExecutionComponent 未实现 handleInput）
- running/done/failed 都支持 toggle
- focus 始终在 editor（Pi 交互模式），不聚焦 tool block

---

## 3. Orchestration 对话流 block（8 行 compact）

```
⠹ orchestrate │ parallel · 2/4 done · 1 running · 8.2k · 23s     ← 第1行（黄背景）
phase: Implement [████░░░░] 2/4                                   ← 第2行（进度）
› ✓ worker-A: implement auth (done, 5 turns)                     ← 第3-8行（step 概要）
› ✓ worker-B: implement API (done, 3 turns)
› ⟳ reviewer: review auth+API (running, 2 turns)
› ○ planner: plan integration (pending)
```

### 第 1 行 — orchestration status

`{glyph} orchestrate · {mode} · {done}/{total} done · {running} running · {tokens} · {elapsed}s`

- glyph 同 single（seed-frame，seed = 所有 step 的 state 汇总）
- mode：parallel / chain / fanout

### 第 2 行 — 进度

- **parallel/fanout**：`phase: {phase名} [████░░] {done}/{total}`（进度条，█=done ░=not-done）
- **chain**：`step {current}/{total}: {当前 agent 名}`（简化，无进度条）

### 第 3-8 行 — step 概要（6 步）

`› {status_glyph} {agent}: {label} ({status_detail})`

| status | glyph | color |
|--------|-------|-------|
| completed | `✓` | green |
| running | `⟳` | spinner |
| failed | `✗` | red |
| pending | `○` | dim |
| skipped | `⊘` | dim |

### 截断策略（> 6 步）

- **chain**：当前步 + 前 3 已完成 + 后 2 pending。更早的折叠为 `… +{N} earlier steps`（dim）
- **parallel/fanout**：所有 running + failed 优先（triage），余位按 startedAt desc → completed → pending
- 底部 `… +{N} more`（dim），引导 Ctrl+O 或 /subagents list

---

## 4. Orchestration Expanded view

```
⠹ orchestrate · parallel · 2/4 done · 8.2k · 23s
══════════════════════════════════════════════════════
▶ worker-A: implement auth (done, 5 turns)
  › read auth.ts ✓
  › edit auth.ts ✓
▼ reviewer: review auth+API (running, 2 turns)        ← active 默认展开
  › read auth.ts ✓
  › bash npm test ✗
○ planner: plan integration (pending)
══════════════════════════════════════════════════════
Result: {聚合结果摘要}
```

- 每个 step 标题 `▶`/`▼`（折叠/展开）。**active step 默认展开**（▼），其余折叠（▶）
- 展开 step 显示完整 eventLog（复用 single 滚动区格式 + `›`/`·`/`>` 图标）
- 折叠状态存 `OrchestrateToolState.expandedSteps: Set<string>`
- 超终端高度：截断为 header + 最近 N 步（每步 3-5 行），完整详情引导 /subagents list

---

## 5. 渲染路由

```
renderResult(result)
  → details = result.details
  → if details.kind === "orchestration"
      → buildOrchestrationRenderLines(details, width, theme)
  → else (kind === "single" 或无 kind 向后兼容)
      → buildRenderLines(details, width, theme)
```

两个渲染函数都是**纯函数**，输入 AnyToolDetails + width + theme，输出 string[]。

---

## 6. 背景色 block 组件契约

```typescript
// SubagentResultComponent implements pi-tui Component
class SubagentResultComponent {
  constructor(details: AnyToolDetails, theme: ThemeLike)
  setExpanded(expanded: boolean): void
  render(width: number): string[]   // 直接返回 buildRenderLines 的内容行 string[]
  invalidate(): void                // no-op（render 每次重建，无缓存）
}
```

**P0（残影修复）：背景色与 padding 归属 Pi default shell，不在此组件。**

- 工具注册**不设** `renderShell`（默认 `default`）。Pi 的 `tool-execution.ts` 用 `contentBox = Box(1,1,bgFn)`
  包裹 `renderCall` + `renderResult` 两个子组件，bgFn 按 `isPartial`/`isError` 自动切换：
  running→`toolPendingBg`、done→`toolSuccessBg`、failed/cancelled→`toolErrorBg`。
- `SubagentResultComponent.render()` 直接返回内容行 `string[]`（状态行 + 滚动区），
  Pi 的 `contentBox` 给每行加 `leftPad + applyBg(line, width)`——等价于 pi-subagents
  `renderSingleCompact`（render.ts:1012-1046）的 `new Container()+new Text(…,0,0)`，但更直接。
- 顶/底背景填充行由 `contentBox` 的 `paddingY=1` 产生，不在本组件输出中。
- 不用 `self` shell：self 路径 prepend 空字符串后拼裸 `string[]`，diff-redraw 引擎对高度跳变
  对齐有缺陷，会导致旧快照残留在新快照上方（残影 bug）。default shell 走组件树高度增长路径，
  有成熟的 invalidate/clear，与 pi-subagents 一致。
- 内容行经 `truncLine`（ANSI 样式保留）截断到 `width`（Pi 传入的已是 contentWidth）。

---

## 7. 事件日志格式（formatEventLogLine）

| 事件类型 | 格式 | 颜色 |
|---------|------|------|
| tool_start | `› {toolName} {args摘要}` | normal |
| tool_end (done) | `› {toolName} {args摘要} ✓` | ✓ = success 绿 |
| tool_end (failed) | `› {toolName} {args摘要} ✗` | ✗ = error 红 |
| text_output | `> {文本片段}` | normal |
| thinking | `· {reasoning 片段}` | dim（含 `·` 图标整行 dim） |
| turn_end（expanded only） | `── turn {N} ──` | dim |

**类型图标语义**（替代原统一 `├─ ` 连接符，提升压缩视图可读性）：

| 图标 | 类型 | 说明 |
|------|------|------|
| `›` | tool_start / tool_end | 工具调用，尾部追加 `✓`/`✗` |
| `>` | text_output | agent 输出文本 |
| `·` | thinking | 推理片段，整行 dim |
| `──` | turn_end | turn 分隔（expanded only） |

args 摘取：read/write/edit → basename；bash → command（≤60 char）；web → query/url。

---

## 8. 分隔符语义体系（impeccable 审查裁定）

| 字符 | 语义 | 何时用 |
|------|------|--------|
| `·` | 同级并列字段 / thinking 图标 | `{model} · {thinking}`、`2 turns · 8.2k · 12s`；thinking eventLog 行首图标 |
| `()` | 元数据分组 | `(model · thinking)` 包裹降级信息 |
| `›` | 工具调用图标 | eventLog tool_start/tool_end 行首 |
| `>` | 输出文本图标 | eventLog text_output 行首 |
| `│` | 大区块分隔 | orchestration header `orchestrate │ parallel`（仅 header） |
| `→` | 时序/因果 | chain DAG 可视化 `scout → planner → worker` |
| `▶`/`▼` | 折叠标记 | orchestration expanded step 标题 |
| `━━` | 分节线 | expanded view 的 turn 分隔 / orchestration 上下边界 |

**禁止**：用 `│` 做 stats 字段分隔（历史 bug 来源）；用 `├─`/`└─` 做 eventLog 行前缀（已废弃，改用类型图标 `›`/`>`/`·`，理由：压缩视图里 thinking/tool/output 难以区分）。
