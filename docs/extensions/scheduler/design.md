# pi-scheduler Extension 设计文档

> 状态：Draft v2
> 创建：2026-07-27
> 更新：2026-07-27
> 作者：zhushanwen

## 1. 概述

pi-scheduler 为 Pi 添加定时任务能力：通过 cron 表达式或间隔时间，在 agent idle 时自动注入 user message 触发新一轮 agent turn。

**典型场景**：
- 每 5 分钟检查 CI 状态
- 每天早上 9 点跑 standup prompt
- 30 分钟后提醒检查部署
- 每小时同步一次数据

**设计借鉴**：oh-pi Scheduler（`~/GitApp/pi-ecosystem/oh-pi/packages/extensions/extensions/scheduler*.ts`）。

### 与 oh-pi 的取舍

| 保留 | 砍掉 | 新增 |
|------|------|------|
| croner 库做 cron 解析 | 多实例 lease 机制（~400 行） | next 5 次执行预览 |
| workspace 路径隔离存储 | safe mode | history[] 执行记录（最近 20 条） |
| idle 时 dispatch | 12 个 command 别名 | TUI 快捷键管理（非嵌套 select） |
| 速率限制 6 次/分 | adopt/release/clear_foreign | GuiComponent 结构化渲染 |
| debounced 持久化 | | force dispatch 选项 |
| jitter 防惊群 | | GUI widget 双通道（TUI/RPC） |

## 2. 文件结构

```
extensions/scheduler/
  index.ts              # 入口，re-export src/index.ts
  package.json          # name: @zhushanwen/pi-scheduler
  src/
    index.ts            # extension factory（注册 tool/command/events）
    types.ts            # 类型定义
    parsing.ts          # cron/duration 解析（纯函数）
    store.ts            # JSON 持久化（读写 + GC）
    runtime.ts          # 调度运行时（任务生命周期 + dispatch）
    tool.ts             # schedule + schedule_control tool 注册
    commands.ts         # /schedule command 注册
    widget.ts           # TUI status bar widget
    gui.ts              # xyz-agent GuiComponent 构建
    format.ts           # 格式化工具函数（纯函数）
  __tests__/
    parsing.test.ts
    runtime.test.ts
    store.test.ts
    format.test.ts
```

## 3. 类型定义

```typescript
// ── 调度规格 ──

type ScheduleMode = 'cron' | 'interval'

type ScheduleSpec =
  | { mode: 'cron'; cronExpression: string }
  | { mode: 'interval'; intervalMs: number }

// ── 任务 ──

type TaskKind = 'once' | 'recurring'
type TaskStatus = 'pending' | 'running' | 'success' | 'failed'

interface ScheduledTask {
  id: string                        // 8 位 hex，自动生成
  name: string                      // 可读名称（用户指定或从 prompt 自动截取前 30 字）
  prompt: string                    // 到期时注入的 message
  kind: TaskKind
  schedule: ScheduleSpec            // once 时 intervalMs = delayMs
  enabled: boolean
  force: boolean                    // true = 即使 agent busy 也 dispatch
  createdAt: number
  nextRunAt: number
  expiresAt?: number                // undefined = 永不过期
  runCount: number
  lastRunAt?: number
  lastStatus?: TaskStatus
  history: ExecutionRecord[]        // 最近 20 条
}

interface ExecutionRecord {
  at: number
  status: TaskStatus
  snippet?: string                  // agent 回复前 100 字
}

// ── 持久化 ──

interface SchedulerStore {
  version: 1
  tasks: ScheduledTask[]
}
```

## 4. Tool 设计

### 4.1 两个 Tool

| Tool | 职责 | Action 数 | LLM 调用频率 |
|------|------|----------|-------------|
| `schedule` | 创建任务 | 无（tool 名即 action） | ★★★★★ |
| `schedule_control` | 管理任务 | 4（list/toggle/delete/run） | ★★★ |

**设计理由**：
- 创建是最高频操作，`schedule({ prompt, schedule })` 比 `schedule({ action: "add", prompt, schedule })` 少一次 LLM 决策
- 管理操作参数少且同质（都需要 id），合并为一个 tool
- 命名与 `goal_control` 一致

### 4.2 Tool: schedule

创建定时任务。一次性提醒或循环任务都通过此 tool 创建。

