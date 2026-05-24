# xyz-pi-extensions

## 项目概述

Pi coding agent 的扩展工具箱。每个扩展是一个独立可安装的 Pi 插件，解决 AI coding agent 工作流中的特定问题。当前包含：

- **goal/** — 持久化目标驱动自主循环，7 态状态机，evidence-based 完成和 token/时间预算
- **todo/** — 轻量三态任务清单（pending/in_progress/completed），`/todos` 命令 + `todo` 工具
- **subagent/** — 任务委派与并行执行，支持 single/parallel/chain/background 四种模式

扩展通过 symlink 安装到 `~/.pi/agent/extensions/<name>` → 源目录。

## 文档索引

- [CONTEXT.md](./CONTEXT.md) — 领域术语表（Pi 平台概念 + 本项目概念 + 歧义标记）
- [docs/adr/](./docs/adr/) — 架构决策记录
  - [001-subagent-architecture.md](./docs/adr/001-subagent-architecture.md) — Subagent 进程隔离、上下文传递、background 模式、能力边界、模型选择
  - [002-goal-7-state-machine.md](./docs/adr/002-goal-7-state-machine.md) — Goal 为什么有 7 种状态（time_limited + cancelled），以及为什么没有 usage_limited
  - [003-evidence-based-completion.md](./docs/adr/003-evidence-based-completion.md) — Goal 为什么强制任务分解 + evidence，以及代价

## 技术栈

- TypeScript（Pi 运行时执行，不独立编译）
- Pi Extension API（`@mariozechner/pi-coding-agent`）
- typebox（参数 schema 定义）
- pi-tui（终端 UI 组件：Text, Container, Spacer, Markdown 等）
- pi-ai（StringEnum 等工具）

**依赖说明**：扩展没有自己的 `node_modules`，所有 `@mariozechner/*` 和 `typebox` 依赖由 Pi 运行时提供。本地开发时 `tsc --noEmit` 通过 `paths` 映射到全局安装的 Pi 包获取类型。

## 架构

```
<extension>/
  index.ts           # 入口，re-export src/index.ts
  package.json       # name + main
  src/
    index.ts         # 扩展工厂函数（export default），注册 tool + command + events
    state.ts         # 数据模型 + 状态机（如果需要）
    templates.ts     # Steering prompt 模板（如果需要）
    widget.ts        # TUI 渲染逻辑（如果需要）
    commands.ts      # 命令参数解析（如果需要）
```

**职责划分原则**：
- `index.ts`（工厂）只做注册胶水，不含业务逻辑
- 状态管理独立为 `state.ts`
- 渲染逻辑独立为 `widget.ts` 或内联 `render*` 函数
- 每个 `pi.on()` 事件处理器保持简短，复杂逻辑提取到命名函数

## 常用命令

```bash
# 类型检查（需要全局安装了 pi）
cd xyz-pi-extensions && npx tsc --noEmit

# 单个扩展类型检查
cd xyz-pi-extensions/goal && npx tsc --noEmit
```

## 关键约束

### 运行环境

- 扩展在 Pi 进程内执行，**不是独立进程**
- 同一进程可能有多个 session。模块级 `let` 变量会被所有 session 共享，必须用闭包或 session_start 重建
- 扩展不能依赖 fs 之外的 Node.js 原生模块（网络、child_process 等由 Pi 核心控制）。**subagent 是已知例外**——它使用 `child_process.spawn` 启动独立 Pi 进程

### Session 隔离

- 状态必须存储在 `session_start` 重建的闭包变量或 `ctx.sessionManager` entries 中
- `todo` 扩展的 `let todos` 是已知的违反——当前单 session 使用不会有问题，但多 session 时需要重构为闭包内状态

### 状态持久化

- 用 `pi.appendEntry(type, data)` 写入，`ctx.sessionManager.getEntries()` 读取
- 自行实现 GC（splice 旧 entries），防止长 session 中 entries 无限积累
- `deserializeState` 必须向后兼容旧格式（字段缺失时给默认值）

### Tool 设计

- 参数用 typebox `Type.Object()` + `StringEnum()` 定义 schema
- `execute` 返回 `{ content: [...], details: {...} }` 结构
- `details` 是 renderResult 的数据来源，不要依赖 content 文本解析
- 错误用 `throw new Error()`，不要返回 `{ content: [{ text: "错误: ..." }] }` 的错误成功模式

### TUI 渲染

- `renderCall` 和 `renderResult` 返回 `new Text(string, 0, 0)`
- 颜色通过 `theme.fg("token", text)` 使用语义 token，不硬编码 ANSI
- 展开/折叠：`options.expanded` 控制显示详细程度

### GUI 渲染描述符（`_render` 协议）

#### 协议概述

扩展的 `execute()` 返回 `{ content: [...], details: {...} }` 结构。`details` 中的数据面向 TUI 的 `renderResult` 消费。为了让 xyz-agent（Electron + Vue 3 GUI）能以最小代价渲染扩展输出，在 `details` 中增加可选的 `_render` 字段，作为 GUI 渲染的声明式描述符。

**核心思想**：扩展侧不关心 GUI 如何渲染，只声明「我产出了什么类型的数据，数据是什么」。GUI 侧根据 `_render.type` 选择对应的 Vue 组件，将 `_render.data` 作为 props 传入。

#### 数据管道

```
┌─────────────────────┐
│  xyz-pi-extensions   │  execute() 返回
│  扩展 (goal/todo/    │  { content, details: { ..., _render } }
│  subagent)           │
└──────────┬──────────┘
           │ Pi 进程内部调用
           ▼
┌─────────────────────┐
│  pi RPC mode        │  tool_execution_end.result
│  (stdout JSON)      │  完整序列化 details（含 _render）
└──────────┬──────────┘
           │ stdout → sidecar
           ▼
┌─────────────────────┐
│  xyz-agent          │  event-adapter 从
│  sidecar (ws)       │  result.details._render 提取
│  event-adapter.ts   │  转发给渲染进程
└──────────┬──────────┘
           │ WebSocket → 前端
           ▼
┌─────────────────────┐
│  xyz-agent          │  根据 _render.type 选择组件
│  渲染进程 (Vue 3)    │  将 _render.data 作为 props
└─────────────────────┘
```

#### 类型定义

```typescript
/** GUI 渲染描述符，嵌入在 details 中 */
interface RenderDescriptor {
  /** 渲染类型，对应 xyz-agent 中的 Vue 组件 */
  type: RenderType;
  /** 传给 Vue 组件的 props 数据 */
  data: RenderDataMap[RenderType];
}

