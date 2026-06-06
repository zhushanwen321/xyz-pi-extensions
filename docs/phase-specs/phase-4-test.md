# Phase 4 Test — 实现规格

> Phase 4 的核心是**测试-修复循环**，不是简单的执行+审查。测试与其他阶段不同：需要反复运行→修复→重跑，直到所有 case 通过或充分跳过。

## 概览

| 项目 | 说明 |
|------|------|
| 阶段 | Phase 4 Test（集成测试 + E2E 测试） |
| Skill | `xyz-harness-phase-test` |
| 执行者 | 主 Agent（编排 + 服务启动）+ Workflow（测试-修复循环）+ Subagent（测试执行 + 修复） |
| 测试范围 | **集成测试 + E2E 测试**（单元测试在 Phase 3 TDD 中完成） |
| 核心机制 | **Test-Fix Loop Workflow**（无限循环直到全部通过） |
| 产出物 | test-execute-v{N}.json（版本化测试执行记录）+ phase4_retrospect.md |
| Review-Gate | **不需要**（测试-修复循环已包含质量保障） |
| Phase-Gate | 脚本检查 + **严格防伪造**（质疑所有测试结果） |

**不使用 Goal 工具**：Phase 4 不使用 `initializeGoalFromExternal()` 做 task tracking。原因：Phase 4 的核心机制是 Test-Fix Loop Workflow，内部用 `test-execute-v{N}.json` 做版本化状态管理（每个 case 有 passed/skipped/failed/fixed 状态），这比 goal 工具的任务列表更适合表达测试循环的语义。goal 工具的任务是线性进度追踪，而测试需要反复执行→修复→重测的非线性循环。

## 测试分层

| 测试类型 | Phase | 说明 |
|---------|-------|------|
| 单元测试 | Phase 3 | TDD 流程内产出（已完成） |
| **API 集成测试** | **Phase 4** | 测试多模块协作、API 契约、数据库交互 |
| **E2E 测试（API 端到端）** | **Phase 4** | 完整 API 链路：创建→读取→更新→删除 |
| **E2E 测试（UI 端到端）** | **Phase 4** | Playwright 模拟真实用户操作流程 |

### Phase 4 执行的测试类型

| 测试类型 | 环境依赖 | 工具 | Subagent 配置 |
|---------|---------|------|-------------|
| API 集成测试 | backend-only | curl / httpx / supertest | 标准 subagent |
| 模块协作测试 | backend + DB | vitest / pytest | 标准 subagent |
| E2E 测试（API） | full-stack | curl / httpx | 标准 subagent |
| E2E 测试（UI） | frontend + backend | Playwright | 强制加载 browser-automation / playwright-mcp / chrome-devtools |

**所有测试都要自动化执行**（AI agent 执行测试），不区分核心/非核心。但分成 2 个串行 workflow，优先保障核心业务。

## 完整流程

```
1. [Skill] xyz-harness-phase-test 加载
2. [主 Agent] 读取 test_cases_template.json + e2e-test-plan.md
3. [主 Agent] 分类测试用例：
   - 核心业务 case（映射 spec 的核心 use-case）
   - 非核心 case（边缘场景、内部功能）
4. [主 Agent] 启动基础设施（dev server / backend / DB），确保服务就绪
5. [Workflow 1] Test-Fix Loop（核心业务 case）← 无限循环直到全部通过
6. [Workflow 2] Test-Fix Loop（非核心 case）← 无限循环直到全部通过
7. [主 Agent] 输出不可测试项手动验证清单给用户
   - 过滤 test_cases_template.json 中 `type: manual` 且 `phase: 4` 的 case
   - 输出为 `changes/manual-verification-checklist.md`
   - 格式：每个 case 列出 ID、描述、verification_method
   - manual case 不进入 Test-Fix Loop，不阻塞 Phase-Gate
8. [脚本 + 严格防伪造] Phase-Gate
9. [Subagent] Retrospect（fork session）
```

## Phase 过渡

**Phase 3 → Phase 4**：Phase 3 Retrospect 完成后，主 agent 调用 `coding-workflow-phase-start(phase=4)`。该 tool handler 执行 compact，注入 Phase 4 steering prompt。

**Phase 4 → Phase 5**：Phase 4 Retrospect 完成后，主 agent 调用 `coding-workflow-phase-start(phase=5)`。该 tool handler 执行 compact，注入 Phase 5 steering prompt（收集证据 + 生成 PR + 推送）。