```typescript
import { Type } from '@sinclair/typebox'

const ScheduleParams = Type.Object({
  prompt: Type.String({
    description: 'Message to inject when the task fires.'
  }),
  schedule: Type.String({
    description: 'Schedule spec: duration (5m/2h/1d) for interval, or cron expression (*/10 * * * *).'
  }),
  kind: Type.Optional(StringEnum(['once', 'recurring'], {
    description: 'Task kind. Default: recurring. Use once for one-time reminders.'
  })),
  name: Type.Optional(Type.String({
    description: 'Human-readable task name. Auto-generated from prompt if omitted.'
  })),
  expires: Type.Optional(Type.String({
    description: 'Expiry duration (30m/2h/7d). Default: 7d for recurring. Pass "never" to disable.'
  })),
  force: Type.Optional(Type.Boolean({
    description: 'Dispatch even when agent is busy. Default: false (wait for idle).'
  })),
})
```

**schedule 参数统一解析**：

| 输入 | 解析结果 |
|------|---------|
| `"5m"` | `{ mode: 'interval', intervalMs: 300000 }` |
| `"2h"` | `{ mode: 'interval', intervalMs: 7200000 }` |
| `"1d"` | `{ mode: 'interval', intervalMs: 86400000 }` |
| `"*/10 * * * *"` | `{ mode: 'cron', cronExpression: '0 */10 * * * *' }`（自动补秒字段） |
| `"0 9 * * 1-5"` | `{ mode: 'cron', cronExpression: '0 0 9 * * 1-5' }` |

不含空格 → 尝试 duration 解析。含空格 → 尝试 cron 解析。

**promptGuidelines**：

```typescript
const scheduleGuidelines = [
  'This tool creates a scheduled task. Use it when the user wants a reminder or recurring check.',
  'Schedule accepts duration (5m, 2h, 1d) for interval-based or cron expression for time-based.',
  'Default kind is recurring. Set kind="once" for one-time reminders (e.g. "remind me in 30m").',
  'After creation, the response includes task id and next 5 run times.',
  'Default expiry is 7 days. Use expires="never" for long-term tasks.',
  'Use force=true only when the task must fire even during active agent work.',
]
```

**调用示例**：

```json
// 每 5 分钟检查 build
{ "prompt": "check build status and report errors", "schedule": "5m" }

// 30 分钟后提醒（一次性）
{ "prompt": "check deployment status", "schedule": "30m", "kind": "once" }

// 工作日 9 点 standup
{ "prompt": "run standup summary", "schedule": "0 9 * * 1-5" }

// 带名称和自定义过期
{ "prompt": "check CI", "schedule": "10m", "name": "ci-watch", "expires": "3d" }

// 永不过期 + 强制 dispatch
{ "prompt": "sync data", "schedule": "1h", "expires": "never", "force": true }
```

### 4.3 Tool: schedule_control

管理已有的定时任务：列表、启用/禁用、删除、立即执行。

```typescript
const ScheduleControlParams = Type.Object({
  action: StringEnum(['list', 'toggle', 'delete', 'run']),
  id: Type.Optional(Type.String({
    description: 'Task id. Required for toggle/delete/run. Get from list action.'
  })),
  enabled: Type.Optional(Type.Boolean({
    description: 'Target enabled state. Required for toggle.'
  })),
})
```

**Action 详解**：

| Action | Required | 说明 |
|--------|----------|------|
| `list` | (none) | 返回所有任务的 id、name、schedule、nextRunAt、enabled 状态 |
| `toggle` | id, enabled | 启用或禁用任务。`enabled=false` 暂停，`enabled=true` 恢复 |
| `delete` | id | 永久删除任务 |
| `run` | id | 立即执行一次（不改变 schedule） |

**promptGuidelines**：

```typescript
const controlGuidelines = [
  'Use action="list" to see all scheduled tasks (no params needed).',
  'After listing, use the returned id for toggle/delete/run.',
  'Prefer toggle(enabled=false) over delete for temporary pauses.',
  'action="run" fires the task immediately without changing its schedule.',
]
```

## 5. Command 设计

### 5.1 唯一命令 /schedule

不设别名。`/schedule` 是唯一的 command 入口。

```
/schedule                                  # 打开 TUI 管理器
/schedule <schedule> <prompt>              # 创建任务（隐含 add）
/schedule once <duration> <prompt>         # 创建一次性任务
/schedule cron '<expr>' <prompt>           # 创建 cron 任务
/schedule list                             # 列出所有
/schedule on <id>                          # 启用
/schedule off <id>                         # 禁用
/schedule rm <id>                          # 删除
/schedule run <id>                         # 立即执行
```

