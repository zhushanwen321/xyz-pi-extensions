# 06. Claude Code `/workflows` TUI 调研

> 基于 `claude-code-source-code` 仓库（v2.1.154+ 时期源码）的逆向分析。
> 注意：`LocalWorkflowTask/` 和 `WorkflowDetailDialog.tsx` 被 `feature('WORKFLOW_SCRIPTS')` 门控，
> 源码目录中不存在这些文件。以下分析基于**可观测的壳层代码**（BackgroundTasksDialog、BackgroundTask、
> pillLabel、commands.ts、tasks.ts 等）推断。

---

## 一、整体界面架构

### 1.1 入口：`/workflows` 命令

`/workflows` 是一个 `local-jsx` 类型命令，注册在 `commands.ts` 中：

```typescript
// commands.ts:86-88
const workflowsCmd = feature('WORKFLOW_SCRIPTS')
  ? require('./commands/workflows/index.js').default
  : null

// commands.ts:341 — 加入命令列表
...(workflowsCmd ? [workflowsCmd] : []),
```

命令受 `WORKFLOW_SCRIPTS` feature flag 门控。外部构建不包含此代码。

### 1.2 命令发现与注册

Workflow 脚本通过 `getWorkflowCommands(cwd)` 动态发现：

```typescript
// commands.ts:403-404
const getWorkflowCommands = feature('WORKFLOW_SCRIPTS')
  ? require('./tools/WorkflowTool/createWorkflowCommand.js').getWorkflowCommands
  : null
```

发现的 workflow 被注册为 `prompt` 类型命令，带 `kind: 'workflow'` 标记：

```typescript
// command.ts - CommandBase
kind?: 'workflow'  // 在 autocomplete 中显示 workflow badge
```

用户在 typeahead 中看到 `(workflow)` 后缀，与普通 skill 区分。

### 1.3 保存路径

```
.claude/workflows/<name>.js    # 项目级（可 git 共享）
~/.claude/workflows/<name>.js  # 个人级（跨项目）
```

---

## 二、TUI 组件层级

### 2.1 组件树

```
BackgroundTasksDialog          ← 主面板（/workflows 命令的 UI）
├── [list mode]                ← 默认模式：任务列表
│   ├── Dialog                 ← 设计系统容器（标题、副标题、快捷键提示）
│   ├── TeammateTaskGroups     ← Agent 分组（团队视图）
│   └── Item[]                 ← 各类任务项
│       └── BackgroundTask     ← 单项渲染（根据 task.type switch）
│           ├── ShellProgress
│           ├── RemoteSessionProgress
│           ├── TaskStatusText
│           └── ... (workflow 专用渲染)
└── [detail mode]              ← 选中后：详情视图
    ├── ShellDetailDialog      ← local_bash 详情
    ├── AsyncAgentDetailDialog ← local_agent 详情
    ├── RemoteSessionDetailDialog ← remote_agent 详情
    ├── InProcessTeammateDetailDialog ← teammate 详情
    ├── WorkflowDetailDialog   ← local_workflow 详情（闭源）
    ├── MonitorMcpDetailDialog ← monitor_mcp 详情
    └── DreamDetailDialog      ← dream 详情
```

### 2.2 Workflow 在列表中的渲染

从 `BackgroundTask.tsx` 的反编译代码可以精确还原 workflow 列表项的渲染：

```tsx
case 'local_workflow': {
  // 显示名称：workflowName > summary > description，截断到 activityLimit
  const label = truncate(task.workflowName ?? task.summary ?? task.description, activityLimit, true)

  // 状态标签
  const statusLabel = task.status === 'running'
    ? `${task.agentCount} ${plural(task.agentCount, 'agent')}`  // "3 agents"
    : task.status === 'completed'
      ? 'done'
      : undefined

  // 未读标记
  const suffix = task.status === 'completed' && !task.notified ? ', unread' : undefined

  return (
    <Text>
      {label}{' '}
      <TaskStatusText status={task.status} label={statusLabel} suffix={suffix} />
    </Text>
  )
}
```

