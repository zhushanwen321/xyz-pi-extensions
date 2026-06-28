# /workflows TUI — 完整功能规格（参考实现对照）

> 本文档基于对 `../main/` 原始实现的逐行追踪（3 个独立 subagent 交叉验证），
> 记录 `/workflows` slash command + WorkflowsView TUI 的**完整功能清单**。
> 用途：refactor 实现的权威验收基准——任何遗漏都是 bug。

---

## 1. 命令分发（commands.ts）

### 1.1 注册
```
api.registerCommand("workflows", { handler })
```

### 1.2 分发逻辑（6 条路径，缺一不可）

| 条件 | 行为 | 代码 |
|------|------|------|
| `!ctx.hasUI`（RPC/print/json） | `notify("/workflows requires interactive mode", "error")` | 分支 A |
| orchestrator 未初始化 | `notify("Workflow system not initialized", "error")` | 分支 B |
| `/workflows <runId>` 精确匹配 | `createWorkflowsView(orch, runId, theme, ctx)` | 分支 C-1 |
| `/workflows <prefix>` 唯一前缀匹配 | `createWorkflowsView(orch, matched[0].runId, theme, ctx)` | 分支 C-2 |
| `/workflows <runId>` 0 或 2+ 前缀匹配 | `notify("Workflow '<id>' not found", "error")` | 分支 C-3 |
| `/workflows`（无参）+ 0 runs | `notify("No workflows found. Use /workflow <name> to start one.", "info")` | 分支 D |
| `/workflows`（无参）+ 1 run | `createWorkflowsView(orch, all[0].runId, theme, ctx)` | 分支 F |
| `/workflows`（无参）+ 多 runs | `select("Select workflow:", entries)` → `createWorkflowsView` | 分支 G |

### 1.3 排序（multi-run select 前）
```ts
statusOrder = { running: 0, paused: 1, completed: 2, failed: 3 }
// 同 status 按 startedAt 降序（新的在前）
```

### 1.4 select 条目格式
```ts
`${s.name} [${s.status}] (${s.runId.slice(0, 12)}...)`
```

---

## 2. View Factory + SDK 集成

### 2.1 `ctx.ui.custom` 调用（完整签名）
```ts
ctx.ui.custom<void>(
  (tui, _theme, _kb, done) => { ... return component; },
  {
    overlay: true,
    overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%", margin: 0 },
  },
);
```
**第二参数 `{overlay, overlayOptions}` 不可省略**——省略则非全屏 overlay 模式。

### 2.2 Factory 内部初始化
1. 解析 instance：`orchestrator.getInstance(runId)`（每次 render 都重新调，取实时数据）
2. instance 不存在 → `notify("Workflow not found", "warning")` + `done()` + 返回 no-op component
3. 初始化 ViewState（见 §3）
4. 初始化缓存：`cache = { width, lines }`
5. **事件订阅**：`orchestrator.events.subscribe(runId, () => if (!disposed) requestRender())`
   - refactored engine 无 events，改用 `setInterval(TICK_MS=1000)` 轮询
6. `wrappedDone`：幂等 → `disposed=true` → `unsubscribe()/clearInterval` → `done()`

### 2.3 Component 三件套

| 方法 | 行为 |
|------|------|
| `invalidate()` | `cache.width = undefined; cache.lines = undefined` |
| `render(width)` | 缓存命中→返回；未命中→`getInstance(runId)`取实时数据→`renderView()`→pad到终端高度→缓存 |
| `handleInput(data)` | `if (disposed) return;` → `processKey(...)` → 若返回 true 则 invalidate + requestRender |

### 2.4 render 的实时数据读取（关键）
```ts
render(width) {
  if (cache valid) return cached;
  const inst = orchestrator.getInstance(runId);  // ← 每次 render 重取！
  const raw = renderView(inst, ...);
  ...
}
```
**refactored 版对齐**：`run.state.trace.toArray()` 每次返回内部数组引用，`trace.append()` 后立即可见。

---

## 3. ViewState（完整字段）

```ts
interface ViewState {
  level: 0 | 1 | 2;       // 导航层级
  phaseIdx: number;        // 选中的 phase
  agentIdx: number;        // 选中的 agent
  promptExpanded: boolean; // L2 prompt 展开/折叠
  disposed: boolean;       // 退出标记
  saveMode: boolean;       // save overlay 激活
  saveScope: "project" | "user";  // refactored 仅 project
  saveInputValue: string;  // save 输入框文本
  saveMessage: string;     // save 反馈消息
  saveMsgOk: boolean;      // save 成功/失败样式
}
```

