# Review-Gate Phase 分析范式

用于分析每个 phase 的 gate 配置。每个 phase 有两层 gate：review-gate（需求/内容审查）和 phase-gate（文档格式审查），顺序执行。

## Gate 分层设计

### Review-Gate（需求/内容审查）

审查交付物的**内容质量**：需求是否穷尽、逻辑是否正确、设计是否合理。

| Phase | 模式 | 失败行为 |
|-------|------|---------|
| 1 Spec | 单次 subagent 检查 | 列出待澄清问题，回退到 brainstorming 讨论步骤 |
| 2 Plan | 单次 subagent 检查（L1/L2 配置不同） | 列出待修正问题，回退到 plan 编写步骤 |
| 3 Dev | 循环 workflow（parallel review → sync → fix） | 循环内自动修复，最多 3 轮 |
| 4 Test | 单次 subagent 检查 | 列出待修正问题，回退到测试编写步骤 |

**关键区别**：
- Phase 1/2/4 的 review-gate **不做循环**。审查的是人类可判断的需求完整性，失败的根因是理解不足，需要回到上游步骤重新讨论，而不是 subagent 循环修复。
- Phase 3 的 review-gate **做循环**。审查的是代码质量，失败的根因是代码错误，subagent 可以自动修复。

### Phase-Gate（文档格式审查）

所有 phase 统一模式：**Workflow 执行**。

```
Phase-Gate Workflow 内部：
  1. 循环：doc-review-and-fix 节点（直到无 MUST-FIX）
     - 检查文档完整性（无 placeholder/TODO）
     - 检查 YAML frontmatter 格式
     - 检查字段合法性
     - 发现问题直接修复
  2. 固定脚本：Python gate script 检查交付物
  3. 防造假检查：验证交付物内容非空、非占位
  4. 通过 → dispatch retrospect subagent
```

Phase-gate 不关心内容是否正确（那是 review-gate 的职责），只关心格式是否合规。

### 两层 Gate 的关系

```
Review-Gate PASSED → 自动触发 Phase-Gate → Phase-Gate PASSED → Retrospect → 下一 Phase
```

主 agent 只感知到调一次 `coding-workflow-gate(phase=N)`，gate tool 内部先跑 review-gate 再跑 phase-gate。

## 分析步骤

### ① 产出物分析

| 问题 | 选项 |
|------|------|
| 产出物是什么？ | 单文件文档 / 多文件文档 / 多文件代码 |
| 产出物复杂度？ | 低（几十行）/ 中（几百行）/ 高（千行级 + 多文件） |
| 内容审查重点？ | 需求完整性 / 设计可行性 / 代码质量 / 测试覆盖 |
| 格式审查重点？ | YAML 格式 / placeholder 扫描 / 字段完整性 |

### ② Review-Gate 配置

| 问题 | 选项 |
|------|------|
| 模式？ | 单次检查（Phase 1/2/4）/ 循环 workflow（Phase 3） |
| 需要几个 reviewer？ | 1 个 / 多个 |
| 是否有复杂度分级（L1/L2）？ | 是（每级独立配置）/ 否 |
| 需要 agent.md 还是复用现有？ | 新建 agent.md / 复用现有 SKILL.md |

**Agent 文件规则 [MANDATORY]**：
- 每个 reviewer 必须有独立的 agent.md，禁止"复用 expert-reviewer + 不同 task prompt"模式
- task prompt 只注入简单差异化内容：文件路径、输出目录、round 编号、上一轮报告路径
- task prompt 不包含审查逻辑、审查步骤、输出格式定义——这些全部在 agent.md 中
- 唯一例外：审查逻辑完全相同且已有独立 SKILL.md 的（如 Phase 3 的 5 个专项 reviewer）

### ③ Phase-Gate 配置

所有 phase 共享相同的 workflow 模式，差异只在交付物列表和检查规则。

| 组件 | 说明 |
|------|------|
| doc-review-and-fix 节点 | 单个 subagent（deliverables-reviewer.md），检查格式并修复 |
| Python gate script | 现有 `gate-runner.ts` 调用的脚本 |
| 防造假检查 | 现有逻辑 |

### ④ 循环终止条件

**Review-Gate（Phase 3 循环模式）**：

| 条件 | 行为 |
|------|------|
| must_fix = 0 | 通过 |
| 达到最大轮数（3） | 强制通过（警告） |
| 连续 2 轮 must_fix 不降 | 人工介入 |

**Phase-Gate（所有 phase 循环）**：

| 条件 | 行为 |
|------|------|
| MUST-FIX = 0 | 退出循环，进入下一步 |
| 达到最大轮数（5） | 强制通过（警告） |

### ⑤ 与现有流程的变更点

| 操作 | 目标 |
|------|------|
| 删除 | SKILL.md 中的 Self-Review、Plan Review 等 review 章节 |
| 删除 | SKILL.md 中的 Gate Handoff 章节 |
| 保留 | 设计步骤（如 ADR Evaluation） |
| 保留 | 格式检查项（交付物验证中的格式部分） |
| 新增 | "完成后调用 coding-workflow-gate" 指导 |
| 修改 | Retrospect 触发方式统一为 phase-gate 通过后 |

