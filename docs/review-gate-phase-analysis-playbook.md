# Review-Gate Phase 分析范式

用于分析每个 phase 的 gate 配置。每个 phase 有两层 gate:review-gate(需求/内容审查)和 phase-gate(文档格式审查),顺序执行。

## Gate 分层设计

### Review-Gate(需求/内容审查)

审查交付物的**内容质量**:需求是否穷尽、逻辑是否正确、设计是否合理。

| Phase | 模式 | 失败行为 |
|-------|------|---------|
| 1 Spec | Workflow 循环(agent 审查+修复) | 循环内自动修复,最多 3 轮 |
| 2 Plan | Workflow 循环(agent 审查+修复) | 循环内自动修复,最多 3 轮 |
| 3 Dev | 循环 workflow(parallel review → sync → fix) | 循环内自动修复,最多 3 轮 |
| 4 Test | Workflow 循环(agent 审查+修复) | 循环内自动修复,最多 3 轮 |

**说明**:所有 phase 的 review-gate 都是 workflow 循环模式。Phase 3 差异在于多维度并行审查 + sync-agent,其他 phase 是单个 agent 审查+修复。循环内 reviewer 发现问题后直接修复,修完重新审查,直到 must_fix=0。

### Phase-Gate(文档格式检查)

所有 phase 共享简化的脚本检查模式。**一次性脚本检查,失败打回主 agent。**

```
Phase-Gate 执行:
  1. 统一脚本检查:文档完整性 + YAML frontmatter + placeholder 扫描
  2. 通过 → dispatch retrospect subagent
  3. 失败 → 返回主 agent,告知修复后直接重新提交 phase-gate
     (跳过 review-gate,因为内容质量已在 review-gate 中通过)
```

Phase-gate 不关心内容是否正确(那是 review-gate 的职责),只关心格式是否合规。

### 两层 Gate 的关系

```
Review-Gate PASSED → 自动触发 Phase-Gate → Phase-Gate PASSED → Retrospect → 下一 Phase
```

主 agent 只感知到调一次 `coding-workflow-gate(phase=N)`,gate tool 内部先跑 review-gate 再跑 phase-gate。

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
| 模式? | 单次检查(Phase 1/2/4)/ 循环 workflow(Phase 3) |
| 需要几个 reviewer? | 1 个 / 多个 |
| 是否有复杂度分级(L1/L2)? | 是(每级独立配置)/ 否 |
| 需要 agent.md 还是复用现有? | 新建 agent.md / 复用现有 SKILL.md |

**Agent 文件规则 [MANDATORY]**:
- 每个 reviewer 必须有独立的 agent.md,禁止"复用 expert-reviewer + 不同 task prompt"模式
- task prompt 只注入简单差异化内容:文件路径、输出目录、round 编号、上一轮报告路径
- task prompt 不包含审查逻辑、审查步骤、输出格式定义--这些全部在 agent.md 中
- 唯一例外:审查逻辑完全相同且已有独立 SKILL.md 的(如 Phase 3 的 5 个专项 reviewer)

### 3 Phase-Gate 配置

所有 phase 共享简化的脚本检查模式。**不再是 workflow 循环**,而是一次性脚本检查。

| 组件 | 说明 |
|------|------|
| 统一脚本检查 | 检查文档完整性、YAML frontmatter 格式、placeholder 扫描、字段合法性 |
| 失败处理 | 返回主 agent,告知修复后直接重新提交 phase-gate(**不再经过 review-gate**) |

**关键变更**:Phase-Gate 不再内部循环 doc-review-and-fix。原因:格式问题通常简单且机械,主 agent 自己就能修,不需要 subagent 循环。失败后直接打回主 agent 修复,修复后**直接重新提交 phase-gate**(跳过 review-gate,因为内容质量已经在 review-gate 中通过)。

### 4 循环终止条件

**Review-Gate(Phase 3 循环模式)**:

| 条件 | 行为 |
|------|------|
| must_fix = 0 | 通过 |
| 达到最大轮数(3) | 强制通过(警告) |
| 连续 2 轮 must_fix 不降 | 人工介入 |

**Phase-Gate(所有 phase,脚本检查)**:

| 条件 | 行为 |
|------|------|
| 脚本检查全部通过 | 通过,进入 retrospect |
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

**Goal 工具注入方式**:

Phase 2 进入时(`executePhaseStartTool` compact 后),coding-workflow 自动调用 goal extension 导出的 `initializeGoalFromExternal()` API,根据 L1/L2 复杂度写入不同的任务列表:

```typescript
const L1_TASKS = [
  "Write plan.md (with Execution Groups)",
  "Write e2e-test-plan.md + test_cases_template.json",
  "Write use-cases.md + non-functional-design.md",
];

const L2_TASKS = [
  "Write plan.md (architecture overview)",
  "Write plan-api-contract.md",
  "Write plan-backend.md + plan-frontend.md",
  "Write interface_chain.json",
  "Write e2e-test-plan.md + test_cases_template.json",
  "Write use-cases.md + non-functional-design.md",
];
```

主 agent 不需要用户手动触发 `/goal`,goal state 已由 coding-workflow 自动创建。主 agent 后续调用 `goal_manager.update_tasks` 追踪进度。

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

**Phase 3 Phase-Gate 与 Phase 1/2 的差异**:

Phase 1/2 的 Phase-Gate 只做脚本检查。Phase 3 的 Phase-Gate 额外增加防伪造检查,使用现有的 `xyz-harness-gate-reviewer` skill。原因:Phase 3 产出的是代码和测试结果,AI 更容易伪造(编造测试结果、跳过实际运行),需要独立 subagent 验证真实性。

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

| 步骤 | 配置 |
|------|------|
| 1 产出物 | test_execution.json + test_retrospect.md |
| 2 Review-Gate | Workflow 循环:agent 审查+修复 → 判断退出。最多 3 轮 |
| 3 Phase-Gate | 脚本检查(文档完整性+YAML+placeholder),失败打回主 agent 直接修复 |
| 4 终止 | Review-Gate 最多 3 轮;Phase-Gate 脚本通过即止 |
| 5 变更 | 新增 Goal 追踪 + Wave 并行化 + 不可测试项声明 |

#### 1 产出物分析

| 问题 | 答案 |
|------|------|
| 产出物是什么? | test_execution.json(测试执行记录)+ test_retrospect.md |
| 产出物复杂度? | **中**(测试用例数取决于 plan,可能有 10-50 个用例) |
| 内容审查重点? | 测试覆盖度、断言有效性、失败用例修复质量 |
| 格式审查重点? | test_execution.json 格式(round/passed/caseId 字段) |

#### 2 Review-Gate 配置

| 问题 | 答案 |
|------|------|
| 模式? | **Workflow 循环** |
| 需要几个 reviewer? | **1 个**(test-requirements-reviewer.md) |

Agent: `test-requirements-reviewer.md`
审查内容:测试覆盖度、断言有效性、mock 合理性、边界场景覆盖、不可测试项标记
输入:test_cases_template.json + test_execution.json + e2e-test-plan.md
输出:`changes/reviews/phase-4/test_requirements_review_v{N}.md`

#### 3 Phase-Gate 配置

同所有 phase:统一脚本检查(文档完整性+YAML+placeholder),失败打回主 agent 直接修复。

#### 4 循环终止条件

**Review-Gate**:最多 3 轮。must_fix=0 通过。

**Phase-Gate**:脚本检查通过即止。

#### 5 与现有流程的变更点

| 操作 | 目标 |
|------|------|
| **新增** | Goal 追踪:用户触发 /goal,每个测试组作为一个任务 |
| **新增** | Wave 并行化:按 e2e-test-plan.md 中的 Wave 编排 dispatch 测试 subagent |
| **新增** | 不可测试项声明:从 plan 中提取 manual 类型用例,输出给用户手动验证 |
| **新增** | Playwright 并行:需要多个 browser 进程时,启动多个 subagent 并行执行 |
| **保留** | test_execution.json 格式不变 |
| **保留** | Self-Check 中的 FR→TC 覆盖矩阵 |

