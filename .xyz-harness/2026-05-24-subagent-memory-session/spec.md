---
verdict: pass
---

# Subagent Memory Session

## Background

当前 subagent 每次调用都是完全空白的状态（`--no-session`），主 agent 需要在 task prompt 中手动打包所有上下文。对于需要深度项目理解或多轮迭代的子任务，这种冷启动模式效率低下——subagent 每次都要重新理解需求、重新探索代码结构。

核心观察：subagent 拥有独立 session 后，它自己的历史会命中 KV cache（cache read 价格约 input 的 1/10），成本可控。

本需求在现有 subagent 扩展上增加可选的 `memory` 参数，让 subagent 拥有持久化的 session 文件，可以在多次调用间复用自己的工作记忆。

## Functional Requirements

### FR-1: memory 参数

新增可选参数 `memory: string`。相同 `memory` 值 = 同一个记忆空间（同一个 subagent session 文件）。

- `memory` 为空或未提供 → 现有行为不变（`--no-session`，无状态）
- `memory` 非空 → 有状态模式（创建或恢复 subagent session）

### FR-2: 首次调用（创建 session）

当 `memory` 指定的记忆空间不存在时：

1. 从主 agent 的当前 session fork 一个新 session 文件
   - 使用 `--fork <主session文件>` CLI 参数（已通过 `pi --help` 确认存在）
   - 新 session 继承主 agent 当前 leaf 为止的完整历史
2. subagent 进程使用 `--session <新session文件>` 启动（而非 `--no-session`）
3. subagent 执行完毕后，session 文件保留在磁盘上
4. 返回结果中附带 `memoryId` 信息，标识这是新创建的记忆空间

### FR-3: 后续调用（恢复 session）

当 `memory` 指定的记忆空间已存在时：

1. 找到已有的 subagent session 文件
2. subagent 进程使用 `--session <已有session文件>` 启动
3. subagent 的历史工作完整保留，KV cache 命中
4. 主 agent 在 task prompt 中自行构造增量背景信息（extension 不做 diff 计算）

### FR-4: Session 文件管理

- **存储位置**: 主 session 文件同目录，命名 `{原文件名}.mem-{sanitized-memory}.jsonl`
  - 例: 主 session `session.jsonl`，memory=`backend-refactor` → `session.mem-backend-refactor.jsonl`
- **sanitization**: memory 参数中的非 `[a-zA-Z0-9_-]` 字符替换为 `_`，截断到 64 字符
- **生命周期**: 跟随主 session。主 session 所在目录被清理时，subagent session 自然一起清理
- **查找**: 通过 `getSessionDir()` + 文件名约定查找已有 session

### FR-5: 模式限制

`memory` 参数**仅适用于 single 模式**。

禁止在 background、parallel、chain 模式中使用 `memory`——memory 模式旨在支持主 agent 串行编排的多轮子任务，并发写入同一 session 文件会导致 JSONL 损坏。如果 background/parallel/chain 模式指定了 `memory`，返回错误提示。

### FR-6: 工具 description 更新

在 subagent 工具的 description 中添加 memory 模式使用指引：

**何时使用 memory:**
- 多轮迭代的复杂子任务（架构分析 → 实现 → 修复）
- subagent 需要深度项目理解（已讨论过的设计决策、代码约定等）
- 主 agent 的上下文接近满，需要"外溢"工作到有记忆的 agent

**何时不使用 memory:**
- 一次性简单任务（grep、format、batch replace）
- 独立的代码审查（agent system prompt 已足够）
- 低复杂度任务（memory 的 session 开销不值得）

### FR-7: renderCall / renderResult 展示 memory 状态

- `renderCall`: 当 `memory` 非空时，在工具调用展示中标注记忆空间名称和状态（新建/恢复）
- `renderResult`: 当 `memory` 非空时，在结果中展示记忆空间信息

## Acceptance Criteria

### AC-1: 首次 memory 调用
- Given 主 session 存在且有历史
- When 调用 subagent tool，`memory="backend-refactor"`
- Then 在主 session 同目录创建 `*.mem-backend-refactor.jsonl`
- And subagent 进程使用 `--session` 而非 `--no-session`
- And 返回结果包含 `memoryId` 字段

### AC-2: 后续 memory 调用
- Given 记忆空间 `backend-refactor` 已存在（之前调用创建的）
- When 再次调用 subagent tool，`memory="backend-refactor"`
- Then 复用已有的 session 文件
- And subagent 进程使用 `--session <已有文件>` 启动

### AC-3: 无 memory 调用不变
- When 调用 subagent tool，不传 `memory`
- Then 行为与改动前完全一致（`--no-session`）

### AC-4: memory 参数 sanitization
- Given `memory="my agent/task:refactor"`
- Then session 文件名中 `memory` 部分为 `my_agent_task_refactor`
- And 长度不超过 64 字符

### AC-5: Session 文件位于主 session 同目录
- Given 主 session 文件路径为 `<dir>/session.jsonl`
- When memory=`backend-refactor` 首次调用
- Then subagent session 文件路径为 `<dir>/session.mem-backend-refactor.jsonl`
- And 与主 session 位于同一目录

### AC-6: 类型检查通过
- `npx tsc --noEmit` 在项目根目录通过

### AC-7: ESLint 通过
- `npm run lint` 无新增 error

### AC-8: memory 不允许在 background/parallel/chain 模式使用
- Given background/parallel/chain 模式中指定了 `memory`
- When 调用 subagent tool
- Then 返回错误信息，提示 memory 仅支持 single 模式

### AC-9: tool description 包含 memory 指引
- subagent tool 的 description 中包含 `memory` 参数说明
- 包含何时使用和不使用 memory 的指引

## Constraints

- **不改变现有行为**: `memory` 为空时，所有代码路径与改动前一致
- **Extension 不做 diff/摘要**: 上下文传递完全由主 agent 的 task prompt 负责
- **Session 文件管理最小化**: 不实现 TTL、显式清理命令等，跟随主 session 生命周期
- **不新增外部依赖**: 只用 Pi runtime 提供的 `SessionManager`、Node.js `fs`/`path`
- **改动范围**: 主要改动 `subagent/src/spawn.ts`（session 管理 + spawn 逻辑）和 `subagent/src/index.ts`（参数 schema + 模式分发 + description 更新 + renderCall/renderResult 内存状态展示）。渲染逻辑内联在 index.ts 中（现有模式，不涉及 widget.ts）

## Complexity Assessment

**中等偏低。** 核心改动集中在两个文件：

1. `spawn.ts`: 增加记忆空间 session 文件管理（查找/创建），修改 spawn 参数构建逻辑
2. `index.ts`: 增加 `memory` 参数 schema，工具 description 更新，mode dispatch 逻辑调整

无新模块、无新数据模型、无跨模块接口变更。主要是参数透传和文件命名约定。