### 5.2 隐含 add 逻辑

`/schedule` 后第一个参数如果不是 `list/on/off/rm/run`，则走创建分支：

```
/schedule 5m check build
  → 第一个参数 "5m" 不是子命令关键词
  → parseSchedule("5m") 成功
  → 创建任务，剩余 "check build" 作为 prompt

/schedule list
  → "list" 匹配子命令
  → 走 list 分支
```

消歧规则（按顺序匹配）：
1. 无参数 → TUI 管理器
2. 第一个参数是 `list` → 列表
3. 第一个参数是 `on` → 启用
4. 第一个参数是 `off` → 禁用
5. 第一个参数是 `rm` → 删除
6. 第一个参数是 `run` → 立即执行
7. 第一个参数是 `once` → 创建一次性（kind=once）
8. 第一个参数是 `cron` → 创建 cron 任务
9. 其他 → 尝试 parseSchedule，成功则创建，失败则报 usage

### 5.3 Command 实现

```typescript
pi.registerCommand('schedule', {
  description: 'Manage scheduled tasks. No args opens TUI. /schedule <schedule> <prompt> to create.',
  getArgumentCompletions(prefix) {
    const trimmed = prefix.trimStart()
    const parts = trimmed.split(/\s+/).filter(Boolean)
    if (parts.length <= 1) {
      return [
        { label: 'list', value: 'list', description: 'Show all scheduled tasks' },
        { label: 'on', value: 'on ', description: 'Enable a task' },
        { label: 'off', value: 'off ', description: 'Disable a task' },
        { label: 'rm', value: 'rm ', description: 'Delete a task' },
        { label: 'run', value: 'run ', description: 'Run a task now' },
        { label: 'once', value: 'once ', description: 'Create a one-time reminder' },
        { label: 'cron', value: "cron '", description: 'Create a cron-based task' },
      ].filter(opt => opt.label.startsWith(trimmed.toLowerCase()))
    }
    // on/off/rm/run 后补全任务 id
    if (['on', 'off', 'rm', 'run'].includes(parts[0])) {
      return runtime.getSortedTasks().map(t => ({
        label: t.id,
        value: t.id,
        description: `${t.name} · ${formatSchedule(t.schedule)}`
      }))
    }
    return null
  },
  handler: async (args, ctx) => { /* ... */ }
})
```

## 6. 运行时设计

### 6.1 SchedulerRuntime 核心方法

```typescript
class SchedulerRuntime {
  // ── 任务 CRUD ──
  addTask(prompt: string, schedule: ScheduleSpec, options: AddOptions): ScheduledTask
  listTasks(): ScheduledTask[]
  toggleTask(id: string, enabled: boolean): boolean
  deleteTask(id: string): boolean
  runTaskNow(id: string): boolean

  // ── 调度 ──
  startScheduler(): void
  stopScheduler(): void
  tickScheduler(): Promise<void>

  // ── dispatch ──
  dispatchTask(task: ScheduledTask): void

  // ── 持久化 ──
  loadTasks(): void
  persistTasks(): void       // debounced 2s
  persistTasksSync(): void   // 同步（session_shutdown 时用）

  // ── TUI ──
  openTaskManager(ctx: ExtensionContext): void
  updateStatusWidget(): void
}
```

### 6.2 Dispatch 流程

```typescript
dispatchTask(task: ScheduledTask) {
  // 1. 检查 enabled
  if (!task.enabled) return

  // 2. 检查 force 或 idle
  if (!task.force) {
    if (!this.ctx.isIdle() || this.ctx.hasPendingMessages()) {
      task.pending = true  // 延迟到下次 tick
      return
    }
  }

  // 3. 检查速率限制（6 次/分钟）
  if (!this.hasDispatchCapacity(Date.now())) return

  // 4. 注入 message
  this.pi.sendMessage(
    { content: task.prompt, customType: 'pi-scheduler:dispatched', display: true },
    { deliverAs: 'followUp', triggerTurn: true }
  )

  // 5. 更新状态
  task.runCount++
  task.lastRunAt = Date.now()
  task.lastStatus = 'success'
  task.pending = false
  task.history.push({ at: Date.now(), status: 'success' })
  if (task.history.length > 20) task.history.shift()

  // 6. 计算下次执行
  if (task.kind === 'once') {
    this.tasks.delete(task.id)
  } else {
    task.nextRunAt = computeNextRun(task.schedule)
  }

  this.persistTasks()
}
```

