---
verdict: pass
must_fix: 0
---

statistics:
  total_issues: 3
  must_fix: 0
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: LOW
    location: "plan.md §F5 (collapsible联动)"
    title: "F5 collapsible 联动缺少显式 Task 覆盖"
    description: "Spec F5 定义了 per-mode collapsed item count 常量（COLLAPSED_ITEM_COUNT=10, CHAIN_COLLAPSED_ITEM_COUNT=5），但 plan 的任务列表未将 F5 列为独立 Task。当前 render.ts 已有 COLLAPSED_ITEM_COUNT=10（与 spec 一致），renderChainCollapsedText 硬编码 .slice(-5)。建议在 Task 3（链式模式编排）的描述中明确包含将硬编码值提取为 CHAIN_COLLAPSED_ITEM_COUNT 常量的步骤。"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "plan.md §Task 1 (BG1)"
    title: "Task 1 覆盖 F1+F2+F8 三个功能，单 Task 范围偏大"
    description: "Task 1 同时覆盖 header 结构重构（F1）、实时计时器集成（F2）、状态图标替换（F8）。虽然三者耦合紧密（修改同一批渲染函数），但实时计时器涉及 context.invalidate() 生命周期管理、setInterval cleanup、abort 信号处理等非平凡逻辑，建议在 plan 中说明该风险，并在 executor 的 task prompt 中明确优先顺序：先 header 结构 + 图标，再集成计时器。"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: INFO
    location: "plan.md §Task 6 (BG3)"
    title: "BG3 验证任务描述偏笼统"
    description: "Task 6 描述为'E2E 验证 + 手动检查'，0 文件修改。subagent 配置为 general-purpose (low)，但验证需要在 Pi 运行时环境中执行手动操作。建议补充说明：该 task 产出为验证 checklist 的逐项填写结果，不依赖 Pi 运行环境。"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录

- **评审时间：** 2026-05-22 10:30
- **评审类型：** 计划评审
- **评审对象：** `.xyz-harness/2026-05-22--1-agent-name-model/`（spec.md + plan.md + e2e-test-plan.md + test_cases_template.json）
- **项目根 CLAUDE.md：** `xyz-pi-extensions/CLAUDE.md`
- **架构 ADR：** `docs/adr/001-subagent-architecture.md`

---

## 1. Spec 完整性

### 1.1 目标明确性 ✅

spec 标题 "Subagent TUI 渲染统一与优化" 准确概括目标。Background 章节说明问题（渲染不一致、缺乏实时计时、活动流缺少 text output、collect_subagent 不再需要），F1-F8 逐条定义目标。无歧义段落。

### 1.2 范围合理性 ✅

Out of Scope 明确列出 7 项不受影响的部分（进程管理逻辑、模型选择、agent 发现、pi-tui 组件库、其他扩展、data format、api surface），边界清晰。

### 1.3 验收标准可量化 ✅

AC1-AC6 每条以 checkbox 列表列出具体可观察行为（如 "renderCall 显示 ⏳ single #id + agent/model/thinking"、"setInterval 在 component unmount / abort 时清理"）。没有模糊表述。

### 1.4 待决议项检查 ✅

无 `[待决议]` 或 `TODO` 标记。

**结论：spec 完整，满足计划评审要求。**

---

## 2. Plan 可行性

### 2.1 任务拆分合理性

| Task | 文件 | 描述 | 粒度评估 |
|------|------|------|---------|
| 1 | render.ts | Header 重构 + 状态图标 + 实时计时 | ⚠️ 偏大（见 #2） |
| 2 | render.ts | 活动流过滤 thinking + text output | ✅ 聚焦 |
| 3 | render.ts | 执行顺序可视化 (F4) | ✅ 聚焦 |
| 4 | index.ts | 移除 collect_subagent | ✅ 聚焦 |
| 5 | index.ts | renderCall 统一 | ✅ 聚焦 |
| 6 | — | E2E 验证 | ✅ |

Task 1 同时覆盖 F1（三层 header）、F2（实时计时）、F8（状态图标）。虽然三者均修改同一批渲染函数（renderSingleCollapsedText / renderParallelTable / renderChainCollapsedText / renderAgentDetail），但实时计时涉及 `context.invalidate()` 生命周期管理和 setInterval cleanup，与非计时部分的 header 改动的耦合度较低。建议在 executor task prompt 中明确优先顺序：先 header + 图标 → 再集成计时器。

### 2.2 依赖关系正确性

```
BG1 (render.ts, Tasks 1→2→3 串行)
BG2 (index.ts, Tasks 4→5 串行)
Wave 1: BG1 ∥ BG2 (不同文件，无冲突)
Wave 2: BG3 (依赖 BG1 + BG2)
```

依赖图正确。BG1 内部串行（同文件修改）、BG2 内部串行（同文件修改）、BG1 ∥ BG2 可行、BG3 依赖正确。

### 2.3 工作量估算

