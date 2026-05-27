---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-27T12:00:00"
  target: ".xyz-harness/2026-05-27-self-evolution-phase4-remaining-scope"
  verdict: fail
  summary: "计划评审完成，第1轮，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 5
  must_fix: 2
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md — Task 1 / spec.md §4.1"
    title: "缺失端到端闭环验证步骤（spec 核心交付物）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md — Task 列表 / spec.md §3.2 P0"
    title: "缺失 '修复实际发现的问题' 的 task 或 buffer"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md — AC 覆盖矩阵 / spec.md §3.2 P1"
    title: "evolve-report command 命名不一致未被处理或标记"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md — Task 2 Step 4 / spec.md §3.2 P1"
    title: "审批交互改进不完整，与 roadmap 期望有差距"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "plan.md — Execution Groups BG1"
    title: "BG1 文件数（10 个）正好在边界，可考虑拆分"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录

- 评审时间：2026-05-27 12:00
- 评审类型：计划评审
- 评审对象：Self-Evolution Phase 4 — spec.md + plan.md + e2e-test-plan.md + use-cases.md + non-functional-design.md
- 复杂度标注：L1

---

## 1. Spec 完整性

### 1.1 目标明确性 ✅

Spec 目标明确：将 Phase 3 已搭建的 evolution-engine（2291 行 TS 骨架）从"从未跑通"的状态推进到"端到端可运行"。spec §4.1 明确列出 5 项剩余工作。

### 1.2 范围合理性 ⚠️

范围划分（P0/P1/P2）合理，三个优先级清晰。P0 是核心（端到端验证 + 质量评估），P1 是缺失功能改进，P2 是 Phase 5 前置准备。整体范围控制得当，但：

- **P0 "修复实际发现的问题" 无工作量预留**：spec 将此项标注为工作量"中"，且明确预期 E2E 测试会发现问题。如果直接纳入范围，需要在 plan 中反映；如果决定推迟到后续轮次，应标记 postponed。

### 1.3 验收标准可量化 ⚠️

Spec 本身没有定义传统格式的验收标准（AC），但通过引用 roadmap 的交付物编号（D4.1-D4.4, D3.3）隐含了验收条件。Plan 的 Spec Coverage Matrix 部分补充了 AC 映射，这弥补了 spec 的不足。建议在 spec 中显式列出每项 AC。

### 1.4 [待决议] 项 ✅

无 [待决议] 标记。所有 scope 决策（postpone _render、Workflow 集成等）在 plan 中明确标注。

---

## 2. Plan 可行性

### 2.1 任务拆分粒度 ✅

3 个 Task，任务粒度适中：
- Task 1（E2E 验证与接口对齐）：6 步，单元级验证
- Task 2（merge-reviewer 模板 + 增强）：7 步，新功能
- Task 3（D3.3 质量评估）：6 步，手动验证

每个 Task 可由一个 subagent 独立完成，粒度合理。

### 2.2 依赖关系 ✅

Task 1 → Task 2 → Task 3，线性依赖，正确。Task 2 依赖 Task 1（需要修复后的代码基础），Task 3 依赖 Task 1+2（需要全部功能就绪后才能做质量评估）。

### 2.3 工作量估算 ⚠️

- Task 1：小（主要是验证 + 少量修复）
- Task 2：小（创建 1 个模板 + 修改 3 个文件）
- Task 3：小（手动评估 + 记录）

**问题**：没有为"修复实际发现的问题"分配工作量。spec 标注此项为"中"，意味着至少需要一个独立的 Task 来 E2E → 发现问题 → 修复 → 验证。

### 2.4 是否遗漏 Task ❌

| Spec 要求 | Plan 覆盖 | 状态 |
|-----------|----------|------|
| D4.1 extension | Task 1 (verify) | ✅ |
| D4.2 四个 Command | Task 1 (verify) | ✅ |
| D4.3 审批交互 | Task 2 (partial) | ⚠️ 仅增加 diff 预览 |
| D4.4 安全回滚 | Task 1 (verify) | ✅ |
| D3.3 建议质量评估 | Task 3 | ✅ |
| merge-reviewer 模板 | Task 2 | ✅ |
| P5.5 自动触发规则 | Task 1 (verify) | ✅ |
| **手动跑一次完整闭环** | **缺失** | **❌** |
| **修复实际发现的问题** | **缺失** | **❌** |
| evolve-report command | 未处理/未标记 | ❌ |
| _render 协议集成 | postponed | ✅ |
| Workflow 集成 | postponed | ✅ |

两个 MUST FIX 遗漏，详细见下文。

---

## 3. Spec 与 Plan 一致性

### 3.1 Plan 是否覆盖 spec 所有需求项

**核心差距**：

