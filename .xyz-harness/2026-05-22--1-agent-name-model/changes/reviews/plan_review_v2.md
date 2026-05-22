---
verdict: pass
must_fix: 0
---

statistics:
  total_issues: 5
  must_fix: 1
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: LOW
    location: "plan.md §F5 (collapsible联动)"
    title: "F5 collapsible 联动缺少显式 Task 覆盖"
    description: "Spec F5 定义了 per-mode collapsed item count 常量（COLLAPSED_ITEM_COUNT=10, CHAIN_COLLAPSED_ITEM_COUNT=5），但 plan 的任务列表未将 F5 列为独立 Task。当前 render.ts 已有 COLLAPSED_ITEM_COUNT=10（与 spec 一致），renderChainCollapsedText 硬编码 .slice(-5)。建议在 Task 3（链式模式编排）的描述中明确包含将硬编码值提取为 CHAIN_COLLAPSED_ITEM_COUNT 常量的步骤。Plan 文本未修改，本问题仍存在。"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan.md §Task 1 (BG1)"
    title: "Task 1 覆盖 F1+F2+F8 三个功能，单 Task 范围偏大"
    description: "Task 1 同时覆盖 header 结构重构（F1）、实时计时器集成（F2）、状态图标替换（F8）。三者耦合紧密（修改同一批渲染函数），但实时计时涉及 context.invalidate() 生命周期管理、setInterval cleanup、abort 信号处理。Plan 文本未修改。建议在 executor task prompt 中明确优先顺序。"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: INFO
    location: "plan.md §Task 6 (BG3)"
    title: "BG3 验证任务描述偏笼统"
    description: "Task 6 描述为'E2E 验证 + 手动检查'，0 文件修改。subagent 配置为 general-purpose (low)，但验证需要在 Pi 运行时环境中执行手动操作。建议补充说明该 task 产出为验证 checklist 的逐项填写结果，不依赖 Pi 运行环境。Plan 文本未修改。"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: MUST_FIX
    location: "plan.md §「关键模式 1」(实时计时参考代码)"
    title: "Timing 参考代码存在定时器叠加 bug，guard 逻辑无效"
    description: >
      Plan 提供的实时计时参考代码片段中，定时器重复防护逻辑有严重 bug：

      ```typescript
      if (!isDone) {
        isDone = false;  // ← 设回 false，防护总是通过
        const timer = setInterval(() => { context.invalidate(); }, 1000);
      }
      ```

      无论 isDone 变量定义在何处（模块级/函数级/renderResult 闭包），该 guard 均不生效：
      - `isDone` 被设为 `false` 后，每次 renderResult 调用都会创建新 setInterval
      - 多个定时器同时运行，每 1s 多次调用 context.invalidate()，造成不必要的重渲染和性能开销
      - isDone 若在模块级定义，还违反 CLAUDE.md session isolation 约束

      Pi 已有经验证的规范模式（bash.ts L418-442）：将 interval ID 存储在 context.state 中，用 `!context.state.interval` 做防护，用 `context.isPartial` 做停止条件：

      ```typescript
      // 正确模式（来自 bash.ts renderResult）:
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }
      ```

      该模式已在 pi-tui-animation-scan.md 中确认可用。

      风险：若 executor 照搬 plan 中的参考代码，将导致定时器叠加、错误的重渲染行为。
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md §e2e-test-plan SC7 / test_cases_template.json TC-5-01"
    title: "AC6 测试覆盖面不完整：缺少 cleanup 持久化和运行时无报错验证"
    description: >
      Spec AC6 包含三项验收标准：
      1. collect_subagent 工具不在注册列表中 — 有 TC-5-01 覆盖
      2. 后台 job 的 temp files 仍会在 session_shutdown 时 cleanup — 无测试覆盖
      3. 不抛出因移除而产生的运行时错误 — 无测试覆盖

      e2e-test-plan SC7 和 TC-5-01 都只覆盖了第一项。建议补充 TC 覆盖 cleanup 持久化和运行时无报错。
    status: open
    raised_in_round: 2
    resolved_in_round: null
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-05-22 11:00
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-22--1-agent-name-model/plan.md`

## 评审说明

第 2 轮评审。基于当前 plan.md（自第 1 轮评审后未修改）进行独立评审。继承 v1 的 3 个问题（均因 plan 未修改而保持 open），新增 2 个问题。

---

## 1. Spec 完整性

与 v1 结论一致，spec 完整。无变更。

## 2. Plan 可行性 — 新增发现

### 2.1 实时计时参考代码问题（MUST FIX #4）

Plan 的「关键模式 1」提供实时计时代码片段，但存在严重的定时器防护逻辑 bug。

**代码片段对比：**

| 方面 | Plan 参考代码 | Pi 规范模式 (bash.ts) |
|------|-------------|---------------------|
| 防护条件 | `if (!isDone)` | `if (!state.interval)` |
| 停止条件 | 未指定 | `!options.isPartial \|\| context.isError` |
| timer 存储 | 函数局部变量 `timer` | `context.state.interval` |
| cleanup 时机 | `context.onAbort` | 停止条件触发时 |

**影响分析：**

| 场景 | 行为 | 严重程度 |
|------|------|---------|
| 正常执行 | 每次 context.invalidate() 触发 renderResult，创建新定时器 → 定时器叠加 | 中度 |
| 长耗时执行 | 叠加 5-10 秒后，每秒多次 invalidate → 终端闪烁，性能下降 | 高 |
| 多 session | isDone 若模块级定义，session A 的定时器影响 session B | 高（违反 session isolation） |

**修改方向：** 将参考代码替换为 bash.ts 的规范模式，使用 `context.state.interval` 存储 timer ID，用 `!context.state.interval` 做防护，用 `options.isPartial` 和 `context.isError` 做停止条件。

### 2.2 其他维度评估

| 维度 | 结论 | 说明 |
|------|------|------|
| 任务拆分合理性 | ✅ 总体合理，v1 的 LOW 建议仍适用 | 6 个 Task 粒度和依赖均正确 |
| 依赖关系 | ✅ 正确 | BG1→BG3, BG2→BG3 无问题 |
| 工作量估算 | ✅ 合理 | 参照 render.ts 560 行、index.ts 738 行，改动范围可控 |

## 3. Spec 与 Plan 一致性

与 v1 结论一致。除 F5 无显式 Task（LOW #1）外，所有 F/AC 均有对应。无新增不一致。

## 4. Execution Groups 合理性

与 v1 结论一致。分组、Wave 编排、Subagent 配置均合理。新增第 2 轮中无新发现。

## 5. 架构合规性

### 5.1 CLAUDE.md 约束

claude.md 要求函数 ≤ 80 行、单文件 ≤ 1000 行。当前 render.ts 560 行，plan 新增代码约 250-300 行后预计 ~860 行，在限额内。✅

但计划大幅重构的函数（renderSingleCollapsedText / renderParallelTable / renderChainCollapsedText）的最终行数应在编码验证时确认。建议在 spec-compliance 审查中检查函数行数不超过 80 行。

### 5.2 Session Isolation

Plan 的参考代码中 `isDone` 和 `timer` 变量未明确作用域。若为模块级 → 违反 CLAUDE.md session isolation。若为函数级 → timer 可能被 GC 回收。MUST FIX #4 已涵盖此问题。

## 6. e2e-test-plan 与 test_cases 覆盖度

### 6.1 新增发现：AC6 测试覆盖面不完整（LOW #5）

e2e-test-plan SC7 和 TC-5-01 都只验证「collect_subagent 工具已移除」，缺少对 AC6 其余两项的验证：

| AC6 验收项 | 测试覆盖 | 状态 |
|-----------|---------|------|
| collect_subagent 不在注册列表 | TC-5-01 | ✅ |
| 后台 temp files 在 session_shutdown 时 cleanup | 无 | ❌ |
| 无运行时错误 | 无 | ❌ |

建议为后两项补充 TC（或更新 TC-5-01 的 steps 包含 cleanup 验证）。

### 6.2 其他覆盖

其余 SC/TC 覆盖完整，AC1-AC5 均有对应测试场景。与 v1 结论一致。

## 7. 问题汇总

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 4 | **MUST FIX** | plan.md §「关键模式 1」 | 实时计时代码定时器防护 bug：`if (!isDone) { isDone = false; }` 不形成防护，每次 renderResult 调用创建新 setInterval | 替换为 bash.ts 规范模式：`if (!context.state.interval && options.isPartial) { context.state.interval = setInterval(...) }`，停止时 `clearInterval(context.state.interval)` |
| 1 | LOW | plan.md §F5 (collapsible联动) | F5 缺少显式 Task 覆盖 | 在 Task 3 中补充 CHAIN_COLLAPSED_ITEM_COUNT 常量的提取步骤 |
| 2 | LOW | plan.md §Task 1 (BG1) | Task 1 覆盖 F1+F2+F8 范围偏大 | 在 executor task prompt 中明确优先顺序：先 header+图标 → 再计时器 |
| 5 | LOW | e2e-test-plan SC7 / TC-5-01 | AC6 测试覆盖面不完整，缺少 cleanup 和运行时无报错验证 | 补充 TC 覆盖 AC6 后两项验收标准 |
| 3 | INFO | plan.md §Task 6 (BG3) | BG3 验证任务描述偏笼统 | 补充说明产出为验证 checklist 逐项填写结果 |

### 等级校准确认

- **#4 MUST FIX**：定时器代码 bug 在生产环境会导致功能失效（定时器叠加、session 隔离违规），严格符合校准规则第 2 条「功能失效」和第 5 条「时序错误」
- **#1、#2、#5 LOW**：常量提取、Task 说明、测试覆盖度为非阻塞优化
- **#3 INFO**：BG3 描述笼统但不影响执行

## 结论

**verdict: fail**

1 条 MUST FIX（实时计时参考代码存在定时器叠加 bug），2 条 LOW 继承自 v1 + 1 条 LOW 新增，1 条 INFO。需修改 plan.md 中的参考代码片段后重审。

### Summary

计划评审完成，第2轮，1条MUST FIX，需修改后重审
