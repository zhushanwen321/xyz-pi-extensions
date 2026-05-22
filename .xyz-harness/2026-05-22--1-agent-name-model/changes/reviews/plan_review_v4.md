---
type: plan_review
round: 4
timestamp: "2026-05-22T16:00:00"
target: ".xyz-harness/2026-05-22--1-agent-name-model/plan.md"
verdict: pass
summary: "计划评审完成，第4轮通过，0条MUST FIX。已达循环上限，本报告为人工决策确认轮。"
must_fix: 0
statistics:
  total_issues: 7
  must_fix: 0
  must_fix_resolved: 1
  low: 2
  info: 1
issues:
  - id: 1
    severity: LOW
    location: "plan.md §Task 3 (BG1 Execution Flow)"
    title: "F5 collapsible 联动缺少显式 Task 覆盖"
    description: "Spec F5 定义了 per-mode collapsed item count 常量（COLLAPSED_ITEM_COUNT=10, CHAIN_COLLAPSED_ITEM_COUNT=5），但 plan 的任务列表未将 F5 列为独立 Task。当前 Task 3 的 Execution Flow 已包含将硬编码 .slice(-5) 提取为 CHAIN_COLLAPSED_ITEM_COUNT=5 常量的步骤，且读取 spec.md §F4, §F5。F5 功能已被覆盖，非阻塞优化建议。"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 3
  - id: 2
    severity: LOW
    location: "plan.md §Task 1 (BG1)"
    title: "Task 1 覆盖 F1+F2+F8 三个功能，单 Task 范围偏大"
    description: "Task 1 同时覆盖 header 结构重构（F1）、实时计时器集成（F2）、状态图标替换（F8）。三者耦合紧密，但实时计时涉及 context.invalidate() 生命周期管理、setInterval cleanup、abort 信号处理。Plan 文本未修改。建议在 executor task prompt 中明确优先顺序：先 header 结构 + 图标，再集成计时器（但受限于 #6 — 计时器需要在 index.ts 的 renderResult 中实现）。"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: INFO
    location: "plan.md §Task 7 (BG3)"
    title: "BG3 验证任务描述偏笼统"
    description: "Task 7 描述为'E2E 验证 + 手动检查'，0 文件修改。subagent 配置为 general-purpose (low)，但验证需要在 Pi 运行时环境中执行手动操作。建议补充说明该 task 产出为验证 checklist 的逐项填写结果，不依赖 Pi 运行环境。当前 plan 已说明'不做实际运行，仅输出逐项验证表'，但余下 open 供主 AI 在编排时注意。"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "plan.md §「关键模式 1」(实时计时参考代码)"
    title: "Timing 参考代码已修正为正确模式"
    description: "v2 发现的定时器叠加 bug（`if(!isDone){isDone=false;}` guard 无效）已在当前 plan 中修正为 bash.ts 规范模式：使用 `context.state.interval` 存储 timer ID，`!context.state.interval && options.isPartial` 做防护，`!options.isPartial || context.isError` 做停止条件。代码正确。"
    status: resolved
    raised_in_round: 2
    resolved_in_round: 3
  - id: 5
    severity: LOW
    location: "e2e-test-plan SC7 / test_cases_template.json TC-5-01/02/03"
    title: "AC6 测试覆盖面已补全"
    description: "v2 发现 AC6 测试仅覆盖第一项（collect_subagent 不在注册列表），缺少 cleanup 持久化和运行时无报错验证。当前 plan 的 e2e-test-plan SC7 已增加 step 3（运行时无报错）和 step 4（cleanup 验证），test_cases_template.json 新增 TC-5-02（cleanup 验证）和 TC-5-03（运行时无报错）。AC6 三个验收项均有对应测试覆盖。"
    status: resolved
    raised_in_round: 2
    resolved_in_round: 3
  - id: 6
    severity: MUST_FIX
    location: "plan.md §BG1 Task 1 + BG2 Task 6"
    title: "renderResult timing/session 集成已添加 Task 6 覆盖"
    description: >
      v3 发现 renderResult 中的 timing 计算和 session ID 集成未分配到任何 Task，导致 F2（实时计时）在 renderResult 中完全不可用、F1（header session ID）部分不可用。

      当前 plan 已新增 Task 6（index.ts: renderResult 集成 timer + session ID），依赖关系正确（依赖 BG1 Task 1 + BG2 Task 5），且在 BG3 的 Depends on 中正确串联（6 → 7）。

      Task 6 的 Execution Flow 详细覆盖了：
      a) context.state 存储 startTime 和 interval ID
      b) setInterval + context.invalidate() 每秒刷新
      c) context.sessionManager?.getSessionId?.() 获取 session ID
      d) 将 sessionShortId/elapsed 传递给 render 函数
      e) 定时器 cleanup（abort/complete）
      f) API 可用性验证 + fallback 方案
      g) spec-compliance 审查

      此问题已解决，状态改为 resolved。
    status: resolved
    raised_in_round: 3
    resolved_in_round: 4
  - id: 7
    severity: LOW
    location: "plan.md §Task 5 (renderCall 代码模板) + §Task 6"
    title: "context.sessionManager 可用性待确认"
    description: >
      Plan 的 Task 5 renderCall 和 Task 6 renderResult 代码模板使用了 `context.sessionManager?.getSessionId?.()` 获取 session ID。

      需要确认 Pi Extension API 的 renderCall 和 renderResult context 参数类型是否暴露 sessionManager。

      Task 6 已包含 fallback 方案："若不可用，需 fallback 方案：从 execute 返回的 details 中传递 session ID 和 startTime"。
      建议在 Task 5/6 的 executor task prompt 中注明需先验证 API 可用性。目前为 LOW 风险——有 fallback 兜底，不影响 plan 架构。
    status: open
    raised_in_round: 3
    resolved_in_round: null
