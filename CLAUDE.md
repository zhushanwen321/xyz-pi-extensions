# xyz-pi-extensions

## 项目概述

Pi coding agent 的扩展工具箱 monorepo。每个 extension 是独立可发布的 npm 包（`@zhushanwen/pi-*`），解决 AI coding agent 工作流中的特定问题。

### Monorepo 架构

```
xyz-pi-extensions/
├── extensions/                  # Pi 扩展（可发布的 npm 包，@zhushanwen/pi-*）
│   ├── goal/                → @zhushanwen/pi-goal
│   ├── todo/                → @zhushanwen/pi-todo
│   ├── vision/             → @zhushanwen/pi-vision
│   ├── coding-workflow/     → @zhushanwen/pi-coding-workflow (含 ~20 个 harness skills)
│   ├── claude-rules-loader/ → @zhushanwen/pi-claude-rules-loader
│   ├── context-engineering/ → @zhushanwen/pi-context-engineering
│   ├── evolve-daily/        → @zhushanwen/pi-evolve-daily (含 evolve skills + tracker 框架)
│   ├── statusline/          → @zhushanwen/pi-statusline
│   ├── structured-output/   → @zhushanwen/pi-structured-output
│   ├── unified-hooks/       → @zhushanwen/pi-unified-hooks
│   ├── workflow/            → @zhushanwen/pi-workflow
│   ├── model-switch/        → @zhushanwen/pi-model-switch
│   ├── turn-timing/         → @zhushanwen/pi-turn-timing
│   └── plan/                → @zhushanwen/pi-plan
├── shared/                      # 内部共享包（private，不独立发布）
│   ├── quota-providers/     → @zhushanwen/pi-quota-providers
│   ├── taste-lint/          → @zhushanwen/pi-taste-lint
│   └── types/               → @zhushanwen/pi-types
├── skills/                      # 独立 skills（无所属 extension，GitHub 分发）
├── scripts/                     # 项目运维脚本（非 gate 类）
├── docs/                        # 统一文档
├── .changeset/                  # 版本管理
├── pnpm-workspace.yaml
├── extension-dependencies.json   # Extension 依赖关系声明
├── extension-dependencies.schema.json
└── package.json
```

**设计原则**：
- `extensions/` = Pi 扩展产品，可发布的 npm 包（`@zhushanwen/pi-*`）
- `shared/` = 内部共享依赖（private 或仅内部引用），不面向终端用户
- Skills 跟着 owner 走：extension-bundled skills 通过 `resources_discover` 自动注册
- 独立 skills 放 `skills/`，它们是 Markdown 资源不是包
- types 是 private 包，仅通过 `workspace:*` 供其他包引用
- coding-workflow 内置 model.ts 用于 resolveModelByComplexity，subagent 功能由 pi-subagents（npm）提供
- Harness 是逻辑概念，不存在叫 "harness" 的物理目录

**目录归属原则**：

| 功能 | 归属目录 | 示例 |
|------|---------|------|
| Pi 扩展（产品） | `extensions/` | goal, todo, vision, statusline |
| 内部共享依赖 | `shared/` | quota-providers, types, taste-lint |
| 独立 skills | `skills/` | vision-analysis, zcommit |
| 共享脚本 | `scripts/` | publish.sh（运维）；gate 脚本见 `.githooks/` |

**硬性约束**：
- npm install 必须能跑：`dependencies` 中的包必须在 npm 上可获取，`workspace:*` publish 时转为具体版本号，`private: true` 的包不能作为依赖
- 一个功能一个位置：禁止同一份代码在 monorepo 里存在两个副本
- **新建 Pi 扩展必须放到 `extensions/` 目录**
- **新增/删除/重命名 extension 后必须同步更新本文件（CLAUDE.md）的目录结构**，防止 AI 因目录信息过时而定位失败

### 社区扩展借鉴

[docs/third-party-extensions/](./docs/third-party-extensions/) — 记录从社区借鉴的扩展。

数据源：`docs/third-party-extensions/extensions.yaml`（source of truth）
Schema：`docs/third-party-extensions/extensions.schema.json`
校验：`python3 .githooks/validate-extensions-yaml`

