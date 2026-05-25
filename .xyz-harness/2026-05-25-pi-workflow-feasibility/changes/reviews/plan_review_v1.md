---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-25T12:00:00"
  target: ".xyz-harness/2026-05-25-pi-workflow-feasibility/{spec.md, plan.md, e2e-test-plan.md, test_cases_template.json}"
  verdict: fail
  summary: "计划评审完成，第1轮，4条MUST FIX，需修改后重审"

statistics:
  total_issues: 6
  must_fix: 4
  must_fix_resolved: 0
  low: 1
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR10"
    title: "FR10 子项编号错误（使用 FR9.* 代替 FR10.*）"
    description: "spec.md 的 FR10（GUI 兼容 _render 协议）下三个子项标记为 FR9.1/FR9.2/FR9.3，应为 FR10.1/FR10.2/FR10.3。这是从 FR9 章节复制后的编号遗漏。该错误会影响 spec-plan 追溯：plan 的 Spec Metrics Traceability 表中如果按 FR10.* 索引则找不到对应项。"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "plan.md:Task List"
    title: "Workflow 完成通知（FR5.3 + FR10.2）未明确映射到任何 Task"
    description: "Spec 要求 workflow 运行结果通过 pi.sendMessage({ customType: 'workflow-result' }) 注入主对话并附带 _render 描述符（FR5.3 + FR10.2）。但 plan 的 Spec Metrics Traceability 表和 Task List 均未映射该需求。Task 8 (commands) 和 Task 9 (workflow-run tool) 各自覆盖了命令和 tool 的交互入口，但完成通知（异步推送）的 _render 输出和 sendMessage 调用没有归属。如果不修复，workflow 完成后用户只能通过 `/workflows` 面板查看结果，主对话中无通知。"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "e2e-test-plan.md:Test Scenarios"
    title: "缺少 AC8（CC 兼容性）的测试场景"
    description: "e2e-test-plan.md 列出了 TS1-TS9，覆盖 AC1-AC7 和 AC9，但缺少 AC8（CC 兼容性）的测试场景。test_cases_template.json 中包含 TC-8-01 和 TC-8-02 覆盖 AC8，但 e2e-test-plan 的 Test Scenarios 列表中没有对应条目，导致 AC8 在测试计划层面无归属。需要新增 TS for AC8，或从 test_cases_template 中移除 AC8 相关 TC。"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "plan.md:BG2 Execution Flow"
    title: "Orchestrator (Task 5) 依赖遗漏 Execution Trace (Task 6)，BG2 执行顺序不明确"
    description: "Plan 的 Task 依赖表显示 Task 5 (orchestrator) 依赖于 Task 2,3,4，但未包含 Task 6 (execution-trace)。Orchestrator 需要调用 execution-trace API 记录 DAG 节点（每次 agent status 变更写入 JSONL）。同时 BG2 的 Execution Flow 仅描述'Tasks 3-7 按依赖顺序串行执行'，未指定确切顺序。按依赖表数值顺序(3→4→5→6→7)会导致 Task 5 在 Task 6 之前构建，orchestrator 无法引用 exec-trace 的类型和函数。需要将 Task 6 加入 Task 5 的依赖列表，并明确 BG2 内部执行顺序（建议：3→6→4→5→7 或注明 3/6/4 可并行）。"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md:Constraints / plan.md:ALL"
    title: "worker_threads 作为 Node 模块例外的 CLAUDE.md 更新未纳入 plan"
    description: "Spec 的 Constraints 部分明确要求'此例外需在 CLAUDE.md 中明确记录'（worker_threads 模块的使用）。但 plan 的任务列表中没有提到对项目 CLAUDE.md 进行更新。应在 BG1 或 BG2 中顺带完成此文档更新，或至少注明在 Task 1 (scaffold) 中同步更新 CLAUDE.md。"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "spec.md:Background"
    title: "Spec 引用的外部文件对 implementer 不可直接访问"
    description: "Spec 的 References 部分列出了 `Claude-Code-Workflow-调研报告.md`、`Pi-Workflow-集成方案.md`、`xyz-harness-coding-workflow-集成分析.md` 三个外部文件路径。这些文件位于 `/Users/zhushanwen/Code/chat_project/workflow/` 目录，是主 AI 用于撰写 spec 的输入。Plan 的执行 subagent 在独立会话中无法访问这些文件。虽然 plan 已经内化了这些文件中的关键设计决策（D1-D4），但建议在 spec 或 plan 中补充关键决策摘要（已在 Decisions 章节完成），避免 implementer 需要反向工程。当前状态：风险可控，Decisions 章节已充分覆盖。"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-25 12:00
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-25-pi-workflow-feasibility/{spec.md, plan.md, e2e-test-plan.md, test_cases_template.json}`

---

## 1. Spec 完整性

### 1.1 目标明确性

目标在 Background 中描述清晰：**在 Pi 上实现兼容 Claude Code Workflow JS 脚本格式的通用多 Agent 编排引擎**。动机明确（Subagent Extension 缺少确定性编排），成功定义具体（P0 完成后 7 项能力）。✅

### 1.2 范围合理性

11 个 FR + 9 个 AC，覆盖了：脚本定义、Worker 模型、执行轨迹、暂停恢复、用户交互、后台并发、错误重试、预算控制、CC 兼容、GUI 渲染、生命周期。无[待决议]项。Out of Scope 已明确列出并标注原因。✅

### 1.3 验收标准可量化

9 个 AC 均有具体可验证的 pass/fail 条件（如"命令返回 runId"、"Worker 线程终止，callCache 保留"）。非主观描述。✅

### 1.4 范围边界问题

**FR10 编号错误**（见 Issue #1）：FR10 的三个子项被误标为 FR9.1/FR9.2/FR9.3，与 FR9（CC 兼容性）的子项编号重复。需要修正为 FR10.1/FR10.2/FR10.3。

---

## 2. Plan 可行性

### 2.1 Task 粒度

11 个 Task，按依赖分为 4 个 Execution Groups。每个 Task 对应一次 subagent 调度（含 TDD 三步骤），粒度合理：

| Task | 范围 | 预估行数 | 评估 |
|------|------|---------|------|
| 1 | Scaffold + state model | ~200-300 | ✅ 适中 |
| 2 | Config loader | ~150-200 | ✅ 适中 |
| 3 | Agent pool | ~200-300 | ✅ 适中 |
| 4 | Worker script | ~200-300 | ✅ 适中 |
| 5 | Orchestrator | ~400-500 | ✅ 适中（核心模块） |
| 6 | Execution trace | ~100-150 | ✅ 偏小但合理 |
| 7 | Budget + retry | ~150-200 | ✅ 适中 |
| 8 | Commands | ~200-300 | ✅ 适中 |
| 9 | Workflow-run tool | ~150-200 | ✅ 适中 |
| 10 | TUI widget | ~300-400 | ✅ 适中 |
| 11 | E2E test script | ~50-100 | ✅ 偏小但合理 |

### 2.2 依赖关系

**整体依赖链：**
```
BG1 ──→ BG2 ──→ BG3 ──→ BG4
```

**问题发现：** Task 5 (orchestrator) 的依赖表遗漏了 Task 6 (execution-trace)。Orchestrator 需要调用 trace 模块记录 DAG 节点，但依赖表中仅列出了 2,3,4（未含 6）。同时 BG2 的 "按依赖顺序串行执行" 未指定确切顺序，按数值顺序(3→4→5→6→7)会导 orchestrator 先于 execution-trace 构建。**（Issue #4）**

### 2.3 工作量评估

整体工作量：11 Task × 3 steps (TDD) = 33 subagent 调用。按中等复杂度估算，大约需要 66-99 次 API 调用（含 review）。保守估计 2-4 小时完成。评估与现实相符。✅

### 2.4 遗漏 Task

**Spec → Plan 覆盖矩阵（含问题标注）：**

| Spec 需求 | Plan 覆盖 | 状态 |
|-----------|----------|------|
| FR1.1-FR1.5 脚本定义 + 扫描 | Task 2, 4 | ✅ |
| FR2.1-FR2.5 Worker 模型 | Task 4, 5 | ✅ |
| FR3.1-FR3.4 DAG/ExecutionTrace | Task 6 | ✅ |
| FR4.1-FR4.5 暂停/恢复 | Task 5 | ✅ |
| FR5.1 命令 | Task 8 | ✅ |
| FR5.2 workflow-run tool | Task 9 | ✅ |
| FR5.3 sendMessage 通知 | **未明确映射** | ❌ **(Issue #2)** |
| FR5.4 TUI 面板交互 | Task 10 | ✅ |
| FR6.1-FR6.4 后台/并发 | Task 5 | ✅ |
| FR7.1-FR7.5 错误重试 | Task 7 | ✅ |
| FR8.1-FR8.4 预算 | Task 7 | ✅ |
| FR9.1-FR9.3 CC 兼容 | Task 2, 4 | ✅ |
| FR10.1 tool 的 _render | Task 9 | ✅ |
| FR10.2 完成通知的 _render | **未明确映射** | ❌ **(Issue #2)** |
| FR10.3 _render 增量字段 | 隐式 | ✅ |
| FR11.1-FR11.2 生命周期 | Task 1, 5 | ✅ |
| Constraints: CLAUDE.md 更新 | **未包含** | ⚠️ (Issue #5 LOW) |

### 2.5 Plan 不含实现代码

Plan 中的代码片段是接口定义和类型描述（interface/class 框架），而非完整实现逻辑。符合 plan 规范，未出现 "plan 中有禁止的实现代码"。✅

---

## 3. Spec 与 Plan 一致性

### 3.1 Spec FR/AC 覆盖

Spec 列出了 9 个 AC，plan 的 Spec Metrics Traceability 表中标注了每个 AC 对应的 Task：

| AC | 描述 | Plan 映射 | 状态 |
|----|------|----------|------|
| AC1 | 最小可用验证（demo workflow） | Task 5, 8, 11 | ✅ |
| AC2 | 暂停/恢复 | Task 5 | ✅ |
| AC3 | parallel 并发 | Task 4, 5 | ✅ |
| AC4 | 错误重试 | Task 7 | ✅ |
| AC5 | 多 workflow 并发 | Task 5 | ✅ |
| AC6 | Token 预算 | Task 7 | ✅ |
| AC7 | Schema 结构化输出 | Task 3 | ✅ (见下方说明) |
| AC8 | CC 兼容性 | Task 2, 4 | ✅ |
| AC9 | _render 输出 | Task 9, 10 | ✅ |

> AC7 映射到 Task 3 (agent-pool) 而非 Task 5 (orchestrator)：Schema 提取逻辑在 spec 中属于"引擎层"职责，定位在 agent-pool 的 JSONL 解析路径中合理——spawn 层直接处理输出解析，与 Subagent Extension 模式一致。不强制要求调整。

### 3.2 Plan 中 spec 未提及的工作

Plan 的所有模块和 Task 均在 spec 定义的 FR 范围内。未发现无来源的额外工作。✅

### 3.3 验收标准到 Task 的可执行性

每个 AC 都能在 plan 中找到对应的实现 Task（除 Issue #2 的完成通知外）。AC 验证步骤已经在 e2e-test-plan 中体现。✅

---

## 4. Execution Groups 合理性

### 4.1 分组合理性

| Group | Task 数 | 文件数 | 文件数评估 |
|-------|---------|--------|-----------|
| BG1 | 2 | 5 | ✅ < 10 |
| BG2 | 5 | 6 | ✅ < 10 |
| BG3 | 3 | 3 | ✅ < 10 |
| BG4 | 1 | 1 | ✅ < 10 |

### 4.2 类型划分

所有 Task 均为 "backend" 类型（TUI Widget 虽然涉及渲染，但在 Pi Extension 中仍属于服务端渲染逻辑，不涉及独立前端应用）。项目为纯 TypeScript Extension，无前后端分离，统一 backend 类型合理。✅

### 4.3 功能关联度

- **BG1**: Scaffold + Config Loader — 关联紧密（基础结构 + 扫描机制）✅
- **BG2**: AgentPool + Worker + Orchestrator + Trace + Budget/Retry — 核心运行时，需要协同工作 ✅
- **BG3**: Commands + Tool + Widget — 用户交互层，依赖共同的后端 API ✅
- **BG4**: E2E 测试 — 验证整体功能 ✅

### 4.4 Wave 编排

| Wave | Groups | 可并行性 | 评估 |
|------|--------|---------|------|
| Wave 1 | BG1 | 无依赖 | ✅ |
| Wave 2 | BG2 | BG2 内部需要按依赖顺序（见 Issue #4） | ⚠️ |
| Wave 3 | BG3 | 依赖 BG2 | ✅ |
| Wave 4 | BG4 | 依赖 BG3 | ✅ |

### 4.5 Subagent 配置完整性

各 BG 的 Subagent 配置均包含：
- Agent 类型 ✅
- Model 选择策略（taskComplexity 自动选择）✅
- 注入上下文（spec 章节 + CLAUDE.md 章节）✅
- 读取文件路径 ✅
- 创建/修改文件列表 ✅

### 4.6 上下文充分性

注入上下文中提到的 "spec.md FR1、FR11"、"CLAUDE.md Extension 模式" 等引用对 subagent 足够清晰。✅

### 4.7 文件数预估

| Group | 预估 | 实际文件数 | 匹配度 |
|-------|------|-----------|--------|
| BG1 | 5 | 5 | ✅ |
| BG2 | 6 | 6 | ✅ |
| BG3 | 2创建+1修改 | 3 | ✅ |

---

## 5. 后端设计充分性（L1）

本项目为纯 L1 复杂度（plan 未标注 L2），不涉及专用后端 subagennt 评审。按 L1 标准检查：

### 5.1 "为什么"的说明

Plan 的设计细节章节对关键决策说明了原因：
- 为什么 Worker 通过 postMessage 代理而非直接 spawn（Issue D2）✅
- 为什么 DAG 是线性日志而非显式图（Issue D3）✅
- 为什么恢复用 callCache 重放而非状态序列化（Issue D4）✅

### 5.2 存储变更合理性

Spec 定义了 Session JSONL 持久化（`pi.appendEntry` + `ctx.sessionManager.getEntries()`），Plan 中 Task 6 (execution-trace) 使用相同的模式。类型定义明确（`WorkflowInstance` 序列化时 Map → Object）。✅

### 5.3 API 端点设计

本扩展提供的是 Tool + Command（非 HTTP API），设计细节充分：
- `workflow-run` Tool 参数 schema（name, args）✅
- Command 参数结构（run/list/workflows/abort）✅

### 5.4 边界条件/异常处理

- Worker 崩溃 → `worker.on("error")` 捕获
- 子进程失败 → 自动重试 3 次 + 指数退避
- 预算超限 → Worker 终止
- 跨会话恢复 → 用户确认提示
- Skip 返回 undefined → Worker 需处理 null/undefined ✅

---

## 6. e2e-test-plan 质量

### 6.1 测试场景覆盖 AC

| AC | Test Scenario | 覆盖状态 |
|----|--------------|---------|
| AC1 | TS1 | ✅ |
| AC2 | TS2, TS3 | ✅ |
| AC3 | TS4 | ✅ |
| AC4 | TS5 | ✅ |
| AC5 | TS6 | ✅ |
| AC6 | TS7 | ✅ |
| AC7 | TS8 | ✅ |
| AC8 | **无对应 TS** | ❌ **(Issue #3)** |
| AC9 | TS9 | ✅ |

### 6.2 test_cases_template.json 有效性

- 有效 JSON：✅
- `test_cases` 非空：✅（13 个用例）
- 每个用例有 id/type/title/description/steps：✅
- 用例覆盖 AC1-AC8（AC8 有 TC-8-01, TC-8-02）：✅

e2e-test-plan 缺少 AC8 场景与 test_cases_template 有 AC8 用例不一致（Issue #3）。

---

## 发现的问���

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md:FR10 | FR10 子项标为 FR9.1/FR9.2/FR9.3，应为 FR10.1/FR10.2/FR10.3 | 修正 spec.md 中 FR10 章节的子项编号 |
| 2 | MUST FIX | plan.md:Task List | FR5.3 (sendMessage 通知) + FR10.2 (完成通知 _render) 未映射到任何 Task | 在 Task 5 或 Task 8 中明确加入完成通知的 sendMessage 和 _render 输出职责，并更新 Spec Metrics Traceability 表 |
| 3 | MUST FIX | e2e-test-plan.md:Test Scenarios | 缺少 AC8（CC 兼容性）测试场景 | 在 e2e-test-plan 中增加 TS for AC8，或确认 AC8 是否已通过其他 TS 覆盖并标注 |
| 4 | MUST FIX | plan.md:BG2 | Task 5 依赖表缺少 Task 6；BG2 执行顺序不明确 | 将 Task 6 加入 Task 5 依赖；明确 BG2 顺序为 3→6→4→5→7（或 3/6/4 并行） |
| 5 | LOW | spec.md:Constraints / plan.md | worker_threads 例外需在 CLAUDE.md 中记录，计划未包含 | 在 Task 1 (scaffold) 或 Task 5 (orchestrator) 中增加 CLAUDE.md 更新步骤 |
| 6 | INFO | spec.md:Background | 外部文件路径对 implementer 不可见，但 Decisions 章节已覆盖关键推理 | 无操作，当前状态可控 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 结论

**需修改后重审**。4 条 MUST FIX 需全部修复后方可进入开发阶段。

| 检查维度 | 结论 |
|---------|------|
| Spec 完整性 | ✅ 通过（除编号错误 Issue #1） |
| Plan 可行性 | ❌ 依赖遗漏 Issue #4 |
| Spec-Plan 一致性 | ❌ 功能遗漏 Issue #2 |
| Execution Groups 合理性 | ✅ 通过 |
| 后端设计充分性 | ✅ 通过 |
| e2e-test-plan 质量 | ❌ 场景遗漏 Issue #3 |

### 修复优先级建议

1. **Issue #1**（编号修复）：spec.md，1 分钟修改，降低追溯歧义
2. **Issue #4**（依赖修正）：plan.md，明确 BG2 顺序和依赖表，降低实现风险
3. **Issue #2**（功能映射）：plan.md，为完成通知指定 Task，修复关键功能缺口
4. **Issue #3**（测试场景）：e2e-test-plan.md，增加 AC8 场景，使测试计划完整

---

## Summary

计划评审完成，第1轮，4条MUST FIX，需修改后重审。
