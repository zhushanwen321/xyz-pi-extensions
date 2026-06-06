# Review-Gate Phase 分析范式

用于分析每个 phase 的 gate 配置。**权威文档以 `docs/phase-specs/phase-{1-4}-*.md` 为准,本文档是交叉引用摘要。**

## Gate 分层设计

### 总览

| Phase | Review-Gate 模式 | Phase-Gate 模式 |
|-------|------------------|------------------|
| 1 Spec | ✅ Workflow 循环(agent 审查+修复,最多 3 轮) | 2 步:脚本检查 + AI Agent 防伪造 |
| 2 Plan | ✅ Workflow 循环(agent 审查+修复,最多 3 轮) | 2 步:脚本检查 + AI Agent 防伪造 |
| 3 Dev | ✅ Workflow 循环(前置审查 + 并行 6 维度,最多 3 轮) | 2 步:脚本检查 + AI Agent 防伪造(严格) |
| 4 Test | ❌ **无 Review-Gate**(Test-Fix Loop 替代) | 3 步:脚本检查 + 一致性检查 + 深度质疑(最严格) |
| 5 PR | ❌ 无 | 2 步:脚本检查 + AI Agent 防伪造 |

### Review-Gate(Phase 1/2/3 内容质量审查)

审查交付物的**内容质量**:需求是否穷尽、逻辑是否正确、代码是否符合 spec+plan。

**Phase 1/2**:单个 agent 审查+修复循环。agent 发现问题后直接修复,修完重新审查,直到 must_fix=0。

**Phase 3**:两阶段循环。阶段一:spec-plan-conformance-reviewer(独立循环,代码是否符合 spec+plan)。阶段二:6 维度并行审查(BLR/Standards/Taste/Robustness/Fallow/Integration)+ sync-agent + Fix Worker。

**Phase 4 不需要 Review-Gate**--Test-Fix Loop Workflow 替代了内容审查角色。测试-修复循环本身保障了测试质量(每个 case 必须通过或充分跳过),Phase-Gate 的严格防伪造检查替代了 review-gate 的质量验证。

### Phase-Gate(所有 phase 统一 2 步模式)

所有 phase 共享统一的 2 步 Phase-Gate:

| 步骤 | 执行者 | 说明 |
|------|--------|------|
| 1. 脚本检查 | 脚本 | 文档完整性 + YAML frontmatter + placeholder 扫描 |
| 2. 防伪造检查 | AI Agent(gate-reviewer subagent) | 验证内容非空、非占位、非伪造 |

**严格度分级**:

| Phase | 脚本检查 | 防伪造严格度 |
|-------|---------|-------------|
| 1/2 Spec/Plan | ✅ | 🟡 标准:验证内容非空、非占位 |
| 3 Dev | ✅ | 🔴 严格:额外验证代码变更真实存在、review 报告非伪造 |
| 4 Test | ✅ | 🔴🔴 最严格:3 层次(脚本 + 一致性比对 + 深度质疑),核心 case 逐条比对,非核心抽查 |
| 5 PR | ✅ | 🟡 标准 |

**失败处理**:返回主 agent,告知修复后**直接重新提交 phase-gate**(跳过 review-gate,因为内容质量已在 review-gate 或 test-fix loop 中通过)。

Phase-Gate 不关心内容是否正确(那是 review-gate/test-fix loop 的职责),只关心格式合规和真实性。

### 两层 Gate 的关系

```
Phase 1/2/3:
  Review-Gate PASSED → 自动触发 Phase-Gate → Phase-Gate PASSED → Retrospect

Phase 4:
  Test-Fix Loop PASSED → 直接触发 Phase-Gate → Phase-Gate PASSED → Retrospect

Phase 5:
  Phase-Gate PASSED → Overall Retrospect
```

主 agent 只感知到调一次 `coding-workflow-gate(phase=N)`。gate tool 内部按 phase 路由:
- Phase 1/2/3:先跑 review-gate,再跑 phase-gate
- Phase 4:先跑 test-fix loop workflow,再跑 phase-gate
- Phase 5:只跑 phase-gate

## 分析步骤

### 1 产出物分析

| 问题 | 选项 |
|------|------|
| 产出物是什么? | 单文件文档 / 多文件文档 / 多文件代码 |
| 产出物复杂度? | 低(几十行)/ 中(几百行)/ 高(千行级 + 多文件) |
| 内容审查重点? | 需求完整性 / 设计可行性 / 代码质量 / 测试覆盖 |
| 格式审查重点? | YAML 格式 / placeholder 扫描 / 字段完整性 |

### 2 Review-Gate 配置