- Task 1: 中等（新 header 结构 + 计时器模式，影响 5+ 函数，约 200 行代码）
- Task 2: 中等（getDisplayItems 重写 + text preview，约 100 行）
- Task 3: 中等（Parallel 表格实时更新 + Chain 步骤编排，约 150 行）
- Task 4: 小（移除 ~100 行注册代码 + 更新文案）
- Task 5: 小（renderCall 重写，约 80 行）
- Task 6: 小（验证 checklist 产出）

整体工作量估算合理。每个 task 可在 subagent 的预算内完成。

### 2.4 Task 覆盖完整性（对照 Spec 逐条）

| Spec 章节 | Plan 对应 | 状态 |
|-----------|-----------|------|
| F1: 统一 Header 格式 | Task 1（含完整设计代码） | ✅ |
| F2: 实时计时 | Task 1（含 setInterval 代码模板） | ✅ |
| F3: 活动流优化 | Task 2（含 getDisplayItems 代码模板） | ✅ |
| F4: 执行顺序可视化 | Task 3 | ✅ |
| F5: collapsible 联动 | **未显式列为 Task** | ⚠️ #1 |
| F6: 移除 collect_subagent | Task 4（含移除范围 + 文案更新） | ✅ |
| F7: renderCall 统一 | Task 5（含完整 renderCall 代码） | ✅ |
| F8: 状态语义化 | Task 1（含 STATUS_ICONS 表和 icon color 规则） | ✅ |
| AC1: Single 模式 | SC1, SC2 + TC-1-01, TC-1-02 | ✅ |
| AC2: Parallel 模式 | SC3 + TC-2-01, TC-2-02 | ✅ |
| AC3: Chain 模式 | SC4 + TC-3-01, TC-3-02 | ✅ |
| AC4: Background 模式 | SC5 + TC-4-01 | ✅ |
| AC5: 实时计时 | SC6 + TC-1-03 | ✅ |
| AC6: 移除 collect_subagent | SC7 + TC-5-01 | ✅ |

**结论：plan 覆盖 spec 全部 F/AC，仅 F5 需额外注意（见 LOW #1）。无 plan 中 spec 未提及的额外工作。**

---

## 3. Spec 与 Plan 一致性

- plan 中所有 task 均可回溯到 spec 的具体 F/AC。无 orphan task。
- spec 的验收标准 AC1-AC6 在 e2e-test-plan 的 SC1-SC8 中有完整映射，test_cases_template.json 有对应 TC。
- e2e-test-plan 的 SC 与 test_cases_template.json 的 TC 一致，无遗漏。
- AC5（实时计时）的 SC6 验证"观察 elapsed 数字每秒刷新"，其在 render.ts 中的实现由 Task 1 覆盖。前后一致。

**结论：spec-plan 一致性高，无矛盾点。**

---

## 4. Execution Groups 合理性

### 4.1 分组合理性

| Group | 文件数 | Task 数 | 评估 |
|-------|--------|---------|------|
| BG1 | 1 (render.ts) | 3 | ✅ ≤10 文件, ≤4 Task |
| BG2 | 1 (index.ts) | 2 | ✅ |
| BG3 | 0 | 1 | ✅ |

### 4.2 类型划分

所有 task 标注为 "backend" 类型。考虑到本项目的架构（TUI 渲染作为 extension 的一部分），render.ts 的改动本质上是 TUI/frontend 工作而非后端。但项目 CLAUDE.md 未明确定义 frontend/backend 类型划分规则，且所有 task 属于同一扩展模块，类型标注一致。**不构成问题。**

### 4.3 功能关联度

- BG1: 三个 task 全部修改 `render.ts`，关联紧密。✅
- BG2: 两个 task 全部修改 `index.ts`，关联紧密。✅

### 4.4 依赖关系

```
BG1 ──→ BG3
BG2 ──→ BG3
```
被依赖的 BG1/BG2 排在 Wave 1，依赖方 BG3 排在 Wave 2。正确。✅

### 4.5 Wave 编排

Wave 1: BG1 ∥ BG2 — 修改 render.ts vs index.ts，**不同文件，无文件冲突**。✅
Wave 2: BG3 — 无文件修改，仅验证。✅

并行可行性确认：render.ts 和 index.ts 的改动范围正交（index.ts 不影响 render.ts 的导出接口），不存在 data race 或 API 合约冲突。

### 4.6 Subagent 配置完整性

| 配置项 | BG1 | BG2 | BG3 |
|--------|-----|-----|-----|
| Agent | general-purpose (×3) | general-purpose (×2) | general-purpose |
| Model | auto(high) | auto(medium) | auto(low) |
| 注入上下文 | spec.md F1-F5,F8 | spec.md F6,F7 | spec.md AC1-AC6 |
| 读取文件 | subagent/src/render.ts | subagent/src/index.ts, spawn.ts | 无 |
| 修改/创建文件 | subagent/src/render.ts | subagent/src/index.ts | 无 |
| 内部执行链 | executor → spec-compliance | executor → spec-compliance | 单一 agent |

全部配置完整。✅

### 4.7 上下文充分性