**实际渲染效果（推断）**：

```
▶ audit-all-files 3 agents  ◐ running
  fix-legacy-api   done ✓
```

关键字段：
- `task.workflowName` — workflow 的 meta.name
- `task.summary` — 运行时摘要（可能动态更新）
- `task.description` — meta.description 或脚本描述
- `task.agentCount` — 当前并行 agent 数量
- `task.status` — running / completed / pending
- `task.notified` — 用户是否已读

### 2.3 状态栏（Pill）渲染

在 Claude Code 底部的背景任务指示器（pill）中，workflow 的显示：

```typescript
// pillLabel.ts
case 'local_workflow':
  return n === 1 ? '1 background workflow' : `${n} background workflows`
```

效果：底部状态栏显示 `1 background workflow` 或 `3 background workflows`。

### 2.4 WorkflowDetailDialog（闭源，推断）

从 `BackgroundTasksDialog.tsx` 的引用可以推断 WorkflowDetailDialog 的接口：

```tsx
<WorkflowDetailDialog
  workflow={task_0}                          // LocalWorkflowTaskState
  onDone={onDone}                           // 关闭回调
  onKill={task_0.status === 'running'       // 停止按钮
    && killWorkflowTask
    ? () => killWorkflowTask(task_0.id, setAppState)
    : undefined}
  onSkipAgent={task_0.status === 'running'  // 跳过单个 agent
    && skipWorkflowAgent
    ? agentId => skipWorkflowAgent(task_0.id, agentId, setAppState)
    : undefined}
  onRetryAgent={task_0.status === 'running' // 重试单个 agent
    && retryWorkflowAgent
    ? agentId_0 => retryWorkflowAgent(task_0.id, agentId_0, setAppState)
    : undefined}
  onBack={goBackToList}                     // 返回列表
  key={`workflow-${task_0.id}`}
/>
```

**推断的详情面板功能**：

| 操作 | 快捷键 | 函数 | 说明 |
|------|--------|------|------|
| 返回列表 | Esc/left | `onBack` | 回到任务列表 |
| 停止 workflow | x | `onKill` → `killWorkflowTask` | 终止整个 run |
| 跳过 agent | (未知) | `onSkipAgent` → `skipWorkflowAgent` | 跳过指定 agent |
| 重试 agent | (未知) | `onRetryAgent` → `retryWorkflowAgent` | 重试指定 agent |

这比 Pi workflow 当前只有 run-level pause/abort 更细——**CC 支持节点级 skip/retry**。

---

## 三、LocalWorkflowTaskState（推断的数据模型）

从多处引用推断：

```typescript
interface LocalWorkflowTaskState {
  type: 'local_workflow'
  id: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'aborted'

  // 显示字段
  workflowName?: string   // meta.name
  summary?: string        // 运行时动态摘要
  description: string     // meta.description 或脚本描述

  // Agent 统计
  agentCount: number      // 当前活跃 agent 数

  // 状态
  notified?: boolean      // 用户是否已读完成通知
  startTime?: number      // 启动时间

  // 背景任务通用
  isBackgrounded: boolean
}
```

---

## 四、交互流程

### 4.1 完整用户旅程

```
1. 用户输入包含 "workflow" 的 prompt
   ↓
2. Claude 决定写一个 workflow 脚本
   ↓
3. 审批 UI（ApprovalGate）
   - Default 模式：每次弹 Dialog
   - Auto 模式：首次弹，选 "Yes, don't ask again" 后跳过
   - ultracode：完全不弹
   ↓
4. 脚本在独立 runtime 执行，创建 LocalWorkflowTask
   ↓
5. 底部 pill 显示 "1 background workflow"
   ↓
6. 用户按 ↓ 或 /workflows 进入 BackgroundTasksDialog
   ↓
7. 列表模式：看到 workflow 名称 + agent 数量 + 状态
   ↓
8. Enter 进入 WorkflowDetailDialog
   - 看到 phase 进度
   - 可以 kill / skip agent / retry agent
   ↓
9. Workflow 完成 → 回到主会话 → Claude 展示最终结果
```