**操作规范**：每次新增/变更社区扩展（安装、fork、借鉴思路），必须同步更新 `extensions.yaml` 并运行校验脚本。如需深度分析，创建对应的 `analysis.md`。

## 文档索引

### 长期文档（main 分支）

- [docs/research/](./docs/research/) — 调研报告（跨分支共享，存 main 分支）
  - `infinite-context-survey.md` — 通用方案调研（学术论文、开源项目、商业产品）
  - `infinite-context-research-report.md` — 学术论文/产品详细分析
  - `hermes-agent-research.md` — Hermes Agent 记忆/上下文管理调研
  - `openclaw-research.md` — OpenClaw 记忆/上下文管理调研
  - `coding-agents-context-research.md` — Claude Code/Aider/Qwen Code/OpenCode 对比调研
  - `pi-extension-production-guide.md` — 生产级 Pi Extension 开发指南（基于 pi-subagents 等调研）
- [docs/monorepo-conventions.md](./docs/monorepo-conventions.md) — **Monorepo 约定与结构规范**（目录结构、命名、依赖发布规则）
- [docs/quality-gates.md](./docs/quality-gates.md) — **质量门控与 Git Hooks**（pre-commit 检查项、阻断级别、跳过条件）

### 当前分支文档

- [CONTEXT.md](./CONTEXT.md) — 领域术语表（Pi 平台概念 + 本项目概念 + 歧义标记）
- [docs/pi-extension-standards.md](./docs/pi-extension-standards.md) — **Pi Extension 开发规范**（所有新增/修改 extension 前必须阅读）
- [docs/adr/](./docs/adr/) — 架构决策记录（已做出的决策，不可逆）
  - [001-subagent-architecture.md](./docs/adr/001-subagent-architecture.md) — Subagent 进程隔离、上下文传递、background 模式、能力边界、模型选择
  - [002-goal-7-state-machine.md](./docs/adr/002-goal-7-state-machine.md) — Goal 为什么有 7 种状态（time_limited + cancelled），以及为什么没有 usage_limited
  - [003-evidence-based-completion.md](./docs/adr/003-evidence-based-completion.md) — Goal 为什么强制任务分解 + evidence，以及代价
- [docs/evolution/](./docs/evolution/) — 架构演进与 Brainstorming（决策前的思考过程，可迭代）
  - `001-context-compression-redesign.md` — 上下文压缩方案重新设计（基于调研的压缩流水线设计）
- `.xyz-harness/` — xyz-harness 工作流产出物（spec、plan、test cases），按 `<date>-<slug>/` 组织，应纳入版本控制

### 文档规范

| 目录 | 性质 | 格式 | 生命周期 |
|------|------|------|----------|
| `docs/adr/` | 已做出的决策 | `NNN-<topic>.md`，含 Status/Context/Decision/Consequences | 永久 |
| `docs/evolution/` | 决策前的探索 | `NNN-<topic>.md`，标注 draft/active/superseded | 迭代到决策或废弃 |
| `docs/research/` | 外部调研 | `<topic>-research.md` | 长期参考 |
| `.xyz-harness/` | 工作流产出 | 按 `<date>-<slug>/` 组织 | 随分支

## 技术栈

- TypeScript（Pi 运行时执行，不独立编译）
- Pi Extension API（`@mariozechner/pi-coding-agent`）
- typebox（参数 schema 定义）
- pi-tui（终端 UI 组件：Text, Container, Spacer, Markdown 等）
- pi-ai（StringEnum 等工具）
- pnpm workspaces + changesets（monorepo 管理和版本发布）

**依赖说明**：扩展没有自己的 `node_modules`（开发时由 pnpm workspace 管理）。运行时 `@mariozechner/*` 和 `typebox` 依赖由 Pi 运行时提供。本地开发时 `tsc --noEmit` 通过 `paths` 映射到全局安装的 Pi 包获取类型。

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
# 全量类型检查
pnpm -r typecheck

# 单包类型检查
pnpm --filter @zhushanwen/pi-goal typecheck