---

# 计划评审 v4（人工确认轮）

## 评审记录
- **评审时间：** 2026-05-22 16:00
- **评审类型：** 计划评审
- **评审对象：** `.xyz-harness/2026-05-22--1-agent-name-model/plan.md`
- **项目根 CLAUDE.md：** `xyz-pi-extensions/CLAUDE.md`
- **声明：** 已达循环上限（≤ 3 轮）。本报告为人工决策确认轮，验证 v3 MUST FIX 是否已修复，并进行最终完整性检查。

---

## 第 3 轮 MUST FIX 修复验证

### #6 (MUST FIX): renderResult timing/session 集成缺口 ✅ RESOLVED

v3 报告的核心问题是：plan 中没有 Task 负责在 `index.ts` 的 `renderResult` 函数中集成 timing 计算、session ID 提取、定时器生命周期管理，导致 F2（实时计时）在 renderResult 中完全失效。

**当前 plan 状态：已修复。** plan.md 的 Task List 中已包含：

| # | Task | Depends on | Group |
|---|------|-----------|-------|
| 6 | index.ts: renderResult 集成 timer + session ID (F1,F2) | 1,5 | BG2 |
| 7 | 🧪 E2E 验证 + 手动检查 | 4,5,6 | BG3 |

Task 6 的 Execution Flow 详细描述了 renderResult 中应实现的所有环节（见 plan.md §BG2 Task 6 设计细节），包括：
- `context.state` 存储 startTime 和 interval ID
- `setInterval` + `context.invalidate()` 实现每秒刷新
- `context.sessionManager?.getSessionId?.()` 获取 session ID
- `sessionShortId` 和 `elapsed` 参数传递给 render 函数
- abort/complete 时定时器 cleanup
- API 可用性验证和 fallback 方案
- spec-compliance 审查

**依赖关系验证：**
```
BG1 (render.ts T1→T2→T3) ──┐
                             ├──→ BG2 T6 (depends on BG1 T1 + BG2 T5)
BG2 (index.ts T4→T5) ───────┘
                             └──→ BG3 T7 (depends on T4,T5,T6)
```

- T6 依赖 T1（render.ts header 函数签名更新） ✅
- T6 依赖 T5（index.ts renderCall 完成后才修改 renderResult） ✅
- T7 等待所有 Task 完成后验证 ✅

**此问题已解决，状态改为 resolved。**

---

## 第 4 轮新增审查

### 1. Spec 完整性

与 v1-v3 结论一致。Spec 完整，F1-F8 清晰可量化，AC1-AC6 有 observable 验收标准。Out of Scope 边界清晰。✅

### 2. Plan 可行性 — 全量复查

#### 2.1 Task 覆盖矩阵（逐条对照 spec）

