# Phase 2 Plan — 实现规格

> 从 `review-gate-phase-analysis-playbook.md` 提取的最终结论，作为实现参考。

## 概览

| 项目 | 说明 |
|------|------|
| 阶段 | Phase 2 Plan（方案设计） |
| Skill | `xyz-harness-writing-plans` |
| 执行者 | 主 Agent（phase 内部步骤 + retrospect）、Workflow（review-gate） |
| 产出物 | L1: 5 个文件 / L2: 9 个文件 |

## 完整流程

```
1. [Skill] xyz-harness-writing-plans 加载
2. [主 Agent] 复杂度评估（L1/L2）— 不用 subagent
3. [Goal] phase-start 自动注入（先注入 L1 默认任务，评估为 L2 后追加额外任务）
4. [主 Agent] 按 Step 顺序编写 plan 交付物（不并行，不 dispatch subagent）
5. [主 Agent] ADR 评估 — 不用 subagent（评估结论写入 plan.md 的 "## ADR 评估" 章节）
6. [主 Agent] 调用 coding-workflow-gate(phase=2)
   → gate tool 内部路由：先跑 Review-Gate，最多 3 轮
   → L2 时 Review-Gate 内含两个 reviewer 串行执行
   → Review-Gate 通过后再跑 Phase-Gate（脚本检查，最多 5 次重试）
7. [主 Agent] Retrospect（Phase-Gate 通过后，gate tool handler 通过 steer 指令触发）→ 产出 `phase2_retrospect.md`
→ 过渡：主 agent 调用 coding-workflow-phase-start(phase=3)
```

## Phase 过渡

**Phase 1 → Phase 2**：Phase 1 Retrospect 完成后，主 agent 调用 `coding-workflow-phase-start(phase=2)`。该 tool handler 执行 compact，注入 Phase 2 steering prompt，并自动初始化 goal。

**Phase 2 → Phase 3**：Phase 2 Retrospect 完成后，主 agent 调用 `coding-workflow-phase-start(phase=3)`。

## Goal 配置

**触发方式**：`phase-start` 自动注入（`initializeGoalFromExternal()` API）

**时序处理**：`executePhaseStartTool` 在入口时无法知道复杂度（L1/L2），采用"先默认后追加"策略：

1. 入口时注入 L1 任务列表（5 个任务）
2. Steering prompt 中指导主 agent 先做复杂度评估
3. 评估为 L2 时，主 agent 调用 `goal_manager.add_tasks()` 追加 4 个额外任务

**L1 任务列表**（默认注入，5 个任务）：
1. Write plan.md (with Execution Groups)
2. Write e2e-test-plan.md
3. Write test_cases_template.json
4. Write use-cases.md
5. Write non-functional-design.md

**L2 追加任务**（评估为 L2 时，调用 `goal_manager.add_tasks()` 追加到 L1 列表末尾）：
- Write plan-api-contract.md
- Write plan-backend.md
- Write plan-frontend.md
- Write interface_chain.json

> 注：`add_tasks()` 追加后，goal 中的实际编号为 6-9（排在 L1 的 5 个任务之后）。编写顺序需按 Step 1-6 执行（见"交付物编写顺序"），不按 goal 任务编号顺序。Steering prompt 中需明确"按 Step 顺序编写，不按 goal 任务编号顺序"。



**时序约束**：复杂度评估必须在标记任何 Goal 任务为 `in_progress` 之前完成。Steering prompt 中必须指导主 agent "进入 Phase 2 后，第一步是完成复杂度评估（L1/L2），评估为 L2 时立即调用 `goal_manager.add_tasks()` 追加额外任务，然后再开始 Step 1 编写 plan.md"。如果主 agent 在评估前已开始编写交付物，Goal 进度百分比会在追加任务时跳变（如 5 任务完成 3 个 = 60%，追加 4 个后变为 9 任务完成 3 个 = 33%），导致进度追踪不准确。

