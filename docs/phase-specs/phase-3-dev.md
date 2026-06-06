# Phase 3 Dev — 实现规格

> 从 `review-gate-phase-analysis-playbook.md` 提取的最终结论，作为实现参考。

## 概览

| 项目 | 说明 |
|------|------|
| 阶段 | Phase 3 Dev（编码实现） |
| Skill | `xyz-harness-phase-dev` |
| 执行者 | 主 Agent + Subagent（按 Wave 编码）+ Workflow（Review-Gate） |
| 测试范围 | **单元测试**（TDD 产出，与代码一起编写） |
| 产出物 | 代码 + 单元测试 + review 报告（6 份）+ simulated_data/*.json + test_results.md + phase3_retrospect.md |

## 完整流程

```
1. [Skill] xyz-harness-phase-dev 加载
2. [Goal] phase-start 自动注入 initializeGoalFromExternal()
3. [主 Agent] 防护预检（Step 0）
4. [主 Agent/Subagent] 按 Goal 任务顺序执行（见 Goal 配置）
5. [Workflow] Review-Gate（整体是一个 Workflow，内含三阶段）
   阶段一：前置检查（单次，不循环）
   阶段一.五：模拟数据生成（如阶段一通过）
   阶段二：并行审查 + Fix Worker 循环
6. [脚本+防伪造] Phase-Gate
7. [Subagent] Retrospect（fork session）
```

## Phase 过渡

**Phase 2 → Phase 3**：Phase 2 Retrospect 完成后，主 agent 调用 `coding-workflow-phase-start(phase=3)`。该 tool handler 执行 compact，注入 Phase 3 steering prompt，并自动初始化 goal（从 plan.md 读取 Execution Groups 构建任务列表）。

**Phase 3 → Phase 4**：Phase 3 Retrospect 完成后，主 agent 调用 `coding-workflow-phase-start(phase=4)`。该 tool handler 执行 compact，注入 Phase 4 steering prompt。

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

## 测试分层：Phase 3 负责单元测试

| 测试类型 | Phase | 说明 |
|---------|-------|------|
| **单元测试** | **Phase 3** | TDD 流程内产出，测试单个函数/模块/组件的逻辑 |
| API 集成测试 | Phase 4 | 测试多模块协作、API 契约 |
| E2E 测试（API 端到端） | Phase 4 | 测试完整 API 链路 |
| E2E 测试（UI 端到端） | Phase 4 | Playwright 测试完整用户流程 |

**Phase 3 的单元测试范围**：
- 函数级：纯逻辑函数的输入输出测试
- 模块级：单个模块/服务的公开接口测试
- 组件级（前端）：Vue/React 组件的 props/events/render 测试
- TDD 红-绿-重构循环产出的所有测试

**不属于 Phase 3 的测试**：
- 需要多个 Execution Group 完成后才能运行的测试（→ Phase 4 集成测试）
- 需要完整前后端联调的测试（→ Phase 4 E2E 测试）
- 需要真实数据库/网络连接的测试（→ Phase 4 集成测试，Phase 3 用 mock）

**test_results.md 的内容**：Phase 3 的 test_results.md 只记录单元测试的运行结果。格式中应区分 `type: unit`。

**重新初始化策略**：阶段一失败后，不重建目标（保留历史），而是将所有任务状态重置为待处理。主代理根据审查报告调整编码策略后按序执行。

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

**整体是一个 Workflow**，内含三个阶段。

**三阶段执行语义**：
- **阶段一**：单次执行（不循环），失败则退出整个 Review-Gate 回到主代理编码
- **阶段一.五**：自动执行（非循环），基于阶段一的 `simulated_data_paths` 字段生成模拟数据文件
- **阶段二**：循环执行（最多 3 轮），审查→修复→重新审查，must_fix=0 时通过

"最多 3 轮"仅适用于阶段二。阶段一/一.五没有轮数概念。

### 阶段一：前置检查（单次，不循环）

| 项目 | 说明 |
|------|------|
| Agent | `spec-plan-conformance-reviewer.md`（新建，合并 BLR） |
| 输入 | spec.md + plan.md + use-cases.md + git diff + 源代码 |
| 审查内容 | 代码是否符合 spec+plan 描述 + 业务逻辑正确性 + AC 覆盖 |

**BLR 合并原因**：BLR（业务逻辑审查）和 spec-plan-conformance（规格符合性审查）审查内容高度重叠——都在对比 spec+plan vs 代码实现。合并后统一审查规格符合性和业务逻辑正确性。

**失败处理**：
```
FAIL → 退出 workflow → 主 agent 重置 goal 状态 → 检查缺失能力
     → 重新拆分 Wave → 编码 → 测试验证 → commit → 重新提交 review-gate
```

打回主 agent 后不回到 review-gate，而是回到编码阶段。**这与 Phase 1/2 不同**：Phase 1/2 review-gate 失败后循环内 agent 直接修复（文档修改成本低），Phase 3 review-gate 失败后回到主 agent 编码（代码修改成本高，需要重新 TDD → 测试 → commit）。
1. 调用 `goal_manager` 重置操作：将现有 goal 的所有任务状态重置为 pending（而不是重建，保留历史记录）
2. 主 agent 分析 spec-plan-conformance 报告中的问题
3. 重新拆分 Wave（可能需要调整 Execution Groups）
   > **Execution Groups 调整权限**：主 agent 有权在 Phase 3 内微调 Execution Groups（如拆分过大的 Group、调整 Wave 归属），但不允许删除或合并 Phase 2 定义的 Group。微调后需在 plan.md 中更新对应 Group 的 `wave` 和 `depends_on` 字段。如果调整超过 30% 的 Group，建议回到 Phase 2 重新规划。
4. 重新编码 → 测试验证 → commit → 重新提交 review-gate（从阶段一开始）

### 阶段二：并行审查 + Fix Worker 循环（最多 3 轮）

> **命名说明**：Phase 3 的 Fix Worker 同时负责"汇总判断 + 修复"（不同于 Phase 4 的 Fix Worker 只负责"修复"）。在实现中命名为 `review-sync-fix-worker.md` 以区分。

**Step 1: 并行审查**

| 维度 | Agent / Skill | 输入 | 输出 |
|------|--------------|------|------|
| Standards | `xyz-harness-standards-reviewer` | git diff + CLAUDE.md | standards_review_v{N}.md |
| Taste | `ts-taste-check` / `rust-taste-check` | git diff | ts_taste_review_v{N}.md |
| Robustness | `xyz-harness-robustness-reviewer` | git diff | robustness_review_v{N}.md |
| Code Quality | `fallow audit --format json` | 变更文件 | fallow_report_v{N}.md |
| Integration | `xyz-harness-integration-reviewer` | 源代码 | integration_review_v{N}.md |

**Fallow 审查**：通过 `fallow-reviewer.md`（新建 agent）包装 `fallow audit --format json --base main` 调用。该 agent 在 task prompt 中执行 fallow CLI，将 JSON 结果转为结构化 review 报告。退出码 1 = "issues found"（正常），需要 `|| true`。

**注意**：fallow 是 CLI 工具不是 SKILL.md，不能直接用 workflow 的 `agent()` 调用。需要 `fallow-reviewer.md` 作为 agent 包装层——它读取 fallow 的 JSON 输出，提取 error 级别问题（unused-export/unused-dep/boundary-violation），格式化为统一的 review 报告（YAML frontmatter + must_fix 计数）。

**Step 2: Fix Worker（汇总 + 判断 + 修复）**

Fix Worker 同时负责汇总判断和修复，一个节点完成：
1. 汇总 5 个 reviewer 的 must_fix 计数
2. must_fix = 0 → **Review-Gate PASSED** → 进入 Phase-Gate
3. must_fix > 0 → 进入修复流程：
   - 收集所有 must_fix 项，**按涉及文件分组**（不是按 Wave 分组）
   - 同一文件的所有 must_fix（可能来自多个 reviewer）由**同一个 subagent 串行处理**，避免并行修改同一文件导致冲突
   - **修复优先级（同一文件内多个 reviewer 的 must_fix）**：
     1. **Taste** → 最高优先级（结构性变更如拆函数、重命名，会改变后续修复的上下文）
     2. **Standards** → 其次（类型注解、import 规范）
     3. **Robustness** → 再次（try-catch、错误处理）
     4. **Integration** → 最后（接口签名，依赖前面修复完成）
     5. **Business Logic** → 与上述按需穿插（逻辑正确性优先于风格）
   - 不同文件之间可以并行（但每个文件独占一个 subagent）
   - 所有修复完成后 git commit
   - 回到 Step 1 重新并行审查

**修复粒度**：文件级分组，不是 Wave 级分组。原因：多个 reviewer 可能对同一文件发现问题（如 `auth.ts` 同时有 standards 和 robustness 问题），并行修复同一文件会冲突。

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

**与 Phase 1/2 的差异**：Phase 1/2 只有脚本检查（🟢 基础严格度）。Phase 3 增加防伪造检查（🟡 标准严格度）。原因：Phase 3 产出的是代码和测试结果，AI 更容易伪造（编造测试结果、跳过实际运行），需要独立 subagent 验证真实性。

**防伪造检查内容**：
- review 报告内容非空（不是空文件或占位符）
- test_results.md 包含实际命令输出（不是编造的）
- 代码变更真实存在（git diff 有实际改动）

**版本号规则**：review 报告文件名中的 `{N}` 随修复轮数递增（v1→v2→v3）。Phase-Gate 只检查最新版本（N = 最大轮数），旧版本保留供参考但不纳入 gate 检查。

**git diff 基准**：每轮并行审查中所有 reviewer 统一使用 `git diff main`（或 `git diff origin/main`），而不是累积 diff。Fix Worker commit 后，下一轮 reviewer 看到的是新的完整 diff。

**Integration reviewer 输入源**：阶段一的 spec-plan-conformance-reviewer 报告中包含「模拟数据路径」字段，列出用于验证集成接口的模拟数据文件路径。Integration reviewer 读取该字段获取模拟数据，不再依赖独立的 BLR 报告。

**spec-plan-conformance-reviewer 输出格式**：

YAML frontmatter 必须包含：
```yaml
verdict: pass | fail
must_fix: <number>
review_metrics:
  spec_coverage: <percentage>
  plan_coverage: <percentage>
  ac_coverage: <percentage>
  simulated_data_paths:
    - path: changes/reviews/phase-3/simulated_data/xxx.json
      description: 用户 API 响应模拟数据（供 Integration Reviewer 使用）
```

`simulated_data_paths` 字段列出 Integration Reviewer 需要的模拟数据文件路径。模拟数据的生成流程：

**阶段一.五（模拟数据生成）**：
1. 阶段一通过后，Workflow 读取 spec-plan-conformance-reviewer 报告中的 `simulated_data_paths` 字段
2. 根据字段中的路径列表和描述，dispatch 一个 subagent 生成模拟数据文件（JSON fixture）
3. 模拟数据文件存放在 `changes/reviews/phase-3/simulated_data/` 目录下
4. 生成完成后进入阶段二并行审查

**为什么需要阶段一.五**：Integration Reviewer 在阶段二 Step 1 并行审查时需要模拟数据来验证模块间接口。如果模拟数据不存在，Integration Reviewer 会因缺少输入而跳过审查或产出不完整的报告。阶段一和阶段二之间必须插入模拟数据生成步骤。

**失败处理**：
- 返回主 agent，告知修复后**直接重新提交 phase-gate**
- **跳过 review-gate**

## 代理修改文件后的上下文同步

Review-Gate 中的代理（阶段一的 spec-plan-conformance-reviewer、阶段二的各 reviewer 和 Fix Worker）会直接修改项目文件。这些修改发生在 workflow 的独立 pi 进程中，主代理的上下文不会自动更新。

**同步策略**：Workflow 完成后，gate tool handler 读取修改后的文件内容，在返回给主代理的结果中附带关键变更摘要（修改了哪些文件、主要变更内容）。主代理收到后可按需读取最新文件。

**如果 Review-Gate 整体失败**（阶段一失败退出）：主代理收到的结果中包含完整的审查报告路径和关键发现，主代理据此决定编码调整方案。此时主代理应重新读取 spec.md、plan.md 和相关源文件以获取最新版本。

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
| simulated_data/*.json | 阶段一.五 自动生成的模拟数据文件 |
| phase3_retrospect.md | Retrospect |

### 交付物检查清单

| 文件 | Review-Gate | Phase-Gate |
|------|:-----------:|:----------:|
| spec_plan_conformance_v{N}.md | ✅ 内容 | ✅ YAML |
| standards_review_v{N}.md | ✅ 内容 | ✅ YAML |
| ts_taste_review_v{N}.md | ✅ 内容 | ✅ YAML |
| robustness_review_v{N}.md | ✅ 内容 | ✅ YAML |
| fallow_report_v{N}.md | ✅ 内容 | ✅ YAML |
| integration_review_v{N}.md | ✅ 内容 | ✅ YAML |
| simulated_data/*.json | — | ✅ 存在 |
| test_results.md | — | ✅ YAML + 防伪造 |
| phase3_retrospect.md | — | ✅ YAML |

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
| `fallow-reviewer.md` | 新建 | Code Quality 审查（包装 fallow CLI，格式化 JSON 为 review 报告） |
| `xyz-harness-integration-reviewer` | 复用 SKILL.md | Integration 审查 |
| `review-sync-fix-worker.md` | 新建 | 阶段二 Review-Sync-Fix Worker：汇总 5 个 reviewer 结果 + 判断退出 + 修复代码 |
| `xyz-harness-gate-reviewer` | 复用 SKILL.md | Phase-Gate 防伪造检查 |

### 项目规范文件传递方式

部分 reviewer（standards、taste）需要读取项目自己的规范文件。采用 **subagent 自行查找并读取** 方案：

1. **SKILL.md 定义查找步骤** — 每个 reviewer 的 SKILL.md 中已定义规范文件查找逻辑（如 standards-reviewer 的 Phase A/B 检测 lint 配置 + 读 CLAUDE.md，taste-reviewer 检测项目类型 + 读 `~/.codetaste/essence.md`）
2. **subagent 自行读取** — subagent 有 `read`/`bash` 工具，按 SKILL.md 指引自行查找和读取。subagent 是独立 `pi --mode json` 进程，读文件不占用主 agent 上下文
3. **`cwd` 设为项目根目录** — dispatch subagent 时必须将 `cwd` 参数设为项目根目录，确保相对路径（如 `CLAUDE.md`、`pyproject.toml`）能正确解析

**不采用主 agent 预读注入的方案**。原因：项目规范路径不固定（CLAUDE.md / .editorconfig / pyproject.toml / ~/.codetaste/essence.md），subagent 按 SKILL.md 指引查找比主 agent 预判更灵活，且避免主 agent 上下文被规范内容膨胀。

## 可视化

`review-gate-flow/p3-dev.html`
