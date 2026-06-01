# Third-Party Extensions Borrowed Reference

记录从社区借鉴的 Pi 扩展，分为三种来源：

| 来源 | 含义 | 目录命名 |
|------|------|----------|
| **direct-install** | 直接安装使用，不做修改 | `direct-<name>/` |
| **fork-modified** | Fork 后根据自身需求修改 | `fork-<name>/` |
| **self-written** | 完全自主开发（可能借鉴了思路） | 已在项目根目录各扩展中 |

每个扩展目录包含一个 `analysis.md`，记录：
- 原始仓库地址和 stars
- 选择该来源的理由
- 借鉴的核心思路
- 与我们现有扩展的关系
- 使用体验和后续计划

## 扩展清单

### direct-install（直接安装）

| 扩展名 | 原始仓库 | Stars | 安装日期 | 用途 |
|--------|----------|-------|---------|------|
| pi-hashline-edit | RimuruW/pi-hashline-edit | 76 | 2025-06-01 | 内容锚定编辑，消除行号偏移问题 |
| pi-interactive-shell | nicobailon/pi-interactive-shell | 513 | 2026-06-01 | 交互式 Shell 控制，PTY 仿真 + 四种运行模式 |
| pi-ask-user | edlsh/pi-ask-user | — | 2026-06-01 | 结构化用户问答，LLM 主动向用户提问确认 |
### fork-modified（Fork 修改）

_暂无_

### self-written（自主开发）

这些是本项目自主开发的扩展，部分借鉴了社区思路：

| 扩展名 | 借鉴来源 | 说明 |
|--------|----------|------|
| context-engineering | magic-context, pi-context-prune | 渐进式上下文压缩，借鉴了工具调用树修剪和 CAS 存储 |
| evolve-daily + skills/evolve* | autocontext | 使用数据收集 + 进化建议，借鉴了 knowledge 蒸馏思路 |
| goal | 无 | 完全自主：持久化目标驱动，7 态状态机 |
| todo | 无 | 完全自主：轻量三态任务清单 |
| subagent | 无 | 完全自主：任务委派与并行执行 |
| skill-state | 无 | 完全自主：Skill 执行追踪 |

## 决策原则

1. **优先直接安装**：功能完备、质量高、与我们的扩展不冲突 → 直接安装
2. **Fork 修改**：核心思路好但需要适配我们的架构/约定 → fork 后修改
3. **自主开发**：我们有独特设计或社区无对应方案 → 自主开发（可借鉴思路）

每次新增或变更扩展来源时，更新本文件和对应的分析文档。

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