**（MUST FIX #1）spec §4.1 第一项 "端到端打通" 在 plan 中无对应步骤。**

spec 明确将"确认 Python analyzer → JSON 报告 → LLM Judge → 建议 → Apply 全链路可运行"列为 Phase 4 的首要任务（§4.1 第 1 条），并在 §3.2 P0 中描述为"手动跑一次完整闭环：/evolve → 建议 → /evolve-apply apply index=0 → 验证 diff 正确"。

但 plan 的 Task 1 仅包含单元级验证（analyzer CLI 接口检查、测试路径修复、错误信息增强、日志增强、运行现有单元测试），**没有任何步骤涉及在真实 pi 环境中安装 extension、运行 `/evolve`、验证 suggestion 生成、执行 apply/rollback**。如果 plan 执行完毕但从未实际跑过 `/evolve`，则无法证明 D4.1-D4.4 已达成。

**（MUST FIX #2）spec §3.2 P0 "修复实际发现的问题" 在 plan 中无对应产出。**

spec 明确将"根据 E2E 测试结果修复 bug"列为工作量"中"的关键任务，且 spec 本身已识别多个风险点（analyzer 路径硬编码、模板 schema 不匹配、LLM Judge 质量不确定性）。但 plan 的 3 个 Task 结束后没有预留任何 E2E 问题修复的 buffer 或独立 task。如果 E2E 测试发现问题（概率高），没有对应的迭代轮次来修复它们。

### 3.2 Plan 中是否有 spec 未提及的额外工作

无。所有 plan 中的修改都来源于 spec 中提及的范围。

### 3.3 验收标准对应实现步骤

除了上述两个缺失项，其他 AC（D4.1-D4.4 验证、D3.3 评估、merge-reviewer）在 plan 中都有对应的实现步骤。

---

## 4. Execution Groups 合理性

### 4.1 分组合理性 ✅

BG1 是唯一分组，包含全部 3 个 Task，文件关联紧密（同一 extension），功能关联度高。

### 4.2 文件数边界 ⚠️

BG1 预估 10 个文件（3 create + 7 modify），刚好达到 reviewer skill 建议的上限（≤ 10）。虽然没有超过，但边界情况。如果 Task 3 的评估文档产生大量迭代变体，建议拆分为独立的 documentation group。

### 4.3 类型划分 ✅

全部为后端 TypeScript 修改 + 一个模板文件 + 评估文档。功能类型一致。

### 4.4 功能关联度 ✅

所有 Task 围绕 evolution-engine extension 展开，关联紧密。

### 4.5 依赖关系 ✅

Task 1 → Task 2 → Task 3，线性依赖。Dependency Graph & Wave Schedule 正确。

### 4.6 Wave 编排 ✅

Wave 1（Task 1）→ Wave 2（Task 2）→ Wave 3（Task 3），作为线性任务，编排正确。

### 4.7 Subagent 配置完整性 ✅

包含 Agent 配置、模型选择策略、注入上下文、读取文件、修改/创建文件。配置完整。

### 4.8 上下文充分性 ✅

注入上下文包含 Task 描述 + spec D4.1-D4.3 + 编码规范约束。充分。

### 4.9 文件数预估 ✅

10 个文件标注合理（3 create + 7 modify），对比 Task 文件变更表一致。

---

## 5. 接口契约审查

### 5.1 Plan 模块接口 ✅

Module interfaces (commands, judge, applier) 定义清晰，方法签名、返回类型、边缘情况、Spec 引用齐全。

### 5.2 AC 覆盖矩阵 ✅

Plan 的 Spec Coverage Matrix 覆盖了 D4.1-D4.4、D3.3、merge-reviewer、P5.5，以及 postponed 项。完整正确。

---

## 6. 后端设计充分性（L1）

### 6.1 实现"为什么" ✅

Plan 在架构说明中解释了"Phase 3 已搭建 skeleton，Phase 4 是验证 + 修复 + 补充"的大背景。每个 Task 的修改有清晰动机。

### 6.2 存储变更 ✅

无新增存储结构。现有 `state.ts` 的 pending.json + history.jsonl 模式已足够的。

### 6.3 API 设计 ✅

Command 接口已由 Phase 3 定义，plan 不做 API 变更，仅增强错误处理和 list 详情展示。

### 6.4 边界条件 ⚠️

Interface Contracts 章节覆盖了主要边缘情况（analyzer 不存在、Judge 超时、index 越界、备份丢失等）。monitor.ts 增加日志增强可观测性。

### 6.5 非功能要求 ✅

