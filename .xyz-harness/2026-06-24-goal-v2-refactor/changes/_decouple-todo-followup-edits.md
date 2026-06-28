# 文档全解耦后续编辑清单（follow-up）

> 本文件记录 goal↔todo 全解耦重构后，harness 设计文档中**剩余的次级编辑点**。
> 核心契约锚点（FR-2/FR-6/FR-7、D3/D15/D17/D19/D27、G2.2/UC-4/AC-4.x、T4.1~T4.7、NFR-AC-6、#7 整段废弃标注）已手工完成。
> 以下为目录注释、mermaid 图边、Wave 依赖链、验收 checklist 等次级残留，由 Explore agent 产出逐字替换方案，待批量应用以达到"零未标注残留"。

## 状态

- ✅ 已完成：8 个根文档的核心契约锚点 + issues.md #7 废弃标注 + nfr #7 废弃标注 + 4 个 changes 文件 superseded 标注
- ⏳ 待应用：以下清单（约 120 处精细编辑，不影响设计正确性，仅文档精确度）

## 应用方式

每条为 `FIND`（原文，逐字）/ `REPLACE`（替换文本）。删除线 `~~...~~` + `（全解耦：...）` 批注为统一风格。保留 evidence 必填、report_blocked 守卫、budget 终态等非 todo 耦合的合法硬约束。

## 待编辑文件与条目数

| 文件 | 待编辑条目 | 主要内容 |
|------|-----------|---------|
| spec.md | ~13 | AC 清单（AC-1/AC-2/AC-6/AC-7/UC-4 预期）、FR-1 跨扩展块、background point 3 |
| requirements.md | ~8 | G3.1 达成路线、数据流图边、关联图边、D27 决策记录 |
| clarification.md | ~6 | G-029、D12/D13 标题加废弃标（正文已改） |
| code-architecture.md | ~20 | 目录注释（types/budget/agent-end）、API 契约表（checkProgress/handleComplete/handleAgentEnd/beforeAgentStart）、功能4 时序图、Deep Module、Wave 依赖链、覆盖完整性自检 |
| execution-plan.md | ~20 | Wave mermaid 节点、调度表、依赖推导、D0/D1/D2 决策记录、T1.5/T1.7、NFR-AC-6/7 映射、Wave 验收 checklist |
| issues.md | ~18 | mermaid #7 节点、#1/#5/#6/#8/#9/#10 的 Blocked by/方案/验收、#7 方案 A + 取舍 + 验收 |
| non-functional-design.md | ~16 | #1 可观测性迁移、#6 stalenessReminder、#7 性能/稳定性整段、#8/#9/#10 降级方案、交叉副作用、缓解项回灌表、NFR-AC-6/7/11 |
| system-architecture.md | ~10 | FR-1、ProgressInput 行、Todo 实体行、Task 行、Context Map mermaid 边、Todo/Plan Extension 行、序列图、D-A3、Port 清单 |
| changes/（剩余 12 文件） | 12 | tracing-issues/round-1/round-2/execution-1/execution-2、review-clarity/code-arch/nfr/architecture/execution、consistency-final、skeleton-verification 加 superseded 标注 |

## 编辑原则（复用）

1. complete 不检查 todo（全解耦）→ prompt 软建议，AI 自行决策
2. 保留 evidence 必填 + status==active 守卫
3. `__todoGetList`(goal 读) / `__planStart`(goal 探测) / `ProgressInput` / `buildProgressInput` / `checkCompletePrerequisites` / `findIncompleteTodos` / `TODO_DEGRADED` / `checkProgress` / `ProgressCheck` / `allTasksDone followUp` / `stalenessReminderPrompt` / `lastUpdatedTurn` / `lastIncompleteCount` / `STALENESS_THRESHOLD_TURNS` → 删除线 + `（全解耦：已移除）`
4. 术语：`硬检查/硬拒绝/硬闸门/拦截率 100%(任务)/必须完成 todo` → `软建议/无硬检查/AI 自行决策`
5. 改写不删除，保持文档结构

## 详细 FIND/REPLACE 方案

> 完整的逐字 FIND/REPLACE 方案由 4 个 Explore agent 产出（spec+requirements 36 处、clarification+system-arch ~16 处、code-arch+execution+issues+nfr ~104 处、changes 16 处）。
> 因方案体量大（~170 条），存储于本文件的 agent 原始输出中。应用时按上述文件分组逐条 Edit 即可。
> 应用后验证：`grep -nE "硬闸门|硬拒绝|必须完成.*todo|拦截率 = 100%.*任务" <file>` 应仅命中删除线/全解耦注释内的文字。
