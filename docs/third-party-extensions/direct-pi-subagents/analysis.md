# pi-subagents (nicobailon) 分析

## 基本信息

| 属性 | 值 |
|---|---|
| 仓库 | https://github.com/nicobailon/pi-subagents |
| 版本 | 0.27.0（安装时） |
| 许可证 | MIT |
| 安装日期 | 2026-06-01 |
| 安装方式 | `pi install npm:pi-subagents` |
| 源码行数 | 26,534 行（75+ 文件） |
| 依赖 | `@earendil-works/pi-*`（新版 Pi 包名） |

## 选择理由

我们之前自主开发了 `@zhushanwen/pi-subagent`（3,115 行，6 文件），功能仅覆盖基本的 single/parallel/chain 执行。nicobailon 的 pi-subagents 在各方面远超我们的实现：

| 维度 | @zhushanwen/pi-subagent | pi-subagents |
|---|---|---|
| 执行模式 | single/parallel/chain | single/parallel/chain + dynamic fanout + clarify TUI |
| Agent 管理 | 只读发现 | CRUD（list/get/create/update/delete） |
| 进程控制 | 启动和等待 | interrupt/resume/status/depth guard |
| 上下文传递 | memory | fork + chain_dir + outputSchema |
| Acceptance | 无 | 完整的验证/审查系统 |
| 内置 agents | 无 | 8 个（scout, researcher, planner, worker, reviewer, context-builder, oracle, delegate） |
| Prompt 模板 | 无 | 7 个（parallel-review, review-loop 等） |
| 测试 | 无 | 50+ 单元测试 + 集成测试 |

直接安装比继续维护自研版本更经济。

## 核心功能

### 执行模式
- **Single**: `{ agent, task }` — 单任务
- **Parallel**: `{ tasks: [...] }` — 并发执行，支持 per-task model/skill/acceptance
- **Chain**: `{ chain: [...] }` — 顺序管道，支持 `{task}`, `{previous}`, `{chain_dir}` 变量
- **Dynamic Fanout**: `{ expand, parallel, collect }` — 从上一步结构化输出动态展开并行任务
- **Async**: `async: true` — 后台执行 + 文件持久化 + result watcher + 通知
- **Clarify**: `clarify: true` — 执行前 TUI 预览/编辑

### Agent 管理
- 发现范围: user + project + builtin（8 个预置角色）
- CRUD: list/get/create/update/delete
- Agent overrides: settings.json 中覆盖任意 agent 的 model/thinking/tools
- 包命名空间: `package.agent` 点分命名

### 进程控制
- interrupt: 软中断当前 child turn
- resume: 从 pause 或 completed session 恢复
- status: 实时进度、tool 调用、turns、tokens
- Control notices: 活动监控（active_long_running / needs_attention）
- 递归深度控制: PI_SUBAGENT_DEPTH + maxSubagentDepth

### 其他
- Worktree 隔离: `worktree: true` 为并行任务创建 git worktree
- Acceptance gates: 完整的验证/审查/命令执行系统
- Intercom bridge: 父子进程双向通信
- Session 分享: 上传到 GitHub Gist
- Slash commands: /parallel-review, /review-loop 等
- Doctor 诊断

## 与我们现有扩展的关系

### 替代关系
- **替代了** `@zhushanwen/pi-subagent`（已删除）

### 残留依赖处理
- `@zhushanwen/pi-coding-workflow` 之前通过 `workspace:*` 引用 subagent 的 model 类型/函数
- 已将 `model.ts` 移至 `coding-workflow/lib/model.ts`，改为本地引用
- 已移除 coding-workflow 对 subagent 的 workspace 依赖

### 保留的自主组件
- `@zhushanwen/pi-vision`（新建）：从旧 subagent 的 vision/spawn 逻辑提取，提供 `analyze_image` tool
  - pi-subagents 不提供 vision 功能
  - vision 需要 vision-models.json 配置 + memory session + 只读约束，不适合通过 subagent tool 间接调用

### 功能映射

| 旧 @zhushanwen/pi-subagent | 新方案 |
|---|---|
| `subagent` tool (single/parallel/chain) | pi-subagents 的 `subagent` tool |
| `analyze_image` tool | `@zhushanwen/pi-vision` 扩展 |
| `resolveModelByComplexity` | `coding-workflow/lib/model.ts`（本地内联） |
| `THINKING_TO_PI` 常量 | `coding-workflow/lib/model.ts`（本地内联） |
| Memory session（subagent 级别） | pi-subagents 的 fork 上下文模式 |
| Background jobs | pi-subagents 的 async 模式 |

## 使用体验

（待补充实际使用后的反馈）

## 后续计划

1. 观察 pi-subagents 在实际工作流中的稳定性
2. 评估内置 agents（scout, reviewer 等）与我们的 coding-workflow 的协作方式
3. 考虑是否通过 pi-subagents 的 agent override 机制配置 vision agent，替代独立 vision 扩展