---

## 4. 键盘交互（完整按键表，按分发优先级）

### 4.1 Save mode 激活时（最高优先级拦截）

| 按键 | 动作 | 条件 |
|------|------|------|
| `Escape` | 退出 save mode | 总是 |
| `\t` (Tab) | 切换 scope project↔user | 总是（refactored 无此键） |
| `\r`/`\n` (Enter) | 空名→报错；非空→`doSaveWorkflow()` 异步保存 | 总是 |
| `\x7f`/`\b` (Backspace) | 清消息 + 删末字符 | 总是 |
| 可打印字符 (≥32) | 清消息 + 追加 | 总是 |
| 其他键 | 屏蔽（不穿透到导航） | — |

### 4.2 正常模式（按 dispatch 顺序）

| # | 按键 | 动作 | 条件 | 返回 |
|---|------|------|------|------|
| 1 | `Escape` | L0→退出；L1→L0；L2→L1 | 总是 | bool |
| 2 | `x` | `handleAbort()` | 总是（handler 内有 terminal guard） | false |
| 3 | `p` | `handlePauseResume()`（running→pause / 非running→resume） | 总是（handler 内有 guard） | false |
| 4 | `r` | `handleRestart()` | `isTerminal OR paused` | false |
| 5 | `s` | 进入 save mode（预填 name） | 总是 | true |
| 6 | `S` | `saveTraceToFile()` | 总是 | false |
| 7 | `↑` L0 | phaseIdx-- | `phaseIdx > 0` | bool |
| 8 | `↑` L1 | agentIdx-- | `agentIdx > 0` | bool |
| 9 | `↑` L2 | agentIdx-- + promptExpanded=false | `agentIdx > 0` | bool |
| 10 | `↓` L0 | phaseIdx++ | `phaseIdx < phases-1` | bool |
| 11 | `↓` L1 | agentIdx++ | `agentIdx < agents-1` | bool |
| 12 | `↓` L2 | agentIdx++ + promptExpanded=false | `agentIdx < agents-1` | bool |
| 13 | `⏎` L0 | level=1 | `agents > 0` | bool |
| 14 | `⏎` L1 | level=2 | 总是 | true |
| 15 | `⏎` L2 | toggle promptExpanded | 总是 | true |
| 16 | `I` L2 | toggle promptExpanded | L2 only | true |

### 4.3 refactored 的键差异（D-9 决策）
- `x`(abort) → 改为 `a`(abort)
- `r`(restart) → **移除**（engine 无 restart 函数）
- `p`(pause/resume) → 保留
- `s`(save) → 保留（仅 tmp workflow）
- `S`(trace 导出) → **移除**（用户未要求恢复）
- `I`(prompt toggle) → 保留

---

## 5. Action Handlers（完整实现）

### 5.1 handlePauseResume / handleAbort
```ts
// 终态 guard
if (isTerminalStatus(status)) { notify(`Workflow already ${status}`, "warning"); return; }
// 异步操作 + notify
void orch.pause(runId)
  .then(() => notify("Workflow paused", "info"))
  .catch((err) => notify(`Pause failed: ${err.message}`, "error"));
```

### 5.2 handleRestart（refactored 无此功能）
```ts
state.disposed = true;  // 先 block 渲染，防 flicker
void orch.restart(runId)
  .then((newRunId) => { notify(`Restarted ...`, "info"); done(); })
  .catch((err) => { notify(`Restart failed: ...`, "error"); state.disposed = false; });
```

### 5.3 saveTraceToFile（refactored 无此功能，S 键）
- 路径：`~/.pi/agent/workflow-traces/{runId}.md`
- Markdown 结构：H1 标题 + 元数据 + budget + per-phase H2 + per-node H3
- 每节点：model, duration, prompt, activity(toolCalls), outcome

### 5.4 doSaveWorkflow（s 键，refactored 有）
```ts
const isTmp = worker.includes("/.tmp/") || worker.includes("\\.tmp\\");
if (!isTmp) return { ok: false, msg: "Only temporary workflows can be saved." };
const name = saveInputValue.trim();
const savedDir = resolve(cwd, ".pi/workflows");  // refactored 仅 project
if (existsSync(destPath)) return { ok: false, msg: `'${name}' already exists...` };
mkdirSync(savedDir, { recursive: true });
renameSync(target.path, destPath);  // refactored 用 rename（tmp 文件保存后消失）
return { ok: true, msg: `Saved '${name}' → ${destPath}` };
```