| Spec 需求 | Plan Task | 状态 |
|-----------|-----------|------|
| F1: 统一 Header 格式 | T1（render.ts header 重构） + T6（renderResult 集成 session ID/elapsed 传递） | ✅ 完整覆盖 |
| F2: 实时计时 | T1（setInterval 代码模板） + T6（renderResult 中计时器集成 + context.invalidate） | ✅ 完整覆盖 |
| F3: 活动流优化 | T2（getDisplayItems + text preview + thinking filter） | ✅ |
| F4: 执行顺序可视化 | T3（Parallel 实时表格 + Chain 步骤编号 + pending/running/done 图标） | ✅ |
| F5: collapsible 联动 | T3（将 `.slice(-5)` 提取为 `CHAIN_COLLAPSED_ITEM_COUNT=5` 常量） | ✅ 已在执行流中覆盖 |
| F6: 移除 collect_subagent | T4（移除注册代码 + 更新 spawn.ts 引用 + cleanup 保留） | ✅ |
| F7: renderCall 统一 | T5（完整 renderCall 代码模板） | ✅ |
| F8: 状态语义化 | T1（STATUS_ICONS 表 + theme.fg 着色） | ✅ |
| AC1: Single 模式 | SC1/SC2 + TC-1-01/02/03 | ✅ |
| AC2: Parallel 模式 | SC3 + TC-2-01/02 | ✅ |
| AC3: Chain 模式 | SC4 + TC-3-01/02 | ✅ |
| AC4: Background 模式 | SC5 + TC-4-01 | ✅ |
| AC5: 实时计时 | SC6 + TC-1-03 | ✅ |
| AC6: 移除 collect_subagent | SC7 + TC-5-01/02/03 | ✅ 已补全（v3 resolved） |

**结论：spec 所有需求项均有对应 plan Task 覆盖，无遗漏。计划中无 spec 未提及的额外工作。**

#### 2.2 任务拆分合理性

| Task | 文件 | 行数预估 | 粒度评估 |
|------|------|---------|---------|
| BG1-T1 | render.ts | ~200 行 | ⚠️ 偏大（F1+F2+F8），但函数耦合紧密，合理 |
| BG1-T2 | render.ts | ~100 行 | ✅ |
| BG1-T3 | render.ts | ~150 行 | ✅ |
| BG2-T4 | index.ts | ~100 行（移除）| ✅ |
| BG2-T5 | index.ts | ~80 行 | ✅ |
| BG2-T6 | index.ts | ~120 行 | ✅ 含 timing + session ID + 函数调用集成 |
| BG3-T7 | — | checklist | ✅ |

所有 task 粒度适中，可在 subagent 预算内独立完成。✅

#### 2.3 依赖关系正确性

```
BG1: T1 → T2 → T3 (同文件串行) ✅
BG2: T4 → T5 → T6 (同文件串行) ✅
T6 依赖 BG1-T1 和 BG2-T5 ✅
T7 依赖 T4+T5+T6 ✅
无环路依赖 ✅
```

#### 2.4 工作量估算

对照项目规模（render.ts ~560 行，index.ts ~738 行），预估改动范围 ~700 行新增/修改。每个 Task 100-200 行的改动范围合理。

### 3. Execution Groups 合理性

| 维度 | 评估 |
|------|------|
| 分组合理性 | BG1（1 文件，3 Task ≤ 4）、BG2（1 文件，3 Task ≤ 4）、BG3（0 文件）✅ |
| 类型划分 | 所有 Task 标注为 backend（本扩展 TUI 渲染属于后端渲染管线）✅ |
| 功能关联度 | BG1 全部 render.ts，BG2 全部 index.ts ✅ |
| 依赖关系 | BG1 → BG3, BG2 → BG3，被依赖在前 ✅ |
| Wave 编排 | Wave 1: BG1 ∥ BG2（不同文件，无冲突）；Wave 2: BG2 T6 跨组依赖；Wave 3: BG3 |
| Subagent 配置完整性 | Agent/Model/注入上下文/读取文件/修改文件 全部配置 ✅ |
| 上下文充分性 | 含完整设计代码模板 + import/type 标注 + 函数签名 ✅ |

#### Wave 编排细节确认

| Wave | Groups | 并行可行性 |
|------|--------|-----------|
| Wave 1 | BG1(render.ts) ∥ BG2(index.ts T4,T5) | ✅ 不同文件，无冲突 |
| Wave 2 | BG2(T6) | 依赖 BG1 T1 + BG2 T5 完成。实际需等待 BG1 全部完成（BG1 内部串行）|
| Wave 3 | BG3 | 依赖所有 Task 完成 ✅ |

