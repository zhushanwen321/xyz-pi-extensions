---
verdict: pass
must_fix: 0
---

statistics:
  total_issues: 7
  must_fix: 1
  must_fix_resolved: 1
  low: 4
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
    location: "plan.md §Task 6 (BG3)"
    title: "BG3 验证任务描述偏笼统"
    description: "Task 6 描述为'E2E 验证 + 手动检查'，0 文件修改。subagent 配置为 general-purpose (low)，但验证需要在 Pi 运行时环境中执行手动操作。建议补充说明该 task 产出为验证 checklist 的逐项填写结果，不依赖 Pi 运行环境。Plan 文本未修改。"
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
    location: "plan.md §BG1 Task 1 + BG2 Task 4/5"
    title: "renderResult 中 timing/session ID 计算代码未分配到任何 Task — 集成缺口"
    description: >
      Plan 的 F1（Header 统一）和 F2（实时计时）要求在 renderResult 的 header 中显示 session ID 和实时 elapsed。当前 renderResult（index.ts 第 523 行起）中 _context 未使用，调用 renderSingleCollapsedText(view, theme) 时未传递 sessionShortId 或 elapsed。


      实现方式（如 plan 的「关键模式 1」和「关键模式 2」所示）需要在 renderResult（位于 index.ts）中：

      a) 用 `context.state` 存储 startTime 和 interval ID
      b) 用 `setInterval` + `context.invalidate()` 实现每秒刷新
      c) 用 `context.sessionManager?.getSessionId?.()` 获取 session ID
      d) 将 sessionShortId 和 elapsed 传入 refactored render 函数


      但：
      - BG1（Task 1-3）仅修改 render.ts，executor 读取文件不包括 index.ts
      - BG2（Task 4）仅移除 collect_subagent 工具注册
      - BG2（Task 5）仅更新 renderCall 格式
      - 没有任何 Task 修改 index.ts 中的 renderResult 函数


      后果：即使 BG1 完成 render.ts 的函数签名更新（添加 sessionShortId/elapsed 可选参数），renderResult 仍会以旧签名调用，不会传入 session ID 或 elapsed。F1 的 session ID 显示和 F2 的实时计时在 renderResult 中完全失效。


      需要在 BG2 中新增一个 Task（或在 Task 5 中扩展范围），在 renderResult 中实现 timing 计算和 session ID 提取，并传递给 refactored render 函数。
    status: open
    raised_in_round: 3
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "plan.md §Task 5 (renderCall 代码模板)"
    title: "renderCall 中 context.sessionManager 可用性待确认"
    description: >
      Plan 的 Task 5 renderCall 代码模板使用了 `context.sessionManager?.getSessionId?.()` 获取 session ID。

      需要确认 Pi Extension API 的 renderCall context 是否暴露 sessionManager。

      若不可用，可选方案：
      - 在 tool registration 时通过闭包获取 session ID
      - 从 execute 返回的 details 中传递 session ID

      建议在 Task 5 的 executor task prompt 中注明需先验证 API 可用性。
    status: open
    raised_in_round: 3
    resolved_in_round: null
---

# 计划评审 v3

## 评审记录
- **评审时间：** 2026-05-22 14:30
- **评审类型：** 计划评审
- **评审对象：** `.xyz-harness/2026-05-22--1-agent-name-model/plan.md`
- **项目根 CLAUDE.md：** `xyz-pi-extensions/CLAUDE.md`

## 评审说明

第 3 轮评审（循环上限轮）。基于当前 plan.md 进行独立评审。继承 v2 的 5 个问题并更新状态，新增 2 个问题。

---

## v2 已修复问题验证

### #4 (MUST FIX): 实时计时参考代码 bug ✅ RESOLVED

v2 发现 plan 中的实时计时代码使用 `if(!isDone){isDone=false;}` 防护模式，每次 renderResult 调用都会创建新的 setInterval，造成定时器叠加和 session 隔离违规。

**当前 plan 状态：** 已修正。第 1 轮发现的错误代码已完全替换为 bash.ts 规范模式：

```typescript
if (options.isPartial && !state.interval) {
  state.interval = setInterval(() => {
    context.invalidate();
  }, 1000);
  context.onAbort?.(() => { clearInterval(state.interval); });
}
if (!options.isPartial || context.isError) {
  state.endedAt ??= Date.now();
  if (state.interval) { clearInterval(state.interval); }
}
```

使用 `context.state.interval` 做防护（session-safe），`options.isPartial` 做停止条件。**此问题已解决，状态改为 resolved。**

