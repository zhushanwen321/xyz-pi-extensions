# 展示层 — /subagents list 全屏 Overlay

> 源：subagent-tui FR-3 + orchestration FR-O6.6
> 展示层契约：只读 runtime.getAllRecords()，产出 string[]。
> 仿 workflow WorkflowsView.ts 的左右分屏布局。

---

## 1. 命令入口

| 命令 | 行为 |
|------|------|
| `/subagents` | 配置摘要（不变） |
| `/subagents config` | 配置向导（不变） |
| `/subagents list` | 全屏 overlay（左右分屏，默认选中第一条） |
| `/subagents list <id>` | 全屏 overlay，直接选中指定 agent（右列显示其详情） |

### 防重叠

runtime `_activeView: { close } | null`。打开新 view 前关闭已有的（G-017）。

---

## 2. 数据范围 — sessionId 过滤

`/subagents list` 只显示**当前 session** 的 subagent 记录，不再显示跨 session 的 cwd 全部历史。

### 过滤机制

- `index.ts` 在 `session_start` 时调用 `ctx.sessionManager.getSessionId()` → `rt.setSessionId(id)`
- `runtime.listHistory()` 内部透传 `this._sessionId` 给 `history-store.read(sessionId)` / `recent(limit, sessionId)`
- `PersistedAgentRecord` 新增 `sessionId?` 字段，4 个 `buildPersistedRecord` 写入点都传递 `sessionId: this._sessionId`
- 内存数据源（`_runningAgents` / `_bgRecords` / `_completedAgents`）天然属于当前 session，无需过滤

### /resume /fork /new 行为

Pi 进程内单例 runtime 在 session 切换时 `revive()` 后重新 `setSessionId(newId)`，history 过滤自动切到新 session。旧 session 写入的记录仍在 history.jsonl 中（不删除），但不再显示。

---

## 3. 左右分屏布局

```
╭─ Subagents ──────────────────────────────────────────────────────╮
│ filter: worker_                                                   │
├──────────────────────────────────┬───────────────────────────────┤
│ Agents (2/5)                     │ Detail                        │
│ ─────────────────────────────── │ ───────────────────────────── │
│ ❯ ✓ worker    3t  89.4k  45s    │ ✓ done · worker               │
│   ✗ reviewer 43t   2.6M  5m02s  │ (anthropic/claude-sonnet-4.5  │
│   ⟳ planner   2t  68.8k     —   │  · thinking high)             │
│   ✓ scout     1t  26.8k   3s    │ 3 turns · 89.4k · 45s · sync  │
│                                 │                               │
│                                 │ Event log:                    │
│                                 │ ⎿  read auth.ts ✓             │
│                                 │ ⎿  edit config.ts ✓           │
│                                 │ ⎿  bash npm test ✓            │
│                                 │                               │
│                                 │ Result:                       │
│                                 │ All tests passed.             │
├──────────────────────────────────┴───────────────────────────────┤
│ ↑↓ 导航 · Enter 详情 · x stop · Esc 退出                          │
╰──────────────────────────────────────────────────────────────────╯
```

### 左列（SIDEBAR_WIDTH = 38）

- `❯` 选中指针（选中行 `theme.bold`）
- 状态图标：✓ done / ⟳ running / ✗ failed / ■ cancelled
- 固定列宽 + `padVisible` 对齐（ANSI-safe，解决 emoji/宽字符错位）
- 列：`pointer(2) icon(1) mode(2) agent(14) turns(5) tokens(8)`
- header：`Agents (filtered/total)`，显示 filter 后/前的数量
- 列表超出视口时自动滚动（跟随 `selectedIdx`）

### 右列（mainWidth = contentWidth - SIDEBAR_WIDTH - 1）

- `Detail` 标题 + 分隔线
- 状态行：`icon statusLabel · agent`
- model/thinkingLevel 行（括号分组）：`(provider/model · thinking high)`，借鉴对话流 block 的 meta 分组
- stats 行：`turns · tokens · elapsed · mode · started time`
- Event log：复用 `formatEventLogLine`，`wrapVisible` 自动换行，带滚动
- Result/Error：`wrapVisible` 自动换行，截断到 5 行

### 分隔

`mergeBody(leftLines, rightLines)` 把左右列按行拼接，左列 `padVisible` 到 SIDEBAR_WIDTH，中间用 `│` 分隔。

---

## 4. 排序（G-020）

running → failed（triage）→ cancelled → done。同状态按 startedAt desc。

---

## 5. 键盘交互

无 drill-down level——始终左右分屏，选中变化时右列实时刷新。

| 键 | 行为 |
|----|------|
| `↑` / `↓` | 上下导航选中（自动滚动左列） |
| `Enter` | 进入详情全屏模式（右列占满，↑↓ 滚动 eventLog） |
| `Esc` | 详情模式返回分屏 / 分屏模式退出 overlay |
| `x` | stop/cancel 选中的 running agent（`cancelBackground(id)`） |
| 可打印字符 | 直接输入 filter（实时过滤左列，匹配 agent 名/id） |
| `Backspace` | 删除 filter 最后一个字符 |

### filter

默认可直接输入——无需 `/` 快捷键进入 filter 模式。filter 输入区在 header 行显示 `filter: {text}_`（带光标）。退出 overlay 后 filter 不保留。

---

## 6. ANSI-aware 对齐工具

| 函数 | 用途 |
|------|------|
| `padVisible(s, width)` | 按**可见宽度**右补空格（非 string.length），解决 ANSI 转义码占字符但不占宽度的对齐问题 |
| `truncVisible(s, maxWidth)` | 按可见宽度截断 + 省略号（ANSI-safe） |
| `wrapVisible(text, maxWidth)` | 按可见宽度自动换行（`Intl.Segmenter` grapheme 切分，避免 emoji/宽字符被劈半） |

底层依赖 pi-tui 的 `visibleWidth` / `truncateToWidth`。

---

## 7. orchestration record（未实现）

orchestration（DAG）record 的 split-pane 渲染（Phase 列表 + step 详情）尚未实现。当前 `getAllRecords` 只处理 single records。未来扩展时，左列选中 orchestration record 后右列渲染 DAG summary + step 列表（参考 workflow WorkflowsView 的 `renderLevel1/2` + `mergeBody`）。

---

## 8. 实时刷新

runtime 事件总线（FR-3.4）：

```typescript
// overlay 打开时订阅
const unsub = runtime.onChange(() => requestRender());
// 退出时取消
unsub();
```

runtime 在 `updateStateFromEvent` / `startBackground .then/.catch` / `cancelBackground` 后调 `notifyChange()`。

---

## 9. hasUI guard

`!ctx.hasUI`（print/RPC 模式）→ error `"/subagents list requires interactive mode"`，不 crash。
