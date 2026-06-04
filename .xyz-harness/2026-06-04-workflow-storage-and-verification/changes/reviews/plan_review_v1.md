---
review:
  type: plan_review
  round: 1
  timestamp: "2026-06-04T22:00:00"
  target: ".xyz-harness/2026-06-04-workflow-storage-and-verification/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，3条MUST FIX（AC编号引用错误、File Structure表遗漏文件、Data Flow Chain不完整），需修改后重审"

statistics:
  total_issues: 3
  must_fix: 3
  must_fix_resolved: 0
  low: 0
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:AC Coverage Matrix → AC-1.5 row; e2e-test-plan.md:E2E-1 coverage; test_cases_template.json:TC-1-08"
    title: "AC-1.5 是幽灵引用——spec 中不存在此编号，E2E 和 test template 均引用了不存在的 AC"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:File Structure table BG2-T4 row"
    title: "File Structure 表 BG2-T4 行遗漏 index.ts，与任务描述和 Subagent 配置矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Data Flow Chain section"
    title: "Data Flow Chain 缺少 maybeEmitSoftWarning 私有方法的流转，dispatch→warning→callback 链路不完整"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-04 22:00
- 评审类型：计划评审
- 评审对象：`plan.md` + `spec.md` + `e2e-test-plan.md` + `use-cases.md` + `non-functional-design.md` + `test_cases_template.json`

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md + e2e-test-plan.md + test_cases_template.json | AC-1.5 在 spec 中不存在。spec 的 FR-1 只有 AC-1.1 ~ AC-1.4 共 4 个 AC。但：(a) plan 的 AC Coverage Matrix 最后一行引用了 AC-1.5；(b) e2e-test-plan.md E2E-1 coverage 列出 "AC-1.5"；(c) test_cases_template.json 的 TC-1-08 描述写 "AC-1.5 (FR-1.5 backward compat)"。FR-1.5（向后兼容）的验收逻辑已被 AC-1.3（外部文件不存在时不报错）覆盖，不需要独立 AC。幽灵引用会导致执行者试图验证一个不存在的 AC，浪费时间或误判覆盖状态 | 三处引用全部修正：(a) plan AC Coverage Matrix 删除 AC-1.5 行；(b) e2e-test-plan E2E-1 coverage 改为 "AC-1.1 ~ AC-1.4"；(c) TC-1-08 description 改为引用 "FR-1.5 backward compat（由 AC-1.3 覆盖）"，title 改为 "reconstructState ignores old workflow-state entries" |
| 2 | MUST FIX | plan.md File Structure table | File Structure 表 BG2-T4 行只列出 `orchestrator.ts`（modify），但任务描述明确写道 "Reconstruct logic: read pointer entries"，且 spec FR-1.4 将 `reconstructState` 定位在 `index.ts:99-124`。Subagent 配置也列出 `index.ts` 在"修改/创建文件"栏。File Structure 表是 plan 的关键索引——执行者和 reviewer 通过此表快速判断影响范围。遗漏 `index.ts` 意味着：(1) reviewer 无法从 File Structure 判断 BG2-T4 的真实变更范围；(2) 潜在的跨文件冲突风险（BG3-T5 也修改 `index.ts`）在 File Structure 层面不可见 | 在 File Structure 表中为 BG2-T4 增加 `extensions/workflow/src/index.ts`（modify）行。同时在 BG2-T4 的依赖说明中注明：BG2-T4 和 BG3-T5 共同修改 `index.ts`，但作用域不同（BG2-T4 改 reconstructState 区域，BG3-T5 改 workflow-run tool 区域 + session_start handler），可通过行号范围隔离 |
| 3 | MUST FIX | plan.md Data Flow Chain | Data Flow Chain 未包含 `maybeEmitSoftWarning` 私有方法的调用链。Interface Contracts 中为 `AgentPool.maybeEmitSoftWarning` 定义了签名和 edge case，但 Data Flow Chain 的 AgentPool 部分只展示了 `dispatch() → totalCallCount += 1`，没有展示 `dispatch → maybeEmitSoftWarning → onSoftLimitReached callback → pi.sendUserMessage` 的完整流转。这导致 Data Flow Chain 不完整——`maybeEmitSoftWarning` 是 FR-4 的核心触发机制，其位置（在 drain 循环中）和守卫条件（`softWarningSent`）应在数据流中显式体现 | 在 Data Flow Chain 的 AgentPool 部分，在 `dispatch() totalCallCount += 1` 之后追加：`└─ maybeEmitSoftWarning(runName, budget)` → 条件判断 → `onSoftLimitReached?.({ runName, totalCalls, budget })` → orchestrator 层 `pi.sendUserMessage(...)` |

### 逐维度审查详情

#### 1. Spec 完整性

**结论: PASS**

Spec 的 6 大元素全部齐全：