**API 调用**：
```typescript
import { initializeGoalFromExternal } from "@zhushanwen/pi-goal";

// executePhaseStartTool 中，Phase 2 入口
initializeGoalFromExternal(pi, ctx, "Phase 2: 完成 plan 阶段交付物", L1_TASKS);
// steering prompt 中指导：
// "评估为 L2 后，调用 goal_manager.add_tasks() 追加 L2 额外任务"
```

## 复杂度分级

| 级别 | 交付物数量 | 判断依据 |
|------|-----------|---------|
| L1 | 5 个 | 单模块、无前后端分离、CRUD 为主 |
| L2 | 9 个 | 多模块、前后端分离、有接口契约、有模块间依赖 |

**L1 产出物**：plan.md, e2e-test-plan.md, test_cases_template.json, use-cases.md, non-functional-design.md

> **Phase 1 推迟项**：use-cases.md 和 non-functional-design.md 是 Phase 1 推迟到 Phase 2 的产出物（因为这两个文件需要基于 plan 的架构设计才能细化）。Phase 2 的 L1 任务列表将这两个文件纳入。

**L2 额外产出物**：plan-backend.md, plan-frontend.md, plan-api-contract.md, interface_chain.json

## 交付物编写顺序

### L2（6 步，有依赖）

```
Step 1: plan.md（总纲）— 必须先写，定义架构和 Execution Groups
Step 2: plan-api-contract.md — 定义接口契约
Step 3: plan-backend.md + plan-frontend.md — 依赖 plan.md + plan-api-contract.md
Step 4: interface_chain.json — 从 Step 2-3 提取接口链
Step 5: e2e-test-plan.md + test_cases_template.json — 依赖 plan.md 的 Execution Groups
Step 6: use-cases.md + non-functional-design.md — 依赖 spec.md，可在 Step 1-5 期间任意时刻执行
```

### test_cases_template.json 的 phase 字段

测试用例必须标注 `phase` 字段，区分测试归属：

```json
{
  "test_cases": [
    {
      "id": "TC-U01",
      "type": "unit",
      "phase": 3,
      "description": "用户创建函数返回正确结构",
      "depends_on": []
    },
    {
      "id": "TC-I01",
      "type": "integration",
      "phase": 4,
      "description": "用户 API CRUD 完整链路",
      "depends_on": ["TC-U01"]
    },
    {
      "id": "TC-E01",
      "type": "e2e",
      "phase": 4,
      "description": "用户注册→登录→创建订单→支付→查看订单",
      "data_testids": ["register-form", "login-btn", "create-order", "pay-btn"],
      "depends_on": ["TC-I01"]
    },
    {
      "id": "TC-M01",
      "type": "manual",
      "phase": 4,
      "description": "支付失败时的错误提示文案检查",
      "verification_method": "manual"
    }
  ]
}
```

**字段说明**：
- `phase`: 3 = Phase 3 TDD 执行，4 = Phase 4 集成/E2E 执行
- `type`: unit / integration / e2e / manual
- `data_testids`: E2E 测试需要的关键 UI 元素 ID（Phase 3 编码时必须添加到代码中）
- `verification_method`: manual = 不可自动化，Phase 4 输出给用户手动验证

### L1（3 步，简化）

```
Step 1: plan.md（含 Execution Groups）
Step 2: e2e-test-plan.md + test_cases_template.json
Step 3: use-cases.md + non-functional-design.md（可在 Step 1-2 期间任意时刻执行）
```

> **Goal 任务与 Step 的映射**：L1 的 5 个 Goal 任务按文件粒度划分，但 Step 按逻辑分组（Step 2 包含 e2e-test-plan.md + test_cases_template.json）。主 agent 在完成一个 Step 内的所有文件后，逐个更新对应的 Goal 任务状态。如果 Step 中某个文件失败，只标记该文件对应的 Goal 任务为 failed，不影响同 Step 其他文件。

## 任务依赖关系（供 Phase 3 使用）