### 4.2 保存为可复用命令

```
/workflows → 选中一个 run → 按 s
  → 保存到 .claude/workflows/<name>.js（项目级）
  → 或 ~/.claude/workflows/<name>.js（个人级）
  → 下次直接 /<name> 调用（注册为 prompt command）
```

### 4.3 恢复运行

```
/workflows → 选中一个 paused 的 run → 按 p
  → 已完成的 agent 返回缓存结果
  → 剩下的 live 重跑
  → 仅同会话有效
```

---

## 五、设计模式分析

### 5.1 统一任务模型

Claude Code 把 workflow 作为 7 种 task type 之一，与 shell、agent、teammate 等并列：

```
TaskState =
  | LocalShellTaskState     // bash 命令
  | LocalAgentTaskState     // 本地 subagent
  | RemoteAgentTaskState    // 远程 agent（ultraplan 等）
  | InProcessTeammateTaskState  // 团队成员
  | LocalWorkflowTaskState  // ← workflow
  | MonitorMcpTaskState     // MCP 监控
  | DreamTaskState          // dream 模式
```

**设计决策**：workflow 不是独立的 UI 概念，而是统一 BackgroundTasks 系统的一种 task type。
好处：复用 Dialog / Item / BackgroundTask 等通用组件，保持 UI 一致性。

### 5.2 Feature Flag 门控

所有 workflow 相关代码被 `feature('WORKFLOW_SCRIPTS')` 隔离：

```typescript
// 编译时 dead-code elimination
const LocalWorkflowTask = feature('WORKFLOW_SCRIPTS')
  ? require('./tasks/LocalWorkflowTask/LocalWorkflowTask.js').LocalWorkflowTask
  : null

// UI 层动态加载
const WorkflowDetailDialog = feature('WORKFLOW_SCRIPTS')
  ? require('./WorkflowDetailDialog.js').WorkflowDetailDialog
  : null
```

闭源部分（`LocalWorkflowTask/`、`WorkflowDetailDialog.tsx`）不在源码仓库中，说明 Anthropic 通过 Bun bundle 的 feature flag + dead-code elimination 实现了**二进制级代码隔离**。

### 5.3 Dialog 设计系统

所有面板基于统一设计系统：

```tsx
<Dialog
  title="Background tasks"
  subtitle={<>{subtitle}</>}
  onCancel={handleCancel}
  color="background"
  inputGuide={renderInputGuide}  // 底部快捷键提示
>
```

- `inputGuide` 渲染 `Byline` + `KeyboardShortcutHint`，显示当前可用操作
- 支持两次 Ctrl+C 退出的 `ExitState`
- `ConfigurableShortcutHint` 支持用户自定义快捷键

### 5.4 列表自动跳转

```typescript
// BackgroundTasksDialog.tsx
// 只有一个任务时，自动跳到详情页（跳过列表）
const allItems = getSelectableBackgroundTasks(typedTasks, foregroundedTaskId);
if (allItems.length === 1) {
  skippedListOnMount.current = true;
  return { mode: 'detail', itemId: allItems[0]!.id };
}
```

**UX 决策**：只有一个 workflow 时，`/workflows` 直接打开详情，不显示空列表。

---

## 六、Workflow 的快捷键体系

从 `BackgroundTasksDialog.tsx` 的 `useKeybindings` 和 `handleKeyDown`：

| 按键 | 上下文 | 动作 |
|------|--------|------|
| ↑/↓ | list | 上下选择 |
| Enter | list | 进入详情 |
| x | list, running | 停止选中任务 |
| f | list, teammate | 前台显示 |
| ←/Esc | list | 关闭面板 |
| ctrl+x ctrl+k | list | 停止所有 agent |

Workflow 详情面板（WorkflowDetailDialog，闭源推断）：

| 按键 | 动作 | 实现 |
|------|------|------|
| x | 停止 workflow | `killWorkflowTask` |
| (skip key) | 跳过 agent | `skipWorkflowAgent` |
| (retry key) | 重试 agent | `retryWorkflowAgent` |
| Esc/← | 返回列表 | `goBackToList` |
| s | 保存为命令 | 保存到 `.claude/workflows/` |
| p | 恢复运行 | replay callCache |

