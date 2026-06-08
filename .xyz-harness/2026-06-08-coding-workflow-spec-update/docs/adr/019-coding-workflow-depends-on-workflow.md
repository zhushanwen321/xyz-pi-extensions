---
status: accepted
date: 2026-06-08
---

# ADR-019: Coding-Workflow 依赖 Workflow Extension

## Context

coding-workflow 的 Review-Gate / Test-Fix Loop 需要多 agent 编排能力：
- Phase 1/2/3 的 Review-Gate 需要循环审查（最多 3 轮）
- Phase 3 阶段二需要并行 5 个 reviewer + 汇总 Fix Worker
- Phase 4 需要 Test-Fix Loop（core → noncore，各最多 10 轮）
- 所有 workflow 需要暂停/恢复、预算控制、callCache 等机制

## Decision

coding-workflow 通过 package 依赖引入 `@zhushanwen/pi-workflow`，使用 `WorkflowOrchestrator` 执行 workflow 脚本。

## Consequences

**正面：**
- 复用 Workflow Extension 成熟的编排能力
- 开发成本降低，无需自研 workflow 引擎
- 自动获得 callCache、budget、pause/resume 等能力

**负面：**
- coding-workflow 与 workflow 形成硬依赖
- 卸载 workflow 会导致 coding-workflow 崩溃
- 需同步更新 `extension-dependencies.json`

## Alternatives Considered

在 coding-workflow 内部实现简化版 workflow 引擎（基于 `runSingleAgent` + 手动循环/并行）。

**放弃原因：** 维护成本高、feature parity 困难，无法复用 Workflow Extension 的状态机和预算控制。