| 问题 | 选项 |
|------|------|
| 模式? | Phase 1/2/3: 循环 workflow; Phase 4: 无(test-fix loop 替代) |
| 需要几个 reviewer? | 1 个 / 多个 |
| 是否有复杂度分级(L1/L2)? | 是(每级独立配置)/ 否 |
| 需要 agent.md 还是复用现有? | 新建 agent.md / 复用现有 SKILL.md |

**Agent 文件规则 [MANDATORY]**:
- 每个 reviewer 必须有独立的 agent.md,禁止"复用 expert-reviewer + 不同 task prompt"模式
- task prompt 只注入简单差异化内容:文件路径、输出目录、round 编号、上一轮报告路径
- task prompt 不包含审查逻辑、审查步骤、输出格式定义--这些全部在 agent.md 中
- 唯一例外:审查逻辑完全相同且已有独立 SKILL.md 的(如 Phase 3 的 5 个专项 reviewer)

### 3 Phase-Gate 配置

所有 phase 共享统一的 2 步 Phase-Gate:脚本检查 + AI Agent 防伪造检查。

| 组件 | 说明 |
|------|------|
| 脚本检查 | 文档完整性 + YAML frontmatter + placeholder 扫描 |
| 防伪造检查 | AI Agent 验证内容非空、非占位、非伪造 |

**严格度按 phase 分级**(见上方 Phase-Gate 表格)。Phase 4 的防伪造最严格(3 层次:脚本 + 一致性比对 + 深度质疑)。

**失败处理**:返回主 agent 修复,修复后**直接重新提交 phase-gate**(跳过 review-gate/test-fix loop,因为内容质量已在前面通过)。

### 4 循环终止条件

**Review-Gate(Phase 3 循环模式)**:

| 条件 | 行为 |
|------|------|
| must_fix = 0 | 通过 |
| 达到最大轮数(3) | 强制通过(警告) |
| 连续 2 轮 must_fix 不降 | 人工介入 |

**Phase-Gate(所有 phase,2 步检查)**:

| 条件 | 行为 |
|------|------|
| 脚本检查 + 防伪造检查全部通过 | 通过,进入 retrospect |
| 有失败项 | 返回主 agent 修复,修复后直接重新提交 phase-gate |

### 5 与现有流程的变更点

| 操作 | 目标 |
|------|------|
| 删除 | SKILL.md 中的 Self-Review、Plan Review 等 review 章节 |
| 删除 | SKILL.md 中的 Gate Handoff 章节 |
| 保留 | 设计步骤(如 ADR Evaluation) |
| 保留 | 格式检查项(交付物验证中的格式部分) |
| 新增 | "完成后调用 coding-workflow-gate" 指导 |
| 修改 | Retrospect 触发方式统一为 phase-gate 通过后 |

## 已分析结果

### Phase 1 Spec

| 步骤 | 配置 |
|------|------|
| 1 产出物 | 多文件文档(spec.md + use-cases.md + non-functional-design.md) |
| 2 Review-Gate | Workflow 循环:agent 审查+修复 → 判断退出。最多 3 轮 |
| 3 Phase-Gate | 脚本检查(文档完整性+YAML+placeholder),失败打回主 agent 直接修复 |
| 4 终止 | Review-Gate 最多 3 轮;Phase-Gate 脚本通过即止 |
| 5 变更 | 删 Spec Review + Gate Handoff;新增整体流程指导 + goal 追踪 |

**完整流程**:
```
1. [Skill] xyz-harness-brainstorming
   → 告知主 agent 整体 5-phase 执行流程
   → focus on 当前目标:完成 spec 阶段的 review-gate
2. [固定] Brainstorming + 用户讨论(多轮)
3. [Goal] 主 agent 初始化 goal 追踪,每个 spec 交付物作为一个任务:
   - Task 1: spec.md
   - Task 2: use-cases.md
   - Task 3: non-functional-design.md
   → 用户手动调用 /goal 启动
4. [固定] 主 agent 按顺序编写 spec 交付物(每完成一个 md 更新 goal)
5. [Workflow] Review-Gate(循环):
   5a. [Agent] spec-requirements-reviewer.md 审查 + 直接修复
   5b. 判断:must_fix = 0 → 通过 / > 0 → 继续循环
   最多 3 轮
6. [脚本] Phase-Gate: 统一脚本检查
   → FAIL: 返回主 agent,告知修复后直接重新提交 phase-gate(跳过 review-gate)
   → PASS: 继续
7. [Subagent] Retrospect (fork session)
```

**Goal 工具注入方式**:

Phase 1 需要用户手动触发 `/goal`。SKILL.md 中增加指导"编写 spec 交付物前,建议用户使用 /goal 工具初始化任务追踪"。Steering prompt 在 `before_agent_start` 时注入,主 agent 收到后提示用户,由用户触发 /goal。