---

## 七、与 Pi Workflow TUI 的对比

### 7.1 架构对比

| 维度 | Claude Code | Pi Workflow |
|------|------------|-------------|
| **UI 框架** | React (Ink) | Pi TUI (setWidget) |
| **组件层级** | 统一 BackgroundTasksDialog | 独立 `/workflows` 面板 |
| **任务模型** | 7 种 TaskState 并列 | 独立 WorkflowStatus |
| **列表入口** | `/workflows` 或按 ↓ | `/workflows` |
| **详情入口** | Enter 进入 Dialog | Ctrl+O 展开 overlay |
| **节点控制** | skipAgent / retryAgent | retryNode / skipNode |
| **状态指示** | 底部 pill "N background workflows" | setWidget 持续显示 |

### 7.2 CC 可借鉴的设计

| 设计 | 描述 | 价值 |
|------|------|------|
| **统一任务模型** | workflow 作为 TaskState 的一种 | 复用现有 UI 组件，减少代码 |
| **自动跳转详情** | 只有一个任务时跳过列表 | 更好的 UX |
| **agentCount 实时显示** | 列表项显示 "3 agents" | 快速了解并行度 |
| **notified 标记** | 完成但未读的任务标记 ", unread" | 避免遗漏 |
| **保存为命令** | 按 s 保存 workflow 脚本 | 可复用、可分享 |
| **Feature Flag 隔离** | 编译时消除未启用功能 | 减少包体积 |

### 7.3 Pi Workflow 独有的优势

| 设计 | 描述 | CC 没有 |
|------|------|---------|
| **跨会话恢复** | JSONL 持久化 + rehydrate | ✅ CC 只支持同会话 |
| **7 态状态机** | budget_limited / time_limited 独立终态 | ✅ CC 状态未公开 |
| **3 重预算** | token + cost + time | ✅ CC 只有 16/1000 硬限制 |
| **Widget 持续显示** | setWidget 在 REPL 中持续渲染 | ✅ CC 只在 pill 显示 |

---

## 十一、真实截图技术解析

> 本节基于用户提供的 Bilibili 视频截图（来源：旧版 Claude Code 教程）做逐像素分析。
> 截图路径：`/var/folders/3p/d4mx1j_j5s7bn3_03x48kpkw0000gn/T/pi-clipboard-5a721aa7-e4cb-41f7-9b83-7a5f2684b3af.png`

### 11.1 截图概述

| 字段 | 值 |
|------|-----|
| **workflow 名称** | `triage-issues-3way` |
| **任务描述** | Triage `memory-lancedb-pro` issues into 3 categories |
| **当前进度** | 10/11 agents completed |
| **运行时长** | 3m20s |
| **当前 phase** | `Classify`（已完成 10/10） |
| **下一 phase** | `Converge`（0/1） |
| **并发模型** | `Haiku`（轻量级模型，用于批量分类） |
| **平均每 agent** | ~4.5s，~50.7k tokens，1 tool call |

### 11.2 界面布局分析

截图展示了 **嵌入式进度视图**（不是弹窗 Dialog），直接渲染在 Claude Code REPL 主界面区域。布局为 **左右分栏**：

```
┌─────────────────────────────────────────────────────────────────────┐
│ triage-issues-3way                                                  │  ← workflow name（粗体）
│ Triage memory-lancedb-pro issues into 3 categories: Haiku fan-...   │  ← 摘要行（dim）
├─────────────────┬───────────────────────────────────────────────────┤
│ Phases          │ Classify · 10 agents                              │  ← 两栏标题
│ ─────────────── │ ──────────────────────────────────────────────────│
│ › ✔ Classify    │ ✔ #833 Partnership inquir... Haiku 4.5 50.5k tok  │
│   10/10         │   · 1 tool ...                                      │
│                 │ ✔ #821 You should update ... Haiku 4.5 50.8k tok  │
│   2  Converge   │   · 1 tool ...                                      │
│   0/1           │ ✔ #819 OpenAI embedder cl... Haiku 4.5 50.8k tok  │
│                 │   · 1 tool ...                                      │
│                 │ ...（共 10 行）                                      │
├─────────────────┴───────────────────────────────────────────────────┤
│ ↑↓ select · x stop workflow · p pause · esc back · s save           │  ← 底部快捷键
└─────────────────────────────────────────────────────────────────────┘
```