**refactored 的 isTmpRun 判断**：
- main 检查 `instance.worker`（worker 进程加载的脚本路径）
- refactored 检查 `run.spec.scriptPath`（RunSpec 记录的原始脚本路径）
- **两者等价**：tmp workflow 的路径都含 `/.tmp/`
- **saved workflow（如 review-fix-loop）路径不含 `.tmp/` → s 不显示 = 正确行为**

---

## 6. 渲染布局（完整视觉结构）

### 6.1 整体框架（box-drawing chars）
```
╭─────────────────────────────────────────────╮  ← renderHeader: ╭ + ─×contentWidth + ╮
│ review-fix-loop                             │  ← bold(name), padVisible
│ description...   ● running · 0/3 · 12s ...  │  ← desc(dim) + right(muted), 或无 desc 时只有 right
├─────────────────────────────────────────────┤  ← renderHeader: ├ + ─×contentWidth + ┤
│ Phases            │ build · 3 agents · 12s  │  ← mergeBody: left(24) + │ + right
│ ────────────────  │ ──────────────────────  │  ← ─×SIDEBAR_WIDTH / ─×mainWidth
│ ❯ ● 1 build 0/3   │   ● builder  model ...  │  ← formatPhaseLine / agent one-liner
│   ● 2 deploy 0/1  │   ● tester   model ...  │
│                   │                          │  ← emptyBodyLine: 24空格 + │ + mainWidth空格
╰─────────────────────────────────────────────╯  ← ╰ + ─×contentWidth + ╯

  ↑↓ phase · ⏎ enter · x stop · p pause · s save · S trace · esc back  ← footer（框外）
```

### 6.2 关键尺寸
- `contentWidth = width - 2`
- `mainWidth = contentWidth - SIDEBAR_WIDTH - 1`（SIDEBAR_WIDTH=24，减 1 给 │ 分隔符）
- `minBodyHeight = max(3, floor(termRows * 2/3) - 6)`（headerFooterLines=6）
- body 每行：`│ + padVisible(leftPad + │ + right, contentWidth) + │`

### 6.3 mergeBody
```ts
const bodyHeight = Math.max(leftLines.length, rightLines.length);
for (let i = 0; i < bodyHeight; i++) {
  const left = padVisible(leftLines[i] ?? "", SIDEBAR_WIDTH);
  lines.push(left + "│" + (rightLines[i] ?? ""));
}
```

### 6.4 headerRight 格式
```ts
`${formatStatusBadge(status, theme)} · ${completed}/${total} agents · ${elapsed}`
// 整体 theme.fg("muted", ...)
```
refactored 追加：`· ${budgetStr}` where `budgetStr = `${usedTokens/1000}k/${maxTokens/1000}k tok · $${usedCost.toFixed(4)}``

### 6.5 三级导航内容

**Level 0（Phase selection）**:
- Left: `"Phases"`(muted) + `─×24` + `formatPhaseLine` per phase
- Right: `"{name} · {count} agents"`(muted) + `─×mainWidth` + agent one-liner per node
- Agent one-liner: `` `  ${dot} ${agent}    ${model}    ${tokStr} · ${tcCount} tools · ${elapsed}` ``

**Level 1（Agent selection）**:
- Left: 同 L0（phase list）
- Right: `"{name} · {count} agents"`(muted) + `─×mainWidth` + agent list with `❯` pointer
- Agent line: `` `${pointer}${dot} ${agent}    ${model}    ${tokStr} · ${tcCount} tools · ${elapsed}` ``

**Level 2（Execution detail）**:
- Left: `"Agents"`(muted) + `─×24` + agent names with `❯` pointer (truncated to SIDEBAR_WIDTH-4)
- Right: `"Detail"`(muted) + `─×mainWidth` + 按序：
  1. `${dot} ${statusLabel} · ${model}`
  2. `formatTokenStat(...)` (dim)
  3. 空行
  4. Worker diagnostics（if errorLogs 非空）
  5. Prompt section（fold/expand）
  6. Activity section（toolCalls）
  7. Outcome section

### 6.6 footer 格式
```ts
navPart = L0: "↑↓ phase · ⏎ enter" | L1: "↑↓ agent · ⏎ detail" | L2: "↑↓ agent · ⏎ prompt"
actionParts = [
  (!terminal) && "x stop" (refactored: "a abort"),
  (!terminal) && (paused ? "p resume" : "p pause"),
  (terminal || paused) && "r restart",  // refactored 移除
  "s save",
  "S trace",  // refactored 移除
  "esc back",
].filter(Boolean)
footer = `${navPart} · ${actionParts.join(" · ")}`  // muted
```
**footer 前有一空行，footer 在 `╰╯` 之后（框外）**