### 6.3 Force 参数行为

| force | agent idle | 行为 |
|-------|-----------|------|
| false (default) | 是 | 立即 dispatch |
| false | 否 | 延迟到 idle 后 dispatch |
| true | 是 | 立即 dispatch |
| true | 否 | 立即 dispatch（可能打断当前操作） |

### 6.4 Tick 逻辑

```typescript
async tickScheduler() {
  const now = Date.now()

  // 1. 过期清理
  for (const [id, task] of this.tasks) {
    if (task.expiresAt && now >= task.expiresAt) {
      this.tasks.delete(id)
    }
  }

  // 2. 标记到期
  for (const task of this.tasks.values()) {
    if (task.enabled && !task.pending && now >= task.nextRunAt) {
      task.pending = true
    }
  }

  // 3. dispatch pending 任务（按 nextRunAt 排序，最早的先 dispatch）
  const pending = [...this.tasks.values()]
    .filter(t => t.pending)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)

  for (const task of pending) {
    if (task.pending) {  // dispatchTask 可能清除 pending
      this.dispatchTask(task)
    }
  }

  this.updateStatusWidget()
}
```

### 6.5 过期策略

| 参数 | 默认值 | 上限 | 说明 |
|------|--------|------|------|
| expires | `7d` | `7d` | recurring 任务自动过期 |
| `expires: "never"` | — | — | 永不过期，需手动删除 |
| `kind: "once"` | — | — | 执行后自动删除，不走 expires |

## 7. TUI 设计

### 7.1 Status Bar Widget

```
⏰ 3 scheduled · check-build in 4m · 1 overdue
```

渲染优先级：overdue 红色提示 > 最近到期任务名+倒计时 > 任务计数。

```typescript
function renderSchedulerWidget(theme: Theme, tasks: ScheduledTask[]): string[] {
  if (tasks.length === 0) return []

  const now = Date.now()
  const enabled = tasks.filter(t => t.enabled)
  const overdue = enabled.filter(t => t.nextRunAt <= now)
  const upcoming = enabled
    .filter(t => t.nextRunAt > now)
    .sort((a, b) => a.nextRunAt - b.nextRunAt)

  const parts: string[] = []
  parts.push(`${enabled.length} scheduled`)

  if (upcoming.length > 0) {
    const next = upcoming[0]
    parts.push(`${truncate(next.name, 20)} ${formatRelativeTime(next.nextRunAt)}`)
  }

  if (overdue.length > 0) {
    parts.push(theme.fg('error', `${overdue.length} overdue`))
  }

  return [`${theme.fg('accent', '⏰')} ${parts.join(' · ')}`]
}
```

### 7.2 TUI Task Manager

`/schedule` 无参数时打开。单层列表 + 底部快捷键：

```
┌─ Scheduled Tasks ──────────────────────────────────────┐
│                                                         │
│  ● check-build    every 5m    next 14:35 (4m)          │
│  ● standup        cron 0 9   next 09:00 (18h)         │
│  ○ deploy-check   once       due now!                  │
│  ● ci-monitor     every 10m  next 14:41 (10m)         │
│                                                         │
│  ↑↓ navigate · [d]elete · [t]oggle · [r]un · [q]uit   │
└─────────────────────────────────────────────────────────┘
```

按 Enter 展开详情：

```
┌─ check-build ──────────────────────────────────────────┐
│  Schedule:  every 5m                                    │
│  Force:     no                                          │
│  Created:   2026-07-27 14:31                            │
│  Expires:   2026-08-03 14:31                            │
│  Runs:      47 · last: 14:31 (success)                  │
│  Prompt:    check build status and report errors        │
│                                                         │
│  History (last 5):                                      │
│    14:31 ✓  14:26 ✓  14:21 ✓  14:16 ✗  14:11 ✓        │
│                                                         │
│  [t]oggle · [r]un now · [f]orce toggle · [b]ack       │
└─────────────────────────────────────────────────────────┘
```

### 7.3 与 oh-pi TUI 对比

