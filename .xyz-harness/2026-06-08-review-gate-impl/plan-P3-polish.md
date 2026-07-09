---
verdict: draft
priority: P3
depends-on: [P2]
blocks: []
estimated-days: 2-3
---

# P3: Goal 注入 + Retrospect + SKILL.md 清理 + 文档（体验打磨）

## Goal

补全三个辅助功能，使 review-gate 体系形成完整体验：
1. Phase 3 Goal 动态任务列表（从 plan.md Execution Groups 构建）
2. Retrospect 上下文注入（降级方案：task prompt 内联关键交付物摘要）
3. 4 个 SKILL.md 清理（删除过时章节，新增 gate 调用指导）

最后完成文档更新和全量验证。

## 前置条件

P2 完成：
- 所有 workflow 脚本和 agent 文件已创建
- Gate Pipeline 完整运行
- workflow 结构已确定（SKILL.md 才能写准确的指导）

## File Structure

| 操作 | 文件 | 行数估计 | 说明 |
|------|------|---------|------|
| **modify** | `extensions/coding-workflow/lib/tool-handlers.ts` | ~40 | Phase 3 Goal 动态任务 + Phase 2 L2 追加 |
| **modify** | `extensions/coding-workflow/lib/review-dispatcher.ts` | ~30 | Retrospect 上下文注入 |
| **modify** | `extensions/coding-workflow/skills/xyz-harness-brainstorming/SKILL.md` | ~100 | 删除旧章节 + 新增 gate 调用指导 |
| **modify** | `extensions/coding-workflow/skills/xyz-harness-writing-plans/SKILL.md` | ~100 | 删除旧章节 + 新增 |
| **modify** | `extensions/coding-workflow/skills/xyz-harness-phase-dev/SKILL.md` | ~150 | 删除旧章节 + 新增 |
| **modify** | `extensions/coding-workflow/skills/xyz-harness-phase-test/SKILL.md` | ~120 | 删除旧章节 + 新增 |
| **create** | `docs/adr/020-coding-workflow-depends-on-workflow.md` | ~60 | ADR 记录 |
| **modify** | `extensions/coding-workflow/CHANGELOG.md` | ~40 | 记录所有变更 |
| **modify** | `extensions/coding-workflow/README.md` | ~60 | 反映新机制 |

## Task List

### Task 3.1: Phase 3 Goal 动态任务列表

**文件**: `extensions/coding-workflow/lib/tool-handlers.ts`

**当前**：`executePhaseStartTool` 中 Phase 2 有硬编码 L1 任务注入。Phase 3 没有任何 Goal 注入。

**改动**：在 Phase 3 入口（`state.currentPhase === 3`）读取 plan.md，解析 Execution Groups，构建任务列表。

```typescript
// executePhaseStartTool 中，Phase 3 入口
const PHASE_DEV_GOAL_INIT = 3;

if (state.currentPhase === PHASE_DEV_GOAL_INIT) {
  try {
    const goalInit = (pi as unknown as Record<string, unknown>).__goalInit as GoalInitFn | undefined;
    if (goalInit) {
      // 读取 plan.md 解析 Execution Groups
      const planPath = path.join(state.topicDir, "plan.md");
      const taskList = buildDevGoalTasks(planPath);
      if (taskList.length > 0) {
        goalInit("Phase 3: Dev 编码实现", taskList);
      }
    }
  } catch { /* goal init failure is non-blocking */ }
}
```

**`buildDevGoalTasks` 实现**：