### 6.7 Save overlay（居中覆盖 body）
```
╭───────────────────────────────╮
│ Save dynamic workflow          │  bold
│ .pi/workflows/{name}.js        │  dim（refactored 无 scope 切换）
│                                │
│ Save as:                       │
│   > {input}█                   │  U+2588 光标
│                                │
│   {message or empty}           │  success/error
│ Enter to save · Esc to cancel  │  muted
╰───────────────────────────────╯
```
refactored hint: `"Enter to save · Esc to cancel"`（无 Tab scope 切换）

---

## 7. 刷新机制

### 7.1 main 方案：事件驱动
```
orchestrator.events.subscribe(runId, () => requestRender())
+ WorkflowEventEmitter 内部 setInterval(1000ms) tick
  → 每 1s emit {type:"tick"} → 触发 requestRender
+ trace append/update/status change 也 emit → requestRender
```

### 7.2 refactored 方案：轮询
```ts
const tick = setInterval(() => {
  if (state.disposed) return;
  cache.width = undefined;
  cache.lines = undefined;
  requestRender();
}, 1000);
```
- engine 无事件层（orchestrator 已拆），view 自轮询
- `render()` 内 `run.state.trace.toArray()` 每次取实时引用
- `wrappedDone` 内 `clearInterval(tick)`

### 7.3 实时数据保证
- `run` 是 `deps.runs.get(runId)` 返回的**同一对象引用**
- engine 的 `trace.append(node)` 直接修改该对象的 `state.trace` 内部数组
- view 的 `trace.toArray()` 返回内部数组引用（非拷贝）
- **因此 tick 触发 → render 重取 → 看到新 trace 节点**

---

## 8. 已知问题清单（refactored 当前状态）

| # | 问题 | 根因 | 严重度 |
|---|------|------|--------|
| 1 | `s` save 在 saved workflow 上不显示 | `isTmpRun` 正确返回 false（saved workflow 非 tmp）——**这是设计正确行为**，非 bug | ℹ️ 非问题 |
| 2 | 刷新机制存在（setInterval），但需验证 SDK 是否响应 requestRender | SDK 集成层，需运行时验证 | ⚠️ 待验证 |
| 3 | `restart`（r 键）缺失 | D-9 决策移除，engine 无 restart 函数 | ✅ 设计决策 |
| 4 | `trace 导出`（S 键）缺失 | 用户未要求恢复 | ✅ 设计决策 |

---

## 9. 验收检查清单

### 9.1 命令分发
- [ ] `!ctx.hasUI` → error notify
- [ ] `/workflows <runId>` 精确匹配 → 打开 view
- [ ] `/workflows <prefix>` 唯一前缀 → 打开 view
- [ ] `/workflows <bad>` → "not found" notify
- [ ] `/workflows` + 0 runs → "No workflows" notify
- [ ] `/workflows` + 1 run → 直接打开
- [ ] `/workflows` + 多 runs → select 列表 → 选中后打开

### 9.2 View 渲染
- [ ] 全屏 overlay（`{overlay:true, overlayOptions}` 第二参数）
- [ ] box-drawing 外框（╭╮├┤╰╯）
- [ ] header：bold name + right-aligned status/agents/elapsed/budget
- [ ] body：sidebar(24) │ main 两栏
- [ ] footer：框外，nav + lifecycle shortcuts

### 9.3 三级导航
- [ ] L0: phase list + selected phase agents overview
- [ ] L1: phase list + agent list with ❯
- [ ] L2: agent names + full detail（worker logs / prompt fold / activity / outcome）
- [ ] ↑↓ 导航 + ⏎ 钻入 + Esc 返回

### 9.4 刷新
- [ ] 运行中 workflow 的 elapsed 时间每秒更新
- [ ] 新 trace 节点实时出现
- [ ] agent status 变化（running→completed）实时反映

### 9.5 快捷键
- [ ] `a` abort（running/paused 时）
- [ ] `p` pause/resume（toggle）
- [ ] `s` save（仅 tmp workflow —— **saved workflow 不显示是正确的**）
- [ ] save overlay：esc 取消 / enter 保存 / backspace 删除 / 字符追加
- [ ] Esc 逐级返回 + L0 退出

### 9.6 错误反馈
- [ ] pause/resume/abort 失败 → `notify("... failed: ...", "error")`
- [ ] 终态时操作 → `notify("Workflow already ...", "warning")`
