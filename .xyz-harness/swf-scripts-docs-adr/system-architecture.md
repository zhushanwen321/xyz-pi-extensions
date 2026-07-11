---
verdict: pass
upstream: requirements.md
downstream: issues.md
backfed_from: []
---

# pi-subagents-workflow 架构设计（T3：预制脚本 + 文档/ADR）

> **refactor 模式** — T3 是三主题收尾，不引入新架构，只做文档 + 脚本 + 配置交付。
> 本架构文档聚焦：(1) 预制脚本的架构定位和文件组织；(2) ADR-030 的文档架构；
> (3) 项目文档更新的范围和一致性约束。

## 1. 目标转换

### 业务目标 → 系统目标

| 业务目标(requirements) | 转换为系统目标 | 衡量标准 |
|----------------------|--------------|---------|
| G1: 预制脚本模板 | 4 个 .example.js 脚本放入 npm 包 examples/ 目录，通过 lintScript | 4 文件 + lint 通过 |
| G2: ADR-030 | ADR-030 含四节，ADR-026 完全 Superseded、ADR-029 部分 Superseded | 3 文件修改 + coding-execute skill |
| G3: 文档/配置更新 | AGENTS.md + extension-dependencies.json 同步 | check-structure + ajv 通过 |
| G4: skill 更新 | workflow-script-format SKILL.md 新增 workflow() 文档 | skill 可加载 |
| G5: 旧包 deprecated | 旧两包 package.json + CHANGELOG deprecated 标记 | npm info 显示 deprecated |

## 2. 设计立场

**核心计算是什么？** — 无新计算。T3 是文档 + 脚本交付，核心是「把 T1/T2 的架构决策固化为可追溯的文档和可复用的模板」。

### 分层架构

**不新增分层**。T3 不改变系统架构（T1 已定义三层架构），只在现有层上添加交付物：

| 层 | 职责 | T3 交付物 |
|----|------|----------|
| **Interface** | tool/command 注册、TUI 渲染 | 无改动（T1/T2 已完成） |
| **Orchestration**（Engine） | workflow DAG 状态机 | 无改动（T1/T2 已完成） |
| **Execution**（Infra） | SubagentService、ConcurrencyPool | 无改动（T1/T2 已完成） |
| **项目级文档** | ADR/AGENTS.md/extension-deps | ADR-030 + ADR-026/029 superseded + 目录更新 + 依赖迁移 |
| **包级资源** | 预制脚本/skill 文档 | examples/ 4 模板 + workflow-script-format skill + coding-execute skill |

## 3. 统一语言（Ubiquitous Language）

> 引用项目根 CONTEXT.md。本次新增/修改术语：

| 术语 | 含义 | 变更 |
|------|------|------|
| 预制脚本模板 | 基于 workflow() 函数的参考实现脚本（.example.js），用户复制修改后使用 | 新增 |
| ADR-030 | 记录 subagents-workflow 合并架构决策的 ADR | 新增 |
| deprecated 包 | 旧两包标记 deprecated，保留代码但停止维护，引导用户迁移到新包 | 新增 |

## 4. 核心模型

> T3 不引入新运行时模型。预制脚本模板是静态文件（无状态、无不变式），ADR 是文档（无运行时模型）。
> 相关模型（WorkflowRun/ExecutionRecord/ConcurrencyPool）已在 T1/T2 定义。

| 模型 | 类型 | 不变式 | 建模理由 |
|------|------|--------|---------|
| 预制脚本模板 | static resource（DTO） | 无（静态文件，用户复制后自管） | 参考实现，用户复制修改 |
| ADR-030 | document（aggregate） | Status 单调转换（Proposed→Accepted）；不可删除 | 合并架构决策的可追溯记录 |
| DeprecatedPackage | metadata（DTO） | deprecated 字段不可逆；迁移路径必填 | npm deprecated 标记 + 迁移指引 |

### 降级决策（主动不建模）