# 全量 lint
pnpm -r lint

# 单包 lint
pnpm --filter @zhushanwen/pi-goal lint

# 创建版本变更记录
pnpm changeset # 交互式选择受影响的包和版本类型

# 本地执行版本 bump（预览）
pnpm changeset version

# 提交版本变更和 changeset
git add -A
git commit -m "chore: bump versions"
git push

# 发布 — 由 GitHub Actions 自动完成
# ⚠️ 禁止在本地执行 pnpm changeset publish 或 npm publish
# 流程：push tag v* → release.yml 自动触发 pnpm changeset publish
# 新包首次发布需要确保 npm scope 下有权限（NPM_TOKEN secret 已配置）
pnpm changeset publish --dry-run  # 仅预览，不实际发布

# 校验 third-party extensions 注册表
python3 .githooks/validate-extensions-yaml

# 结构检查（独立于 pre-commit）
bash .githooks/check-structure
```

## 脚本与 Git Hooks 目录约定

| 目录 | 用途 | 内容 |
|------|------|------|
| `.githooks/` | **[强制]** 所有 gate/intercept 类脚本。被 git hook 调用或手动运行做质量门控。 | Hook 入口（`pre-commit`）+ 校验脚本（`validate-*`）+ 结构检查（`check-structure`） |
| `scripts/` | **[强制]** 项目运维脚本。不被 hook 调用，仅人手动运行或 CI 调用。 | 发布脚本（`publish.sh`）等非 gate 类运维工具 |

**判定规则**：
- 凡是"检查是否合规"的脚本 → `.githooks/`（gate/intercept 性质）
- 凡是"做某件事"的脚本 → `scripts/`（operational 性质）
- `.githooks/` 中的脚本也可以被人直接调用（如 `python3 .githooks/validate-extensions-yaml`）

### 版本管理

**核心原则：各包独立版本号，通过 changeset 管理。**

## 扩展安装红线

**[强制规范] 所有扩展必须通过 npm 包（`pi install`）加载，禁止通过本地目录（`~/.pi/agent/extensions/`）加载，dev 环境测试除外。**

| 方式 | 场景 | 是否允许 |
|------|------|----------|
| `pi install npm:@zhushanwen/pi-xxx` | 生产使用 | ✅ 唯一正确方式 |
| `~/.pi/agent/extensions/` 目录放置 | dev 环境调试 | ✅ 仅开发时 |
| `~/.pi/agent/extensions/` 目录放置 | 日常使用 | ❌ 禁止 |

**原因**：Pi 的包发现机制对 npm 包和本地目录走不同路径。npm 包通过 `collectPackageResources` → `readPiManifest` 发现，**必须**有 `pi` 字段才能加载扩展。本地目录有 `index.ts` fallback 所以不报错，但这掩盖了 `pi` 字段缺失的问题，导致 npm 安装后扩展静默不加载。

**每个扩展 package.json 必须包含以下最小声明**：

```json
{
  "type": "module",
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "keywords": ["pi-package"]
}
```

有 skills 目录的扩展还必须声明：

```json
{
  "pi": {
    "extensions": ["./index.ts"],
    "skills": ["./skills"]
  }
}
```

**[强制]** `pi.extensions` 必须为 `["./index.ts"]`，禁止 `["./src/index.ts"]`。顶层 `index.ts` re-export `src/index.ts`，确保 Pi 扩展加载列表统一显示纯包名。

## 关键约束

### 运行环境

- 扩展在 Pi 进程内执行，**不是独立进程**
- 同一进程可能有多个 session。模块级 `let` 变量会被所有 session 共享，必须用闭包或 session_start 重建
- 扩展不能依赖 fs 之外的 Node.js 原生模块（网络、child_process 等由 Pi 核心控制）。**subagent 是已知例外**——它使用 `child_process.spawn` 启动独立 Pi 进程

### 资源自包含

扩展的文件分为两类，路径策略不同：

**资源文件**（扩展自带、随 npm 分发的脚本/配置）：
- 必须放在扩展自己的目录内（如 `scripts/`、`data/`），禁止引用扩展目录外的绝对路径
- 代码中通过 `import.meta.dirname`（ESM）或 `__dirname`（CJS）定位扩展内资源
- `package.json` 的 `files` 字段必须包含所有资源文件（`.py`、`.sh`、`.json` 等），确保 `npm pack` 后完整可用

**运行时数据文件**（扩展运行时产出的报告/缓存等）：
- 使用 Pi 平台约定路径 `homedir() + '.pi/agent/<用途>/'`
- 不纳入 npm 包，不随扩展分发

目标：用户 `pi install <extension>` 后直接可用，无需额外下载或配置外部资源。

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

### Pi Extension 开发规范

所有扩展的开发必须遵循 [docs/pi-extension-standards.md](./docs/pi-extension-standards.md) 中定义的规范，包括但不限于：
- 包结构与入口模式
- Tool/Command 注册与 execute 规范
- 事件生命周期与状态管理
- 错误处理（stale context 保护、防重入）
- 类型安全与依赖管理

新增扩展前先阅读规范中的「新扩展检查清单」章节。

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

### 类型检查零容忍

pre-commit hook 会运行 `tsc --noEmit`，任何类型错误都会阻止提交。

**核心规则：全量修复，不接受「不是本次引入」作为跳过理由。**

- `tsc --noEmit` 报告的错误必须全部修复，无论是否本次修改引入
- 禁止 `SKIP_LINT=1 git commit` 跳过 hook，除非是紧急 hotfix 且后续立即修复
- 禁止 `--no-verify` 提交，除非是紧急 hotfix 且后续立即修复
- 修复时从 `shared/types/mariozechner/index.d.ts` 的 stub 开始检查——缺失的导出声明会导致下游包报错
- 回调参数缺少类型注解（TS7006 `implicitly has an 'any' type`）是代码质量问题，必须补全类型
- 如果修复量过大（>50 个错误），使用 subagent 并行处理，不要手动一个一个修

### 检查命令

```bash
# 全量类型检查
npx tsc --noEmit

