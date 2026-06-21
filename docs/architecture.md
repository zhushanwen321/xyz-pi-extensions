# 系统架构

xyz-pi-extensions 是 Pi coding agent 的扩展工具箱 monorepo。本文档是架构总览入口，深入细节见 [standards.md](./standards.md)、[monorepo-conventions.md](./monorepo-conventions.md)、[adr/](./adr/)。

## Monorepo 组成

三层，职责严格分离：

| 层 | 目录 | 职责 | 发布 |
|----|------|------|------|
| 产品 | `extensions/` | Pi 扩展（`@zhushanwen/pi-*`），解决 AI coding 工作流特定问题 | npm |
| 共享依赖 | `shared/` | 跨 extension 复用的内部包（quota-providers / taste-lint / types） | private 或内部 |
| 独立 skills | `skills/` | 无代码逻辑的 Markdown skill，GitHub 分发 | GitHub |

依赖方向：`extensions/* → shared/* → 外部`，Pi SDK 始终 `peerDependencies`。禁止 `shared/` 反向引用 `extensions/`。

## 运行时架构

- **进程内执行**：extension 在 Pi 进程内运行，非独立进程。`subagents` 是已知例外，用 `child_process.spawn` 起独立 Pi 进程实现隔离
- **多 session 共存**：同一进程可能有多个 session。模块级 `let` 变量被所有 session 共享，状态必须存于 `session_start` 重建的闭包或 `ctx.sessionManager` entries
- **事件驱动**：extension 通过 `pi.on(event, handler)` 接入生命周期（`session_start` / `before_agent_start` / `agent_end` 等）。`agent_end` 只做同步清理，禁止启动新 LLM 调用
- **状态持久化**：`pi.appendEntry(type, data)` 写入，`ctx.sessionManager.getEntries()` 读取；需自行 GC 旧 entries；`deserializeState` 向后兼容

## 关键子系统

| 子系统 | 扩展 | 职责 |
|--------|------|------|
| Subagent 执行 | `subagents` | 进程隔离的子 agent 执行（sync / background / poll），agent 发现 + 并发控制 |
| 目标驱动循环 | `goal` | 持久化目标 + 7 态状态机 + 预算管理 |
| 任务清单 | `todo` | 轻量三态待办 |
| 编码工作流 | `coding-workflow` | 5-Phase 编码工作流（spec → plan → dev → test → pr），含 ~20 个 harness skills |
| 上下文压缩 | `context-engineering` | 渐进式压缩（L0 / L1 / L2 / Microcompact / Budget） |
| DAG 引擎 | `workflow` | 通用多 agent 编排 |
| 其他 | `vision` / `evolve-daily` / `statusline` / `structured-output` / `model-switch` / `turn-timing` / `plan` / `ask-user` / `unified-hooks` / `claude-rules-loader` | 各自独立功能 |

子系统间通过 extension 依赖声明协作（见根目录 `extension-dependencies.json`）。关键架构决策记录在 [adr/](./adr/)，决策前的方案探索在 [evolution/](./evolution/)。