```typescript
function buildDevGoalTasks(planPath: string): string[] {
  if (!fs.existsSync(planPath)) return [];

  const content = fs.readFileSync(planPath, "utf8");
  const tasks: string[] = [];

  // 解析 plan.md 中的 Execution Groups 和 Tasks
  // 格式：### BG{N}: {title} → Task {N}.M: {description}
  // 提取每个 Task 作为 Goal task
  const taskRegex = /^###\s+(?:Task|BG)\s+\d+[\.:]\s*(.+)$/gm;
  let match;
  while ((match = taskRegex.exec(content)) !== null) {
    const taskDesc = match[1]!.trim();
    if (taskDesc) {
      tasks.push(taskDesc.slice(0, 60)); // Goal task 描述上限 60 字符
    }
  }

  // fallback: 如果没有解析到 Task，尝试解析 Execution Group
  if (tasks.length === 0) {
    const egRegex = /^###\s+(BG\d+|Execution Group \d+)\s*[:\-]\s*(.+)$/gm;
    while ((match = egRegex.exec(content)) !== null) {
      tasks.push(match[2]!.trim().slice(0, 60));
    }
  }

  return tasks;
}
```

**注意**：
- plan.md 的格式由 `xyz-harness-writing-plans` SKILL 控制，Task 标题格式是 `### Task N.M: {description}` 或 `### BG{N}: {title}`
- 解析失败时不阻塞——返回空列表，Goal 不注入
- 每个 Goal task 描述限制 60 字符（`goal_manager` 的 `create_tasks` 约束）

### Task 3.2: Phase 2 L2 任务追加

**文件**: `extensions/coding-workflow/lib/tool-handlers.ts`

**当前**：Phase 2 注入了固定的 L1 任务列表，没有 L2 追加逻辑。

**改动**：不在代码中硬编码 L2 追加（L2 需要主 agent 评估后决定），而是在 Phase 2 的 steering prompt 中增加指导：

```typescript
// executePhaseStartTool 中，Phase 2 的 compact customInstructions 追加：
if (state.currentPhase === PHASE_GOAL_INIT) {
  // ... 现有 L1 任务注入 ...

  // Phase 2 的 steering prompt 追加 L2 指导
  // （通过 compact 的 customInstructions 或 sendUserMessage）
}
```

实际上，Phase 2 的 L2 追加更适合在 `xyz-harness-writing-plans` SKILL.md 中指导主 agent，而不是代码中硬编码。SKILL.md 中加一句：

> "如果 plan.md 的 complexity 评估为 L2，使用 `goal_manager.add_tasks()` 追加额外的 L2 任务（如业务逻辑审查、集成测试等）。"

这个改动放在 Task 3.5（SKILL.md 清理）中完成。

### Task 3.3: Retrospect 上下文注入

**文件**: `extensions/coding-workflow/lib/review-dispatcher.ts`

**当前**：`buildRetrospectFollowUp` 构造一段 steer 文本，指导主 agent 写 retrospect。但 steer 中没有内联关键交付物摘要。

**改动**：在 steer 文本中追加当前 phase 的关键交付物摘要。

```typescript
export function buildRetrospectFollowUp(
  phaseConfig: PhaseConfigForReview,
  topicDir: string,
  skillResolver: SkillResolver,
  allPhases: PhaseConfigForReview[],
): string {
  // ... 现有逻辑 ...

  // 新增：内联关键交付物摘要
  const contextSummary = buildContextSummary(phaseConfig, topicDir);
  if (contextSummary) {
    parts.push("", "---", "关键交付物摘要（供回顾参考）：", contextSummary);
  }

  return parts.join("\n");
}

function buildContextSummary(
  phaseConfig: PhaseConfigForReview,
  topicDir: string,
): string {
  const summaries: string[] = [];

  for (const deliverable of phaseConfig.deliverables) {
    const filePath = path.join(topicDir, deliverable);
    if (!fs.existsSync(filePath)) continue;

    try {
      const content = fs.readFileSync(filePath, "utf8");
      // 截取前 500 字符作为摘要
      const preview = content.slice(0, 500).trim();
      if (preview) {
        summaries.push(`### ${deliverable}\n${preview}...`);
      }
    } catch { /* skip unreadable files */ }
  }

  return summaries.join("\n\n");
}
```

**注意**：
- 摘要长度控制在合理范围（每个文件 500 字符，最多 5 个文件 = 2500 字符）
- 这不是真正的 fork session，而是降级方案——在 steer prompt 中内联关键信息
- 真正的 fork session 需要等 pi-subagents 开放 CLI fork 参数（spec 中标注为 postponed）

### Task 3.4: 更新 `xyz-harness-brainstorming` SKILL.md

**文件**: `extensions/coding-workflow/skills/xyz-harness-brainstorming/SKILL.md`

**应删除**的章节（如果存在）：
- Spec Review 章节（手动的 spec 自审流程）
- Gate Handoff 章节（手动 gate 调度指令）
- Phase Transition 中"单独 session 跑 gate"的指导

**应新增**的内容：

```markdown
## Gate 调用

