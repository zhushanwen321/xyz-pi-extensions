---
verdict: pass
---

# coding-workflow 拆分重构

## Background

coding-workflow 是一个 5-phase 编码工作流扩展（~2500 行 TS + 827 行 Python gate 脚本 + 19 skills + 18 agents）。当前所有逻辑耦合在一个单体 extension 中：编排（phase 顺序、状态机）、执行（skill 注入、gate 检查、review 调度）和基础设施（subagent 管理、进程管理）混在一起。

核心痛点：
1. **无法单独调试**：想单独跑 "review-gate-loop" 必须跑完整个 5-phase 流程
2. **无法独立优化**：改 review 逻辑要改 `executeGateTool`，改 gate 顺序要改 `PHASES` 数组
3. **流程硬编码**：phase 顺序、gate 组合全部写死在 `index.ts` 中
4. **状态耦合**：`WorkflowState` 的 10 个字段被所有操作共享，任何操作修改都会影响全局

## Functional Requirements

### FR-1: 原子操作独立可调用

每个原子操作都有独立的 tool 入口，可在没有编排引擎的情况下单独调用。

**拆分出的 8 个原子操作：**

| ID | 操作 | 对应现有代码 | 独立入口 |
|----|------|-------------|---------|
| A1 | init | `executeInitTool` + `/coding-workflow` command | `coding-workflow-init` tool |
| A2 | skill-inject | `buildBeforeAgentStartMessage` + `buildSkillInjection` | `coding-workflow-skill-inject` tool |
| A3 | gate-check | `gate-check.py` + `PhaseGate` | `coding-workflow-gate-check` tool |
| A4 | review-dispatch | `dispatchReviewSubagent` | `coding-workflow-review-dispatch` tool |
| A5 | review-loop | `runReviewGateLoop` + `ReviewGate` | `coding-workflow-review-loop` tool |
| A6 | test-fix-loop | `runTestFixLoop` + `TestFixLoopGate` | `coding-workflow-test-fix-loop` tool |
| A7 | retrospect | `buildRetrospectFollowUp` | `coding-workflow-retrospect` tool |
| A8 | phase-transition | `executePhaseStartTool` (compact + goal init) | `coding-workflow-phase-start` tool |

### FR-2: 编排与执行分离

编排层（pipeline 执行器）读取声明式 phase 配置，按序调用原子操作。Phase 顺序和 gate 组合通过配置定义，不改源码即可调整。

### FR-3: 共享基础设施模块化

subagent 管理、skill 解析、gate 脚本运行、YAML 解析等跨操作共用的模块提取为独立文件，被原子操作引用而非绑定。

### FR-4: 状态隔离

每个原子操作维护自己的局部状态（JSON 文件），全局 workflow 状态机只追踪 phase 进度和操作间依赖。

### FR-5: 结构化返回值

每个原子操作返回统一的结构化结果（passed/failed + 详情），不再返回自由文本。

### FR-6: 保持向后兼容

重构后的 extension 保持对外的 tool/command 名称不变（coding-workflow-gate, coding-workflow-init, coding-workflow-phase-start），新增的原子操作 tool 是增量暴露。

## Acceptance Criteria

### AC-1: 单独调用验证

- [ ] 不启动 workflow（不 call init），直接 call `coding-workflow-gate-check`，传入 topicDir + phase，能独立运行 gate-check.py
- [ ] 不启动 workflow，直接 call `coding-workflow-review-loop`，传入 topicDir + phaseConfig，能独立运行 review 循环
- [ ] 不启动 workflow，直接 call `coding-workflow-test-fix-loop`，传入 topicDir，能独立运行测试修复循环

### AC-2: 编排流程不变

- [ ] `/coding-workflow <requirement>` 走完 5-phase 全流程，行为与重构前一致
- [ ] `coding-workflow-gate(phase=N)` 的 FAIL/PASS 语义不变
- [ ] `coding-workflow-phase-start()` 的 compact + skill 注入行为不变

### AC-3: 代码结构