plan.md 中每个 Execution Group 必须标注：

```yaml
# plan.md 中 Execution Group 的标注格式
groups:
  - id: BG1
    depends_on: []
    provides: [基础数据接口]
    wave: 1
  - id: BG2
    depends_on: [BG1]
    provides: [业务接口]
    wave: 2
```

**interface_chain.json 角色**：定义模块间接口签名。Phase 3 的 Integration Reviewer 依赖此文件验证模块衔接。

**Wave 编排规则**：
- 同一 Wave 内的 Group 可并行执行（最多 3 个 subagent）
- 不同 Wave 之间串行
- Wave = DAG 拓扑排序分层

**嵌入规范**：plan.md 中的 Execution Groups 必须遵循以下格式：

```markdown
## Execution Groups

\`\`\`yaml
groups:
  - id: BG1
    depends_on: []
    provides: [基础数据接口]
    wave: 1
  - id: BG2
    depends_on: [BG1]
    provides: [业务接口]
    wave: 2
\`\`\`
```

- 必须在 `## Execution Groups` 章节下
- 必须使用 YAML 围栏代码块（` ```yaml ... ``` `）
- Phase 3 的 `extractExecutionGroups()` 函数按此格式解析定位
- **L1 项目也必须包含 Execution Groups 章节**（即使只有 1 个 Group，作为 Phase 3 Goal 任务构建的输入）

> **Phase 3 微调权限**：Phase 3 的主 agent 允许在 EG 调整不超过 30% 的前提下微调 Execution Groups（拆分过大的 Group、调整 Wave 归属、修改 depends_on）。超过 30% 的调整**建议**回退到 Phase 2 重新规划（需用户确认）。详见 Phase 3 spec 的"Execution Groups 调整权限"章节。

## Review-Gate

| 项目 | 说明 |
|------|------|
| 模式 | Workflow 循环 |
| L1 Agent | `plan-requirements-reviewer.md`（单 agent） |
| L2 Agent | `plan-requirements-reviewer.md` + `plan-bl-requirements-reviewer.md`（**串行**审查） |
| 循环 | agent 审查 + 直接修复 → must_fix=0 退出 |
| 最大轮数 | 3 |
| 连续不降 | 2 轮 → 人工介入 |

**内部结构**：
```
循环 {
  // L2: 两个 reviewer 串行执行（避免同时修改文件冲突）
  [Agent 1] plan-requirements-reviewer.md 审查 + 直接修复
  [Agent 2] plan-bl-requirements-reviewer.md 审查 + 直接修复（L2 only）
  判断: must_fix = 0 → 通过 / > 0 → 继续循环
}
```

**为什么串行不用并行**：Phase 2 的产出物是文档（plan.md 等），两个 reviewer 同时修改同一文件会导致冲突。文档数量不多（最多 9 个文件），串行执行的额外耗时可接受。

**连续不降阈值说明**：与 Phase 1 一致，2 轮不降→人工介入，最大 3 轮。

## Phase-Gate

| 项目 | 说明 |
|------|------|
| 模式 | 脚本检查（无防伪造） |
| 检查项 | 文档完整性 + YAML frontmatter + placeholder 扫描 |
| 严格度 | 🟢 基础（仅脚本） |
| 失败处理 | 返回主 agent 修复，修复后直接重新提交 phase-gate（跳过 review-gate） |
| 最大重试 | 5 次 |

**通过后动作**：Phase-Gate 通过后，gate tool handler 执行以下两个动作：
1. 通过 steer 指令触发主 agent 执行 Retrospect（与 Phase 1/3/4 一致）
2. 将当前 commit hash 记录到 phase state 文件 `coding-workflow-p2.json` 中的 `phase2_gate_commit` 字段。该 hash 供 Phase 4 一致性检查使用——验证 `test_cases_template.json` 未被后续篡改。