任务列表(供主 agent 参考):
- Task 1: spec.md
- Task 2: use-cases.md
- Task 3: non-functional-design.md

### Phase 2 Plan

| 步骤 | 配置 |
|------|------|
| 1 产出物 | 多文件文档(5-9 个,取决于 L1/L2) |
| 2 Review-Gate | Workflow 循环:agent 审查+修复 → 判断退出。最多 3 轮 |
| 3 Phase-Gate | 脚本检查(文档完整性+YAML+placeholder),失败打回主 agent 直接修复 |
| 4 终止 | Review-Gate 最多 3 轮;Phase-Gate 脚本通过即止 |
| 5 变更 | 删 Self-Review + Plan Review + Gate Handoff;新增 goal 追踪 |

**L2 产出物清单**:

| 文件 | L1 | L2 |
|------|:---:|:---:|
| plan.md | ✅ | ✅ |
| e2e-test-plan.md | ✅ | ✅ |
| test_cases_template.json | ✅ | ✅ |
| use-cases.md | ✅ | ✅ |
| non-functional-design.md | ✅ | ✅ |
| plan-backend.md | ❌ | ✅ |
| plan-frontend.md | ❌ | ✅ |
| plan-api-contract.md | ❌ | ✅ |
| interface_chain.json | ❌ | ✅ |

**任务依赖关系与并行编排设计**:

Phase 2 的 plan 产出物需要考虑 Phase 3 实际编码时的依赖关系:

1. **Execution Groups 与 Wave 编排** - plan.md 中必须声明 Execution Groups 和 Wave Schedule。Wave 编排决定了 Phase 3 中 subagent 的并行度。
   - 同一 Wave 内的 Group 可以并行执行(最多 3 个 subagent)
   - 不同 Wave 之间串行(前一个 Wave 全部完成后才开始下一个)
   - Group 之间的依赖关系用 DAG 表示,Wave 是 DAG 的拓扑排序分层

2. **interface_chain.json 的角色** - L2 必须产出,定义模块间的接口签名。Phase 3 的 Integration Reviewer 依赖此文件验证模块衔接。Phase 3 编码时,不同 Execution Group 的 subagent 按此文件约定的接口并行开发。

3. **依赖标注格式** - plan.md 中每个 Execution Group 必须标注:
   - `depends_on: [group_id1, group_id2]` - 本 group 依赖哪些 group 的产出
   - `provides: [interface1, interface2]` - 本 group 产出哪些接口(供下游 group 消费)
   - `wave: N` - 所属 Wave 编号

#### 测试 Plan 细化要求(新增)

Phase 2 的 e2e-test-plan.md 和 test_cases_template.json 需要进一步细化,为 Phase 4 的并行化测试提供基础:

1. **测试用例依赖关系标注** - test_cases_template.json 中每个测试用例必须标注:
   - `depends_on: ["TC-1-01"]` - 本用例依赖哪些用例先通过(如先创建数据才能查询)
   - `test_group: "auth"` - 所属测试分组(同组内可并行)
   - `wave: N` - 所属 Wave(同 Wave 内用例可并行执行)

2. **可并行化标注** - e2e-test-plan.md 中必须声明:
   - 哪些测试组可以并行执行(无共享状态、无数据依赖)
   - 哪些测试必须串行(依赖上游测试创建的数据)
   - 是否需要多个 browser 进程并行(Playwright)

3. **不可测试部分声明** - e2e-test-plan.md 中必须声明:
   - 哪些 AC/FR 无法自动化测试(第三方依赖、支付流程、物理设备等)
   - 每个不可测试项给出手动验证步骤
   - 不可测试项标记为 `verification_method: manual`,在 test_cases_template.json 中 `type: manual`

4. **环境依赖标注** - e2e-test-plan.md 中每个测试场景标注:
   - 需要的运行环境(backend-only / frontend-only / full-stack)
   - 需要的 mock/stub(外部 API、数据库状态)
   - 需要的测试数据准备步骤

**Plan 交付物编写顺序**:

L2 的 9 个交付物有明确的编写顺序依赖:

```
Step 1: plan.md(总纲)- 必须先写,定义架构和 Execution Groups
Step 2: plan-api-contract.md - 定义接口契约,无上游设计依赖
Step 3: plan-backend.md + plan-frontend.md(并行)- 依赖 plan.md 总纲 + plan-api-contract.md
Step 4: interface_chain.json - 从 plan-backend.md + plan-frontend.md + plan-api-contract.md 提取接口链
Step 5: e2e-test-plan.md + test_cases_template.json - 依赖 plan.md 的 Execution Groups
Step 6: use-cases.md + non-functional-design.md - 依赖 spec.md(与 plan 编写无强依赖,可与 Step 1-5 并行)
```

