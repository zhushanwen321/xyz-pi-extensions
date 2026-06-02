---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-31T22:00:00"
  target: ".xyz-harness/2026-05-31-skill-state-tracker/plan.md"
  verdict: pass
  summary: "计划评审完成，第1轮通过，0条MUST FIX，3条LOW，1条INFO"

statistics:
  total_issues: 4
  must_fix: 0
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: LOW
    location: "plan.md: Task 3 Step 1 第 7-8 点"
    title: "Tool execute 返回结构（content/details）和 renderCall/renderResult 未描述"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan.md: Task 3 Step 1 第 3 点 (reconstructState)"
    title: "reconstructState 缺少 currentTurnIndex 恢复逻辑说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md: Spec Coverage Matrix + Spec Metrics Traceability"
    title: "AC-7 Task 映射在两处不一致（Task 3 vs Task 2, Task 3）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "e2e-test-plan.md: TS-3 Step 7"
    title: "TS-3 step 7 测试 loaded→recorded 非法转换时，item 已在 step 5 变为 error 状态"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-31 22:00
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-31-skill-state-tracker/plan.md` + spec.md + 辅助文件

---

## 1. Spec 完整性

**目标明确性：✅ 通过**

"实现 skill-state Pi 扩展，自动追踪 skill 加载/执行/异常状态，通过状态机引导 AI 完成全生命周期管理"。一句话能说清楚要做什么。

**范围合理性：✅ 通过**

4 状态状态机 + 3 个事件 hook（tool_call, turn_end, before_agent_start）+ 1 个工具（skill_state）。预估 ~580 行。中等复杂度，不过大不过小。边界清晰：不直接 spawn 进程、不 import subagent 代码、通过 steering 消息间接协作。

**验收标准可量化：✅ 通过**

8 个 AC（AC-1 到 AC-8），全部是 Given-When-Then 格式，可写测试验证。无"提升用户体验"类模糊描述。

**[待决议] 项：无**

---

## 2. Plan 可行性

**任务拆分：✅ 合理**

4 个 Task 线性依赖：骨架 → 模板 → 核心逻辑 → 安装验证。Task 3 最重（~400 行，4 事件 + 1 工具 + 渲染），但所有逻辑在单文件内、依赖紧密，拆分反而增加复杂度。可接受。

**依赖关系：✅ 正确**

Task 1 → Task 2 → Task 3 → Task 4，串行。Task 1（state.ts）定义数据模型和状态机函数，Task 2（templates.ts）依赖 TrackedItem 类型，Task 3（index.ts）依赖两者。Task 4 依赖前三个完成。

**工作量估算：✅ 现实**

~580 行，4 个文件。与 todo/goal 扩展规模对比合理。

**遗漏检查：⚠️ 有轻微遗漏（见 Issue #1, #2）**

对照 spec 逐条覆盖：所有 FR（FR-1 到 FR-8）在 plan 中都有对应实现步骤。但 Tool 返回结构和渲染函数的描述不够明确。

---

## 3. Spec 与 Plan 一致性

**AC 逐条对照：**

| AC | Spec 描述 | Plan 对应 | 覆盖 |
|----|----------|----------|------|
| AC-1 | Skill 加载检测 | Task 3 Step 1 第 4 点 (tool_call event) | ✅ |
| AC-2 | 重复加载不重复创建 | Task 3 Step 1 第 4 点 (findNonTerminalByName) | ✅ |
| AC-3 | 终态可重新追踪 | Task 3 Step 1 第 4 点 (isTerminalStatus 检查) | ✅ |
| AC-4 | AI 状态流转 | Task 3 Step 1 第 7 点 (canTransition → update) | ✅ |
| AC-5 | 异常累加 | Task 3 Step 1 第 7 点 (errorCount++ + ≥2 检查) | ✅ |
| AC-6 | 10 Turn 提醒 | Task 3 Step 1 第 5 点 (turn_end event) | ✅ |
| AC-7 | 状态持久化与恢复 | Task 3 Step 1 第 3 点 (session_start) + Task 1 (serialize/deserialize) | ✅ |
| AC-8 | before_agent_start 注入 | Task 3 Step 1 第 6 点 (before_agent_start event) | ✅ |

**所有 AC 均有对应实现步骤。**

**Plan 是否有 spec 未提及的额外工作：无。** 所有 task 均可追溯到 spec FR。

---

## 4. Execution Groups 合理性

**分组合理性：✅**

BG1 包含 4 个 Task，5 个文件。文件数 ≤ 10，Task 数 ≤ 4。均在限制内。

**类型划分：✅**

全部为后端 Task，无前端混合。

**功能关联度：✅**

所有 Task 属于同一扩展（skill-state），关联紧密。

**依赖关系：✅**

串行执行，被依赖 Group 排在前面。

**Wave 编排：✅**

仅 Wave 1 BG1，无并行冲突。

**Subagent 配置完整性：✅**

- Agent: general-purpose ✅
- Model: taskComplexity medium ✅
- 注入上下文: spec.md 全文 + CLAUDE.md 编码规范 + Interface Contracts ✅
- 读取文件: todo/goal 参考实现 + types ✅
- 修改/创建文件: 5 个文件明确列出 ✅

**上下文充分性：✅**

注入了 spec 全文（含 FR-1 到 FR-8）和 Interface Contracts，参考文件包含两个已有扩展实现。Subagent 可独立完成。

**文件数预估：✅**

5 个文件（5 create），与 Task 描述一致。

---

## 5. 接口契约审查

**plan.md Interface Contracts 完整性：✅**

- `state.ts`：TrackedItemStatus 枚举（4 值）、TrackedItem 接口（8 字段）、SkillStateRuntimeState 接口（3 字段）、6 个函数签名完整 ✅
- `templates.ts`：4 个函数签名 + 返回值类型 ✅
- `index.ts`：工厂函数签名 ✅

**AC 覆盖矩阵完整性：✅**

所有 8 个 adopted AC 在矩阵中有对应行。无 postponed AC。每行包含 Interface Method + Data Flow + Task 映射。

**类型传递一致性：✅**

Data flow 描述清晰：tool_call → extractSkillName → new TrackedItem → loadedSteeringPrompt → sendMessage。每个环节的输入输出类型在 Interface Contracts 中有定义。

---

## 6. 后端设计充分性（L1）

**"为什么"说明：✅**

Spec Background 章节解释了设计动机（70+ skill、57 个未触发、skill-memory-keeper 失败原因）。Plan 的 step-level 描述对 spec 引用（FR-1, AC-1/2/3 等）提供了追溯性。

**存储选型理由：✅**

使用 `appendEntry` 是 Pi 扩展的标准做法（CLAUDE.md 约束），GC 策略在 spec FR-6 和 non-functional-design.md 中有说明。

**边界条件覆盖：✅**

- 去重规则（非终态同 name 不重复）→ plan findNonTerminalByName ✅
- 终态不可变更 → plan canTransition ✅
- 提醒间隔 → plan turn_end 检查逻辑 ✅
- 非法转换拒绝 → plan canTransition 检查 + throw Error ✅

**非功能性要求：✅**

有独立的 non-functional-design.md，覆盖稳定性（try-catch）、数据一致性（单写者 + GC）、性能（O(n) 简单遍历）、安全性（无用户输入/敏感数据）。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | plan.md: Task 3 Step 1 第 7-8 点 | Tool execute 返回结构和渲染函数未描述。Plan 只说"返回更新后 items"和"注册消息渲染器"，未说明 `{ content: [...], details: {...} }` 中 content 和 details 分别放什么，也未提到 `renderCall`/`renderResult` 的实现。 | 在 Task 3 Step 1 第 7 点补充 details 结构说明（如 `{ action, items, trackedItemId }`），第 8 点明确 renderCall/renderResult 返回格式。BG1 配置已包含读取 todo/goal 参考实现，执行者应能推断，但显式描述更可靠。 |
| 2 | LOW | plan.md: Task 3 Step 1 第 3 点 (reconstructState) | reconstructState 只描述"过滤终态 item"，未说明 currentTurnIndex 的恢复逻辑。Spec FR-7 明确要求"恢复当前 turn 计数器（从 entries 中的 turn_end 事件推算）"。若不恢复，session 重建后 turnIndex 从 0 开始，10 turn 提醒将过早触发。 | 在 reconstructState 描述中补充：遍历 entries 中的 turn_end 事件计算 currentTurnIndex 初始值，或从最新的 skill-state-tracker entry 中保存/恢复该值。 |
| 3 | LOW | plan.md: Spec Coverage Matrix + Spec Metrics Traceability | AC-7 在 Coverage Matrix 中映射到 "Task 3"，但在 Metrics Traceability 中映射到 "Task 2, Task 3"。两者不一致。此外 AC-7 涉及 Task 1（serialize/deserialize）而非 Task 2（templates），Metrics Traceability 中的 "Task 2" 也不准确。 | 统一 AC-7 的 Task 映射为 "Task 1, Task 3"（state model + session_start handler）。 |
| 4 | INFO | e2e-test-plan.md: TS-3 Step 7 | TS-3 step 7 测试 loaded→recorded 非法转换，但此时 item 已在 step 4-5 经历 loaded→error→error（errorCount=2），status 为 error 而非 loaded。需要另建一个 fresh item 才能测试 loaded→recorded。 | 修改 TS-3：在 step 7 前创建新 TrackedItem(status=loaded)，用该 item 测试 loaded→recorded 非法转换。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 结论

**通过。**

Plan 质量整体良好：spec 和 plan 的一致性高（8/8 AC 完全覆盖），任务拆分合理，Execution Groups 配置完整，接口契约定义清晰。发现的 3 条 LOW 问题均为描述不够详细，不影响功能正确性——执行者通过参考文件（todo/goal 扩展）和 CLAUDE.md 规范可以正确实现。

### Summary

计划评审完成，第1轮通过，0条MUST FIX。