## 核心机制：Test-Fix Loop Workflow

### 为什么用 Workflow 而不是 Wave

Wave 是一次性并行调度，适合编码任务（每个 subagent 独立写代码）。但测试不同：
- 测试需要**反复执行**：修复后要重跑验证
- 测试结果有**版本化状态**：每轮记录通过/跳过/失败
- 修复和重测是**紧耦合循环**：不能分开管理

### Loop 结构

```
Test-Fix Loop Workflow（无限循环）:
  ┌─────────────────────────────────────────────────────────┐
  │ Turn N:                                                  │
  │                                                          │
  │ 1. [Workflow 节点] 构造/读取 test-execute-v{N}.json     │
  │    - Turn 1: 从 test_cases_template.json 构造 v1        │
  │      **只过滤 phase=4 的 case**（phase=3 的 unit case    │
  │      已在 Phase 3 TDD 中完成，不属于 Phase 4）           │
  │      **排除 type: manual 的 case**（manual case 由主     │
  │      agent 输出给用户手动验证，不进入自动测试循环）       │
  │    - Turn 2+: 读取上一轮 v{N-1}，生成 v{N}              │
  │    - 标记哪些 case 需要重新测试                           │
  │                                                          │
  │ 2. [Workflow 节点] 分派 Wave 并行测试                    │
  │    - 按 depends_on / wave 构建 DAG                       │
  │    - 每个 Wave 最多 3 个 subagent 并行                   │
  │    - 每个 subagent 负责一组 case                          │
  │                                                          │
  │ 3. [Subagent] 执行测试，更新 case 状态：                 │
  │    - passed: 测试通过                                    │
  │    - skipped: 跳过（必须给出理由）                        │
  │    - failed: 不通过（给出表现 + 初步问题分析）            │
  │                                                          │
  │ 4. [Workflow 节点] 汇总                                  │
  │    - 所有 case 都 passed 或 skipped？                    │
  │    - 所有 skipped 的理由是否充分？                        │
  │    → YES: 退出 Loop                                      │
  │    → NO: 进入 Fix Worker                                 │
  │                                                          │
  │ 5. [Subagent] Fix Worker:                                │
  │    - 分析 failed case 的问题                             │
  │    - 修复代码或测试                                      │
  │    - 更新 case 状态为 "fixed"，记录 bug 原因             │
  │    - git commit                                          │
  │    → 回到 Step 1，Turn N+1                               │
  │                                                          │
  └─────────────────────────────────────────────────────────┘
```

### test-execute-v{N}.json 结构

**示例（Turn 2 结束时的中间状态，非最终退出结果）**：

```json
{
  "version": 2,
  "workflow": "core",
  "timestamp": "2025-01-15T10:30:00Z",
  "summary": {
    "total": 15,
    "passed": 12,
    "skipped": 1,
    "failed": 2,
    "fixed_from_previous": 2
  },
  "cases": [
    {
      "id": "TC-I01",
      "type": "integration",
      "description": "用户 API CRUD 完整链路",
      "assigned_to": "subagent-wave1-1",
      "status": "passed",
      "last_run": "2025-01-15T10:25:00Z",
      "history": [
        {"turn": 1, "status": "failed", "evidence": "404 on PUT /users/123"},
        {"turn": 2, "status": "passed"}
      ]
    },
    {
      "id": "TC-E01",
      "type": "e2e",
      "description": "用户注册→登录→创建订单→支付",
      "assigned_to": "subagent-wave1-2",
      "status": "fixed",
      "last_run": "2025-01-15T10:26:00Z",
      "failure": {
        "symptom": "支付按钮点击后页面无响应",
        "analysis": "支付 API 返回 500，疑似订单金额为负数导致后端校验失败",
        "affected_files": ["src/services/payment.ts"]
      },
      "fix_description": "修复订单金额计算逻辑，添加负数校验",
      "bug_cause": "订单创建时未校验商品数量是否为正整数，导致金额为负数触发支付网关 500",
      "fixed_by": "fix-worker-1",
      "history": [
        {"turn": 1, "status": "failed", "evidence": "支付按钮无响应，API 500"},
        {"turn": 2, "status": "fixed", "evidence": "修复 order.quantity 校验"}
      ]
    },
    {
      "id": "TC-I05",
      "type": "integration",
      "description": "日志导出功能（非核心）",
      "assigned_to": "subagent-wave2-1",
      "status": "skipped",
      "skip_reason": "依赖的日志存储服务未在测试环境中部署（S3 mock 不可用），需要手动验证",
      "history": [
        {"turn": 1, "status": "skipped", "evidence": "S3 mock 不可用"}
      ]
    }
  ]
}
```

