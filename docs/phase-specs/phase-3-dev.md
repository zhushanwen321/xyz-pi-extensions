# Phase 3 Dev — 实现规格

> 从 `review-gate-phase-analysis-playbook.md` 提取的最终结论，作为实现参考。

## 概览

| 项目 | 说明 |
|------|------|
| 阶段 | Phase 3 Dev（编码实现） |
| Skill | `xyz-harness-phase-dev` |
| 执行者 | 主 Agent + Subagent（按 Wave 编码）+ Workflow（Review-Gate） |
| 产出物 | 代码 + 测试 + review 报告（6 份）+ test_results.md + retrospect |

## 完整流程

```
1. [Skill] xyz-harness-phase-dev 加载
2. [Goal] phase-start 自动注入 initializeGoalFromExternal()
3. [主 Agent] 防护预检（Step 0）
4. [主 Agent/Subagent] 按 Goal 任务顺序执行（见 Goal 配置）
5. [Workflow] Review-Gate（整体是一个 Workflow，内含两阶段）
   阶段一：前置检查（单次，不循环）
   阶段二：并行审查 + Fix Worker 循环
6. [脚本+防伪造] Phase-Gate
7. [Subagent] Retrospect（fork session）
```

## Goal 配置

**触发方式**：`phase-start` 自动注入（`initializeGoalFromExternal()` API）

**任务列表**（根据 spec+plan 动态生成）：

```
Task 1: TDD 测试编写（根据 spec AC + plan Execution Groups 编写测试用例）
Task 2: Wave 1 编码（按 EG dispatch subagent 编码，全部 GREEN）
Task 3: Wave 2 编码（如果有，依赖 Wave 1 产出）
...
Task N: 运行全量测试 + 修复（0 failures）
Task N+1: 复跑测试（二次验证，0 failures）
Task N+2: 再跑测试（稳定性检查，0 failures）
Task N+3: 写 test_results.md + git commit + push
```

**Task 1 完成标准**：测试文件存在，运行后全部失败（RED 状态）——TDD 的起点。

**Task 2..N-1 完成标准**：对应 Wave 的所有测试通过（GREEN 状态）。

**API 调用**：
```typescript
import { initializeGoalFromExternal } from "@zhushanwen/pi-goal";

// executePhaseStartTool 中，Phase 3 compact 后
const plan = readPlan(state.topicDir);
const executionGroups = extractExecutionGroups(plan);
const taskList = buildDevGoalTasks(executionGroups);
initializeGoalFromExternal(pi, ctx, "Phase 3: Dev 编码实现", taskList);

function buildDevGoalTasks(groups: ExecutionGroup[]): string[] {
  const tasks: string[] = [];
  tasks.push("TDD 测试编写：根据 spec AC + plan 编写所有 Execution Group 的测试用例");
  for (const wave of groupWaves(groups)) {
    tasks.push(`Wave ${wave.number} 编码：${wave.groups.map(g => g.id).join(', ')}`);
  }
  tasks.push("运行全量测试 + 修复失败");
  tasks.push("复跑测试（二次验证）");
  tasks.push("再跑测试（稳定性检查）");
  tasks.push("写 test_results.md + git commit + push");
  return tasks;
}
```

## Review-Gate

**整体是一个 Workflow**，内含两个阶段。

### 阶段一：前置检查（单次，不循环）

| 项目 | 说明 |
|------|------|
| Agent | `spec-plan-conformance-reviewer.md`（新建，合并 BLR） |
| 输入 | spec.md + plan.md + use-cases.md + git diff + 源代码 |
| 审查内容 | 代码是否符合 spec+plan 描述 + 业务逻辑正确性 + AC 覆盖 |

**BLR 合并原因**：BLR（业务逻辑审查）和 spec-plan-conformance（规格符合性审查）审查内容高度重叠——都在对比 spec+plan vs 代码实现。合并后统一审查规格符合性和业务逻辑正确性。

**失败处理**：
```
FAIL → 退出 workflow → 主 agent 重新启动 goal → 检查缺失能力
     → 重新拆分 Wave → 编码 → 测试验证 → commit → 重新提交 review-gate
```

打回主 agent 后不回到 review-gate，而是回到编码阶段：
1. 重新启动 goal（`initializeGoalFromExternal()` 或重置现有 goal 状态）
2. 主 agent 分析 spec-plan-conformance 报告中的问题
3. 重新拆分 Wave（可能需要调整 Execution Groups）
4. 重新编码 → 测试验证 → commit → 重新提交 review-gate（从阶段一开始）

### 阶段二：并行审查 + Fix Worker 循环（最多 3 轮）

**Step 1: 并行审查**

| 维度 | Agent / Skill | 输入 | 输出 |
|------|--------------|------|------|
| Standards | `xyz-harness-standards-reviewer` | git diff + CLAUDE.md | standards_review_v{N}.md |
| Taste | `ts-taste-check` / `rust-taste-check` | git diff | ts_taste_review_v{N}.md |
| Robustness | `xyz-harness-robustness-reviewer` | git diff | robustness_review_v{N}.md |
| Code Quality | `fallow audit --format json` | 变更文件 | fallow_report_v{N}.md |
| Integration | `xyz-harness-integration-reviewer` | 源代码 | integration_review_v{N}.md |

**Fallow 审查**：`fallow audit --format json --base main`，对变更文件做 dead-code + complexity + duplication 综合审计。退出码 1 = "issues found"（正常），需要 `|| true`。