non-functional-design.md 覆盖了稳定性、数据一致性、性能、业务安全、数据安全 5 个维度。Task 1 Step 4（monitor 日志增强）直接响应可观测性需求。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | spec.md §4.1 / plan.md Task 1 | **缺失端到端闭环验证步骤。** spec 将"端到端打通（Python analyzer → JSON → LLM Judge → 建议 → Apply 全链路可运行）"列为 Phase 4 首要目标（§4.1 第 1 条），且 §3.2 描述为"手动跑一次完整闭环（/evolve → 建议 → /evolve-apply apply index=0 → 验证 diff）"。但 plan 的 Task 1 只有单元级验证，没有任何步骤涉及在真实 pi 环境中安装 extension 并运行 `/evolve`。不跑 `/evolve` 就无法证明扩展能被 pi 加载、command 能注册、analyzer 调用链能跑通。| 在 Task 1 中增加步骤：安装 evolution-engine 到 `~/.pi/agent/extensions/` → 启动 pi → 运行 `/evolve` → 验证输出 JSON 结构 → 运行 `/evolve-apply` → 验证文件变更 → 运行 `/evolve-rollback` → 验证恢复。或新增 Task 1.5 专门做 E2E 验证。 |
| 2 | **MUST FIX** | spec.md §3.2 P0 / plan.md Task 列表 | **缺失"修复实际发现的问题"的 task 或 buffer。** spec 将此项标注为工作量"中"，明确预期 E2E 测试会发现 bug。且 spec 已识别多个高风险点（analyzer 路径硬编码、模板 schema 不匹配、LLM Judge 质量不确定性）。但 plan 的 3 个 Task 结束后没有任何迭代 buffer 或独立 task 来修复 E2E 发现的问题。如果 E2E 发现问题（概率高），当前 plan 没有对应的迭代轮次。 | 在 Wave 3 之后（或 Task 3 之前）增加一个修复 buffer task（如 Task 2.5）："根据 E2E 验证结果修复发现的问题"。同时设置轮次上限（如 2 轮），超时升级为人工决策。 |
| 3 | **LOW** | spec.md §3.2 P1 / plan.md AC 覆盖矩阵 | **evolve-report command 命名不一致未被处理或标记。** spec 指出"roadmap 定义了 4 个 command，实际有 4 个但命名略有差异（有 evolve-stats，无独立的 evolve-report）"，工作量标记为"小"。Plan 既没有安排改名/别名处理，也没有在 postponed 中明确标注。虽不影响核心闭环，但这是一个已知的命名不一致。 | 在 plan 的 postponed 列表中添加 "evolve-report command 别名" 并注明原因（核心命令已覆盖 stats 功能，重命名非 Phase 4 必须），或直接在 Task 1 中增加一个步骤：在命令注册时添加 `evolve-report` 作为 `evolve-stats` 的别名。 |
| 4 | **LOW** | spec.md §3.2 P1 / plan.md Task 2 Step 4 | **审批交互改进不完整。** spec 的 P1 "改进审批交互"引用 roadmap 期望交互式逐条确认（TUI 中逐条 yes/no/skip）。但 plan 的 Task 2 Step 4 仅增加了 diff 预览（前 10 行）到 list 展示，并未实现交互式审批。这与 roadmap 描述的交互体验有差距。虽然参数式 API 对于 Phase 4 MVP 足够，但需要明确标注为 postponed。 | 在 plan 的 postponed 列表中添加 "交互式审批（TUI 逐条确认）"，注明原因（依赖 pi TUI 组件复杂度高，推迟到后续 Phase）。 |
| 5 | **INFO** | plan.md — Execution Groups BG1 | **BG1 文件数（10 个）正好在边界上限。** Reviewer skill 建议每组 ≤ 10 个文件。BG1 预估 3 create + 7 modify = 10，刚好在边界。没有超过，但也没有余量。如果 Task 3 的评估文档 `d3.3-quality-assessment.md` 在多轮迭代中产生多个版本文件，可以考虑拆分为独立的 documentation group。 | 当前无需操作。如果实施过程中文件数超出，将 Task 3 的文档产出拆为独立 Group。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 结论

**需修改后重审。**

Plan 整体结构合理、Task 粒度适中、Execution Groups 和 Wave 编排正确、AC 覆盖矩阵完整。但存在两个关键 gap：

1. **没有包含 spec 中定义的端到端闭环验证步骤**（手动跑一次 `/evolve` → apply → rollback），无法证明 Phase 4 核心交付物已达成。
2. **没有为"修复 E2E 发现的问题"预留工作量或 buffer**，而 spec 明确预期 E2E 会发现问题。

建议在 plan 中：
- Task 1 增加 E2E 闭环验证步骤，或在 Task 1 后插入 E2E 验证 Task
- 在 Task 2 和 Task 3 之间增加一个修复 buffer task

---

## Summary

计划评审完成，第1轮，2条MUST FIX，需修改后重审。