完成 spec.md 编写后，**不要**手动运行任何审查流程。直接调用：

\`\`\`
coding-workflow-gate(phase=1)
\`\`\`

Review-Gate 会自动启动 workflow 循环审查 + 修复。如果 gate 返回 FAIL，按修复指引修改 spec.md 后重新调用。

## Goal 追踪

Brainstorming 完成后，建议使用 `/goal` 初始化任务追踪。示例任务列表：
- 完成需求分析和用户故事梳理
- 编写 spec.md（含 Problem Statement、Goals、Non-Goals、Use Cases、Constraints、Acceptance Criteria）
- 确认 spec.md 通过 Review-Gate

Goal 任务列表在 Phase 2 启动时会自动注入。
```

### Task 3.5: 更新 `xyz-harness-writing-plans` SKILL.md

**文件**: `extensions/coding-workflow/skills/xyz-harness-writing-plans/SKILL.md`

**应删除**的章节：
- Self-Review 章节（手动自审流程）
- Plan Review 章节（手动 plan 审查）
- Gate Handoff 章节

**应新增**的内容：

```markdown
## Gate 调用

完成所有 plan 交付物后，直接调用：

\`\`\`
coding-workflow-gate(phase=2)
\`\`\`

## L2 复杂度追加

如果 plan.md 的 complexity 评估为 **L2**，在完成 L1 基础任务后，使用 `goal_manager.add_tasks()` 追加：
- 业务逻辑覆盖度审查
- 集成测试计划
- 性能/安全测试用例

L2 任务应根据 spec.md 的 use-cases 和 non-functional requirements 动态确定。
```

### Task 3.6: 更新 `xyz-harness-phase-dev` SKILL.md

**文件**: `extensions/coding-workflow/skills/xyz-harness-phase-dev/SKILL.md`

**应删除**的章节：
- Step 4: Five-Step Specialized Review（手动 5 步审查）
- Step 4a: Retrospect 触发
- Step 6 中 review 文件检查项（已由 Review-Gate 自动处理）
- Step 7: Gate Handoff（手动 gate 调度）
- Step 8 中"单独 session 跑 gate"的指导

**应新增**的内容：

```markdown
## Goal 自动追踪

Phase 3 启动时，Goal 任务列表会自动从 plan.md 的 Execution Groups 构建。每个 Task 对应一个 Goal task。完成编码后手动更新对应的 task 状态。

## Gate 调用

完成编码和单元测试后，直接调用：

\`\`\`
coding-workflow-gate(phase=3)
\`\`\`

Review-Gate 会自动执行三阶段审查：
1. 阶段一：Spec-Plan Conformance（规格符合性）
2. 阶段一.五：Simulated Data Generation（模拟数据生成）
3. 阶段二：Code Quality Review-Fix Loop（并行审查 + 自动修复）

如果阶段一 FAIL，说明代码与 spec/plan 不一致，需要重新编码。回到 TDD 流程修复。

如果阶段二有 must_fix，Fix Worker 会自动按文件分组修复。你不需要手动处理审查发现。
```

### Task 3.7: 更新 `xyz-harness-phase-test` SKILL.md

**文件**: `extensions/coding-workflow/skills/xyz-harness-phase-test/SKILL.md`

**应删除**的章节：
- Review-Gate 章节（Phase 4 不走 Review-Gate，走 Test-Fix Loop）
- Gate Handoff 章节

**应新增**的内容：