**Step 2: Fix Worker（汇总 + 判断 + 修复）**

Fix Worker 同时负责汇总判断和修复，一个节点完成：
1. 汇总 5 个 reviewer 的 must_fix 计数
2. must_fix = 0 → **Review-Gate PASSED** → 进入 Phase-Gate
3. must_fix > 0 → 进入修复流程：
   - 收集所有 must_fix 项，按涉及文件分组
   - 分析文件间依赖关系（A 文件的修复依赖 B 文件先修好）
   - 按 Wave 拆分修复任务（同 Wave 无依赖可并行）
   - 按 Wave 执行 subagent 修复
   - git commit
   - 回到 Step 1 重新并行审查

**循环终止条件**：

| 条件 | 行为 |
|------|------|
| must_fix = 0（Fix Worker 汇总判断） | 通过，触发 Phase-Gate |
| must_fix > 0 | Fix Worker 分析依赖→Wave 拆分→subagent 修复→回到并行审查 |
| 达到最大轮数（3） | 强制通过（警告） |
| 连续 2 轮 must_fix 不降 | 人工介入 |

## Phase-Gate

| 项目 | 说明 |
|------|------|
| 模式 | 脚本检查 + 防伪造检查 |
| 脚本检查 | 文档完整性 + YAML frontmatter + placeholder 扫描 |
| 防伪造 | `xyz-harness-gate-reviewer` subagent |

**与 Phase 1/2 的差异**：Phase 1/2 只有脚本检查。Phase 3 额外增加防伪造检查。原因：Phase 3 产出的是代码和测试结果，AI 更容易伪造（编造测试结果、跳过实际运行），需要独立 subagent 验证真实性。

**防伪造检查内容**：
- review 报告内容非空（不是空文件或占位符）
- test_results.md 包含实际命令输出（不是编造的）
- 代码变更真实存在（git diff 有实际改动）

**失败处理**：
- 返回主 agent，告知修复后**直接重新提交 phase-gate**
- **跳过 review-gate**

## 产出物

### Review-Gate 产出物

| 文件 | 产出者 | 消费者 |
|------|--------|--------|
| spec_plan_conformance_v{N}.md | 阶段一 reviewer | 主 agent（失败时） |
| standards_review_v{N}.md | Standards reviewer | Fix Worker |
| ts_taste_review_v{N}.md | Taste reviewer | Fix Worker |
| robustness_review_v{N}.md | Robustness reviewer | Fix Worker |
| fallow_report_v{N}.md | Fallow CLI | Fix Worker |
| integration_review_v{N}.md | Integration reviewer | Fix Worker |

### Phase-Gate 产出物

| 文件 | 说明 |
|------|------|
| test_results.md | 测试结果（verdict: pass, all_passing: true） |
| dev_retrospect.md | Retrospect |

### 交付物检查清单

| 文件 | Review-Gate | Phase-Gate |
|------|:-----------:|:----------:|
| spec_plan_conformance_v{N}.md | ✅ 内容 | ✅ YAML |
| standards_review_v{N}.md | ✅ 内容 | ✅ YAML |
| ts_taste_review_v{N}.md | ✅ 内容 | ✅ YAML |
| robustness_review_v{N}.md | ✅ 内容 | ✅ YAML |
| fallow_report_v{N}.md | ✅ 内容 | ✅ YAML |
| integration_review_v{N}.md | ✅ 内容 | ✅ YAML |
| test_results.md | — | ✅ YAML + 防伪造 |
| dev_retrospect.md | — | ✅ YAML |

## SKILL.md 变更

| 操作 | 目标 |
|------|------|
| **删除** | Step 4（Five-Step Specialized Review）全部内容 |
| **删除** | Step 4a（Retrospect）— 改由 phase-gate 触发 |
| **删除** | Step 6 中 review 文件检查项 — 改由 gate 保证 |
| **删除** | Step 7（Gate Handoff）— 不再需要单独 session |
| **删除** | Step 8（Tell user）中的"run gate check in a separate session" |
| **保留** | Step 0（防护预检） |
| **保留** | TDD/编码逻辑（简单/复杂路径判断、接口签名传递规则） |
| **保留** | test_results.md 格式 |
| **保留** | git commit + push |
| **新增** | Goal 自动追踪（`initializeGoalFromExternal()` API 在 phase-start 注入） |
| **新增** | "完成后调用 coding-workflow-gate(phase=3)" |

## Agent 文件规划

| Agent | 新建/复用 | 职责 |
|-------|----------|------|
| `spec-plan-conformance-reviewer.md` | 新建 | 阶段一前置审查：规格符合性 + 业务逻辑 |
| `xyz-harness-standards-reviewer` | 复用 SKILL.md | Standards 审查 |
| `ts-taste-check` / `rust-taste-check` | 复用 SKILL.md | Taste 审查 |
| `xyz-harness-robustness-reviewer` | 复用 SKILL.md | Robustness 审查 |
| `fallow`（CLI） | 外部工具 | Code Quality 审查 |
| `xyz-harness-integration-reviewer` | 复用 SKILL.md | Integration 审查 |
| `fix-worker.md` | 新建 | 阶段二 Fix Worker：汇总 + 判断 + 修复 |
| `xyz-harness-gate-reviewer` | 复用 SKILL.md | Phase-Gate 防伪造检查 |

## 可视化

`review-gate-flow/p3-dev.html`