注意：BG2 T6 理论上只需 BG1 T1 和 BG2 T5，但 wave 调度会等整个 Wave 1 完成。plan 已注明此限制，不影响正确性。

### 4. 架构合规性

| CLAUDE.md 约束 | 合规性 |
|----------------|--------|
| TUI: 仅用 Text/Container/Spacer/Markdown | ✅ Plan 代码仅使用现有组件 |
| Theme: 通过 theme.fg() 语义 token 着色 | ✅ STATUS_ICONS + theme.fg("token", text) |
| Session 隔离: 状态在 context.state 中 | ✅ context.state.startedAt/interval |
| 向后兼容: SubagentDetails 结构不变 | ✅ Plan 声明不改变 api surface |
| 无 any 类型 | ✅ 代码模板有完整类型标注 |
| 函数 ≤ 80 行 | ⚠️ 编码阶段验证（renderParallelTable 重构后可能接近边界）|
| 单文件 ≤ 1000 行 | ✅ render.ts ~560 + ~200 ≤ 1000；index.ts ~738 + ~200 ≤ 1000 |

### 5. e2e-test-plan & test_cases_template 复查

| 检查项 | 状态 |
|--------|------|
| AC1-AC5 测试覆盖 | ✅ SC1-SC8 覆盖 |
| AC6 完整覆盖（3 项）| ✅ TC-5-01/02/03 覆盖所有 3 项 |
| Single 成功/失败路径 | ✅ TC-1-01/02 |
| Parallel 运行中/完成 | ✅ TC-2-01/02 |
| Chain 运行中/中断 | ✅ TC-3-01/02 |
| Background 启动/注入 | ✅ TC-4-01 |
| 实时计时验证 | ✅ TC-1-03 + SC6 |
| collect_subagent 移除 | ✅ TC-5-01 |
| cleanup 持久化 | ✅ TC-5-02（新增） |
| 运行时无报错 | ✅ TC-5-03（新增） |
| 活动流 text output | ✅ SC8 |
| renderCall 统一格式 | ✅ TC-7-01 |

---

## 残留问题（非阻塞）

以下问题已标记 LOW/INFO，不影响 plan 的执行正确性。建议在 task prompt 中注意：

### #2 (LOW): Task 1 范围偏大（F1+F2+F8 合并）
- **状态：** open（plan 文本未修改，但不影响正确性）
- **建议：** 在 BG1-T1 的 executor task prompt 中明确执行顺序：header 结构 + 图标 → 计时器模板代码（计时器集成主要在 T6 的 renderResult 中完成）
- **注意：** v1 提出时认为计时器在 render.ts 中实现（错误），当前修正方案中计时器集成实际在 index.ts T6 完成。T1 中计时器部分仅为 render.ts 侧的函数签名更新（添加 `elapsed?` 可选参数），不影响 T1 粒度

### #7 (LOW): context.sessionManager API 可用性
- **状态：** open（待 Task 5/6 的 executor 验证）
- **建议：** Task 5 和 Task 6 的 executor task prompt 注明需先验证 `context.sessionManager?.getSessionId?.()` 和 `context.state` 的 API 可用性
- **退路：** Task 6 已包含 fallback 方案（从 execute 返回值传递 session ID）

### #3 (INFO): BG3 验证任务描述偏笼统
- **状态：** open
- **说明：** BG3 设计为产出验证 checklist，不做实际运行。主 AI 执行时需手动按 checklist 验证

---

## 结论

**verdict: pass**

0 条 MUST FIX。v3 指出的 renderResult 集成缺口（#6）已通过新增 Task 6 完全修复。plan 覆盖 spec 全部 F1-F8 需求和 AC1-AC6 验收标准。Execution Groups 设计合理，依赖关系正确，subagent 配置完整。2 条 LOW 建议和 1 条 INFO 记录不影响执行。

**已达循环上限（≤ 3 轮）。** 本报告为第 4 轮人工决策确认。当前 plan.md 已修正全部 MUST FIX，建议批准执行。

### Summary

计划评审完成，第4轮通过，0条MUST FIX。已达循环上限，本报告为人工决策确认轮。