| 概念 | 为什么不建模 | 应有的处理 |
|------|------------|-----------|
| 预制脚本的状态机 | 脚本是参考模板，用户复制后自行管理状态 | 不建模，脚本内用简单变量 |
| ADR 的版本管理 | ADR 是 append-only 文档，Status 字段管理生命周期 | 不建模，遵循 ADR 约定 |

## 5. 模块拆分

### T3 交付物范围

| 交付物 | 当前状态 | T3 改造 | 归属 |
|--------|---------|---------|------|
| `extensions/subagents-workflow/examples/chain.example.js` | 不存在 | 新建 | 新包资源 |
| `extensions/subagents-workflow/examples/parallel.example.js` | 不存在 | 新建 | 新包资源 |
| `extensions/subagents-workflow/examples/scatter-gather.example.js` | 不存在 | 新建 | 新包资源 |
| `extensions/subagents-workflow/examples/map-reduce.example.js` | 不存在 | 新建 | 新包资源 |
| `docs/adr/030-subagents-workflow-merge.md` | 不存在 | 新建 | 项目级 ADR |
| `docs/adr/026-two-package-architecture-no-l3a.md` | Accepted | Status → Superseded by ADR-030 | 项目级 ADR |
| `docs/adr/029-full-workflow-takeover-with-worktree.md` | Proposed | Status → Partially superseded by ADR-030（D-033R） | 项目级 ADR |
| `AGENTS.md` (extensions/ 目录 + 包清单) | 旧结构 | 新增 subagents-workflow 条目 | 根文档 |
| `extension-dependencies.json` | 旧结构 | 新增 subagents-workflow 条目 | 根配置 |
| `extensions/subagents-workflow/skills/workflow-script-format/SKILL.md` | 旧内容 | 新增 workflow() 文档 + 并发上限 6 | 新包 skill |
| `extensions/coding-workflow/skills/coding-execute/SKILL.md` | 旧内容 | 新增 worktree 编排模式说明（ADR-029 决策 2 转移，D-033R） | coding-workflow skill |
| `extensions/subagents/package.json` | 正常 | 添加 deprecated 字段 | 旧包 |
| `extensions/workflow/package.json` | 正常 | 添加 deprecated 字段 | 旧包 |

### 预制脚本文件组织

```
extensions/subagents-workflow/
├── examples/                         # 预制脚本模板（新增）
│   ├── chain.example.js              # 顺序编排：workflow A → B → C
│   ├── parallel.example.js           # 并行编排：Promise.allSettled([A, B, C])
│   ├── scatter-gather.example.js     # 分发-收集：split → parallel process → merge
│   └── map-reduce.example.js         # 映射-归约：parallel map → reduce
├── skills/
│   └── workflow-script-format/
│       └── SKILL.md                  # 更新：新增 workflow() 函数文档
├── package.json                      # files 字段含 examples/
└── src/
    └── ...                           # T1/T2 已完成的代码
```

**资源自包含约束**：`examples/` 目录必须在 `package.json` 的 `files` 字段中声明，确保 `npm pack` 后模板随包分发。

**目录命名选择**：用 `examples/` 而非 `scripts/`（AGENTS.md 根级 `scripts/` = 运维脚本，语义混淆）。
模板是**纯参考实现**（D-031），用户复制到 `.pi/workflows/` 或 `~/.pi/agent/workflows/` 后执行，
不放入 `workflows/` 目录（避免污染用户的 `workflow list` 命名空间）。

### 预制脚本架构定位

| 属性 | 值 | 理由 |
|------|-----|------|
| 类型 | 参考模板（reference implementation） | 用户复制到 .pi/workflows/ 后修改执行，不是可直接 workflow run 的发现脚本 |
| 执行方式 | 用户复制到 `.pi/workflows/` 或 `~/.pi/agent/workflows/` 后 `workflow run` | workflow 发现机制（config-loader.ts）只扫这三处 + npm 包 `workflows/` 目录 |
| 参数传递 | `$ARGS` 全局变量 | workflow 脚本标准入参 |
| 错误处理 | try-catch + 返回 error 对象 | 不 crash，符合 AgentResult 契约 |
| 并发控制 | 依赖分层配额（T2 已实现） | 脚本不自管并发，用 parallel() |

