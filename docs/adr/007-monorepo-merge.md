# ADR-007: Two-Repo Monorepo (xyz-pi-extensions + xyz-harness)

**Status**: Accepted

## Context

ADR-0008 (harness 仓库) 提出了三仓库整合方案（xyz-agent + xyz-pi-extensions + xyz-harness）。实际执行时发现 xyz-agent（Electron GUI 应用）与两个扩展仓库的变更节奏和发布方式差异过大，不适合合并。

## Decision

仅合并 xyz-pi-extensions 和 xyz-harness-engineering 为一个 pnpm workspaces monorepo。xyz-agent 保持独立仓库。

合并后的架构：
- 每个 extension 作为独立 npm 包（`@zhushanwen/pi-*`）发布
- Skills 内嵌到所属 extension，通过 `resources_discover` 自动注册
- 独立 skills 保持 GitHub 分发
- Harness 是逻辑概念（coding-workflow extension + 配套 skills），不是物理层

## Consequences

- 正面：单仓库改动、统一版本管理、subagent 去重、npm 分发替代 symlink
- 负面：仓库体积增大、需要学习 changesets 工作流
- xyz-harness-engineering 仓库归档为只读
