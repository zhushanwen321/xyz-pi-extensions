# Third-Party Extensions Registry

> **Source of truth**: [`extensions.yaml`](./extensions.yaml)
> Schema: [`extensions.schema.json`](./extensions.schema.json)
> Validate: `python3 .githooks/validate-extensions-yaml`

## 来源分类

| 来源 | 含义 | 目录命名 |
|------|------|----------|
| **direct-install** | 直接安装使用，不做修改 | `direct-<name>/` |
| **fork-modified** | Fork 后根据自身需求修改 | `fork-<name>/` |
| **self-written** | 完全自主开发（可能借鉴了思路） | 已在项目根目录各扩展中 |

每个扩展目录包含一个 `analysis.md`，记录原始仓库、选择理由、核心思路、与现有扩展的关系。

## 扩展清单

下表由 `extensions.yaml` 生成。修改时请编辑 YAML，不要直接改本表。

### direct-install

| 扩展名 | 仓库 | Stars | 安装日期 | 状态 | 用途 |
|--------|------|------:|---------|------|------|
| pi-hashline-edit | [RimuruW/pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) | 76 | 2025-06-01 | active | 内容锚定编辑，消除行号偏移 |
| pi-interactive-shell | [nicobailon/pi-interactive-shell](https://github.com/nicobailon/pi-interactive-shell) | 513 | 2026-06-01 | active | 交互式 Shell，PTY 仿真 + 四种模式 |
| pi-ask-user | [edlsh/pi-ask-user](https://github.com/edlsh/pi-ask-user) | — | 2026-06-01 | active | 结构化用户问答 |
| pi-subagents | [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents) | — | 2026-06-01 | active | 完整 subagent 系统，替代自研 |

### fork-modified

_暂无_

### self-written

| 扩展名 | 借鉴来源 | 状态 | 说明 |
|--------|----------|------|------|
| context-engineering | magic-context, pi-context-prune | active | 渐进式上下文压缩 |
| evolve-daily | autocontext | active | 数据收集 + 进化建议 |
| goal | — | active | 持久化目标驱动，7 态状态机 |
| todo | — | active | 轻量三态任务清单 |
| skill-state | — | active | Skill 执行追踪 |
| ~~subagent~~ | — | replaced | 已被 pi-subagents 替代 |

## 决策原则

1. **优先直接安装**：功能完备、质量高、与我们的扩展不冲突 → 直接安装
2. **Fork 修改**：核心思路好但需要适配我们的架构/约定 → fork 后修改
3. **自主开发**：我们有独特设计或社区无对应方案 → 自主开发（可借鉴思路）

每次新增或变更扩展来源时，更新 `extensions.yaml` 并运行校验脚本。

## 深度架构分析

| 文档 | 对比对象 | 内容 |
|------|---------|------|
| [context-management-architecture-comparison.md](./context-management-architecture-comparison.md) | context-engineering vs pi-context-prune vs magic-context | 源码级架构总对比：架构图、数据结构、压缩算法、持久化、API 使用、设计决策、代码质量评分、演进路径
| [autocontext-vs-evolve-architecture-comparison.md](./autocontext-vs-evolve-architecture-comparison.md) | evolve vs autocontext | 源码级架构对比：评估能力、改进循环、知识管理、演进路径
| [context-engineering-module-reference.md](./context-engineering-module-reference.md) | context-engineering 全部 6 个模块 | 模块级详解：5 层压缩管道（MC→Budget→L0→L1→L2）完整算法、Turn boundary、Protected turn、Tool pairing、FrozenFreshState
| [pi-context-prune-module-reference.md](./pi-context-prune-module-reference.md) | pi-context-prune 全部 16 个模块 | 模块级详解：函数签名、算法伪代码、边界条件、调用关系
| [magic-context-architecture.md](./magic-context-architecture.md) | magic-context 15 个核心模块 | 源码架构：三层架构、SQLite Schema（5 张核心表）、Forge 16 步管道、Historian/Dreamer 详解、Tag/搜索/记忆系统、Prompt Cache 保护
| [evolve-ecosystem-comparison.md](./evolve-ecosystem-comparison.md) | evolve vs Hermes vs OpenClaw vs 社区 | 自进化机制全景对比：四种范式（统计驱动/生命周期/对话学习/评估进化），社区相关项目（reflexio/agent-sessions），Evolve 的独特优势和行动建议 |
| [magic-context-historian-dreamer-strip-analysis.md](./magic-context-historian-dreamer-strip-analysis.md) | magic-context Historian/Compressor/Dreamer/Strip/Cache/Partial-Recomp | 源码级深度分析：Historian 两阶段验证+三重降级、Compressor 深度优先选择+ordinal 吸附、Dreamer 任务队列+circuit breaker、7 种 Strip 策略+sentinel cache 安全、Prompt Hash 保护、Partial Recomp 三段划分