### #5 (LOW): AC6 测试覆盖面不完整 ✅ RESOLVED

v2 发现 AC6 只验证了"collect_subagent 工具不在注册列表"，缺少 cleanup 和运行时无报错验证。

**当前 plan 状态：** 已补全。
- e2e-test-plan SC7 新增 step 3（运行时验证）和 step 4（cleanup 验证）
- test_cases_template.json 新增 TC-5-02（background job cleanup）和 TC-5-03（运行时无报错）
- AC6 三项验收标准均有对应测试覆盖

**此问题已解决，状态改为 resolved。**

### #1 (LOW): F5 collapsible 联动 ✅ RESOLVED

v1 指出 F5 没有独立 Task，但当前 Task 3 的 Execution Flow 已显式包含：
- 读取 spec.md §F4, §F5
- 将 Chain 模式硬编码 `.slice(-5)` 提取为 `CHAIN_COLLAPSED_ITEM_COUNT = 5` 常量
- spec-compliance 检查 F4、F5 是否实现

**此问题已解决（已在计划中自然覆盖），状态改为 resolved。**

---

## 新增发现

### #6 (MUST FIX): renderResult timing/session 代码集成缺口

**严重级别：MUST FIX**

#### 问题描述

plan 的 F1（Header 统一）和 F2（实时计时）需要在 **renderResult** 中实现：

| 需求 | 需要 renderResult 中做什么 | 在哪里做 |
|------|--------------------------|---------|
| 实时 elapsed 计算 | `context.state.startedAt` + `setInterval` + `context.invalidate()` | index.ts 的 renderResult |
| 定时器 cleanup | `!options.isPartial \|\| context.isError` 时 `clearInterval` | index.ts 的 renderResult |
| Session ID 提取 | `context.sessionManager?.getSessionId?.()` | index.ts 的 renderResult 或 renderCall |
| 传递参数给 render 函数 | 将 sessionShortId 和 elapsed 传入 renderSingleCollapsedText/Chain/Parallel | index.ts 的 renderResult |

#### 当前 Task 范围对照

| Task | 修改文件 | 范围 | 覆盖 renderResult? |
|------|---------|------|-------------------|
| BG1-T1 | render.ts | Header 结构 + 图标 + 实时计时 | ❌ 只改 render.ts，无法访问 context.state |
| BG1-T2 | render.ts | 活动流过滤 | ❌ 与 renderResult 无关 |
| BG1-T3 | render.ts | 执行顺序可视化 | ❌ 与 renderResult 无关 |
| BG2-T4 | index.ts | **移除 collect_subagent** | ❌ 不涉及 renderResult |
| BG2-T5 | index.ts | **统一 renderCall 格式** | ❌ 只改 renderCall，不改 renderResult |

没有任何 Task 修改 renderResult 中的 timing 计算和 session ID 传递。

#### 影响

即使 BG1 完成 render.ts 的函数签名升级（添加 `sessionShortId?` 和 `elapsed?` 可选参数），当前的 renderResult 代码仍然：

```typescript
// 当前 index.ts L523+
renderResult(result, { expanded }, theme, _context) {
  // ...
  if (details.mode === "single") {
    return new Text(renderSingleCollapsedText(view, theme), 0, 0);  // ← 不传 sessionShortId/elapsed
  }
  // ...
  return renderChainCollapsedText(views, details, icon, theme);  // ← 不传 sessionShortId
  // ...
  return renderParallelTable(summary, theme);  // ← 不传 sessionShortId
}
```

`_context` 前缀下划线表明当前未使用。所有 render 函数调用均按旧签名进行。即使 render.ts 加了新参数（可选），renderResult 也不会传递：
- session ID → header 中不显示 session ID（F1 部分失效）
- elapsed → 不传入 timing 参数，实时计时不工作（F2 完全失效）
- context.invalidate() → 从未调用，定时器从未启动（F2 完全失效）

**判定依据：** 此问题在生产环境会导致 F2（实时计时）完全不可用，F1（header 中的 session ID）部分不可用，严格符合校准规则第 2 条「功能失效」。

#### 修改方向

需要在 BG2 中新增一个 Task（或在 Task 5 中扩展范围），负责修改 renderResult（位于 index.ts）：

1. 使用 `_context`（改为 `context`）获取 session ID 和存储 timing 状态
2. 实现 setInterval + context.invalidate() 实时刷新
3. 将 sessionShortId 和 elapsed 作为参数传递给 render 函数
4. 实现 abort / isPartial cleanup

依赖关系：必须等待 BG1（render.ts 函数签名更新）完成后才能执行。