L1 的 5 个交付物顺序简化:
```
Step 1: plan.md(含 Execution Groups)
Step 2: e2e-test-plan.md + test_cases_template.json
Step 3: use-cases.md + non-functional-design.md
```

**完整流程**:
```
1. [Skill] xyz-harness-writing-plans 加载
2. [主 Agent] 复杂度评估(L1/L2)- 不用 subagent,主 agent 直接执行
3. [Goal] 初始化 goal 追踪,每个 plan 交付物作为一个任务:
   L2 示例:plan.md / plan-api-contract.md / plan-backend.md / plan-frontend.md / interface_chain.json / e2e-test-plan.md / test_cases_template.json / use-cases.md / non-functional-design.md
   L1 示例:plan.md / e2e-test-plan.md / test_cases_template.json / use-cases.md / non-functional-design.md
   → 用户手动调用 /goal 启动
4. [主 Agent] 按 Step 顺序编写 plan 交付物(不并行,不 dispatch subagent)
   L2: 6 steps / L1: 3 steps(每完成一个交付物更新 goal)
5. [主 Agent] ADR 评估 - 不用 subagent
6. [Workflow] Review-Gate(循环):
   6a. [Agent] plan-requirements-reviewer.md 审查 + 直接修复
       L2 额外: plan-bl-requirements-reviewer.md 并行审查
   6b. 判断:must_fix = 0 → 通过 / > 0 → 继续循环
   最多 3 轮
7. [脚本] Phase-Gate: 统一脚本检查
   → FAIL: 返回主 agent,告知修复后直接重新提交 phase-gate(跳过 review-gate)
   → PASS: 继续
8. [Subagent] Retrospect (fork session)
```

**Goal 工具注入方式**：

Phase 2 进入时（`executePhaseStartTool` 入口），先注入 L1 默认任务列表。Steering prompt 指导主 agent 先做复杂度评估，评估为 L2 后调用 `goal_manager.add_tasks()` 追加额外任务。

**L1 默认任务**（入口注入）：
1. Write plan.md (with Execution Groups)
2. Write e2e-test-plan.md + test_cases_template.json
3. Write use-cases.md + non-functional-design.md

**L2 追加任务**（评估为 L2 后追加）：
4. Write plan-api-contract.md
5. Write plan-backend.md
6. Write plan-frontend.md
7. Write interface_chain.json

```typescript
import { initializeGoalFromExternal } from "@zhushanwen/pi-goal";
initializeGoalFromExternal(pi, ctx, "Phase 2: 完成 plan 阶段交付物", L1_TASKS);
// steering prompt 指导主 agent 评估后 add_tasks
```

### Phase 3 Dev

#### 1 产出物分析

| 问题 | 答案 |
|------|------|
| 产出物是什么? | 多文件代码 + 测试代码 + review 报告 + test_results.md |
| 产出物复杂度? | **高**(千行级代码,多文件跨模块,可能跨前后端) |
| 内容审查重点? | 代码质量:业务逻辑正确性、规范合规、代码品味、健壮性、模块集成 |
| 格式审查重点? | review 报告 YAML frontmatter(verdict/must_fix/review_metrics)、test_results.md(all_passing 布尔值) |

**Review-Gate 产出物**(reviewer subagent 写入):

| 文件 | 产出者 | 消费者 |
|------|--------|--------|
| `changes/reviews/phase-3/spec_plan_conformance_v{N}.md` | Spec-Plan-Conformance reviewer | sync-agent |
| `changes/reviews/phase-3/business_logic_review_v{N}.md` | BLR reviewer | Integration reviewer + sync-agent |
| `changes/reviews/phase-3/standards_review_v{N}.md` | Standards reviewer | sync-agent |
| `changes/reviews/phase-3/ts_taste_review_v{N}.md` | Taste reviewer | sync-agent |
| `changes/reviews/phase-3/robustness_review_v{N}.md` | Robustness reviewer | sync-agent |
| `changes/reviews/phase-3/fallow_report_v{N}.md` | Fallow audit | sync-agent |
| `changes/reviews/phase-3/integration_review_v{N}.md` | Integration reviewer | sync-agent |

**Phase-Gate 产出物**:

| 文件 | 说明 |
|------|------|
| `changes/evidence/test_results.md` | 测试结果(all_passing: true) |
| `changes/reviews/phase-3/dev_retrospect.md` | Retrospect |

#### 2 Review-Gate 配置