**完整流程**:
```
1. [Skill] xyz-harness-phase-test
2. [主 Agent] 读取 test_cases_template.json + e2e-test-plan.md
3. [主 Agent] 分析依赖关系和并行化机会:
   - 按用例的 depends_on / test_group / wave 字段构建 DAG
   - 按环境依赖(backend-only / frontend-only / full-stack)分组
   - 识别需要 Playwright 的前端测试
4. [Goal] 用户触发 /goal,每个测试 Wave 作为一个任务:
   - Wave 1: 独立 API 测试(无依赖)
   - Wave 2: 依赖 Wave 1 数据的集成测试
   - Wave N: ...
   - Final: 不可测试项列表(输出给用户)
5. [Subagent] 按 Wave 编排执行测试:
   - 同一 Wave 内的测试用例并行 dispatch(最多 3 个 subagent)
   - API 测试:curl/httpx 直接调用
   - Frontend 测试:Playwright browser 进程并行
   - Integration 测试:service-level 验证
   - 每个子任务完成一个用例组,写入 test_execution.json 片段
6. [主 Agent] 合并所有 Wave 的 test_execution.json 片段
7. [主 Agent] 标记不可测试项(type: manual),输出手动验证清单给用户
8. [Workflow] Review-Gate(循环):
   8a. [Agent] test-requirements-reviewer.md 审查 + 直接修复
   8b. 判断:must_fix = 0 → 通过 / > 0 → 继续循环
   最多 3 轮
9. [脚本] Phase-Gate: 统一脚本检查
   → FAIL: 返回主 agent,告知修复后直接重新提交 phase-gate
   → PASS: 继续
10. [Subagent] Retrospect (fork session)
```

**Wave 并行化示例**:

```
Wave 1 (3 subagents 并行):
  Subagent-1: [TC-1-01, TC-1-02] - Auth API 测试
  Subagent-2: [TC-2-01, TC-2-02] - Config API 测试
  Subagent-3: [TC-3-01] - Health Check 测试

Wave 2 (2 subagents 并行):
  Subagent-4: [TC-4-01, TC-4-02] - 需要 Wave 1 创建的用户数据的集成测试
  Subagent-5: [TC-5-01] - Frontend Playwright 测试(独立 browser 进程)

Final:
  [TC-6-01] - 手动验证:支付流程(不可自动化)
  [TC-6-02] - 手动验证:邮件发送
```

**Playwright 并行说明**:
- 每个 frontend 测试 subagent 启动独立的 Playwright browser 进程
- 测试数据隔离:每个 subagent 使用独立的测试用户账号
- 浏览器调试:subagent 可通过 browser-automation skill 截图定位问题
- 同一 Wave 内最多 2 个 Playwright subagent(避免资源争抢)

**不可测试项处理**:
- Phase 2 plan 中标记为 `verification_method: manual` / `type: manual` 的用例
- Phase 4 输出"手动验证清单"给用户,包含:
  - 用例 ID + 描述
  - 手动验证步骤
  - 预期结果
- 手动验证结果不进入 test_execution.json(不阻塞 phase-gate)

## Agent 文件规划

| Phase | Review-Gate Agent | Phase-Gate Agent |
|-------|-------------------|-----------------|
| 1 Spec | `spec-requirements-reviewer.md` | `deliverables-reviewer.md`(通用) |
| 2 Plan L1 | `plan-requirements-reviewer.md` | `deliverables-reviewer.md` |
| 2 Plan L2 | `plan-requirements-reviewer.md` + `plan-bl-requirements-reviewer.md` | `deliverables-reviewer.md` |
| 3 Dev | `spec-plan-conformance-reviewer.md`(新建,前置节点)+ 5 个现有 SKILL.md + `fallow`(CLI)+ `sync-agent.md` | `deliverables-reviewer.md` |
| 4 Test | `test-requirements-reviewer.md` | `deliverables-reviewer.md` |

## 分析历史

| Phase | 分析轮次 | 关键决策 |
|-------|---------|---------|
| Spec | 第 3 轮 | Review-Gate 改为 Workflow 循环(agent 审查+修复+判断退出);Phase-Gate 简化为脚本检查(失败打回主 agent 直接修复,不再经过 review-gate);新增 Goal 追踪(用户手动触发) |
| Plan | 第 3 轮 | 前 4 步(skill/评估/编写/ADR)改为主 agent 顺序执行不用 subagent;新增 Goal 追踪;Review-Gate 改为 Workflow 循环;Phase-Gate 简化 |
| Dev | 第 4 轮 | 新增前置节点 spec-plan-conformance-reviewer(独立循环)+ Fallow 审查维度;Review-Gate 两阶段:先规格符合性,再并行 5 维度质量审查 |
| Test | 第 3 轮 | Review-Gate 改为 Workflow 循环；新增 Goal 追踪 + Wave 并行化（按 DAG 编排 subagent）+ Playwright 并行 + 不可测试项声明；Phase-Gate 简化 |