```markdown
## Test-Fix Loop Workflow

Phase 4 使用 Test-Fix Loop Workflow，不再走 Review-Gate。

核心流程：
1. 完成测试准备工作（启动 dev server、数据库等基础设施）
2. 调用 `coding-workflow-gate(phase=4)`
3. Test-Fix Loop 自动执行：
   - 核心 case 循环（最多 10 轮）
   - 非核心 case 循环（核心全部 passed 后，最多 10 轮）
4. 每轮：coordinator 构造 test-execute JSON → Wave 测试 → Fix Worker 修复

## test-execute JSON 版本化

每轮测试结果写入：
- `{topicDir}/changes/reviews/phase-4/test-execute-v{round}-{scope}.json`

JSON 格式：
\`\`\`json
{
  "version": 1,
  "scope": "core|noncore",
  "timestamp": "2026-06-08T10:30:00Z",
  "summary": { "total": 10, "passed": 8, "failed": 2, "skipped": 0, "fixed": 0 },
  "cases": [
    { "id": "TC-001", "name": "...", "status": "passed|failed|skipped|fixed", "evidence": "..." }
  ]
}
\`\`\`

## 增量测试策略

第 2 轮起不重跑所有 case，只重跑：
- 上一轮 status='fixed' 的 case（已修复待验证）
- `depends_on` 包含这些 case 的下游 case

## Phase-Gate 严格防伪造

Phase 4 的 Phase-Gate 会验证：
- test-execute JSON 存在且格式正确
- 所有核心 case 状态为 passed 或 skipped
- 非核心 case 的失败率在可接受范围内

请确保测试结果真实可靠。
```

### Task 3.8: 创建 ADR-020

**文件**: `docs/adr/020-coding-workflow-depends-on-workflow.md`

```markdown
# ADR-020: Coding-Workflow 依赖 Workflow Extension

## Status

Accepted

## Context

Coding-workflow 的 Review-Gate / Test-Fix Loop 需要多 agent 编排能力（循环审查、并行 reviewer、Fix Worker 分组修复）。当前用 `runSingleAgent`（spawn `pi --mode json`）实现，缺乏：
- 并行 agent 执行
- 结构化结果解析
- callCache / budget 控制

Workflow Extension 提供了 `agent()`/`parallel()`/`pipeline()` API，能解决这些问题。

## Decision

Coding-workflow 通过 `pi.__workflowRun`（类似 `pi.__goalInit` 模式）调用 Workflow Extension 的 orchestrator，启动 workflow 脚本执行 Review-Gate / Test-Fix Loop。

不使用 package 级别的代码 import，因为 `WorkflowOrchestrator` 是 workflow extension 工厂函数的内部闭包。

依赖关系在 `extension-dependencies.json` 中声明为 `optional`（缺失时降级到 `runSingleAgent`）。

## Consequences

- 正面：利用 Workflow Extension 成熟的编排能力（parallel/callCache/budget），开发成本降低
- 正面：降级策略保证 coding-workflow 在无 workflow extension 的环境也能工作
- 负面：coding-workflow 与 workflow 形成运行时依赖，workflow 缺失时体验降级
- 负面：`pi.__workflowRun` 是约定接口，非正式 Pi API，可能有兼容性风险
```

### Task 3.9: 全量验证 + CHANGELOG + README

1. 全量类型检查：`pnpm -r typecheck`（确保所有包通过）
2. 全量 lint：`pnpm -r lint`
3. 更新 `extensions/coding-workflow/CHANGELOG.md`
4. 更新 `extensions/coding-workflow/README.md`

**CHANGELOG 新增条目**：