| 问题 | 答案 |
|------|------|
| 模式? | **两阶段循环 Workflow**(Phase 3 独有) |
| 需要几个 reviewer? | **前置 1 个 + 并行 5 个 + 1 个 Integration + 1 个 sync-agent** |
| 是否有复杂度分级? | 否(L1/L2 在 Phase 2 已决定,Dev 阶段执行相同的审查流程) |
| 需要 agent.md 还是复用现有? | **新建 spec-plan-conformance-reviewer.md** + **复用现有 5 个 SKILL.md** + **fallow CLI** + **新建 sync-agent.md** |

**两阶段审查设计**:

Phase 3 的 Review-Gate 分为两个阶段,第一阶段是前置门控,不通过则后续审查无意义:

**阶段一:规格符合性审查(前置节点,独立循环)**

审查代码实现是否符合 spec.md 和 plan.md 中的描述。这是第一个审查节点,如果代码连规格要求都没实现,后续的质量审查没有意义。

| 维度 | Agent | 输入 | 输出 | 依赖 | 循环 |
|------|-------|------|------|------|------|
| Spec-Plan Conformance | `spec-plan-conformance-reviewer.md`(新建) | spec.md + plan.md + git diff | spec_plan_conformance_v{N}.md | 无 | **独立循环,must_fix=0 才进入阶段二** |

**阶段二:多维度质量审查(并行 + 串行,循环修复)**

前置节点通过后,进入多维度并行审查。失败的根因是代码错误,subagent 可以自动修复。

**为什么 Phase 3 可以复用现有 SKILL.md 而不需要新建 agent.md?**

因为 5 个 reviewer 各有完全独立的 SKILL.md(xyz-harness-business-logic-reviewer、xyz-harness-standards-reviewer 等),每份 SKILL.md 定义了完整的审查方法论、输入输出格式、维度清单。不同于 Phase 1/2 复用 expert-reviewer 同一个 skill + 不同 task prompt 的问题,Phase 3 的每个 reviewer 本身就是独立的方法论文档。符合 Agent 文件规则 [MANDATORY] 的"每个 reviewer 有独立的角色定义"要求。

**Fix Worker(合并 Sync 职责)**:汇总 5 个 reviewer 报告,判断 must_fix,决定是否修复或通过。

**前置审查整合**:

BLR(业务逻辑审查)和 spec-plan-conformance(规格符合性审查)审查内容高度重叠(都在对比 spec+plan vs 代码实现)。合并为 **spec-plan-conformance-reviewer.md**,职责:审查代码实现是否符合 spec.md + plan.md 的描述,包括业务逻辑正确性和 AC 覆盖。

**Reviewer 详细配置**:

| 维度 | Agent/Skill | 输入 | 输出 | 依赖 |
|------|------------|------|------|------|
| Spec+BLR(前置) | `spec-plan-conformance-reviewer.md`(新建) | spec.md + plan.md + use-cases.md + git diff + 源代码 | spec_plan_conformance_v{N}.md | 无 |
| Standards | `xyz-harness-standards-reviewer` | git diff + CLAUDE.md | standards_review_v{N}.md | 无 |
| Taste | `ts-taste-check` / `rust-taste-check` | git diff | ts_taste_review_v{N}.md | 无 |
| Robustness | `xyz-harness-robustness-reviewer` | git diff | robustness_review_v{N}.md | 无 |
| Code Quality | `fallow`(CLI 工具) | git diff(变更文件) | fallow_report_v{N}.md | 无 |
| Integration | `xyz-harness-integration-reviewer` | 源代码 | integration_review_v{N}.md | 无 |
| Fix Worker | `fix-worker.md`(新建,合并 sync) | 5 份 review report | fix_summary_v{N}.json + 代码修复 | 全部 reviewer 完成 |

**Fallow 审查**:`fallow audit --format json --base main` - 对变更文件做 dead-code + complexity + duplication 综合审计,将 JSON 结果转为结构化 review 报告。Fallow 退出码 1 表示"issues found"(正常),不是运行错误。需要 `|| true` 防止误判。

**执行编排**(整体是一个 Workflow):

```
Review-Gate(Workflow):

  ═══ 阶段一:前置检查(单次,不循环)═══
  Spec+BLR Conformance Review (spec-plan-conformance-reviewer.md)
      │
      ├─ PASS → 进入阶段二
      └─ FAIL → 打回主 agent
           1. 重新启动 goal 状态(回到编码阶段)
           2. 主 agent 检查缺失能力
           3. 重新拆分 Wave 编码
           4. 编码完成 → 重新提交 review-gate

  ═══ 阶段二:并行审查 + 循环修复 ═══
  ┌─ Step 1: 并行审查 ─────────────────────┐
  │  ┌─ Standards ──────────────────────┐  │
  │  ├─ Taste ─────────────────────────┤  │
  │  ├─ Robustness ────────────────────┤  │
  │  ├─ Fallow ────────────────────────┤  │
  │  ├─ Integration ──────────────────┤  │
  │  └─────────────────────────────────┘  │
  │  Step 1: Fix Worker(汇总 + 判断 + 修复)    │
  │    汇总 5 个 reviewer 的 must_fix           │
  │    must_fix = 0 → Review-Gate PASSED        │
  │    must_fix > 0 → 分析依赖→Wave 拆分        │
  │           → subagent 修复 → git commit      │
  │           → 回到 Step 1 并行审查             │
  └──────────────────────────────────────────────┘
```