type RenderType = "task-list" | "summary-table" | "progress" | "code-block";

/** 各渲染类型对应的数据结构 */
interface RenderDataMap {
  "task-list": TaskListData;
  "summary-table": SummaryTableData;
  "progress": ProgressData;
  "code-block": CodeBlockData;
}
```

#### 支持的渲染类型

##### `task-list` — 任务/待办列表

适用于：goal 的任务列表、todo 的待办列表、subagent 的并行任务状态。

```typescript
interface TaskListData {
  /** 列表标题 */
  title: string;
  /** 任务项 */
  items: TaskItem[];
  /** 可选的汇总信息 */
  summary?: string;
}

interface TaskItem {
  /** 显示文本 */
  label: string;
  /** 任务状态 */
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  /** 可选的详情/证据 */
  detail?: string;
  /** 可选的子项 */
  children?: TaskItem[];
}
```

##### `summary-table` — 结构化表格

适用于：subagent 的多 agent 结果汇总、任何需要多列对比的场景。

```typescript
interface SummaryTableData {
  /** 表格标题 */
  title: string;
  /** 列定义 */
  columns: TableColumn[];
  /** 数据行 */
  rows: Record<string, unknown>[];
}

interface TableColumn {
  /** 列 key，对应 rows 中的字段名 */
  key: string;
  /** 显示标题 */
  label: string;
  /** 列宽（flex 比例） */
  width?: number;
  /** 值的语义类型，影响渲染样式 */
  valueType?: "text" | "status" | "duration" | "number";
}
```

##### `progress` — 进度指示

适用于：goal 的预算消耗、长时间操作的进度反馈。

```typescript
interface ProgressData {
  /** 进度项标题 */
  label: string;
  /** 当前值 */
  current: number;
  /** 总量 */
  total: number;
  /** 可选的单位 */
  unit?: string;
  /** 可选的子进度项 */
  segments?: ProgressData[];
}
```

##### `code-block` — 代码/结构化文本块

适用于：命令输出、代码片段、日志展示。

```typescript
interface CodeBlockData {
  /** 语言标识（用于语法高亮） */
  language?: string;
  /** 代码内容 */
  content: string;
  /** 可选的标题 */
  title?: string;
}
```

#### 扩展侧改动示例

扩展只需在 `details` 中添加 `_render` 字段。**不改变现有 `details` 结构**，`_render` 是增量字段，TUI 渲染不受影响。

```typescript
// goal/src/index.ts — makeGoalResult 中添加 _render
function makeGoalResult(session: GoalSession, text: string) {
  const state = session.state!;
  // ... 现有逻辑不变 ...
  return {
    content: [{ type: "text" as const, text: text + suffix }],
    details: {
      action: "update",
      tasks: state.tasks.map((t) => ({ ...t })),
      goalId: state.goalId,
      status: state.status,
      // ↓ 新增：GUI 渲染描述符
      _render: {
        type: "task-list",
        data: {
          title: state.objective,
          items: state.tasks.map((t) => ({
            label: t.description,
            status: t.status,
            detail: t.evidence,
            children: t.subTodos?.map((s) => ({
              label: s.text,
              status: s.status,
            })),
          })),
        },
      },
    } satisfies GoalManagerDetails,
  };
}
```

Details 接口更新：在现有 interface 中追加可选字段：

```typescript
interface GoalManagerDetails {
  action: string;
  tasks: GoalTask[];
  goalId: string;
  status: string;
  _render?: RenderDescriptor; // 新增，可选
}
```

#### xyz-agent 侧改动说明

xyz-agent 的 event-adapter 需要两个改动点：

1. **提取 `_render`**：在 `tool_execution_end` 事件处理中，从 `result.details._render` 提取描述符，附加到转发给渲染进程的消息中。当前 event-adapter 丢弃了 details，需要保留 `_render` 字段。

2. **渲染组件映射**：在 Vue 渲染进程中，根据 `_render.type` 选择对应的 Vue 组件。可以是一个简单的 `<RenderDescriptorSwitch>` 组件：

```vue
<!-- 伪代码，展示选择逻辑 -->
<template>
  <TaskListWidget v-if="descriptor.type === 'task-list'" :data="descriptor.data" />
  <SummaryTableWidget v-else-if="descriptor.type === 'summary-table'" :data="descriptor.data" />
  <ProgressWidget v-else-if="descriptor.type === 'progress'" :data="descriptor.data" />
  <CodeBlockWidget v-else-if="descriptor.type === 'code-block'" :data="descriptor.data" />
  <!-- fallback: 显示 content 文本 -->
  <MarkdownText v-else :text="fallbackText" />