```markdown
## 0.3.0 — 2026-06-XX

### Added
- Gate Pipeline 抽象：`lib/gates/` 目录（Gate 接口、ReviewGate、PhaseGate、TestFixLoopGate）
- `pi.__workflowRun` 交叉调用通道（workflow extension 暴露）
- 11 个新 agent 文件（spec/plan/conformance/fallow/simulated-data/fix-worker/test-coordinator 等）
- 4 个 workflow 脚本（phase1/2/3-review-gate + phase4-test-fix-loop）
- Phase 3 Goal 动态任务列表（从 plan.md Execution Groups 构建）
- Retrospect 上下文注入（steer prompt 内联关键交付物摘要）
- ADR-020: coding-workflow 依赖 workflow extension

### Changed
- Review-Gate 全部改为 Workflow Extension 驱动（降级：runSingleAgent）
- Test-Fix Loop 改为 workflow 脚本（core → noncore 串行 + 增量测试）
- Gate Pipeline 按 phase 配置执行 gate 链（不再硬编码顺序）
- 4 个 SKILL.md 清理（删除旧审查/gate 章节，新增 workflow 调用指导）

### Removed
- 旧的硬编码 gate 调度逻辑（`executeGateTool` 中的 review-gate → phase-gate 硬编码）
```

**README 更新要点**：
- 架构图更新（加入 workflow 脚本 + agent 文件）
- Gate Pipeline 机制说明（按 phase 配置执行 gate 链）
- Review-Gate workflow 说明（Phase 1/2/3 三种模式）
- Test-Fix Loop workflow 说明（core/noncore 串行 + 增量策略）
- 新增 agent 文件列表
- 降级策略说明

## Dependency Graph

```
Task 3.1 (Phase 3 Goal) ──┐
Task 3.2 (Phase 2 L2) ───┤──→ Task 3.3 (Retrospect)
                          │
Task 3.4 (brainstorming) ─┤
Task 3.5 (writing-plans) ─┤──→ Task 3.9 (全量验证)
Task 3.6 (phase-dev) ─────┤
Task 3.7 (phase-test) ────┘

Task 3.8 (ADR) ───────────────→ Task 3.9
```

可并行：
- Task 3.1/3.2/3.3（代码改动）和 Task 3.4-3.7（SKILL.md 改动）之间无依赖
- Task 3.8（ADR）独立

## Acceptance Criteria

1. Phase 2 进入时 Goal 任务列表自动注入（L1 基础任务）
2. Phase 3 进入时从 plan.md 动态构建任务列表
3. Retrospect steer 包含关键交付物摘要（每个 deliverable 前 500 字符）
4. 4 个 SKILL.md 无过时的章节引用：
   - 无 "Self-Review"、"Plan Review"、"Five-Step"、"Gate Handoff" 等旧章节
   - 有 "Gate 调用" 新章节，指导调用 `coding-workflow-gate`
5. ADR-020 存在且内容完整
6. `pnpm -r typecheck` 全量通过
7. `pnpm -r lint` 全量通过
8. CHANGELOG 和 README 反映所有变更

## 验证命令

```bash
# 全量类型检查
pnpm -r typecheck

# 全量 lint
pnpm -r lint

# SKILL.md 内容检查（确认旧章节已删除）
grep -r "Self-Review\|Five-Step\|Gate Handoff" extensions/coding-workflow/skills/ || echo "OK: no stale sections"

# ADR 存在性检查
test -f docs/adr/020-coding-workflow-depends-on-workflow.md && echo "OK: ADR exists"

# 手动端到端验证
/coding-workflow test end to end feature
# Phase 1: 确认 Goal 追踪建议
# Phase 2: 确认 Goal 自动注入 + L2 追加指导
# Phase 3: 确认 Goal 动态任务列表
# 每个 phase gate 通过后: 确认 Retrospect steer 包含摘要
```

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| plan.md 格式不统一，Task 解析失败 | Goal 任务列表为空 | regex 覆盖多种格式 + fallback 到 Execution Group |
| SKILL.md 删除过多内容 | 指导信息丢失 | 逐文件确认删除范围，保留非冲突的内容 |
| Retrospect 摘要过长 | steer prompt 超出限制 | 每个 deliverable 限制 500 字符，最多 5 个文件 |
| 全量 typecheck 有其他包的错误 | 阻塞提交 | 区分 coding-workflow 的错误和其他包的错误，先修 coding-workflow 的 |
