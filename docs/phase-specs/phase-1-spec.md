# Phase 1 Spec — 实现规格

> 从 `review-gate-phase-analysis-playbook.md` 提取的最终结论，作为实现参考。

## 概览

| 项目 | 说明 |
|------|------|
| 阶段 | Phase 1 Spec（需求分析） |
| Skill | `xyz-harness-brainstorming` |
| 执行者 | 主 Agent（phase 内部步骤 + retrospect）、Workflow（review-gate） |
| 产出物 | spec.md（use-cases.md 和 non-functional-design.md 推迟到 Phase 2） |

## 完整流程

```
1. [Skill] xyz-harness-brainstorming
   → 告知主 agent 整体 5-phase 执行流程
   → focus on 当前目标：完成 spec 阶段的 review-gate
2. [固定] Brainstorming + 用户讨论（多轮）
3. [Goal] 用户手动触发 /goal（Brainstorming 完成后，准备编写交付物时）
   → 任务列表：spec.md
4. [固定] 主 agent 编写 spec.md（完成后更新 goal）
5. [主 Agent] 调用 coding-workflow-gate(phase=1)
   → gate tool 内部路由：先跑 Review-Gate，最多 3 轮
   → Review-Gate 通过后再跑 Phase-Gate（脚本检查，最多 5 次重试）
6. [主 Agent] Retrospect（Phase-Gate 通过后，gate tool handler 通过 steer 指令触发）→ 产出 `phase1_retrospect.md`
→ 过渡：主 agent 调用 coding-workflow-phase-start(phase=2)
```

## Phase 过渡

**Phase 1 → Phase 2**：Retrospect 完成后，主 agent 调用 `coding-workflow-phase-start(phase=2)`。该 tool handler 执行 compact，注入 Phase 2 steering prompt，**并自动初始化 Phase 2 的 goal 任务列表**（先默认注入 L1 任务列表，复杂度评估为 L2 时再由主 agent 调用 `goal_manager.add_tasks()` 追加额外任务，详见 Phase 2 spec 的 Goal 配置章节）。

## Goal 配置

**触发方式**：用户手动 `/goal`

**触发时机**：Brainstorming 完成后、开始编写 spec.md 之前。Steering prompt 中指导主 agent 在 brainstorming 完成的确认点（见下方"完成条件"）提示用户触发 `/goal`。

**任务列表**：
1. Write spec.md

> **产出物范围说明**：Phase 1 只产出 spec.md。use-cases.md 和 non-functional-design.md 推迟到 Phase 2，因为这两个文件需要基于 plan 的架构设计才能细化（Phase 1 阶段 spec 尚未定案，不适合写详细用例和非功能设计）。Phase 2 的 L1/L2 任务列表和产出物清单中包含这两个文件。

**注入方式**：SKILL.md 中增加指导“Brainstorming 完成、准备编写 spec 交付物时，建议用户使用 /goal 工具初始化任务追踪”。Steering prompt 在 `before_agent_start` 时注入，主 agent 收到后在 brainstorming 完成后提示用户触发 `/goal`。

**为什么 Phase 1 不自动注入**：Phase 1 的 brainstorming（步骤 2）可能持续多轮，需求在讨论过程中逐渐明确。自动注入会在需求未定时就创建任务列表，导致任务不准确。Phase 2 则不同——进入时 spec 已定，可以直接注入。

**完成条件**：Brainstorming 阶段在以下任一条件下视为完成：
1. 用户明确说"开始写 spec"、"可以了"、"继续"等表示结束讨论的指令
2. 用户连续 2 轮回复没有提出新的需求或修改意见（仅确认或补充细节）
3. 主 agent 判断核心需求（spec 的用户故事、验收标准、非功能约束）已全部明确，并主动向用户确认"需求是否已明确，可以开始编写 spec？"

条件 3 由主 agent 主观判断，但必须在 steering prompt 中指导主 agent 主动触发确认，而非被动等待用户指令。

## Review-Gate

