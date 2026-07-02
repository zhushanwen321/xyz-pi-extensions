# 产品文档

> **always-current**，更新频率低（愿景稳定）。
> 给新需求的 ①full-clarity 提供「产品已经是什么」的上下文，避免每次需求从零理解产品。
> 本次需求细节在 `.xyz-harness/{主题}/requirements.md`（不搬进本文件——那是需求级，非产品级）。

## 愿景

Pi coding agent 的扩展工具箱：为 AI coding agent 工作流中的特定问题提供独立可安装的 Pi 扩展，每个扩展是一个 npm 包（`@zhushanwen/pi-*`）。

## 核心用户

| Actor | 诉求 | 边界 |
|-------|------|------|
| Pi 用户（开发者） | 安装即用的扩展增强 coding agent 能力 | 不定制 Pi 核心行为 |
| 扩展开发者 | 复用 monorepo 共享基础设施（types / taste-lint / quota-providers） | 不直接发布 shared 包 |

## 功能边界

16 个 extension，覆盖目标驱动（goal/todo）、设计工作流（coding-workflow/design-status）、上下文（vision/context-engineering）、基础设施（unified-hooks/workflow/subagents）等。完整清单与成熟度见 AGENTS.md「当前包清单」。

## 非目标（Non-goals）

> **本文件最有价值的章节**——产品边界的有效载体，累积下来即「这个产品明确不做什么」，防止功能蔓延。
> 每条标溯源，便于追溯为何划这条边界。新需求若想推翻某条，须先改本文件 + 加 ADR。

- {待 coding-closeout 沉淀}

## 路线图

> 已交付的主题里程碑，指向 `.xyz-harness/{主题}/`。进行中的标状态。

| Topic | 里程碑 | 状态 |
|-------|--------|------|
| {待 coding-closeout 维护} | | |