</template>
```

GUI 组件（`TaskListWidget` 等）是 xyz-agent 的工作，扩展侧不需要关心组件实现。

#### 设计原则

1. **增量字段**：`_render` 是 `details` 中的可选字段。缺失时 GUI fallback 到 `content` 文本渲染。TUI 渲染完全不受影响（TUI 的 `renderResult` 不读取 `_render`）。

2. **声明式**：扩展声明「我产出什么」，不声明「怎么显示」。渲染决策在 GUI 侧。扩展不输出颜色、布局、间距等 UI 指令。

3. **类型驱动**：`RenderType` 是有限枚举，不支持扩展自定义类型。新增渲染类型需要在本协议中定义，xyz-agent 同步实现对应组件。这避免了 GUI 侧运行时动态解析的复杂性。

4. **数据冗余可接受**：`_render.data` 中的数据可能与 `details` 中的其他字段有重叠（如 `tasks` 和 `_render.data.items`）。这是有意为之——`details` 面向 TUI，`_render` 面向 GUI，两者的数据消费模式不同，冗余换来的是解耦。

5. **下划线前缀**：`_render` 使用下划线前缀，明确标记这是元协议字段，不属于扩展的业务 `details` 数据。降低命名冲突风险。

6. **向后兼容**：旧版 xyz-agent 不识别 `_render` 字段会忽略它。旧版扩展不输出 `_render` 字段时，xyz-agent 使用 `content` 文本 fallback。两端都可以独立升级。

## 代码规范

### TypeScript

- 禁止 `any`，用 `unknown` 或具体类型
- `(entry as any).customType` 这种模式改为类型守卫函数
- import 顺序：Node 内置 → npm 包 → 项目内部

### 行数

- 单文件不超过 1000 行。超过时按职责拆分到 `src/` 下
- 函数不超过 80 行

### 命名

- 扩展入口：`export default function xxxExtension(pi: ExtensionAPI)`
- 状态接口：`XxxRuntimeState`
- 工具参数：`XxxParams`（typebox schema）
- 工具详情：`XxxDetails`（renderResult 数据）

### Git

- 分支命名：`feat/`、`fix/`、`refactor/`、`chore/`
- Commit 信息：英文

## 质量检查

```bash
# 类型检查
npm run typecheck
# 或 npx tsc --noEmit

# ESLint 品味检查（0 error 为通过）
npm run lint

# 自动修复
npm run lint:fix

# 跳过 pre-commit hook
SKIP_LINT=1 git commit -m "..."

# 手动验证（启动 Pi 后）
/goal Fix the typo in README --tokens 10000
/todos
```

### 品味规则（taste-lint）

项目使用自定义 ESLint 插件 `taste-lint`，复用自 llm-simple-router 项目的通用规则：

- `no-explicit-any: error` — 类型即契约
- `prefer-allsettled` — 独立数据源用 `Promise.allSettled`
- `no-silent-catch` — catch 块不能为空或只有 console
- `no-unbounded-while-true` — while(true) 必须有迭代上限
- `no-inline-import-type` — 禁止 `as import(...).Type`
- `max-lines: 1000` / `max-lines-per-function: 300` — 结构先于一切
- `no-magic-numbers` — 语义化命名（0/1/-1 豁免）

规则源文件：`taste-lint/base.mjs` + `taste-lint/rules/`

## 安装新扩展

```bash
# 全局安装
ln -s /path/to/xyz-pi-extensions/<name> ~/.pi/agent/extensions/<name>

# 项目级安装
ln -s /path/to/xyz-pi-extensions/<name> .pi/extensions/<name>
```