**阶段一失败后的处理**:

打回主 agent 后,主 agent 不会回到 review-gate,而是回到编码阶段:
1. 重新启动 goal(`initializeGoalFromExternal()` 或重置现有 goal 状态)
2. 主 agent 分析 spec-plan-conformance 报告中的问题
3. 重新拆分 Wave(可能需要调整 Execution Groups)
4. 重新编码 → 测试验证 → commit → 重新提交 review-gate(从阶段一开始)

**阶段二 Step 3 Fix Worker 的智能修复**:

不是简单串行修复,而是分析 5 个 reviewer 的 must_fix 列表,按文件依赖关系分组:
1. 收集所有 must_fix 项,按涉及文件分组
2. 分析文件间依赖关系(A 文件的修复依赖 B 文件先修好)
3. 按 Wave 拆分修复任务(同 Wave 无依赖可并行)
4. 按 Wave 执行 subagent 修复
5. 修复完成 → git commit → 回到 Step 1 重新审查

**Taste Review 语言分支**:

| 项目类型 | Skill | 跳过条件 |
|---------|-------|----------|
| TypeScript | `ts-taste-check` | - |
| Rust | `rust-taste-check` | - |
| Python | `~/.codetaste/essence.md`(注入 task prompt) | 文件不存在时跳过 |
| 纯文档/脚本 | 跳过 | 在 standards_review 中注明 |

#### 3 Phase-Gate 配置

与 Phase 1/2 相同的 workflow 模式,差异只在交付物列表。

**交付物列表**:

| 文件 | 检查项 |
|------|--------|
| spec_plan_conformance_v{N}.md | YAML frontmatter: verdict=pass, must_fix=0 |
| standards_review_v{N}.md | YAML frontmatter: verdict=pass, must_fix=0 |
| ts_taste_review_v{N}.md | YAML frontmatter: verdict=pass, must_fix=0 |
| robustness_review_v{N}.md | YAML frontmatter: verdict=pass, must_fix=0 |
| fallow_report_v{N}.md | YAML frontmatter: verdict=pass, must_fix=0 |
| integration_review_v{N}.md | YAML frontmatter: verdict=pass, must_fix=0 |
| test_results.md | YAML: verdict=pass, all_passing=true(布尔值) |
| dev_retrospect.md | YAML: phase=dev, verdict=pass |

| 组件 | 说明 |
|------|------|
| 脚本检查 | 统一脚本:文档完整性 + YAML frontmatter + placeholder 扫描 |
| 防伪造检查 | `xyz-harness-gate-reviewer` subagent:验证 review 报告内容非空、test_results 包含实际命令输出、代码变更真实存在 |

**Phase 3 Phase-Gate 严格度**：

所有 phase 都是 2 步（脚本检查 + 防伪造检查）。Phase 3 的防伪造比 Phase 1/2 更严格：额外验证代码变更真实存在、review 报告内容非空、test_results 包含实际命令输出。使用现有的 `xyz-harness-gate-reviewer` skill。

#### 4 循环终止条件

**Review-Gate(两阶段 Workflow)**:

**阶段一(前置检查,单次不循环)**:

| 条件 | 行为 |
|------|------|
| must_fix = 0 | 通过,进入阶段二 |
| must_fix > 0 | 打回主 agent,重新进入 goal 编码状态 |

**阶段二(并行审查 + Fix Worker 循环)**:

| 条件 | 行为 |
|------|------|
| must_fix = 0(Fix Worker 汇总判断) | 通过,触发 Phase-Gate |
| must_fix > 0 | Fix Worker 分析依赖→Wave 拆分→subagent 修复→回到并行审查 |
| 达到最大轮数(3) | 强制通过(警告) |
| 连续 2 轮 must_fix 不降 | 人工介入 |

**Phase-Gate(脚本 + 防伪造)**:

| 条件 | 行为 |
|------|------|
| 脚本检查通过 + 防伪造通过 | 通过,进入 retrospect |
| 脚本检查失败 | 返回主 agent 修复,修复后直接重新提交 phase-gate |
| 防伪造失败 | 返回主 agent,告知伪造嫌疑项,修复后重新提交 phase-gate |

#### 5 与现有流程的变更点