---

### #7 (LOW): renderCall 中 context.sessionManager 可用性待确认

Plan 的 Task 5 renderCall 代码模板使用了 `context.sessionManager?.getSessionId?.()` 获取 session ID。

需要确认 Pi Extension API 的 renderCall context 参数类型是否包含 sessionManager 属性。若不可用，需要替换方案：
- 在 tool registration 闭包中捕获 session ID
- 从 execute 返回的 details 中传递

建议在 Task 5 的 executor task prompt 中注明需先验证 API 可用性。

---

## Spec 完整性

与 v1 结论一致。Spec 完整，F1-F8 清晰可量化，AC1-AC6 有 observable 验收标准，无 `[待决议]` 项。Out of Scope 边界合理。✅

## Plan 可行性 — 其他维度

### 任务拆分合理性

除 #6 所述集成缺口外，Task 粒度和依赖关系均正确：

| Task | 文件 | 粒度 | 说明 |
|------|------|------|------|
| 1 | render.ts | ⚠️ 偏大 | 见 #2 LOW，且受 #6 约束（计时器无法在 render.ts 完成） |
| 2 | render.ts | ✅ | 活动流过滤，聚焦 |
| 3 | render.ts | ✅ | 执行顺序可视化 + F5 常量 |
| 4 | index.ts | ✅ | 移除 collect_subagent |
| 5 | index.ts | ⚠️ 需扩展 | 应增加 renderResult 修改（见 #6） |
| 6 | — | ✅ | E2E 验证 |

### 依赖关系

当前：
```
BG1 (render.ts) ──┐
                   ├──→ BG3 (verification)
BG2 (index.ts) ───┘
```

新增 Task 后应调整为：
```
BG1 (render.ts) ──→ BG2a (renderResult in index.ts) ──┐
                                                        ├──→ BG3 (verification)
BG2a (renderResult) 与 BG2b (collect_remove + renderCall) 无冲突，可并行 ──┘
```

### Execution Groups

BG1/BG2 配置如前报告，分组合理。BG3 验证任务可执行但描述偏笼统（#3 INFO）。

### 架构合规性

所有 CLAUDE.md 约束得到遵守（theme token 着色、TUI 组件限定、session 隔离）。函数 ≤ 80 行的约束需在编码阶段确认。✅

### e2e-test-plan 与 test_cases_template

AC6 测试覆盖面已补全（#5 RESOLVED）。其余 SC/TC 覆盖完整。✅

---

## 问题汇总

| # | 优先级 | 位置 | 状态 | 描述 |
|---|--------|------|------|------|
| 6 | **MUST FIX** | plan.md BG1/BG2 范围 | **open** | renderResult timing/session 代码未分配到任何 Task，F1/F2 在 renderResult 中不可用 |
| 2 | LOW | plan.md §Task 1 | open | Task 1 覆盖 F1+F2+F8 范围偏大 |
| 7 | LOW | plan.md §Task 5 renderCall 模板 | open | context.sessionManager 可用性待确认 |
| 3 | INFO | plan.md §Task 6 (BG3) | open | BG3 验证任务描述偏笼统 |
| 1 | LOW | plan.md §Task 3 | resolved (v3) | F5 已在 Task 3 Execution Flow 中覆盖 |
| 4 | MUST FIX | plan.md §关键模式 1 | resolved (v3) | 定时器参考代码已修正 |
| 5 | LOW | e2e-test-plan SC7 / TC | resolved (v3) | AC6 测试覆盖面已补全 |

### 等级校准确认

- **#6 MUST FIX**：renderResult 中 timing 和 session ID 代码未分配到任何 Task，导致 F2 完全不可用、F1 部分不可用，严格符合校准规则第 2 条「功能失效」的判断口诀——"该问题在生产环境会导致功能不可用"
- **#2 LOW**：Task 1 范围偏大但非功能缺陷，子步骤修改同组函数，紧密耦合
- **#7 LOW**：API 可用性问题在编码前即可确认和解决，不影响 plan 架构
- **#3 INFO**：BG3 描述笼统但不影响执行

---

## 结论

**verdict: fail**

1 条 MUST FIX（#6：renderResult 中 timing/session 计算代码未分配到任何 Task，导致 F1/F2 在 renderResult 中不可用）。需在 BG2 中新增 Task 覆盖 renderResult 修改后重审。

已达循环上限（第 3 轮），建议升级到人工决策。

### Summary

计划评审完成，第3轮，1条MUST FIX，需修改后重审。已达循环上限，升级到人工决策。