| oh-pi | 新设计 |
|-------|--------|
| 嵌套 select（选 task → 选 action → 确认），3 步 | 单层列表 + 快捷键，1 步 |
| 无执行历史 | 显示最近 5 次 ✓/✗ |
| 无到期状态颜色 | overdue 红色，即将到期黄色 |
| 无内联编辑 | 按 Enter 展开详情 |

## 8. xyz-agent GUI 协议集成

### 8.1 三个渲染通道

| 通道 | 用途 | 实现 |
|------|------|------|
| Tool Result `__gui__` | tool 返回的结构化渲染 | `details.__gui__` 嵌入 GuiComponent |
| Widget | 实时状态推送 | `guiSetWidget(ctx, 'scheduler', ...)` |
| Message Renderer | dispatch 时的特殊消息 | `pi.registerMessageRenderer('pi-scheduler:dispatched', ...)` |

### 8.2 通道 1：Tool Result

**schedule (add) 成功返回**：

```typescript
const gui = guiResult(guiComponent('card', {
  variant: 'success',
  header: '⏰ Task Scheduled',
  body: [
    guiComponent('stats-line', {
      items: [
        { label: 'Name', value: task.name },
        { label: 'Schedule', value: formatSchedule(task.schedule) },
        { label: 'Kind', value: task.kind },
        { label: 'Next', value: formatRelativeTime(task.nextRunAt) },
        { label: 'Expires', value: task.expiresAt ? formatRelativeTime(task.expiresAt) : 'never' },
        { label: 'Force', value: task.force ? 'yes' : 'no' }
      ]
    }),
    guiComponent('list-tree', {
      items: [
        { label: 'Upcoming runs:', depth: 0 },
        ...nextRuns.map(t => ({
          label: new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          depth: 1,
          icon: 'dot' as const
        }))
      ]
    })
  ]
}))

return {
  content: [{ type: 'text', text: summaryText }],
  details: { task, __gui__: gui }
}
```

**schedule_control (list) 返回**：

```typescript
const gui = guiResult(guiComponent('card', {
  header: `⏰ ${tasks.length} Scheduled Tasks`,
  body: [
    guiComponent('list-tree', {
      items: tasks.map(task => ({
        label: `${task.name} · ${formatSchedule(task.schedule)} · ${formatRelativeTime(task.nextRunAt)}`,
        status: task.enabled ? 'running' : 'done',
        icon: task.enabled ? 'dot' : 'pause'
      }))
    })
  ]
}))
```

### 8.3 通道 2：Widget

```typescript
import { guiSetWidget, guiComponent, isGuiCapable } from '@xyz-agent/extension-protocol'

function syncWidget(ctx: ExtensionContext, tasks: ScheduledTask[]) {
  if (isGuiCapable(ctx)) {
    guiSetWidget(ctx, 'scheduler', guiComponent('stats-line', {
      items: buildStatusItems(tasks)
    }))
  } else {
    ctx.ui.setWidget('scheduler', (tui, theme) => ({
      dispose() {},
      invalidate() {},
      render(width) {
        return renderSchedulerWidget(theme, tasks)
          .map(line => truncateToWidth(line, width))
      }
    }))
  }
}
```

### 8.4 通道 3：Message Renderer

```typescript
pi.registerMessageRenderer('pi-scheduler:dispatched', (message, { expanded }, theme) => {
  const details = message.details as DispatchDetails
  const lines = [
    theme.fg('accent', theme.bold('⏰ Scheduled task fired')),
    `${theme.fg('muted', 'Task')}: ${details.taskId} · ${details.taskName}`,
    `${theme.fg('muted', 'Run')}: #${details.runCount}`,
    '',
    message.content as string
  ]
  return new Text(lines.join('\n'), 0, 0)
})
```

## 9. 持久化

### 9.1 存储路径

```typescript
import { getAgentDir } from '@mariozechner/pi-coding-agent'
import * as path from 'node:path'

