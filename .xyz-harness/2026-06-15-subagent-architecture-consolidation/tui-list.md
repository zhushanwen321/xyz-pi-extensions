# 展示层 — /subagents list 全屏 Overlay

> 源：subagent-tui FR-3 + orchestration FR-O6.6
> 展示层契约：只读 runtime.getAllRecords()，产出 string[]。

---

## 1. 命令入口

| 命令 | 行为 |
|------|------|
| `/subagents` | 配置摘要（不变） |
| `/subagents config` | 配置向导（不变） |
| `/subagents list` | 全屏 overlay（Level 0） |
| `/subagents list <id>` | 直接进入指定 agent 详情 |

### 防重叠

runtime `_activeView: { close } | null`。打开新 view 前关闭已有的（G-017）。

---

## 2. Level 0 — 记录列表

```
┌─ Subagents ─────────────────────────────────────────────────┐
│  ID              Type           Agent/Mode    Status         │
│  run-3           single         worker        ✓ done         │
│  orch-1-xyz      orchestration  parallel      ⟳ running 2/4  │
│  bg-2-abc        single         researcher    ✓ done         │
│                                                              │
│  j/k 导航 · Enter 详情 · x 取消 · q 退出                     │
└──────────────────────────────────────────────────────────────┘
```

- 列：ID / Type（single|orchestration）/ Agent·Mode / Status
- Status 图标：✓ done / ⟳ running / ✗ failed / ■ cancelled
- orchestration 行 Status 含进度：`⟳ running 2/4` / `✗ failed (step 3)`

### 排序（G-020）

running → failed（triage）→ cancelled → done。同状态按 startedAt desc。

### 空状态

`No subagent executions in this session.`

---

## 3. single record → Level 1（agent 详情）

```
╭─ run-3: worker (done) ──────────────────────────────────────╮
│  5 turns │ 12.3k tok │ 45s │ anthropic/claude-sonnet-4.5     │
│                                                              │
│  Event log:                                                  │
│  ├─ read auth.ts ✓                                           │
│  ├─ edit auth.ts ✓                                           │
│  ├─ bash npm test ✓                                          │
│  └─ turn 5: "Authentication module complete..."              │
│                                                              │
│  Result: Authentication module complete. JWT validation      │
│  added to auth.ts. All tests passing.                        │
│                                                              │
│  esc back                                                    │
╰──────────────────────────────────────────────────────────────╯
```

- header：ID + agent + status + turns/tokens/elapsed/model
- eventLog：完整（j/k 滚动），复用 formatEventLogLine
- result/error：完整文本
- 数据源：AgentExecutionState（running 实时，completed 快照）

---

## 4. orchestration record → Level 1（DAG summary，split panes）

```
╭─ orch-1-xyz parallel (running 2/4) ─────────────────────────╮
│  Phases              │ Context · 2 agents                     │
│  ────────────────    │ ──────────────────────────────────     │
│  ❯ ● Context  1/2   │   ● worker-A    deepseek/ds-flash       │
│    ● Implement 1/2   │      12k tok · 4 tools · 45s ✓         │
│    ○ Review    0/1   │   ● worker-B    deepseek/ds-flash       │
│                      │      8k tok · 3 tools · 32s ✓          │
│                      │                                        │
│  ↑↓ phases · ⏎ agents│ ↑↓ · ⏎ detail · x cancel · esc back   │
╰──────────────────────────────────────────────────────────────╯
```

- 左 pane：Phase 列表（buildPhaseGroups 按 phase 分组）
- 右 pane：当前 phase 的 step 列表
- step 行：`{dot} {agent} {model} · {tokens} · {tools} · {elapsed} {glyph}`

### Level 2 — step 详情

```
╭─ worker-A: implement auth (done) ───────────────────────────╮
│  5 turns │ 12k tok │ 45s │ deepseek/ds-flash                 │
│                                                              │
│  Event log:                                                  │
│  ├─ read auth.ts ✓                                           │
│  ├─ edit auth.ts ✓                                           │
│  └─ turn 5: "Authentication module complete..."              │
│                                                              │
│  Result: Authentication module complete...                   │
│                                                              │
│  esc back to step list                                       │
╰──────────────────────────────────────────────────────────────╯
```

- 数据源：OrchestrationGraphNode.recentEvents + result
- 渲染逻辑与 single Level 1 相同（只换数据源）

---

## 5. 键盘交互

| 键 | Level 0 | Level 1 (single) | Level 1 (DAG) | Level 2 |
|----|---------|-------------------|---------------|---------|
| j/k | 上下导航 | 滚动 eventLog | 右 pane 步骤 / 左 pane phase | 滚动 eventLog |
| Enter | 进详情 | — | step → Level 2 | — |
| x | cancel running | cancel | cancel 整个 DAG | — |
| q/Esc | 退出 | 回 Level 0 | 回 Level 0 | 回 Level 1 |

### cancel

- single：`cancelBackground(id)`（background only）；sync 通过 AbortController
- orchestration：`cancelBackground(runId)` → abort 整个 DAG

---

## 6. 实时刷新

runtime 事件总线（FR-3.4）：

```typescript
// overlay 打开时订阅
const unsub = runtime.onChange(() => requestRender());
// 退出时取消
unsub();
```

runtime 在 `updateStateFromEvent` / `startBackground .then/.catch` / `cancelBackground` 后调 `notifyChange()`。

---

## 7. hasUI guard

`!ctx.hasUI`（print/RPC 模式）→ error `"/subagents list requires interactive mode"`，不 crash。

---

## 8. 终端过小

`minHeight = 8`（header 3 + ≥3 content + footer 2）。`terminalRows < 8` → 显示 `Terminal too small (need ≥8 rows)` + 缩减内容。