# 全量 lint
pnpm -r lint

# 全量测试
pnpm -r test

# 单包检查
pnpm --filter @zhushanwen/pi-goal typecheck
pnpm --filter @zhushanwen/pi-goal lint
pnpm --filter @zhushanwen/pi-statusline test

# 跳过 pre-commit hook（仅紧急 hotfix）
SKIP_LINT=1 git commit -m "..."

# 手动验证（启动 Pi 后）
/goal Fix the typo in README --tokens 10000
/todos
```

### Git Hooks

项目使用 `.githooks/pre-commit`（通过 `git config core.hooksPath .githooks` 激活），包含：

1. `tsc --noEmit` — 全量 TypeScript 类型检查
2. `eslint` — 仅检查 staged 的 `.ts` 文件
3. `vitest` — 按需触发：仅当 staged 文件涉及的包有 `src/__tests__/` 时运行
4. 文件行数上限检查 — >1000 行阻断，>500 行警告
5. CLAUDE.md 同步检查 — extensions/ 目录变化时验证 CLAUDE.md 同步更新
6. pi manifest 检查 — package.json 的 pi.extensions/type:module/keywords
7. package.json 深度检查 — 包名格式、peerDeps、files
8. scripts 校验 — extensions.yaml + SKILL.md YAML 格式

bare+worktree 模式下 hook 自动检测 rebase 状态并跳过。

详见：[docs/quality-gates.md](./docs/quality-gates.md)

### 独立结构检查

```bash
# 完整结构检查（不阻断 commit，可手动运行）
bash .githooks/check-structure

# 快速模式（仅阻断级别）
bash .githooks/check-structure --quick
```

检查项包括：扩展入口文件存在、CLAUDE.md 同步、文件行数上限、入口模式、模块级变量、package.json files 字段完整性。

### 类型 Stub 维护（`shared/types/`）

`shared/types/mariozechner/index.d.ts` 是 CI 环境的类型桩（ambient module declarations）。本地开发时 `tsconfig.json` 的 `paths` 优先解析到真实 Pi SDK 类型。

**当 Pi SDK 更新或新增导入时，必须同步更新此 stub 文件。** 新增的 `export` 声明缺失会导致本地 typecheck 全量报错。检查方式：

```bash
# 确认哪些导入缺失
npx tsc --noEmit 2>&1 | grep "has no exported member"
```

添加 stub 声明的模式：`export type XxxName = any;`（类型）或 `export function xxx(): void;`（函数）。

```bash
# 全量类型检查
pnpm -r typecheck