**关键布局特征**：

1. **不是弹窗**：没有 Dialog 边框，直接在 REPL 输出区域嵌入
2. **左右分栏**：左侧窄栏显示 phases，右侧宽栏显示 agents
3. **横线分隔**：`─` 字符分隔标题区和内容区
4. **当前 phase 高亮**：`›` 箭头 + `✔` 标记表示当前展开且完成
5. **agent 行右对齐**：模型/耗时/token 数据右对齐，描述左对齐

### 11.3 每行 agent 的数据模型

从截图反推 agent 行的数据结构：

```typescript
interface AgentRow {
  // 状态
  status: 'completed' | 'running' | 'pending' | 'failed'
  statusIcon: '✔' | '🔄' | '⏳' | '❌'

  // 标识
  id: string           // e.g. "#833"
  description: string  // e.g. "Partnership inquir..."（截断）

  // 模型信息
  model: string        // e.g. "Haiku"
  modelVersion: string // e.g. "4.5"（可能是 model 版本或耗时？）

  // 资源消耗
  durationMs: number   // 截图显示 "4.5"，推断为秒
  tokens: number       // 截图显示 "50.5k"

  // 工具调用
  toolCount: number    // 截图显示 "1 tool"

  // 操作
  hasMoreActions: boolean  // "..." 按钮
}
```

**关于 "4.5" 的推测**：
- 可能是耗时（4.5 秒）—— 所有 agent 都是 ~4.5，且是 Haiku（快模型），4.5s 合理
- 可能是模型温度/版本号—— 但所有行都是 4.5，不太像版本号
- **最可能**：耗时（秒），因为 Batch classification 任务用 Haiku 每个约 4-5 秒合理

### 11.4 Phase 列表设计

```
Phases
› ✔ Classify  10/10
   2  Converge   0/1
```

- `Phases` 是左栏标题
- `›` 表示当前展开的 phase（类似 tree view 的展开箭头）
- `✔` 表示该 phase 已完成
- `10/10` 是 agent 完成计数
- `2` 是 phase 序号（推断）
- `Converge` 是下一个 phase 的名称
- `0/1` 表示该 phase 还未开始

这与 `meta.phases` 定义和 pipeline 编排模式完全吻合：
```javascript
const meta = {
  name: "triage-issues-3way",
  description: "...",
  phases: ["Classify", "Converge", "Report"]  // 推断有 3 个 phase
};
```

### 11.5 底部快捷键

```
↑↓ select · x stop workflow · p pause · esc back · s save
```

与源码推断的功能映射：

| 按键 | 截图显示 | 源码对应 | 说明 |
|------|----------|----------|------|
| `↑↓` | select | — | 上下选择 agent |
| `x` | stop workflow | `onKill` | 停止整个 workflow |
| `p` | pause | — | 暂停 workflow |
| `esc` | back | `onBack` | 返回列表/关闭 |
| `s` | save | 保存为命令 | `.claude/workflows/` |

注意：截图底部字幕提到这是「旧版 Claude Code 中的显示方式」，可能与当前版本有差异。当前版本从源码推断还有 `x to stop`（停止）。

### 11.6 与源码推断的差异

| 维度 | 源码推断 | 真实截图 | 差异说明 |
|------|----------|----------|----------|
| **展示位置** | BackgroundTasksDialog 弹窗 | REPL 主界面嵌入 | 截图是直接嵌入，不是弹窗 |
| **布局** | 单栏堆叠 | 左右分栏 | 截图展示了两栏布局 |
| **phase 显示** | 文本列表 | 可展开的 tree | 截图有 `›` 展开箭头 |
| **agent 数据** | 描述 + 状态 | 6 列数据 | 截图更详细 |
| **底部提示** | Dialog 内置 inputGuide | 独立提示行 | 截图是行内提示 |
| **暂停功能** | 未推断 | `p pause` | 截图有暂停键 |

