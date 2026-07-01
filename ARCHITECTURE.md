# 系统架构

> 由 **coding-closeout** 在收尾时从 `.xyz-harness/{主题}/system-architecture.md` 沉淀。
> **当前态快照，非历史**——架构演进的历史决策见 `docs/adr/`。
> 本文件不重复 CLAUDE.md 的目录清单，只记架构层级的稳定结论。

## 分层

xyz-pi-extensions 是 monorepo，三层：

| 层 | 目录 | 职责 |
|----|------|------|
| 产品扩展 | `extensions/` | 可发布的 Pi 扩展包（`@zhushanwen/pi-*`），面向终端用户 |
| 内部共享 | `shared/` | private 包，仅 workspace 内引用（types / quota-providers / taste-lint） |
| 独立 skills | `skills/` | 无所属 extension 的 Markdown 资源，GitHub 分发 |

> 命名 / 依赖 / 发布规则详见 [CLAUDE.md](./CLAUDE.md)「Monorepo 架构」与 [docs/monorepo-conventions.md](./docs/monorepo-conventions.md)。

## 模块划分

每个 extension 是独立 npm 包，职责单一。完整清单见 CLAUDE.md「当前包清单」。

| 模块 | 职责 | 变化轴 |
|------|------|--------|
| goal | 持久目标驱动自主循环（任务分解 + 证据验证 + 三重预算 + 阻塞/停滞检测） | 状态机、护栏策略（预算/stall/context）、Pi 事件钩子、steering prompt |

> 其他模块的变化轴待 coding-closeout 沉淀。

## 关键状态机

- **goal 7 态状态机**：详见 [docs/adr/002-goal-7-state-machine.md](./docs/adr/002-goal-7-state-machine.md)

> 其他核心状态机待 coding-closeout 沉淀。

## 外部依赖

| 类别 | 依赖 |
|------|------|
| In-process | `@mariozechner/pi-coding-agent`（Pi 运行时提供 typebox / pi-tui / pi-ai） |
| True-external | Pi 平台（扩展在 Pi 进程内执行，非独立进程；subagent 是已知例外） |

> 详见 CLAUDE.md「运行环境」「技术栈」。