### Turn N+1 的增量测试

Turn 2+ 不重跑所有 case，只重跑：
- 上一轮 `failed` 且已 `fixed` 的 case
- 上一轮依赖 failed case 的下游 case（通过 depends_on 判断）

```json
{
  "version": 3,
  "rerun_strategy": "incremental",
  "rerun_cases": ["TC-E01", "TC-E02"],
  "rerun_reason": "TC-E01 fixed in turn 2, TC-E02 depends on TC-E01"
}
```

### Fix Worker 行为

1. 读取当前 version 的 test-execute JSON 中所有 failed case
2. 分析 failure.symptom + failure.analysis + failure.affected_files
3. 按涉及文件分组修复（同一文件的修复合并处理）
4. 修复后更新 case 状态为 `fixed`，记录：
   - `fix_description`: 修复了什么
   - `bug_cause`: 根因分析
5. git commit（commit message 包含修复的 case ID）
6. 回到 Loop 顶部，触发 Turn N+1

**与 Phase 3 Fix Worker 的关系**：Phase 4 的 Fix Worker 是独立的，不遵循 Phase 3 Review-Gate 的修复优先级（Taste > Standards > Robustness > Integration）。Phase 4 Fix Worker 的唯一目标是让测试通过，修复优先级按 case 类型决定：核心业务 case > 非核心 case。Phase 3 的 review 报告不作为 Phase 4 Fix Worker 的输入。

### Loop 退出条件

| 条件 | 行为 |
|------|------|
| 所有 case `passed` 或 `skipped` + 跳过理由充分 | 退出 Loop |
| 达到最大 Turn 数（10） | 强制退出，生成报告并交给用户决策 |
| 连续 3 轮 failed 数量不降 | 强制退出，报告阻塞问题给用户 |

**强制退出后的处理流程**：

1. Workflow 生成强制退出报告（`test-forced-exit-report.json`），列出所有未通过 case 及其失败原因
2. Workflow 将报告返回给 gate tool handler
3. Gate tool handler 将结果返回给主 agent，**附带明确的用户决策选项**：
   - **选项 A**：接受当前测试覆盖率（用户确认风险），继续进入 Phase-Gate
   - **选项 B**：回到 Test-Fix Loop 继续修复（从 Workflow 1 重新开始）
   - **选项 C**：回退到 Phase 3 重新编码（适用于系统性设计缺陷导致大量测试失败）
4. 主 agent 将选项展示给用户，等待用户决策
5. 用户选择后，主 agent 按选择执行

### 跳过理由的充分性判定

**判定主体**：跳过理由的充分性由 Test-Fix Loop Workflow 中的汇总节点（`test-execute-coordinator.md`）判定。该 coordinator 是 AI Agent（不是纯代码逻辑），有能力做主观判断。对于 ⚠️ 需审查的情况，coordinator 会尝试让 Fix Worker 构造测试数据或重试；对于 ❌ 不充分的情况，coordinator 拒绝跳过并强制 Fix Worker 分析修复。

| 跳过理由 | 是否充分 | 说明 |
|---------|---------|------|
| 外部服务不可用（S3/支付网关） | ✅ 充分 | 测试环境无法模拟 |
| 依赖未实现的功能 | ✅ 充分 | Phase 3 未覆盖的功能点 |
| 测试数据不足 | ⚠️ 需审查 | Fix Worker 应尝试构造测试数据 |
| 测试环境不稳定（flaky） | ⚠️ 需审查 | 应至少重试 2 次后才允许跳过 |
| 不确定 | ❌ 不充分 | Fix Worker 必须分析并修复 |

## 两个串行 Workflow

### Workflow 1：核心业务 Case

**范围**：映射 spec.md 核心use-case 的集成/E2E 测试。

- 注册/登录/支付/提交等核心用户旅程
- 关键 API CRUD 链路
- 数据完整性验证