| 操作 | 目标 |
|------|------|
| **删除** | Step 4(Five-Step Specialized Review)全部内容 - 改由 review-gate workflow 执行 |
| **删除** | Step 4a(Retrospect)- 改由 phase-gate 通过后自动 dispatch |
| **删除** | Step 6(Self-Check)中的 review 文件检查项 - 改由 gate 保证 |
| **删除** | Step 7(Gate Handoff)- 不再需要单独 session,主 agent 调用 coding-workflow-gate 即可 |
| **删除** | Step 8(Tell user)中的"run gate check in a separate session" |
| **保留** | Step 0(防护预检)- 编码前检查 |
| **保留** | TDD/编码逻辑 - 简单/复杂路径判断、接口签名传递规则 |
| **保留** | test_results.md 格式 |
| **保留** | git commit + push |
| **新增** | Goal 追踪(用户触发 /goal,按 spec+plan 拆分任务:TDD测试→Wave编码→多轮测试验证→commit) |
| **新增** | "完成后调用 coding-workflow-gate(phase=3)" |
| **修改** | Phase Loop 机制 - gate tool 内部管理循环 |

**完整流程**:
```
1. [Skill] xyz-harness-phase-dev 加载
2. [Goal] 自动初始化(`initializeGoalFromExternal()`),按 spec+plan 拆分任务
3. [主 Agent] 防护预检(Step 0)
4. [主 Agent] 根据 spec.md + plan.md 拆分 goal 任务(见下方 Goal 任务构造)
5. [主 Agent/Subagent] 按 Goal 任务顺序执行:
   Task 1: TDD 测试编写(根据 spec+plan 写测试用例)
   Task 2..N: Wave 编排执行(按 Execution Group dispatch subagent 编码)
   Task M-2: 运行全量测试 + 修复
   Task M-1: 复跑测试 + 修复
   Task M: 再跑测试 + 修复
   Task M+1: 写 test_results.md + git commit + push
6. [Workflow] Review-Gate(调用 coding-workflow-gate(phase=3) 内部执行)
   前置节点: spec-plan-conformance-reviewer(独立循环)
   Batch 1: BLR + Standards + Taste + Robustness + Fallow(并行)
   Batch 2: Integration(依赖 BLR)
   Sync Agent → must_fix > 0 → Fix Worker → 回到 Batch 1
7. [脚本] Phase-Gate: 统一脚本检查
   → FAIL: 打回主 agent 修复,修复后直接提交 phase-gate
   → PASS: 继续
8. [Subagent] Retrospect (fork session)
```

**Goal 任务构造**(根据 spec+plan 动态拆分):

```
Task 1: TDD 测试编写
  → 根据 spec 的 AC + plan 的 Execution Groups,为每个 task 编写测试用例
  → 简单路径:主 agent 直接编写
  → 复杂路径:dispatch TDD coder subagent
  → 完成标准:测试文件存在,运行后全部失败(RED 状态)

Task 2: Wave 1 编码
  → 按 plan 的 Execution Groups(Wave 1 的 groups)编码
  → 简单路径:主 agent 按 TDD 红→绿→重构
  → 复杂路径:dispatch subagent per group,注入接口签名
  → 完成标准:Wave 1 的所有测试通过

Task 3: Wave 2 编码(如果有)
  → 同 Task 2,但使用 Wave 2 的 groups
  → 依赖 Wave 1 产出的接口
...

Task N: 运行全量测试 + 修复
  → 运行所有测试(包括已有),确认 0 failures
  → 有失败则修复后重新运行

Task N+1: 复跑测试(二次验证)
Task N+2: 再跑测试(稳定性检查)

Task N+3: 写 test_results.md + git commit + push
  → 生成 test_results.md(verdict: pass, all_passing: true)
  → git add -A && git commit && git push
```

**Goal 工具注入方式**:

Phase 3 在 `coding-workflow-phase-start` tool handler 中自动初始化 goal,调用 `initializeGoalFromExternal()` API。不需要用户手动触发 /goal。

```typescript
// coding-workflow/lib/tool-handlers.ts - executePhaseStartTool
if (state.currentPhase === 3) {
  const plan = readPlan(state.topicDir);
  const executionGroups = extractExecutionGroups(plan);
  const taskList = buildDevGoalTasks(executionGroups);
  initializeGoalFromExternal(pi, ctx, "Phase 3: Dev 编码实现", taskList);
}

function buildDevGoalTasks(groups: ExecutionGroup[]): string[] {
  const tasks: string[] = [];
  // Task 1: TDD 测试编写
  tasks.push(`TDD 测试编写:根据 spec AC + plan 编写所有 Execution Group 的测试用例`);
  // Tasks 2..N: Wave 编排
  for (const wave of groupWaves(groups)) {
    tasks.push(`Wave ${wave.number} 编码:${wave.groups.map(g => g.id).join(', ')}`);
  }
  // Tasks N+1..N+3: 测试验证
  tasks.push('运行全量测试 + 修复失败');
  tasks.push('复跑测试(二次验证)');
  tasks.push('再跑测试(稳定性检查)');
  tasks.push('写 test_results.md + git commit + push');
  return tasks;
}
```