| 元素 | 状态 | 说明 |
|------|------|------|
| 目标 | ✅ | "解决 4 个 UX/storage 问题"，一段话说清楚 |
| 范围 | ✅ | In-scope 5 FR，Out-of-scope 4 项明确拒绝，边界清晰 |
| 验收标准 | ✅ | 27 个 AC，全部可量化、可写测试验证 |
| 技术约束 | ✅ | 5 类约束（技术栈/性能/兼容性/范围/工作量），不含糊 |
| 业务用例 | ✅ | 5 个 UC，每个含 Actor/场景/预期结果 |
| 风险与假设 | ✅ | 15 个 Code-Level Assumptions（13 VERIFIED + 1 VERIFIED GAP + 1 UNVERIFIED） |

无 `[待决议]` 项。Self-check checklist 全勾。Complexity Assessment 合理（中等架构复杂度，5-7 天工作量）。

#### 2. Plan 可行性

**结论: PASS（有文档准确性问题）**

| 维度 | 状态 | 说明 |
|------|------|------|
| 任务粒度 | ✅ | 8 个 task，每个 ≤ 1 个文件修改（BG2-T4 例外，改 2 文件但关联紧密），单 task 可由 subagent 独立完成 |
| 依赖关系 | ✅ | BG1(基础) → BG2(编排) → BG3(审批) → BG5(文档)，BG4 独立并行。依赖图正确 |
| 工作量估算 | ✅ | 7 个 task × 0.5~2 天，总计 5-7 天，与 spec 一致 |
| 遗漏检查 | ✅ | 逐 FR 对照，所有 FR/AC 均有对应 task |
| 测试数量 | ✅ | 34 个新测试（7+0+8+8+8+0+3），远超 spec AC-6.1 要求的 ≥13 |

**Wave Schedule 合理性：**

| Wave | Tasks | 并行约束 | 判定 |
|------|-------|---------|------|
| Wave 1 | BG1-T1, BG1-T2, BG1-T3, BG4-T6, BG4-T7 | 5 个完全独立 task 并行 | ✅ 合理 |
| Wave 2 | BG2-T4 | 依赖全部 BG1（state_lost + stub + callback type） | ✅ 正确 |
| Wave 3 | BG3-T5 | 依赖 BG2（需要 orchestrator 层面的 pointer/entry 模式就位） | ✅ 正确 |
| Wave 4 | BG5-T8 | 依赖所有实现（需要引用最终代码） | ✅ 正确 |

Wave 1 的 5 subagent 并行未超过 5 个上限。每个 task 粒度 ≤ 3 文件，符合 subagent 约束。

**Subagent 配置完整性：**

每个 task 均包含 Agent/Model/注入上下文/读取文件/修改创建文件，配置充分。模型选择合理（stub 更新用 low，跨文件编排用 high，文档用 low）。

#### 3. Spec-Plan 一致性

**结论: PASS（幽灵 AC 引用除外，见 Issue #1）**

逐 FR 对照：

| FR | Plan Task | 覆盖 |
|----|-----------|------|
| FR-1.1 (pointer entry) | BG2-T4 | ✅ |
| FR-1.2 (external state file) | BG2-T4 | ✅ |
| FR-1.3 (write path) | BG2-T4 | ✅ |
| FR-1.4 (reconstruct path) | BG2-T4 | ✅ |
| FR-1.5 (backward compat) | BG2-T4 | ✅ |
| FR-1.6 (state_lost) | BG1-T1 | ✅ |
| FR-1.7 (perf budget) | BG2-T4 (informal) | ✅ 非门控 |
| FR-2.1 (UI confirm) | BG3-T5 | ✅ |
| FR-2.2 (session memory) | BG3-T5 | ✅ |
| FR-2.3 (tmp special) | BG3-T5 | ✅ |
| FR-2.4 (force confirmSkipped) | BG3-T5 | ✅ |
| FR-2.5 (hasUI fallback) | BG3-T5 | ✅ |
| FR-2.6 (stub update) | BG1-T2 | ✅ |
| FR-3.1 (SKILL.md patterns) | BG4-T6 | ✅ |
| FR-3.2 (promptGuidelines) | BG4-T7 | ✅ |
| FR-3.3 (no hook change) | verification check | ✅ 正确做法 |
| FR-3.4 (verifyStrategy field) | BG1-T1 | ✅ |
| FR-4.1~4.6 (soft warning) | BG1-T3 + BG2-T4 | ✅ |
| FR-5.1 (doc) | BG5-T8 | ✅ |
| FR-5.2 (no ADR) | Self-Review section | ✅ 无需 task |
| FR-5.3 (CONTEXT.md) | Phase 1 已完成 | ✅ 正确标注 |

Plan 中无 spec 未提及的额外工作。所有 task 都可追溯到 spec FR/AC。

#### 4. Interface Contracts 审查

**结论: PASS（Data Flow Chain 缺口除外，见 Issue #3）**

| 模块 | 覆盖 | 说明 |
|------|------|------|
| `state.ts` (WorkflowStatus) | ✅ | 新值 `state_lost` + TERMINAL_STATUSES + VALID_TRANSITIONS 完整定义 |
| `agent-pool.ts` (AgentPoolOptions + AgentPool) | ✅ | 构造函数、dispatch、maybeEmitSoftWarning 签名 + 边界条件完整 |
| `orchestrator.ts` (persistState + reconstructState) | ✅ | 签名变更（sync→async）+ pointer entry 数据结构 + 边界条件 |
| `index.ts` (session_start + workflow-run) | ✅ | approval memory entry + sessionApprovals + tool 参数变更完整 |
| `mariozechner/index.d.ts` (ui stub) | ✅ | confirm/select/input/setStatus/setWidget/setFooter 签名完整 |