### ADR 文档架构

```
docs/adr/
├── 025-agent-execution-in-process.md     # 保留（subagents 仍用 createAgentSession）
├── 026-two-package-architecture-no-l3a.md # → Superseded by ADR-030（完全）
├── 027-subagent-execution-persistence.md  # 保留（仍然有效）
├── 028-subagents-discovery-decoupling.md   # 保留（仍然有效）
├── 029-full-workflow-takeover-with-worktree.md # → Partially superseded by ADR-030（仅 worktree 编排被取代）
└── 030-subagents-workflow-merge.md        # 新建（T3）
```

**ADR-030 核心内容**：

| 章节 | 内容 |
|------|------|
| Status | Accepted |
| Context | T1/T2/T3 三主题拆分背景；两包合并为一包的动机；执行链统一的需求 |
| Decision | 4 项核心决策：(1) 合并为一包；(2) 统一执行链（SAR 委托 SS）；(3) 分层配额 + workflow 嵌套；(4) 删 sync + 通知合并。额外承接 ADR-026 Decision 段放弃的 L3A 能力（合并进单包，不做独立 L3A 包） |
| Consequences | 正面：单包交付、执行链单一、嵌套能力；负面：旧包迁移成本、包体积增大 |

**ADR-026/029 superseded 范围**（D-033R：ADR-029 部分 superseded）：

| ADR | superseded 范围 |
|-----|----------------|
| ADR-026 | 完全 superseded（两包架构 → 单包合并；ADR-030 承接 L3A 能力合并进单包） |
| ADR-029 | **部分 superseded**（仅 worktree 编排决策 2 被取代，转移到 coding-execute skill；per-call cwd 决策 1 已实现且仍活跃；决策 3 cw调用/决策 4 plan.json schema/决策 5 砍 pending-env/决策 6 store WAL 与合并正交，均仍有效） |

## 6. 系统间上下文边界（Context Map）

> T3 不改变系统边界（T1 已定义）。此处只记录 T3 对现有边界的影响（零改动）。

| 关联系统 | 关系模式 | T3 影响 |
|---------|---------|---------|
| coding-workflow | 客户-供应商（pi.__workflowRun） | 零改动 |
| pending-notifications | 共享内核（EventBus） | 零改动 |
| 旧两包 | superseded | deprecated 标记 + 迁移指引 |

## 7. 约束

- **预制脚本约束**：
  - 必须符合 workflow-script-format 规范（meta 声明、require()、无 ESM）
  - 必须通过 lintScript 检查
  - 必须在 package.json `files` 字段中声明
  - 目录名用 `examples/`（不与 AGENTS.md 根级 `scripts/` 语义混淆）
  - 模板是纯参考实现（D-031），用户复制到 `.pi/workflows/` 后执行，不放入 `workflows/` 发现路径

- **ADR 约束**：
  - 遵循项目 ADR 格式（Status/Context/Decision/Consequences）
  - superseded ADR 保留原文，只改 Status + 添加 superseded 说明

- **文档一致性约束**：
  - AGENTS.md 目录结构必须与实际 extensions/ 一致
  - extension-dependencies.json 必须通过 schema 校验
  - 旧包 deprecated 标记必须同时出现在 package.json + CHANGELOG

## 8. 不做（Out of Scope）

> 同 requirements.md §8。T3 只做文档 + 脚本 + 配置，不改代码。

## 9. 行为契约保持清单（refactor 模式）

> T3 不改代码行为，无行为契约。相关契约（pi.__workflowRun 签名、EventBus 事件、AgentResult 形状）
> 已在 T1/T2 保证。T3 的契约是文档一致性：

| 契约 | 验证方式 | 状态 |
|------|---------|------|
| AGENTS.md 目录结构与实际一致 | `bash .githooks/check-structure` | T3 保证 |
| extension-dependencies.json schema 合法 | `npx ajv-cli validate` | T3 保证 |
| 预制脚本通过 lint | `lintScript` | T3 保证 |
| ADR 格式合规 | 人工审查（Status/Context/Decision/Consequences 四节齐全） | T3 保证 |