### 11.7 对 Pi Workflow 重构的启示

从这张截图可以学到：

1. **左右分栏**：phase 列表在左（窄），agent 列表在右（宽）—— 比上下堆叠更高效
2. **每行 6 个数据维度**：状态、编号、描述、模型、耗时、token、工具调用 —— 信息密度高但清晰
3. **模型标识**：显示每个 agent 使用的模型（Haiku）—— 多模型混排时非常有用
4. **实时摘要行**：顶部动态更新 `10/11 agents · 3m20s` —— 一目了然
5. **可展开的 phase**：`›` 箭头切换 phase 视图 —— 大量 agent 时可折叠
6. **底部常驻快捷键**：`↑↓ · x · p · esc · s` 常驻显示，不用记

---

## 八、结论

### 8.1 CC Workflow TUI 的核心设计

1. **统一任务面板**：workflow 不是独立 UI，而是 BackgroundTasksDialog 的一种 task type
2. **两级视图**：列表模式（快速浏览）→ 详情模式（phase 进度 + 节点控制）
3. **节点级操作**：skipAgent / retryAgent，比 run-level 控制更细
4. **可复用化**：s 键保存为项目级命令，team 共享

### 8.2 对 Pi Workflow TUI 重构的建议

1. **短期**：在 widget 中显示 agentCount（类似 CC 的 "3 agents"）
2. **短期**：完成但未读的 workflow 加 "unread" 标记
3. **中期**：将 workflow 纳入统一的任务管理面板（如果 Pi 未来有多种后台任务类型）
4. **中期**：支持 "保存为可复用命令"（类似 CC 的 s 键）
5. **长期**：React Ink 级别的 UI 组件系统（如果 Pi 要做更复杂的 TUI）

---

## 九、真实 TUI 截图（来自公开材料）

### 9.1 官方博客截图 — Workflow 发起界面

来源：Anthropic 官方博客（2026-05-28）

展示的是 Claude Code REPL 中用户输入包含 "workflow" 关键词后，
Claude 显示 "Dynamic workflow requested" 并准备写 workflow 脚本的界面。

关键元素：
- `ultracode` 标签（右上角）
- `auto mode on` 状态
- `Dynamic workflow requested` 提示
- 用户 prompt: "Create a workflow that migrates every internal fetch() call to the new HttpClient wrapper, updating tests as you go."

### 9.2 实际运行中 TUI — Workflow 详情面板

来源：第三方博客/教程截图

展示了 workflow 运行中的 TUI 界面，核心特征：

1. **Phase 进度条**：顶部显示 workflow 的 phases（如 Scope → Search → Fetch → Verify → Synthesize）
2. **Agent 状态面板**：每个 phase 下列出正在运行的 agents，显示描述和状态
3. **实时进度**：底部显示总 token 数和已完成 agent 数
4. **交互控制**：`x` 停止、`p` 暂停、`s` 保存等快捷键

### 9.3 Background Tasks 统一面板

来源：Medium 文章截图

展示了 BackgroundTasksDialog，即 `/workflows` 或按 ↓ 进入的面板：

- 标题 "Background tasks"
- 按 type 分组显示（Workflows / Shells / Local agents）
- 每个 task 显示描述 + 状态（agent 数 / done / running）
- 选中项有 `▶` 指针
- 底部快捷键提示：`↑/↓ to select · Enter to view · x to stop · Esc to close`

> **注意**：以上截图来源于公开的第三方博客和 Anthropic 官方材料。
> 源文件路径：`/tmp/cc-workflow-official.png`、`/tmp/cc-workflow-detail.jpg`、`/tmp/cc-workflow-medium1.png`、`/tmp/cc-workflow-medium2.png`