function getStorePath(cwd: string): string {
  const resolved = path.resolve(cwd)
  const parsed = path.parse(resolved)
  const segments = resolved.slice(parsed.root.length)
    .split(path.sep).filter(Boolean)
  const root = parsed.root
    .replaceAll(/[^a-zA-Z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .toLowerCase() || 'root'
  return path.join(getAgentDir(), 'scheduler', root, ...segments, 'scheduler.json')
}
```

路径格式：`~/.pi/agent/scheduler/<root>/<segments>/scheduler.json`

### 9.2 策略

| 场景 | 策略 |
|------|------|
| 常规写入 | debounced 2 秒 |
| session_shutdown | 同步写入（persistTasksSync） |
| 启动 / session_start | 读取 JSON → 加载到内存 |
| GC | 写入时清理 history > 20 条 + 过期任务 |
| 文件损坏 | catch → 空 store + notify 用户 |
| 版本迁移 | version 字段，缺失字段给默认值 |

## 10. Parsing 模块

纯函数，零副作用。

### 10.1 Cron

```typescript
import { Cron } from 'croner'

function normalizeCronExpression(input: string): { expression: string; note?: string } | undefined
function computeNextCronRunAt(expression: string, from?: number): number | undefined
function computeNextCronRuns(expression: string, from?: number, count?: number): number[]
```

5 字段 cron 自动补 `seconds=0` 前缀。

### 10.2 Duration

```typescript
function parseDuration(text: string): number | undefined   // '5m' → 300000
function formatDuration(ms: number): string                 // 300000 → '5m'
```

支持：`5s` / `5m` / `2h` / `1d` / `30seconds` / `2hours` 等。

### 10.3 统一解析

```typescript
interface ParseScheduleResult {
  spec: ScheduleSpec
  note?: string
}

function parseSchedule(input: string, kind: TaskKind): ParseScheduleResult | undefined {
  // 1. 不含空格 → 尝试 duration → interval mode
  // 2. 含空格 → 尝试 cron → cron mode
  // 3. 都失败 → undefined
}
```

### 10.4 Next Runs 预览

```typescript
function computeNextRuns(spec: ScheduleSpec, from?: number, count?: number): number[] {
  if (spec.mode === 'cron') return computeNextCronRuns(spec.cronExpression, from, count)
  return Array.from({ length: count }, (_, i) => (from ?? Date.now()) + spec.intervalMs * (i + 1))
}
```

## 11. 事件生命周期

```typescript
pi.on('session_start', (_event, ctx) => {
  runtime.setContext(ctx)
  runtime.loadTasks()
  runtime.startScheduler()
  syncWidget(ctx, runtime.getSortedTasks())
})

pi.on('agent_end', (event) => {
  runtime.handleAgentEnd(event)
})

pi.on('session_shutdown', () => {
  runtime.persistTasksSync()
  runtime.stopScheduler()
})
```

## 12. 错误处理

| 场景 | Tool 返回 | 行为 |
|------|----------|------|
| cron 表达式无效 | isError + 示例 | 不创建任务 |
| schedule 无法解析 | isError + "Use duration (5m/2h) or cron" | 不创建任务 |
| id 不存在 | isError + "Use list to see tasks" | 不操作 |
| 任务数超限（50） | isError + "Delete a task first" | 不创建任务 |
| 持久化文件损坏 | — | 空 store + notify 用户 |
| dispatch 时 session 关闭 | — | catch + task.pending = true |
| croner 未加载 | — | 降级 interval-only + notify |

## 13. 测试策略

| 模块 | 类型 | 关键 case |
|------|------|----------|
| parsing.ts | 单元 | cron 解析/边界/无效、duration 解析、parseSchedule、computeNextRuns |
| format.ts | 单元 | 时间格式化、schedule 描述、相对时间 |
| store.ts | 单元 | 读写 roundtrip、损坏文件降级、GC、版本迁移 |
| runtime.ts | 集成 | add→tick→dispatch 全流程、toggle、delete、过期、force |
| tool.ts | 集成 | schedule / schedule_control 各 action 参数校验 + 错误路径 |

## 14. UX 方法论参考

| 原则 | 来源 | 在本设计中的应用 |
|------|------|-----------------|
| 反馈循环 | Norman, The Design of Everyday Things | 创建后返回 next 5 次执行时间 |
| 可见性 | Nielsen, 10 Heuristics | status bar 始终显示任务状态 |
| 渐进式披露 | — | 简单场景 3 参数搞定（prompt + schedule + kind 可选） |
| 错误预防 | Nielsen | cron 创建前校验 + 预览 |
| 可撤销性 | — | toggle 代替 delete |
| 一致性 | — | `schedule` + `schedule_control` 命名与 `goal_control` 一致 |
| 效率 | Fitts' Law | TUI 快捷键 1 步操作 vs oh-pi 的 3 步嵌套 |
| 最小惊讶 | — | `/schedule 5m check build` 直接创建，无需 `add` |

---

## 实现偏差说明

本节记录实现与 spec 描述（上文）的偏差。按 code-review skill §2 MANDATORY 要求记录。

### D1: TUI Task Manager（§7.2）— deferred

**spec 描述**：`/schedule` 无参数打开 TUI 任务管理器（单层列表 + 快捷键）。
**实现现状**：commands.ts:49 返回 "TUI manager not yet implemented. Use /schedule list to see tasks."
**决策**：W5 阶段未实现，defer 到下个迭代。当前用 `/schedule list` + `schedule_control` tool 替代核心交互。
**影响**：用户无法在 TUI 内直接 toggle/delete，需通过 command 或 tool。

### D2: xyz-agent GUI 集成（§8）— deferred

**spec 描述**：三个 GUI 渲染通道——Tool Result `__gui__` 字段（card/stats-line/list-tree）、GUI Widget 双通道（guiSetWidget vs TUI setWidget）、Message Renderer（pi-scheduler:dispatched）。
**实现现状**：
- gui.ts 已删除（原为死代码，且依赖 AGENTS.md 已 DEPRECATED 的 `__gui__` 协议）
- index.ts 只实现 TUI widget 通道（ctx.ui.setWidget string[] 重载），无 isGuiCapable/guiSetWidget 分支
- 未调用 pi.registerMessageRenderer
**决策**：W5 阶段聚焦调度引擎核心（parsing/store/runtime/tool/command），GUI 集成 defer 到 xyz-agent 侧需求明确后。AGENTS.md 已标 `_render`/`__gui__` 协议 DEPRECATED，新实现应等替代方案。
**影响**：xyz-agent GUI 下无结构化卡片渲染，fallback 到 content 文本。

### D3: agent_end 事件（§11）— deferred

**spec 描述**：`pi.on('agent_end', ...)` 调 runtime.handleAgentEnd，用于回填 dispatch 后 agent 的真实执行结果（success/failed）。
**实现现状**：index.ts 只注册 session_start / session_shutdown。runtime 无 handleAgentEnd 方法。dispatch 后无条件标 lastStatus='success'（sendMessage fire-and-forget，无法同步得知 agent 结果）。
**决策**：defer。当前 success 仅表示"消息已注入 session"，不代表 agent 执行成功。后续若需精确状态追踪，需在 agent_end 回填。
**影响**：history 中 status 全为 success，无法区分 agent 执行失败的任务。

### D4: widget 主题着色（§7.1）— simplified

**spec 描述**：renderSchedulerWidget(theme, tasks)，overdue 用 theme.fg('error',...) 红色，⏰ 用 theme.fg('accent',...)。
**实现现状**：widget.ts 用 SDK setWidget 第一重载（string[]），无 theme 参数。overdue 标记用纯文本 `[!]`。
**决策**：string[] 重载不提供 theme。若需着色，需切到 SDK 第二重载（Component factory），复杂度高，defer。
**影响**：overdue 任务无红色高亮，仅文本标记。

### D5: command cron 表达式解析（§5.1 / §5.2）— 已修复

**spec 描述**：`/schedule cron '<expr>' <prompt>` 创建 cron 任务，引号包裹的 cron 表达式作为单一 schedule 参数。
**原始 bug**：commands.ts:53 用 `trimmed.split(/\s+/)` 切分整行，不做 shell-style quote 解析。`scheduleInput = parts[scheduleStart]` 只取第二个 token，cron 表达式含空格会被切碎。
**修复**：引入 `tokenizeQuoted()` 函数，支持单引号/双引号包裹含空格的 token。handler 改用 `tokenizeQuoted(trimmed)` 替代 `trimmed.split(/\s+/)`。
- `cron '*/10 * * * *' prompt` → `['cron', '*/10 * * * *', 'prompt']` → 创建成功
- `cron "0 9 * * 1-5" standup` → `['cron', '0 9 * * 1-5', 'standup']` → 创建成功
- `cron */10 * * * * prompt`（不带引号）→ 仍然失败（无法区分 cron 字段和 prompt），用户需加引号或使用 schedule tool
**已知限制**：未加引号的多 token cron 表达式仍不可用，需用户显式引号包裹或使用 schedule tool（JSON 参数无歧义）。