### Phase 4 Test

> **详细规格见 `docs/phase-specs/phase-4-test.md`。本节为摘要。**

| 步骤 | 配置 |
|------|------|
| 1 产出物 | test-execute-v{N}-core.json + test-execute-v{N}-noncore.json + test_retrospect.md |
| 2 Review-Gate | ❌ **无**(Test-Fix Loop Workflow 替代) |
| 3 Test-Fix Loop | 2 个串行 Workflow:先核心业务 case,再非核心 case。无限循环直到全部通过 |
| 4 Phase-Gate | 3 层次严格防伪造(脚本检查 + 一致性比对 + 深度质疑) |
| 5 终止 | Loop 最大 10 Turn 或连续 3 轮 failed 不降 |
| 6 变更 | 去掉 Review-Gate;新增 Test-Fix Loop;Phase-Gate 最严格 |

#### 核心机制:Test-Fix Loop Workflow

Phase 4 与其他 phase 的核心区别:**测试需要反复执行(测试→修复→重测)**,不是一次性 Wave 并行。因此用 Workflow Loop 替代 Review-Gate。

Loop 内部:构造/读取版本化 test-execute JSON → Wave 并行测试 → 汇总判断 → Fix Worker 修复 → 回到 Loop 顶部。

2 个串行 Workflow:Workflow 1(核心业务 case)全部通过后才开始 Workflow 2(非核心 case)。

**case 过滤逻辑**:从 test_cases_template.json 构造 test-execute v1 时,**只取 phase=4 的 case**(phase=3 的 unit case 已在 Phase 3 TDD 中执行完毕)。

#### Phase-Gate:3 层次严格防伪造

| 层次 | 检查内容 | 🔴 核心 | 🟡 非核心 |
|------|---------|---------|----------|
| 1. 脚本检查 | JSON 格式 + 最终 version 全部 passed/skipped | ✅ | ✅ |
| 2. 一致性比对 | test_cases_template.json 与 Phase 2 commit 版本比对 | 逐字节 | 抽查 |
| 3. 跳过理由质疑 | 每个 skipped case 的理由是否充分 | 必须环境日志 | 文字说明 |
| 3. 测试结果真实性 | evidence 是否包含实际命令输出 | 必须执行日志 | 通过即可 |

## Agent 文件规划

| Phase | Review-Gate Agent | Phase-Gate Agent |
|-------|-------------------|-----------------|
| 1 Spec | `spec-requirements-reviewer.md` | `deliverables-reviewer.md`(通用) |
| 2 Plan L1 | `plan-requirements-reviewer.md` | `deliverables-reviewer.md` |
| 2 Plan L2 | `plan-requirements-reviewer.md` + `plan-bl-requirements-reviewer.md` | `deliverables-reviewer.md` |
| 3 Dev | `spec-plan-conformance-reviewer.md`(新建,前置节点)+ 5 个现有 SKILL.md + `fallow`(CLI)+ `sync-agent.md` | `deliverables-reviewer.md` |
| 4 Test | ❌ 无(Test-Fix Loop 替代) | `deliverables-reviewer.md` + 严格 3 层次防伪造 |

## 分析历史

| Phase | 分析轮次 | 关键决策 |
|-------|---------|---------|
| Spec | 第 3 轮 | Review-Gate 改为 Workflow 循环(agent 审查+修复+判断退出);Phase-Gate 简化为脚本检查(失败打回主 agent 直接修复,不再经过 review-gate);新增 Goal 追踪(用户手动触发) |
| Plan | 第 3 轮 | 前 4 步(skill/评估/编写/ADR)改为主 agent 顺序执行不用 subagent;新增 Goal 追踪;Review-Gate 改为 Workflow 循环;Phase-Gate 简化 |
| Dev | 第 4 轮 | 新增前置节点 spec-plan-conformance-reviewer(独立循环)+ Fallow 审查维度;Review-Gate 两阶段:先规格符合性,再并行 5 维度质量审查 |
| Test | 第 4 轮 | 去掉 Review-Gate；改为 Test-Fix Loop Workflow（无限循环，2 个串行 workflow）；Phase-Gate 最严格防伪造（3 层次）；产出物改为 test-execute-v{N}.json（版本化状态管理） |