**优先级**：最高。必须先全部通过，才开始 Workflow 2。

### Workflow 2：非核心 Case

**范围**：边缘场景、内部管理功能、非核心 UI 交互。

- 错误提示文案检查
- 分页/排序/过滤
- 内部管理页面
- 边缘输入值测试

**优先级**：次高。在 Workflow 1 通过后执行。

### 串行原因

1. 核心业务 case 失败往往暴露系统性问题（影响非核心 case），先修核心能减少非核心的返工
2. Fix Worker 修复核心 case 时代码变更可能影响非核心 case，避免并行时的冲突
3. 资源集中：先保障核心通过，再处理非核心

### Workflow 1 → Workflow 2 状态传递

Workflow 1 完成后，Workflow 2 启动前需要以下信息传递：

1. **受影响的非核心 case**：读取 Workflow 1 最终 test-execute JSON 中所有 `fixed` case 的 `affected_files` 字段，与 Workflow 2 的非核心 case 做依赖匹配。如果非核心 case 的被测文件在 `affected_files` 中，该 case 应优先测试
2. **代码变更摘要**：Workflow 2 的 coordinator 读取 Workflow 1 的 Fix Worker commit（`git log --oneline`），了解核心修复的内容。如果修复涉及公共模块（如认证、数据层），Workflow 2 的测试用例可能需要调整预期
3. **环境状态确认**：Workflow 1 的 Fix Worker 可能修改了数据库 schema 或 API 路由，Workflow 2 启动前主 agent 需确认基础设施状态（dev server / DB）仍然就绪

**数据流详细路径**：

```
test-execute-v{N}-core.json (Workflow 1 最终版)
  ↓ 提取所有 status=fixed 的 case
  ↓ 读取每个 fixed case 的 failure.affected_files 字段
  ↓
test_cases_template.json
  ↓ 过滤 phase=4, type≠manual, 未在 Workflow 1 中 passed 的 case
  ↓ 检查这些 case 的测试目标文件是否出现在 affected_files 中
  ↓ 如果是 → 标记为“需重跑”（依赖核心修复）
  ↓ 如果否 → 正常加入 Workflow 2 队列
```

**保守策略**：如果 test_cases_template.json 中的 case 缺少与源文件的映射（没有 `affected_files` 维度），Workflow 2 默认保守策略：**所有非核心 case 都标记为“需重跑”**，确保不遗漏。

## Phase-Gate：严格防伪造

Phase 4 没有 Review-Gate（测试-修复循环已保障质量），但 **Phase-Gate 需要做最严格的防伪造检查**。

### 检查内容

| 检查项 | 说明 | 严格度 |
|--------|------|--------|
| 脚本检查 | test-execute JSON 格式 + 最终 version 全部 passed/skipped | — |
| Case 与 Spec/Plan 一致性 | 质疑每个 case 是否和 spec.md、plan.md 中定义的一致 | 🔴 核心严格，🟡 非核心适当放宽 |
| Case 与 Phase 2 提交一致性 | 检查 test_cases_template.json 是否和 Phase 2 git commit 时一致，是否被后续篡改 | 🔴 严格 |
| 跳过理由质疑 | 对每个 skipped case 质疑：为什么跳过？理由是否充分？环境真的不可用吗？ | 🔴 核心严格，🟡 非核心适当放宽 |
| 测试结果真实性 | test-execute JSON 中的 evidence 是否包含实际命令输出/断言结果 | 🔴 严格 |
| 修复记录完整性 | 每个 fixed case 是否有 fix_description + bug_cause | 🟡 检查 |

### 防伪造检查的 3 个层次

**层次 1：脚本检查（自动化）**
- test-execute-v{final}.json 格式完整
- 最终 version 所有 case 状态为 passed 或 skipped
- 每个 skipped case 有 skip_reason 字段

**层次 2：一致性检查（AI Agent）**
- 对比 test_cases_template.json（Phase 2 gate 通过时的 commit 版本）vs 当前 test-execute JSON
- 验证 case ID、description、type 完全匹配
- 检查 test_cases_template.json 文件是否被修改过（`git diff <phase2_gate_commit> -- test_cases_template.json`）
- `phase2_gate_commit` 从 phase state 文件（`coding-workflow-p2.json`）的 `phase2_gate_commit` 字段读取