> 以下界面基于 `BackgroundTasksDialog.tsx`、`BackgroundTask.tsx`、`Dialog.tsx`、
> `Pane.tsx`、`KeyboardShortcutHint.tsx`、`TaskStatusText` 等组件的反编译代码还原。
> 状态 3 额外结合了真实截图进行修正（详见 Section 十一）。
> WorkflowDetailDialog 是闭源的，其界面为推断。


### 10.1 状态 1：正常运行（底部 pill 指示器）

当有 workflow 在后台运行时，Claude Code 的 REPL 底部显示一个 **pill（药丸指示器）**：

```
┌─────────────────────────────────────────────────────────────┐
│                                                             │
│  > 帮我审计整个项目的安全问题                               │
│                                                             │
│  我来创建一个 workflow 来并行审计所有文件。                  │
│  Running security-audit workflow...                         │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  ◇ 1 background workflow · ↓ to view                       │  ← pill（底部状态栏）
└─────────────────────────────────────────────────────────────┘
```

**pill 渲染逻辑**（`pillLabel.ts`）：
- 单数：`1 background workflow`
- 复数：`3 background workflows`
- 前缀：`◇`（DIAMOND_OPEN，表示运行中）
- 后缀：`↓ to view`（只有 ultraplan 的 needs_input/plan_ready 才显示，普通 running 不显示）


### 10.2 状态 2：按 ↓ 进入 BackgroundTasksDialog（列表模式）

用户按 ↓ 或输入 `/workflows`，弹出统一的 **Background tasks** 面板：

```
─────────────────────────────────────────────────────────────
  Background tasks                                            
  1 active agent                                              
─────────────────────────────────────────────────────────────

    Workflows (2)
      ▶ security-audit  3 agents (running)                   
        fix-legacy-api (done)                                 

    Shells (1)
        npm test (running)                                    

    Local agents (1)
        Reviewing auth module (done, unread)                  

─────────────────────────────────────────────────────────────
  ↑/↓ to select · Enter to view · x to stop · Esc to close  
─────────────────────────────────────────────────────────────
```

**渲染细节**（逐行对应源码）：

| 区域 | 源码 | 渲染规则 |
|------|------|----------|
| 标题 | `Dialog title="Background tasks"` | 粗体，默认 `permission` 色 |
| 副标题 | `subtitle` | dim 色，`1 active agent` 格式 |
| 分组标题 | `<Text bold>  Workflows</Text> (2)` | dim 色 + 粗体 + 计数 |
| 选中指针 | `isSelected ? figures.pointer + " " : "  "` | `▶` 或两空格 |
| Workflow 名称 | `truncate(workflowName ?? summary ?? description)` | 截断到 `maxActivityWidth` |
| 状态标签 | `TaskStatusText` | `(3 agents)` / `(done)` / `(done, unread)` |
| 底部快捷键 | `Byline` + `KeyboardShortcutHint` | dim 色，` · ` 分隔 |


### 10.3 状态 3：Workflow 运行中进度视图（WorkflowDetailDialog）

选中一个 workflow 后按 Enter，或 workflow 运行时自动展示，进入 **workflow 详情面板**。
以下基于源码接口推断 + **真实截图修正**：

**真实界面（来自 Bilibili 视频截图，见 Section 十一）**：

```
triage-issues-3way
Triage memory-lancedb-pro issues into 3 categories: Haiku fan-...10/11 agents · 3m20s

Phases ──────────────────────── Classify · 10 agents ───────────────────────
 › ✔ Classify   10/10            ✔ #833 Partnership inquir...  Haiku 4.5 50.5k tok · 1 tool ...
   2  Converge    0/1            ✔ #821 You should update ...  Haiku 4.5 50.8k tok · 1 tool ...
                                 ✔ #819 OpenAI embedder cl...  Haiku 4.5 50.8k tok · 1 tool ...
                                 ✔ #817 Bug: Backup failed...  Haiku 4.5 50.7k tok · 1 tool ...
                                 ✔ #816 Silent hybrid→vect...  Haiku 4.5 51.1k tok · 1 tool ...
                                 ✔ #814 fix: reflection fa...  Haiku 4.5 50.9k tok · 1 tool ...
                                 ✔ #813 [Feature Request] ...  Haiku 4.5 50.8k tok · 1 tool ...
                                 ✔ #812 Request: cut a new...  Haiku 4.5 50.9k tok · 1 tool ...
                                 ✔ #809 Hermes用不了啊，怎...   Haiku 4.5 50.5k tok · 1 tool ...
                                 ✔ #801 Would pre-action D...  Haiku 4.5 50.7k tok · 1 tool ...

 ↑↓ select · x stop workflow · p pause · esc back · s save
```