# 全量 lint
pnpm -r lint

# 单包检查
pnpm --filter @zhushanwen/pi-goal typecheck
pnpm --filter @zhushanwen/pi-goal lint

# 跳过 pre-commit hook
SKIP_LINT=1 git commit -m "..."

# 手动验证（启动 Pi 后）
/goal Fix the typo in README --tokens 10000
/todos
```


项目使用自定义 ESLint 插件 `taste-lint`，复用自 llm-simple-router 项目的通用规则：

- `no-explicit-any: error` — 类型即契约
- `prefer-allsettled` — 独立数据源用 `Promise.allSettled`
- `no-silent-catch` — catch 块不能为空或只有 console
- `no-unbounded-while-true` — while(true) 必须有迭代上限
- `no-inline-import-type` — 禁止 `as import(...).Type`
- `max-lines: 1000` / `max-lines-per-function: 300` — 结构先于一切
- `no-magic-numbers` — 语义化命名（0/1/-1 豁免）

规则源文件：`taste-lint/base.mjs` + `taste-lint/rules/`

### 测试规范

#### 测试框架

使用 vitest（`^4.1.8`），禁止 `node:test`。

#### 测试文件约定

- 测试文件放在 `src/__tests__/` 目录下，命名 `*.test.ts`
- 每个有测试的包需要 `vitest.config.ts`（放在包根目录）
- `tsconfig.json` 已 exclude `**/__tests__` 和 `**/vitest.config.ts`，无需额外配置
- 新增 exclude 规则时必须更新 `tsconfig.json` 的 `exclude` 数组

#### 运行命令

```bash
# 全量测试（跑所有有 test script 的包）
pnpm -r test

# 单包测试
pnpm --filter @zhushanwen/pi-statusline test

# 监听模式
pnpm --filter @zhushanwen/pi-statusline test:watch
```

#### 可测试性设计

- 纯格式化/计算逻辑从 `index.ts` 提取到独立模块（如 `format.ts`、`speed.ts`），不依赖 Pi 运行时（ExtensionAPI、Theme 等）
- Pi 运行时类型通过 `PlainPallet`/`plainThemeFg` 等无 ANSI 替代品绕过
- 测试文件只 import 被测模块的导出函数，不 import Pi SDK

#### vitest.config.ts alias 约定

| 包位置 | 需要 alias | 示例 |
|--------|------------|------|
| `extensions/*` | `@zhushanwen/pi-quota-providers` → `../../shared/quota-providers/src/index.ts` | statusline |
| `shared/*` | `@mariozechner/pi-coding-agent` → workspace root `shared/types/mariozechner/index` | quota-providers |

所有 vitest.config.ts 的 `include` 统一为 `["src/__tests__/**/*.test.ts"]`。

#### 添加新包测试的检查清单

1. `pnpm --filter <pkg> add -D vitest`
2. 创建 `vitest.config.ts`（参考已有包的配置）
3. `package.json` 添加 `"test": "vitest run"` script
4. 创建 `src/__tests__/` 目录和测试文件

## 安装指南

### npm 包安装（唯一正式方式）

```bash
# 安装单个 extension（唯一正式方式）
pi install npm:@zhushanwen/pi-goal
```

Extension-bundled skills 通过 `pi.extensions`/`pi.skills` manifest 自动注册，无需手动安装。

### 本地开发调试（仅 dev 环境）

本地开发时可以 symlink 到 `~/.pi/agent/extensions/` 目录进行调试，但**禁止用于日常使用**。本地目录的发现机制有 `index.ts` fallback，会掩盖 `pi` 字段缺失的问题。

### 独立 Skills（GitHub 分发）

无所属 extension 的 skills 需要手动安装：