| 项目 | 说明 |
|------|------|
| 模式 | Workflow 循环 |
| Agent | `spec-requirements-reviewer.md` |
| 循环 | agent 审查 + 直接修复 → must_fix=0 退出 |
| 最大轮数 | 3 |
| 连续不降 | 2 轮 → 人工介入 |

**内部结构**：
```
循环 {
  [Agent] spec-requirements-reviewer.md 审查 + 直接修复
  判断: must_fix = 0 → 通过 / > 0 → 继续循环
}
```

**连续不降处理**：如果连续 2 轮 must_fix 数量没有下降（例如 5→5→5），Workflow 退出循环并将结果返回主 agent，由主 agent 决定是否继续（需用户确认）或接受当前质量。

> **阈值规则**（适用于 Phase 1/2/3 的 Review-Gate）：
> - 连续不降阈值：**2 轮**（连续 2 轮 must_fix 数量未下降 → 人工介入）
> - 最大轮数：**3**（无论是否收敛，3 轮后强制退出循环）
> - Phase 4 的 Test-Fix Loop 阈值不同（连续 3 轮、最大 10 轮），因为测试修复的反馈周期更短（跑测试→看结果→修代码），需要更多轮数才能收敛。详见 Phase 4 spec。

## Phase-Gate

| 项目 | 说明 |
|------|------|
| 模式 | 脚本检查（无防伪造） |
| 检查项 | 文档完整性 + YAML frontmatter + placeholder 扫描 |
| 严格度 | 🟢 基础（仅脚本） |
| 失败处理 | 返回主 agent 修复，修复后直接重新提交 phase-gate（跳过 review-gate） |
| 最大重试 | 5 次 |

**失败处理**：
- 返回主 agent，告知修复后**直接重新提交 phase-gate**
- **跳过 review-gate**（内容质量已在 review-gate 中通过）

**通过后动作**：Phase-Gate 通过后，gate tool handler 通过 steer 指令触发主 agent 执行 Retrospect（与 Phase 2/3/4 一致）。

## 产出物

| 文件 | Review-Gate 检查 | Phase-Gate（脚本） |
|------|-----------------|----------------|
| spec.md | ✅ 内容审查 | ✅ 格式 + YAML |
| phase1_retrospect.md | — | — | `changes/reviews/phase-1/phase1_retrospect.md` |

> use-cases.md 和 non-functional-design.md 在 Phase 2 产出（见 Phase 2 spec）。

## 代理修改文件后的上下文同步

Review-Gate 中的 agent (`spec-requirements-reviewer.md`) 会直接修改 spec.md。这些修改发生在 Workflow 的独立 pi 进程中，主 agent 的上下文不会自动更新。

**同步策略**：Workflow 完成后，gate tool handler 读取修改后的 spec.md 内容，在返回给主 agent 的结果中附带关键变更摘要（修改了哪些章节、主要变更内容）。主 agent 收到后可按需读取最新文件。

**说明**：Phase 1 的 review-gate 修改的文档量较小（通常 1 个 spec.md），上下文同步的复杂度低于 Phase 2/3（多文件）。

## SKILL.md 变更

| 操作 | 目标 |
|------|------|
| **删除** | Spec Review 章节（主 agent 自审） |
| **删除** | Gate Handoff 章节（单独 session 提交 gate） |
| **保留** | Quick Overview → Brainstorm → Terminology → Scan → Write |
| **新增** | 整体 5-phase 执行流程指导（focus on review-gate） |
| **新增** | Goal 追踪建议（steering prompt 中提示用户 /goal，限定在 brainstorming 完成后；Phase 2 起的 Goal 改由 `phase-start` 自动注入） |
| **新增** | "完成后调用 coding-workflow-gate(phase=1)" |

## Agent 文件规划

| Agent | 新建/复用 | 职责 |
|-------|----------|------|
| `spec-requirements-reviewer.md` | 新建 | Review-Gate 审查 + 直接修复 spec.md |

**项目规范文件传递方式**：与 Phase 3 一致——subagent 自行查找并读取项目规范文件（CLAUDE.md），`cwd` 设为项目根目录。详见 Phase 3 spec 的"项目规范文件传递方式"小节。

## 可视化

`review-gate-flow/p1-spec.html`