> **commit hash 记录时机**：每次 Phase-Gate 重新提交并通过时，commit hash 都用最新的 commit 覆盖前值（不使用最初通过时的 hash），确保 Phase 4 检查的是"Phase 2 gate 最近一次通过时的 commit"。

**失败处理**：
- 返回主 agent，告知修复后**直接重新提交 phase-gate**
- **跳过 review-gate**

## 代理修改文件后的上下文同步

Review-Gate 中的 agent（`plan-requirements-reviewer.md`、`plan-bl-requirements-reviewer.md`）会直接修改 plan 文档。这些修改发生在 Workflow 的独立 pi 进程中，主 agent 的上下文不会自动更新。

**同步策略**：Workflow 完成后，gate tool handler 读取修改后的 plan 文档内容，在返回给主 agent 的结果中附带关键变更摘要（修改了哪些文件、主要变更内容）。主 agent 收到后可按需读取最新文件。

**说明**：Phase 2 的 review-gate 修改的文档量中等（L1 = 5 个文件 / L2 = 9 个文件），上下文同步复杂度介于 Phase 1（1 个文件）和 Phase 3（多代码文件）之间。

## SKILL.md 变更

| 操作 | 目标 |
|------|------|
| **删除** | Self-Review 章节（主 agent 自审） |
| **删除** | Plan Review 章节（主 agent 自审） |
| **删除** | Gate Handoff 章节（单独 session 提交 gate） |
| **保留** | 设计步骤（ADR Evaluation） |
| **保留** | 格式检查项（交付物验证中的格式部分） |
| **新增** | "完成后调用 coding-workflow-gate(phase=2)" |
| **新增** | 复杂度评估后调用 `goal_manager.add_tasks()` 追加 L2 任务 |

## 产出物清单

| 文件 | L1 | L2 | Review-Gate | Phase-Gate（脚本） |
|------|:--:|:--:|:-----------:|:----------:|
| plan.md | ✅ | ✅ | ✅ 内容 | ✅ 格式 |
| e2e-test-plan.md | ✅ | ✅ | ✅ 内容 | ✅ 格式 |
| test_cases_template.json | ✅ | ✅ | ✅ 内容 | ✅ 格式 |
| use-cases.md | ✅ | ✅ | ✅ 内容 | ✅ 格式 |
| non-functional-design.md | ✅ | ✅ | ✅ 内容 | ✅ 格式 |
| plan-backend.md | ❌ | ✅ | ✅ 内容 | ✅ 格式 |
| plan-frontend.md | ❌ | ✅ | ✅ 内容 | ✅ 格式 |
| plan-api-contract.md | ❌ | ✅ | ✅ 内容 | ✅ 格式 |
| interface_chain.json | ❌ | ✅ | ✅ 内容 | ✅ 格式 |
| phase2_retrospect.md | — | — | — | `changes/reviews/phase-2/phase2_retrospect.md` |

## Agent 文件规划

| Agent | 新建/复用 | 职责 |
|-------|----------|------|
| `plan-requirements-reviewer.md` | 新建 | L1/L2 共用 Review-Gate 审查：覆盖规格符合性 + plan 结构合理性（Execution Groups、API 契约、interface_chain） |
| `plan-bl-requirements-reviewer.md` | 新建 | L2 专用 Review-Gate 审查：在 `plan-requirements-reviewer` 之后串行执行，专注业务逻辑覆盖（use-case → Execution Group 映射、边界条件、跨模块业务流） |

**L2 双 agent 串行原因**：Phase 2 的产出物是文档（plan.md 等），两个 reviewer 同时修改同一文件会导致冲突。文档数量不多（最多 9 个文件），串行执行的额外耗时可接受。

**项目规范文件传递方式**：与 Phase 3 一致——subagent 自行查找并读取项目规范文件（CLAUDE.md），`cwd` 设为项目根目录。详见 Phase 3 spec 的"项目规范文件传递方式"小节。

## 可视化

`review-gate-flow/p2-plan.html`