**布局解析**：

| 区域 | 内容 | 渲染规则 |
|------|------|----------|
| **workflow name** | `triage-issues-3way` | 粗体高亮，meta.name |
| **摘要行** | `Triage memory-lancedb-pro issues...10/11 agents · 3m20s` | dim 色，动态更新；`10/11 agents` 显示进度；`3m20s` 运行时长 |
| **左栏标题** | `Phases` | 粗体，带横线分隔符 |
| **当前 phase** | `› ✔ Classify 10/10` | `›` 展开箭头 + `✔` 完成标记 + phase 名 + `完成数/总数` |
| **后续 phase** | `2  Converge 0/1` | 序号 + 名称 + 进度（灰色，未完成） |
| **右栏标题** | `Classify · 10 agents` | 当前 phase 名 + agent 数量 |
| **agent 行** | `✔ #833 Partnership inquir...` | 状态图标 + 编号 + 描述（截断） |
| **agent 元数据** | `Haiku 4.5 50.5k tok · 1 tool` | 模型 + 耗时 + token + 工具调用数 |
| **更多按钮** | `...` | 每行末尾，展开详情 |
| **底部提示** | `↑↓ select · x stop workflow · p pause · esc back · s save` | dim 色，快捷键提示 |

**每行 agent 的列结构**：

```
[状态] [编号] [描述]                    [模型] [耗时] [tokens]   [工具] [操作]
  ✔     #833  Partnership inquir...     Haiku   4.5   50.5k tok  · 1 tool ...
```

**状态图标推断**：

| 图标 | 状态 | 条件 |
|------|------|------|
| `✔` | 完成（done） | agent 返回成功 |
| `🔄` | 运行中（running） | 正在执行 |
| `⏳` | 等待中（pending） | 排队等待 |
| `❌` | 失败（failed） | 错误或超时 |

**推断依据**：
- `onKill` → 对应 `x stop workflow`（截图底部已确认）
- `onSkipAgent` → 对应跳过单个 agent 的操作
- `onRetryAgent` → 对应 `r to retry`
- `onBack` → 对应 `Esc to back`
- `meta.phases` → 左栏 phase 列表
- `agent({ description })` → 每行 agent 的描述
- `agent({ model })` → 每行显示模型名（Haiku）

**截图揭示的关键设计**：

1. **左右分栏布局**：左侧 phase 列表 + 右侧 agent 列表，不是上下堆叠
2. **每行 agent 显示 6 个维度的数据**：状态、编号、描述、模型、耗时、token、工具调用
3. **实时统计**：摘要行动态更新 `10/11 agents` 和运行时长
4. **底部常驻快捷键**：`↑↓ select · x stop workflow · p pause · esc back · s save`，不是弹窗式提示


### 10.4 状态 4：保存 workflow（按 s）

```
─────────────────────────────────────────────────────────────
  Save workflow                                               
─────────────────────────────────────────────────────────────

    ○ Save to project (.claude/workflows/)                    
    ● Save to user (~/.claude/workflows/)                     

─────────────────────────────────────────────────────────────
  ↑/↓ to navigate · Space to toggle · Enter to confirm       
─────────────────────────────────────────────────────────────
```

保存后，workflow 出现在 `/` 命令的 typeahead 中，带 `(workflow)` badge：

```
> /sec
  /security-audit  Run security audit on all files (workflow)
  /session          Manage sessions
```
