---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-29T02:30:00"
  target: ".xyz-harness/2026-05-28-infinite-context-engine"
  verdict: fail
  summary: "计划评审完成，第1轮，2条MUST FIX，需修改后重审"

statistics:
  total_issues: 5
  must_fix: 2
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md（Task List + Execution Flow 的 TDD 步骤）vs e2e-test-plan.md（测试方式章节）"
    title: "TDD/单元测试与手动测试矛盾——子任务流程引用 TDD 但 E2E 测试计划说无单元测试框架"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "plan.md Interface Contracts → TreeCompactor.triggerCompression() 签名，以及 commands.ts 的调用方式"
    title: "triggerCompression 异步完成通知机制缺失——/tree-compact 命令无法获知压缩何时完成以显示结果"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "plan.md Interface Contracts → TreeCompactor.isCompressing() 方法 + spec FR-1.5"
    title: "isCompressing 所有权不明确——spec 定义为闭包变量但接口契约中有类方法"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "plan.md 全篇——未涉及 entries GC"
    title: "Entry GC 未规划——项目 CLAUDE.md 要求自行实现 entries GC，但 plan 无对应 task"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: INFO
    location: "plan.md Task 1"
    title: "Task 1 创建 5 个文件含 types.ts/segment-tracker.ts/token-estimator.ts/index.ts/package.json，工作量偏重"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- **评审时间：** 2026-05-29 02:30
- **评审类型：** 计划评审（模式一）
- **评审对象：** `.xyz-harness/2026-05-28-infinite-context-engine/`（spec.md + plan.md + e2e-test-plan.md + use-cases.md + non-functional-design.md）
- **项目架构参考：** `CLAUDE.md`

---

## 1. Spec 完整性

### 1.1 目标是否明确
✅ **通过。** 目标一句话清晰说明："构建一个 Pi 扩展，通过 LLM 驱动的树结构上下文压缩，使 AI coding agent 永远不会触达上下文窗口上限。"

### 1.2 范围是否合理
✅ **通过。** 有明确的 Out of Scope 章节（9 项），功能边界清晰不膨胀。

### 1.3 验收标准是否可量化
✅ **通过。** AC-1 至 AC-6 共 29 项子条款，每项都是可验证的行为描述（如"当前段使用完整原文""压缩结果持久化到 session entries"），没有"提升用户体验"类模糊标准。

### 1.4 是否有 [待决议] 项
✅ **无。** spec 中不存在 `[待决议]` 标记。

---

## 2. Plan 可行性

### 2.1 任务拆分是否合理
✅ **基本合理。** 6 个 Task 的粒度适中，每个 Task 对应一个独立模块，可由 subagent 独立完成：

| Task | 职责 | 覆盖 AC | 粒度评估 |
|------|------|---------|---------|
| 1 | 段索引追踪器 + Token 估算器 | AC-1 | ⚠️ 偏重（5 个文件） |
| 2 | 树压缩引擎 | AC-2, AC-6.1 | 合理 |
| 3 | Context Handler | AC-3 | 合理 |
| 4 | Commands + 扩展入口注册 | AC-5, AC-6.2 | 轻量但合理（负责注册所有 handler） |
| 5 | Recall 工具 | AC-4 | 合理 |
| 6 | 集成验证 + TUI 渲染 | 全部 AC | 合理 |

### 2.2 依赖关系是否正确
✅ **通过。**

```
Task 1 (segment-tracker)         # 无依赖
  └── Task 2 (tree-compactor)    # 依赖 Task 1
        └── Task 3 (context-handler)  # 依赖 Task 1, 2
              ├── Task 4 (commands+entry)  # 依赖 Task 1, 2, 3
              └── Task 5 (recall-tool)     # 依赖 Task 2, 3
                    └── Task 6 (integration) # 依赖 1-5
```

阶段依赖图 `BG1 → BG2` 正确。

### 2.3 工作量估算是否现实
✅ **基本合理。** Spec 预估 ~1200 行 TypeScript。6 个 Task 平均 ~200 行/Task。Task 2（压缩引擎）和 Task 3（context handler）逻辑最复杂，但拆分合理。

### 2.4 是否有遗漏的 task
✅ **基本覆盖。** 所有 FR 和 AC 都有对应 Task。对照检查如下：