```bash
# Pi 的 skills 目录
ln -s /path/to/xyz-pi-extensions/skills/<name> ~/.pi/agent/skills/<name>

# Claude Code 的 skills 目录
ln -s /path/to/xyz-pi-extensions/skills/<name> ~/.agents/skills/<name>
```

### 当前包清单

**`extensions/`** — Pi 扩展（可发布）

| 包名 | npm name | 说明 | 内嵌 Skills |
|------|----------|------|------------|
| `extensions/goal/` | `@zhushanwen/pi-goal` | 持久化目标驱动循环，7 态状态机 | — |
| `extensions/todo/` | `@zhushanwen/pi-todo` | 轻量三态任务清单 | — |
| `extensions/vision/` | `@zhushanwen/pi-vision` | 图片分析（vision model + memory session） | — |
| `extensions/coding-workflow/` | `@zhushanwen/pi-coding-workflow` | 5-Phase 编码工作流 | ~20 个 xyz-harness-* skills |
| `extensions/claude-rules-loader/` | `@zhushanwen/pi-claude-rules-loader` | 加载 CLAUDE.md 规则 | — |
| `extensions/context-engineering/` | `@zhushanwen/pi-context-engineering` | 渐进式上下文压缩 | — |
| `extensions/evolve-daily/` | `@zhushanwen/pi-evolve-daily` | 每日数据收集 + Tracker 框架 | evolve, evolve-apply, evolve-report |
| `extensions/statusline/` | `@zhushanwen/pi-statusline` | Pi 状态栏 | — |
| `extensions/structured-output/` | `@zhushanwen/pi-structured-output` | Schema 结构化输出（tool call 机制） | — |
| `extensions/unified-hooks/` | `@zhushanwen/pi-unified-hooks` | Hook 管理 | — |
| `extensions/workflow/` | `@zhushanwen/pi-workflow` | 通用 DAG 执行引擎 | — |
| `extensions/model-switch/` | `@zhushanwen/pi-model-switch` | 模型切换 | — |
| `extensions/turn-timing/` | `@zhushanwen/pi-turn-timing` | Turn 各阶段耗时记录 | — |
| `extensions/plan/` | `@zhushanwen/pi-plan` | 轻量级 Plan Mode（brainstorming + writing-plans） | — |

**`shared/`** — 内部共享包（private）

| 包名 | npm name | 说明 |
|------|----------|------|
| `shared/quota-providers/` | `@zhushanwen/pi-quota-providers` | Quota/Provider 配置加载 |
| `shared/taste-lint/` | `@zhushanwen/pi-taste-lint` | ESLint 品味规则 |
| `shared/types/` | `@zhushanwen/pi-types` | 共享类型定义 |

### Extension 依赖管理 [MANDATORY]

所有 extension 之间的依赖关系必须在根目录的 `extension-dependencies.json` 中声明。新增、修改、删除 extension 时必须同步更新此文件。

**数据文件**：
- `extension-dependencies.json` — 依赖关系数据（source of truth）
- `extension-dependencies.schema.json` — JSON Schema 校验

**依赖类型**：

| 类型 | 标识 | 含义 | 在 package.json 中体现 |
|------|------|------|----------------------|
| **runtime** | `"runtime"` | 运行时需要对方 extension 已安装，但代码层面不 import | 不体现（通过 pi 自动加载 extension） |
| **package** | `"package"` | npm 包级别依赖，代码中直接 import 对方的模块 | 必须在 `dependencies` 或 `peerDependencies` 中声明 |
| **optional** | `"optional"` | 功能增强，缺失时降级运行 | 在 `peerDependencies` + `peerDependenciesMeta.optional: true` 中声明 |

**更新时机**：
1. 新增 extension → 添加条目，声明所有依赖
2. 新增/移除/修改依赖 → 更新对应的 `dependsOn` 数组
3. 删除 extension → 移除条目，检查是否有其他 extension 依赖它

**校验**：`npx ajv-cli validate -s extension-dependencies.schema.json -d extension-dependencies.json`

详见：[ADR-018](./docs/adr/018-structured-output-extension.md)