**AC Coverage Matrix 审查：**
- 27 个 AC 中 24 个有 Interface Method 映射 ✅
- 3 个标记为 "no task" / "verification check"：AC-3.3（正确，negative verification）、AC-5.2（Phase 1 已完成）、AC-5.3（正确，不需要 task）✅
- **AC-1.5 行不存在**（幽灵引用）— 见 Issue #1 ❌

#### 5. Spec Metrics Traceability 审查

**结论: PASS**

所有 FR（FR-1.1 ~ FR-5.3）和所有 AC（AC-1.1 ~ AC-6.3）在 Spec Metrics Traceability 表中均有对应行，状态均为 `adopted`。无 `rejected` 或 `postponed` 项。

#### 6. 执行代码检查

**结论: PASS**

Plan 中的代码片段（Interface Contracts 的方法签名、Data Flow Chain 的伪代码、Task Description 中的 implementation outline）均为设计级别——签名、类型定义、逻辑流程说明。无完整函数体实现。符合"禁止实现代码"规则。

#### 7. test_cases_template.json 审查

**结论: PASS（幽灵 AC 引用除外，见 Issue #1）**

共 32 个测试用例，覆盖全部 6 个 FR 域：

| FR 域 | TC 数量 | 覆盖 AC |
|-------|---------|---------|
| FR-1 (External State) | 8 | AC-1.1~1.4 |
| FR-2 (Approval Gate) | 8 | AC-2.1~2.7 |
| FR-3 (Verification) | 4 | AC-3.1~3.4 |
| FR-4 (Soft Warning) | 6 | AC-4.1~4.6 |
| FR-5 (Doc) | 3 | AC-5.1~5.3 |
| AC-6 (Test Coverage) | 3 | AC-6.1~6.3 |

测试类型分布合理：api 测试 22 个、integration 测试 5 个、manual 测试 5 个。每条 TC 都有明确的 steps 和可验证的 assert。

**Issue #1 影响**：TC-1-08 引用 "AC-1.5" 需修正为 "FR-1.5 backward compat（由 AC-1.3 覆盖）"。

#### 8. use-cases.md 审查

**结论: PASS**

5 个 UC 全部可追溯到 spec AC：

| UC | 主要 AC | 次要 AC | 追溯清晰度 |
|----|---------|---------|-----------|
| UC-1 | AC-1.1, AC-1.2 | AC-1.3 | ✅ 每个步骤都标注 AC |
| UC-2 | AC-2.1, AC-2.5, AC-2.6 | AC-2.2~2.4 | ✅ Main/Alternative/Exception 分层清晰 |
| UC-3 | AC-3.1, AC-3.2 | AC-3.4 | ✅ 含代码示例展示 Pattern B |
| UC-4 | AC-4.1, AC-4.2, AC-4.6 | AC-4.3~4.5 | ✅ 含完整 dispatch 循环描述 |
| UC-5 | AC-5.1 | — | ✅ 6 个月后回看场景真实可感 |

每个 UC 包含 Actor / Preconditions / Main Flow / Alternative Paths / Exception Paths / Postconditions / Module Boundaries / Coverage 表。覆盖映射表完整，无遗漏 FR 域。

#### 9. non-functional-design.md 审查

**结论: PASS**

| 维度 | 评估质量 | 说明 |
|------|---------|------|
| 稳定性 | ✅ 充分 | 逐 FR 分析风险点+缓解措施，结论"三层防护"有据 |
| 数据一致性 | ✅ 充分 | 分析了写入顺序（先文件后 pointer）、崩溃恢复、并发控制，结论合理 |
| 性能 | ✅ 充分 | 引用 spec FR-1.7 预算，对比新旧实现开销，具体到 O(n) 和毫秒级 |
| 业务安全 | ✅ 充分 | "5 层防护"体系化分析，每层都关联到具体 FR |
| 数据安全 | ✅ 充分 | 分析了文件权限、敏感信息、新增风险点，结论"无新增风险"有据 |

无空话。每个维度都有具体的技术分析和结论，不是泛泛而谈。

### 结论

需修改后重审。

3 条 MUST FIX 均为文档准确性问题，不涉及架构设计缺陷。Spec 本身质量高，Plan 的设计、分组、依赖关系、接口契约均合理。修复文档准确性后即可通过。

### Summary

计划评审完成，第1轮，3条MUST FIX，需修改后重审。Spec 完整性强（6 大元素齐全、27 AC 无遗漏），Plan 可行性好（34 测试、合理的 4 Wave 编排），use-cases 和 non-functional-design 质量高。问题集中在 plan 文档的内部一致性：(1) AC-1.5 幽灵引用跨 3 个文件，(2) File Structure 表遗漏 BG2-T4 的 index.ts，(3) Data Flow Chain 缺少 maybeEmitSoftWarning 调用链。
