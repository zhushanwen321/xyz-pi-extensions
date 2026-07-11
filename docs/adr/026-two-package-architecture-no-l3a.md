# ADR-026: 两包架构——Agent Runtime + Workflow（不做 L3A 交互式编排）

## Status: Superseded by [ADR-030](./030-subagents-workflow-merge.md)

> **Superseded 说明（2026-07-11）**：本文记录的两包架构决策已被 [ADR-030](./030-subagents-workflow-merge.md) 完全取代——两包（`@zhushanwen/pi-subagents` + `@zhushanwen/pi-workflow`）合并为单包 `@zhushanwen/pi-subagents-workflow`。L3A 能力（LLM 即席编排）合并进单包，与 `workflow()` 嵌套编排共存——即「不做独立 L3A 包」的立场保留，但 L3A 能力本身不再缺失（由单包的 `agent()` 即席编排覆盖）。原文保留不动供历史追溯。

## Context

调研了 pi-subagents（nicobailon）和 tintinweb/pi-subagents 两个系统后，原计划做三包分层（L1+L2 底层 / L3A 交互式编排 / L3B 脚本编排）。L3A 注册 `subagent` tool 让 LLM 通过 function calling 触发 chain/parallel/fanout。L3B 是现有的 workflow JS 脚本编排。

两者能力高度重叠（single/chain/parallel/fanout/acceptance 都能做），区别仅在"谁做决策"：L3A 是 LLM 实时决策，L3B 是人预写脚本。

## Decision

只做两个包：`@zhushanwen/pi-agent-runtime`（L1+L2 底层）和 `@zhushanwen/pi-workflow`（L3B 脚本编排）。不做 L3A 交互式编排包。

需要 LLM 即席编排的用户继续安装 pi-subagents（nicobailon），它与 workflow 不冲突（不同 tool 名）。

## Consequences

- 架构简洁：只有 2 个包需要维护和版本同步
- workflow 改造后覆盖所有编排能力（chain/parallel/pipeline + steer + abort）
- 缺失 LLM 即席编排：用户无法通过 function calling 直接让 LLM 编排子 agent，需要通过 `/workflow` 命令间接使用
- 需要安装 pi-subagents 来获得 LLM 即席编排能力