- [ ] 每个原子操作一个文件，文件 ≤ 300 行
- [ ] 共享基础设施一个目录（`infra/`），每个模块一个文件
- [ ] 编排引擎一个目录（`orchestrator/`），pipeline + config 解析
- [ ] `index.ts`（入口）只做注册胶水，≤ 200 行
- [ ] 全量 typecheck 通过（`pnpm --filter @zhushanwen/pi-coding-workflow typecheck`）

### AC-4: 可调试性

- [ ] 每个原子操作产出结构化 JSON 结果，可 cat 查看状态
- [ ] 操作级重试计数独立记录，不与其他操作耦合
- [ ] 每个操作有独立的错误边界，try/catch 不穿透到编排层

## Constraints

- **不新增 extension**：在 `extensions/coding-workflow/` 目录内重构
- **不新增依赖**：仅使用现有依赖（typebox, js-yaml, Pi SDK）
- **skills 和 agents 目录不动**：19 个 skills 和 18 个 agents 只改归属目录，内容零改动
- **gate-check.py 不拆分**：827 行 Python 脚本保持原样，后续可单独优化
- **向后兼容**：现有的 3 个 tool（gate/init/phase-start）保持注册，新增原子操作 tool 是增量

## Decisions

### D-1: 原子操作通过 tool 暴露（而非 command）

Tool 有参数 schema（typebox），返回结构化结果，可被 AI 直接调用。Command 是字符串参数，不适合结构化交互。

### D-2: 编排引擎用硬编码数组实现，声明式配置作为后续迭代

当前 PHASES 数组的声明式改造不是高优先级。先用重构后的 pipeline 执行器替代 executeGateTool 内的硬编码流程，phase 配置仍然用 TypeScript 数组。等原子操作稳定后再迁移到 JSON/YAML 配置。

### D-3: 状态管理从单一大 state 改为分层的局部状态 + 全局进度

```
全局状态（WorkflowState 精简版）:
  - isActive, currentPhase, topicDir, topicName
  - phaseResults: Record<number, "passed">

局部状态（per-operation JSON）:
  - gate-check: .gate-check-p{N}.json
  - review-loop: .review-gate-p{N}.json
  - test-fix-loop: .review-gate-p4.json
```

去掉全局的 `gateRetryCount`、`compactRetryCount`、`gateInProgress`，改为操作内部管理。

### D-4: ReviewGate 的 phase 分支逻辑拆入 review-loop 操作内部

当前 `ReviewGate.run()` 根据 `phase === 3` 走三阶段逻辑，`phase === 4` 走 test-fix-loop。拆分后：
- A5 review-loop 内部处理 Phase 1/2 的标准循环 + Phase 3 的三阶段逻辑
- A6 test-fix-loop 独立处理 Phase 4 的 core/noncore 循环
- 调度者（编排引擎）根据 phase 配置决定调用 A5 还是 A6

## 业务用例

### UC-1: 调试 review-loop 失败

- **Actor**: 开发者
- **场景**: coding-workflow 在 Phase 3 review-gate-loop 失败，需要单独重跑 review 调试
- **预期结果**: 直接调用 `coding-workflow-review-loop` tool，传入 topicDir + phase=3，跳过 gate-check 和 retrospect，只跑 review 循环

### UC-2: 单独验证 gate-check

- **Actor**: 开发者
- **场景**: spec.md 已写好，想快速验证是否满足 gate 要求，不想启动完整 workflow
- **预期结果**: 直接调用 `coding-workflow-gate-check` tool，传入 topicDir + phase=1，得到结构化的检查结果

### UC-3: 调整 phase 流程

- **Actor**: 开发者
- **场景**: 某个简单任务不需要 Phase 4 (Test) 和 Phase 5 (PR)，想跳过
- **预期结果**: 修改 phase 配置（未来：YAML；现在：TypeScript 数组），只保留 3 个 phase

## Complexity Assessment

- **领域复杂度**: L1 — 拆分重构，不引入新概念
- **存储复杂度**: L1 — 不涉及 DB/持久化变更
- **数据流复杂度**: L1 — 操作间数据流是线性的（pipeline 顺序调用）
- **API 复杂度**: L1 — tool 接口是现有接口的子集暴露
- **非功能性复杂度**: L1 — 无性能/安全/并发要求

整体：**L1**