## 已分析结果

### Phase 1 Spec

| 步骤 | 配置 |
|------|------|
| ① 产出物 | 多文件文档（spec.md + use-cases.md + non-functional-design.md） |
| ② Review-Gate | 单次 subagent（spec-requirements-reviewer.md），无循环。失败回退 brainstorming |
| ③ Phase-Gate | Workflow：循环 deliverables-reviewer.md → script → 防造假 |
| ④ 终止 | Review-Gate 无循环；Phase-Gate 最多 5 轮 |
| ⑤ 变更 | 删 Spec Review + Gate Handoff；新增 review-gate 指导 |

**完整流程**：
```
1. [Skill] xyz-harness-brainstorming
2. [固定] Brainstorming + 用户讨论（多轮）
3. [固定] 编写 spec 交付物
4. [Subagent] Review-Gate: spec-requirements-reviewer.md
   → FAIL: 列出待澄清问题，回退到步骤 2
   → PASS: 自动触发 Phase-Gate
5. [Workflow] Phase-Gate:
   5a. 循环: deliverables-reviewer.md (doc-review-and-fix)
   5b. Python script 检查交付物
   5c. 防造假检查
6. [Subagent] Retrospect (fork session)
```

### Phase 2 Plan

| 步骤 | 配置 |
|------|------|
| ① 产出物 | 多文件文档（5-9 个，取决于 L1/L2） |
| ② Review-Gate L1 | 单次 subagent（plan-requirements-reviewer.md），无循环 |
| ② Review-Gate L2 | 单次并行 subagent（plan-requirements-reviewer.md + plan-bl-requirements-reviewer.md），无循环 |
| ③ Phase-Gate | Workflow：循环 deliverables-reviewer.md → script → 防造假 |
| ④ 终止 | Review-Gate 无循环；Phase-Gate 最多 5 轮 |
| ⑤ 变更 | 删 Self-Review + Plan Review + Gate Handoff |

**L2 产出物清单**：

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

**完整流程**：
```
1. [Skill] xyz-harness-writing-plans
2. [固定] 复杂度评估（L1/L2）
3. [固定] 编写 plan 交付物
4. [固定] ADR 评估
5. [Review-Gate]:
   L1: [Subagent] plan-requirements-reviewer.md
   L2: [Parallel Subagent] plan-requirements-reviewer.md + plan-bl-requirements-reviewer.md
   → FAIL: 列出待修正问题，回退到步骤 3
   → PASS: 自动触发 Phase-Gate
6. [Workflow] Phase-Gate:
   6a. 循环: deliverables-reviewer.md (doc-review-and-fix)
   6b. Python script 检查交付物
   6c. 防造假检查
7. [Subagent] Retrospect (fork session)
```

### Phase 3 Dev（待详细分析）

| 步骤 | 配置 |
|------|------|
| ① 产出物 | 多文件代码 |
| ② Review-Gate | 循环 Workflow：parallel 5 reviewer → sync → fix，最多 3 轮 |
| ③ Phase-Gate | Workflow：循环 deliverables-reviewer.md → script → 防造假 |
| ④ 终止 | Review-Gate 3 轮；Phase-Gate 5 轮 |

### Phase 4 Test（待详细分析）

| 步骤 | 配置 |
|------|------|
| ① 产出物 | 多文件测试代码 |
| ② Review-Gate | 单次 subagent（test-requirements-reviewer.md），无循环 |
| ③ Phase-Gate | Workflow：循环 deliverables-reviewer.md → script → 防造假 |
| ④ 终止 | Review-Gate 无循环；Phase-Gate 5 轮 |

## Agent 文件规划

| Phase | Review-Gate Agent | Phase-Gate Agent |
|-------|-------------------|-----------------|
| 1 Spec | `spec-requirements-reviewer.md` | `deliverables-reviewer.md`（通用） |
| 2 Plan L1 | `plan-requirements-reviewer.md` | `deliverables-reviewer.md` |
| 2 Plan L2 | `plan-requirements-reviewer.md` + `plan-bl-requirements-reviewer.md` | `deliverables-reviewer.md` |
| 3 Dev | 5 个现有 SKILL.md + `sync-agent.md` | `deliverables-reviewer.md` |
| 4 Test | `test-requirements-reviewer.md` | `deliverables-reviewer.md` |

## 分析历史

| Phase | 分析轮次 | 关键决策 |
|-------|---------|---------|
| Spec | 第 2 轮 | 重新设计两层 gate：review-gate（需求审查）+ phase-gate（格式审查）；review-gate 单次无循环；phase-gate 统一 workflow |
| Plan | 第 2 轮 | 跟随 Spec 的两层 gate 设计；L2 review-gate 并行但无循环 |
| Dev | 待分析 | — |
| Test | 待分析 | — |