**层次 3：深度质疑（AI Agent）**
- 对每个 skipped case：质疑跳过理由，要求提供更充分的证据
- 对核心 case：要求 subagent 提供执行日志片段作为 evidence
- 对 fixed case：验证 bug_cause 是否合理，fix 是否真的解决了问题

### 严格度差异

| 维度 | 核心业务 Case | 非核心 Case |
|------|-------------|------------|
| Case 与 spec/plan 一致性 | 逐条比对 | 抽查 |
| 跳过理由 | 必须提供环境日志作为证据 | 文字说明即可 |
| 测试结果真实性 | 必须有命令输出/断言日志 | 通过即可 |
| 修复记录 | fix_description + bug_cause + affected_files | fix_description 即可 |
| Phase 2 一致性 | git diff 逐字节比对 | 抽查关键字段 |

### 失败路由（根据失败原因决定后续动作）

| 失败原因 | 路由 |
|---------|------|
| 格式错误（YAML/placeholder/字段缺失） | 主 agent 直接修复 → 重新提交 phase-gate |
| 测试证据不完整（evidence 缺少命令输出） | 回到 Test-Fix Loop 重跑对应 case → 通过后再提交 phase-gate |
| 状态不一致（JSON 中有 failed case 但 summary 写 all_passed） | 主 agent 审查并修正 → 重新提交 phase-gate |
| case 一致性问题（test_cases_template.json 被篡改） | 回到 Phase 2 重新确认 |

**最大重试 5 次**（与 Phase 1/2/3 一致）。超过 5 次仍失败时，打回主 agent 并附带最后一次失败报告，由用户决定后续动作。

**关键区分**：**内容格式问题**直接修，**测试实质问题**需回到 Test-Fix Loop。

### Retrospect 触发

- Phase-Gate **通过**后，主 agent dispatch Retrospect subagent（fork session）
- Phase-Gate **失败**后打回主 agent 修复，修复通过后重新提交 phase-gate，phase-gate 通过后再 dispatch Retrospect
- Retrospect 始终在 Phase-Gate 通过后触发，不会跳过

**与其他 Phase 一致**：Phase 1/2/3 也是 Phase-Gate 通过后由主 agent dispatch Retrospect（流程图中的 `[Subagent] Retrospect` 步骤）。

## 主 Agent 与 Subagent 职责分离

| 角色 | 职责 |
|------|------|
| **主 Agent** | 启动基础设施（dev server / backend / DB）、dispatch Workflow、合并结果、输出手动验证清单 |
| **Subagent（测试执行）** | 执行测试用例、更新 case 状态（passed/skipped/failed） |
| **Subagent（Fix Worker）** | 分析失败原因、修复代码/测试、更新 case 状态为 fixed |
| **Subagent（Phase-Gate 防伪造）** | 独立验证测试结果真实性 |

**关键约束**：subagent 不负责启动/停止服务器。主 agent 启动服务，subagent 消费服务。

## 前端测试 Subagent

### 强制 Skill 注入

主 agent dispatch 前端测试 subagent 时，task prompt 中必须包含加载以下 skill/MCP 的指导：

| Skill / MCP | 用途 |
|------------|------|
| `browser-automation` | 截图、元素检查、UI 交互、样式检查 |
| `playwright-mcp` | Playwright 测试执行和断言 |
| `chrome-devtools` | 网络监控、性能分析、Console 日志 |

### 进程隔离

- 每个 frontend 测试 subagent 启动独立 Playwright browser 进程
- 测试数据隔离：每个 subagent 使用独立测试用户账号
- Subagent 之间不能共享页面状态

## E2E 测试最佳实践

### 1. 以用户旅程为中心

E2E 测试 case 应直接映射 spec.md 的 use-case，不是映射 plan 的 Execution Group。

### 2. 稳定唯一选择器

- 使用 `data-testid` 属性作为选择器
- Playwright 优先级：`getByRole` > `getByTestId` > `getByText` > CSS selector
- Phase 3 编码时必须为关键交互元素添加 `data-testid`（Standards Reviewer 检查）
- Phase 2 plan 中标注哪些页面/组件需要 `data-testid`

### 3. 测试隔离与无共享状态

- 每个测试用独立的测试数据
- Wave 并行时每个 subagent 使用独立测试数据集
- 不依赖测试执行顺序

### 4. 智能等待策略

