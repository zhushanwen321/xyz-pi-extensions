# ADR-020: Plan Mode 只读约束采用提示词驱动

## Status

Accepted

## Context

Plan Mode 需要约束 AI 在规划期间不执行写入操作（编辑代码文件、运行写入类命令）。实现方案有两种：

1. **提示词驱动**：在 SKILL.md 中告知 AI 当前在 plan mode，禁止写入
2. **tool_call 事件拦截**：通过 `pi.on("before_tool_call", ...)` 拦截 BashTool 和 EditTool，白名单放行 plan 文件操作

## Decision

采用提示词驱动，不做 tool_call 事件拦截。

## Consequences

**正面**：
- 实现简单，无需维护 bash 命令白名单
- 与 coding-workflow 的只读约束实现一致
- 主流模型（Claude）对提示词约束的遵从度足够高

**负面**：
- AI 可能违反约束执行写入操作（概率低但存在）
- 用户需要在 review 时自行发现违规操作并 abort

**风险缓解**：
- 违规操作可通过 git diff 发现
- 用户可在 plan mode 中随时 abort