plan 为每个 task 提供了完整的设计细节代码模板（含 import 语句、函数签名、类型标注、实现逻辑），subagent 无需自行推导实现方案。上下文充分。✅

### 4.8 Subagent 内部链的合理性

BG1/BG2 内部使用 executor → spec-compliance 链：executor 实现后由 spec-compliance 审查。这是合理的双重保障（与 xyz-harness-subagent-driven-development 模式一致）。但需注意 spec-compliance subagent 也是 general-purpose agent，其可用工具与 executor 相同——如果 spec-compliance 发现实现不符合 spec，它应该报告问题而非直接修改代码。**plan 未明确定义 spec-compliance 失败时的处理流程（是报告给主 AI 还是继续下一个 task）。** 当前设为 INFO（不做 MUST FIX，因为 executor 已具备足够的设计细节，失败概率低；且主 AI 在下一轮可以通过 gate/review 发现）。

---

## 5. 架构合规性

### 5.1 CLAUDE.md 约束检查

| CLAUDE.md 约束 | Plan 合规性 | 说明 |
|----------------|------------|------|
| TUI: 仅用 Text/Container/Spacer/Markdown | ✅ | Plan 代码仅使用现有组件 |
| Theme: 通过 theme.fg() 着色 | ✅ | Plan 全部使用 theme.fg("token", text) |
| Session 隔离: 状态在 context.state 中 | ✅ | Plan 将 startTime 存在 context.state |
| 向后兼容: SubagentDetails 结构不变 | ✅ | Plan 明确声明不改变 api surface |
| 无 any 类型 | ✅ | Plan 代码模板有完整类型标注 |
| Function ≤ 80 行 | ⚠️ 待执行验证 | Plan 未明确声明，但 renderParallelTable 重构后可能接近边界 |
| 单文件 ≤ 1000 行 | ⚠️ 待执行验证 | render.ts(561行) + 改动后应不超标 |

### 5.2 ADR-001 架构约束检查

| ADR-001 约束 | Plan 合规性 | 说明 |
|--------------|------------|------|
| 进程隔离: subagent 独立进程 | ✅ | Plan 不修改 spawn 逻辑 |
| Context 传递协议: task prompt 包含背景/文件/约束/产出 | ✅ | Plan 的 BG1/BG2 配置了注入上下文 |
| Background 自动注入保持 | ✅ | Plan 仅移除 collect_subagent，不修改 auto-inject |
| 跨进程文件写冲突: BG1/BG2 写不同文件 | ✅ | Wave 1 并行无冲突 |
| 禁止嵌套 subagent | ✅ | Plan 的 subagent 链是 executor→spec-compliance，非嵌套 |

---

## 6. e2e-test-plan 与 test_cases_template 审查

### 6.1 覆盖度

e2e-test-plan 的 8 个测试场景（SC1-SC8）覆盖 spec 全部 6 个 AC 和 F3/F7 等关键功能。

test_cases_template.json 的 11 个 TC 与 e2e-test-plan 的 SC 一致。TC ID 按 `{模式}-{序号}` 分组便于阅读。

### 6.2 可执行性

所有 TC 的 steps 都是通过 Pi CLI 触发 subagent 命令，无需自动化框架。manual 类型合理。

### 6.3 质量问题

无。test_cases_template 覆盖了成功路径、失败路径、实时刷新、collapsed/expanded、移除验证等所有关键场景。

**结论：e2e 和 test cases 设计良好，满足验证需求。**

---

## 7. 问题汇总

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 1 | LOW | plan.md §F5 | F5 collapsible 联动缺少显式 Task 覆盖 | 在 Task 3 说明中补充将硬编码 `.slice(-5)` 提取为 `CHAIN_COLLAPSED_ITEM_COUNT = 5` 常量的步骤 |
| 2 | LOW | plan.md §Task 1 | Task 1 覆盖 F1+F2+F8 三个功能，单 Task 范围偏大 | 在 executor task prompt 中明确优先顺序：先 header 结构 + 图标 → 再集成计时器；或说明各子步骤的依赖关系 |
| 3 | INFO | plan.md §Task 6 | BG3 验证任务描述偏笼统 | 补充说明验证是通过产出 checklist 逐项填写完成的，不依赖 Pi 运行环境 |

**等级校准确认：**
- #1：CHAIN_COLLAPSED_ITEM_COUNT 常量的缺失不会导致功能失效——当前硬编码 `.slice(-5)` 与 spec 建议值一致，执行时可自然提取。标 LOW。
- #2：Task 1 的范围偏大但非功能缺陷——子步骤修改同一组函数，紧密耦合。标 LOW（建议优化而非阻塞）。
- #3：BG3 描述不够具体但不影响执行。标 INFO。

---

## 结论

**verdict: pass**

0 条 MUST FIX。Plan 整体设计正确、task 拆分合理、execution groups 编排无冲突、spec-plan 一致性高。2 条 LOW 建议（F5 常量 + Task 1 范围说明）和 1 条 INFO 记录，不阻塞流程。

### Summary

计划评审完成，第1轮通过，0条MUST FIX