- 禁止 `page.waitForTimeout()`
- 使用 `expect(locator).toBeVisible()` 等 web-first assertion
- CI 环境配置 `retries: 2`
- 配置 `trace: 'on-first-retry'` 只在失败时记录

### 5. 测试维护是一等活动

- 测试代码和产品代码同等重要
- Fix Worker 修复测试代码时和修复产品代码同等标准

## 产出物

### 为什么 Phase 3 用 test_results.md 而 Phase 4 用 test-execute JSON？

Phase 3 的单元测试产出 `test_results.md`（Markdown + YAML frontmatter），因为 Phase 3 的测试结果是**一次性的**——TDD 写完跑完就结束，不需要版本化追踪。

Phase 4 的集成/E2E 测试产出 `test-execute-v{N}.json`（JSON 版本化），因为 Phase 4 是**循环的**——测试→修复→重测，每轮结果不同，需要版本化状态管理（failed → fixed → passed）。

### Phase 4 Fix Worker 修复代码后，Phase 3 的 review 报告是否失效？

**可能失效，但不重新验证**。原因：
1. Phase 4 的 Fix Worker 只修复影响测试通过的代码（如数据校验逻辑、接口字段映射），不涉及 Phase 3 review 报告审查的架构设计
2. 如果 Fix Worker 的修改影响了 Phase 3 review 的结论（如改变了接口契约），Phase-Gate 的一致性检查会发现（test_cases_template.json 与 Phase 2 commit 比对）
3. 重新跑 Phase 3 的全部 review 成本过高（6 个 subagent），收益不成比例

### 测试执行记录（版本化）

| 文件 | 说明 |
|------|------|
| `test-execute-v{N}-core.json` | Workflow 1（核心）最终 version 的测试执行记录 |
| `test-execute-v{N}-noncore.json` | Workflow 2（非核心）最终 version 的测试执行记录 |
| `manual-verification-checklist.md` | 输出给用户手动验证的不可测试项清单（不进入 Phase-Gate 检查） |
| `test-forced-exit-report.json` | 强制退出时生成（可选，仅在触发强制退出时存在） |

### Phase-Gate 产出物

| 文件 | 说明 |
|------|------|
| `test-execute-v{N}-core.json` | 核心测试最终结果 |
| `test-execute-v{N}-noncore.json` | 非核心测试最终结果 |
| `phase4_retrospect.md` | Retrospect |

### 交付物检查清单

| 文件 | 脚本检查 | 一致性检查 | 深度质疑 |
|------|:-------:|:---------:|:-------:|
| test-execute-v{N}-core.json | ✅ 格式 | ✅ 与 Phase 2 比对 | ✅ 逐条 |
| test-execute-v{N}-noncore.json | ✅ 格式 | 🟡 抽查 | 🟡 抽查 |
| phase4_retrospect.md | ✅ YAML | — | — |
| manual-verification-checklist.md | — | — | ❌ 不检查 |

## SKILL.md 变更

| 操作 | 目标 |
|------|------|
| **删除** | Review-Gate 章节（被 Test-Fix Loop 替代） |
| **删除** | Gate Handoff 章节 |
| **保留** | 依赖分析步骤 |
| **保留** | 前端测试 Subagent Skill 注入指导 |
| **保留** | 主 Agent 服务启动 + Subagent 消费的职责分离 |
| **新增** | Test-Fix Loop Workflow 机制（2 个串行 workflow） |
| **新增** | test-execute-v{N}.json 版本化状态管理 |
| **新增** | 不可测试项手动验证清单输出 |
| **新增** | 严格 Phase-Gate 防伪造检查（3 层次 + 严格度差异） |
| **修改** | "完成后调用 coding-workflow-gate(phase=4)"（gate tool 内部路由：跳过 review-gate，先跑 test-fix loop workflow，再跑 phase-gate） |

## Agent 文件规划

| Agent | 新建/复用 | 职责 |
|-------|----------|------|
| `test-execute-coordinator.md` | 新建 | Workflow 节点：构造/读取 test-execute JSON、分派 Wave、汇总判断 |
| `test-fix-worker.md` | 新建 | Fix Worker：分析失败 + 修复 + 更新状态 |
| `xyz-harness-gate-reviewer` | 复用 SKILL.md | Phase-Gate 防伪造检查（加强版：3 层次检查） |

## 可视化

`review-gate-flow/p4-test.html`