| Spec 功能 | 对应 Task |
|-----------|-----------|
| FR-1 段索引管理 | Task 1 |
| FR-1.5 并发压缩守卫 | Task 2 |
| FR-2 树压缩 | Task 2 |
| FR-2.6 无缝执行（异步） | Task 2 |
| FR-3 Context 组装 | Task 3 |
| FR-3.1 独立 tree-context 估算 | Task 3 |
| FR-3.4 Recall 提示注入 | Task 3 |
| FR-4 Recall 工具 | Task 5 |
| FR-5 /tree-compact 命令 | Task 4 |
| FR-6 /context-status 命令 | Task 4 |

---

## 3. Spec 与 Plan 一致性

### 3.1 Plan 是否覆盖 spec 所有需求项
✅ **通过。** Spec Coverage Matrix 在 plan.md 中完整列出，29 条 AC 子项均有对应的 Interface Method、Data Flow 和 Task。

### 3.2 Plan 中是否有 spec 未提及的额外工作
⚠️ **有，合理的扩展。**
- Task 6 的"TUI 渲染优化"（renderCall/renderResult）是合理的增值工作，spec 未强制要求但符合项目质量预期。
- token-estimator.ts 从 types.ts 拆分为独立模块，有助于单一职责。

### 3.3 验收标准是否都能在 plan 中找到对应实现步骤
✅ **通过。** AC 覆盖矩阵提供了逐条映射。每个 Task 的 Step 列表描述了具体实现步骤。

但有一个 **全局性问题** 需要指出（见 MUST FIX #1）：

Plan 的每个 Task 子步骤都引用了 `xyz-harness-test-driven-development` skill 并要求"写失败测试"（TDD 第一步），但 E2E 测试计划明确写着 `Pi 无单元测试框架` 且测试方式为 `手动集成测试`。这是核心矛盾——如果 subagent implementer 尝试执行 TDD，写出的测试无法运行，导致做"空中楼阁"式的无用功。

---

## 4. Execution Groups 合理性

### 4.1 分组合理性
✅ **通过。**

| 维度 | BG1 | BG2 | 判定 |
|------|-----|-----|------|
| 文件数 | 7 个（6 create + 1 package.json）| 5 个（4 create + 1 modify）| ✅ ≤10 |
| Task 数 | 2 | 4 | ✅ 功能关联度优先 |
| 类型划分 | 全 backend | 全 backend | ✅ 无混合 |

### 4.2 功能关联度
✅ **通过。** BG1 是基础设施（段追踪 + 压缩引擎），BG2 是消费者（context 组装 + 命令 + recall + 集成）。分组合理。

### 4.3 依赖关系
✅ **通过。** `BG1 → BG2`，Wave 1 → Wave 2，无环。

### 4.4 Wave 编排
✅ **通过。** Wave 1 内 BG1 无外部依赖可并行（但实际是串行——Task 2 依赖 Task 1）。Wave 2 的 4 个 Task 存在内部依赖，串行编排正确。

### 4.5 Subagent 配置完整性
✅ **完整。** 每个 Group 包含 Agent、Model、注入上下文、读取文件、修改/创建文件。

### 4.6 上下文充分性
✅ **充分。** BG1 注入 "spec FR-1/FR-2、types.ts 类型定义、goal 扩展模式参考"；BG2 注入 "spec FR-3/FR-4/FR-5/FR-6、BG1 产出的 types.ts"。足够 subagent 独立工作。

### 4.7 文件数预估
✅ **合理。** 与 File Structure 表一致。

---

## 5. 接口契约审查（L1 模式）

### 5.1 AC 覆盖矩阵完整性
✅ **通过。** 29 条 AC 子项全部在 Spec Coverage Matrix 中有对应行，无遗漏。

### 5.2 方法签名完备性
✅ **通过。** 定义的 5 个模块（SegmentTracker, TreeCompactor, ContextAssembler, RecallTool, TokenEstimate）共 14 个方法和 5 个数据结构，覆盖所有主要功能。

---

## 6. 后端设计充分性（L1）

### 6.1 实现方式说明
✅ 每个 Task 的 Step 列表说明了"做什么"，架构章节和接口契约补充了"为什么"。

### 6.2 存储选型理由
✅ `pi.appendEntry` 是 Pi Extension 的标准持久化方案，有项目级 precedent（goal 扩展）。

### 6.3 API 映射
✅ 类方法到 spec FR 的映射清晰。

### 6.4 边界条件与异常处理
⚠️ 压缩引擎的异常处理（校验重试、降级）规划完整，但 context handler 和 recall 工具的边界条件在 plan 中仅列在 Interface Contracts 的 Edge Cases 列，未展开实现细节。这属于 L1 可接受范围，但实现时需注意覆盖全面。

### 6.5 非功能性需求的 Task 映射
⚠️ 性能约束（30s 超时、50ms handler）嵌入在 Task 2/3 的步骤中，但没有独立的非功能验证 Task。当前集成在 Task 6 中，可接受。

---

## 发现的问题

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 1 | **MUST FIX** | plan.md Task Execution Flow 各子步骤（"写失败测试"） vs e2e-test-plan.md 测试方式章节 | **TDD 步骤与测试框架缺失矛盾。** plan 中每个 Task 的子执行流引用 `xyz-harness-test-driven-development` 要求写"失败测试"，但 E2E 测试计划明确声明 "Pi 无单元测试框架"且测试方式为"手动集成测试"。subagent implementer 若遵循 TDD 指示，写出的测试无法执行。 | **统一策略：** (a) 若确实有可运行的测试框架，则在 plan 中说明框架是什么、如何运行；或者 (b) 若无框架，将 TDD 步骤替换为"写 type-level 验证代码"或"写手动测试脚本"，移除虚假的"写失败测试"步骤。避免实施阶段混淆。 |
| 2 | **MUST FIX** | plan.md Interface Contracts → TreeCompactor.triggerCompression() 返回 `Promise<void>`；commands.ts `/tree-compact` 调用方式 | **异步完成通知机制缺失。** `triggerCompression` 返回 `Promise<void>`，spec 要求异步非阻塞（`child_process.spawn`）。因此 `/tree-compact` 命令 handler 无法在压缩完成后获知结果并 TUI notify。plan 无回调/事件机制说明。 | 至少三种方案： (a) TreeCompactor 内部维护事件回调列表，压缩完成后通知； (b) 将 triggerCompression 拆分为 `startCompression`（返回 void，立即返回）和 `onCompressionComplete(callback)`； (c) 使用 Pi 的 `pi.notify()` 在压缩完成时主动推送通知。plan 需选择一个方案并更新接口契约。 |
| 3 | LOW | plan.md Interface Contracts → TreeCompactor.isCompressing() 与 spec FR-1.5 | **isCompressing 所有权不明确。** Spec FR-1.5 定义为工厂函数的闭包变量（"isCompressing 布尔标志（闭包变量）"），但 plan 接口契约为 TreeCompactor 类方法 `isCompressing()`。如果 TreeCompactor 内部持有，工厂函数无法直接控制；如果工厂持有，TreeCompactor 方法需要额外参数或回调。 | plan 中明确 isCompressing 的归属：建议由 TreeCompactor 内部管理（封装性更好），工厂函数通过 TreeCompactor.isCompressing() 查询，通过 TreeCompactor 的事件或 Promise 感知完成。 |
| 4 | LOW | plan.md 全篇；项目 CLAUDE.md 状态持久化章节 | **Entry GC 未规划。** CLAUDE.md 明确要求"自行实现 GC（splice 旧 entries），防止长 session 中 entries 无限积累"。当前 plan 未包含任何 entry 清理逻辑。长期会话中 `ic-segment` + `ic-turn` + `ic-compact-tree` entries 会无限累积。 | 在 Task 6（集成验证）或新增子步骤中增加 GC 逻辑：达到一定条目数（如 1000 条）时 splice 最旧的 ic-turn 和 ic-segment entries。注意 tree entries 不可删除（否则历史树丢失）。 |
| 5 | INFO | plan.md Task 1 | **Task 1 工作量偏重。** 创建 5 个文件（types.ts、segment-tracker.ts、token-estimator.ts、index.ts、package.json），其中 types.ts 包含所有核心类型定义，segment-tracker.ts 包含 5 个方法。虽然技术上可行，但合并一处可能导致 subagent 上下文窗口紧张。 | 可考虑将 types.ts 定义放在前导任务，由 subagent 先产出类型再实施 segment-tracker。但当前方案也可接受，仅作观察记录。 |

---

## 结论

**需修改后重审。** 存在 2 条 MUST FIX 问题需要修订，LOW 问题建议同时处理。

### Summary

计划评审完成，第1轮，2条MUST FIX，需修改后重审。

---

## 评审依据

| 检查维度 | 状态 |
|---------|------|
| 1. Spec 完整性 | ✅ 通过 |
| 2. Plan 可行性 | ⚠️ 2 条 MUST FIX |
| 3. Spec-Plan 一致性 | ⚠️ 1 条 MUST FIX |
| 4. Execution Groups 合理性 | ✅ 通过 |
| 5. 接口契约审查（L1） | ✅ 通过 |
| 6. 后端设计充分性（L1） | ⚠️ LOW 建议 |
