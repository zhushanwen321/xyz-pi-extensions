---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-22T12:20:00"
  target: ".xyz-harness/2026-05-22--1-agent-name-model/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第1轮，1条 MUST FIX（F5与AC3数值冲突），需修改后重审。plan.md 缺失，无法执行计划评审完整流程（维度2/3/4）。"

statistics:
  total_issues: 2
  must_fix: 1
  must_fix_resolved: 0
  low: 1
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md: F5 section ↔ AC3 section"
    title: "COLLAPSED_ITEM_COUNT 全局常量与 Chain 模式限制冲突"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "spec.md: F6 section"
    title: "SpawnManager 方法移除的条件性未落实"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-22 12:20
- 评审类型：计划评审（仅 spec 完整性）
- 评审对象：`.xyz-harness/2026-05-22--1-agent-name-model/spec.md`

### 前置说明

本次评审仅收到 spec.md，未提供 plan.md，因此仅执行**维度1（spec 完整性）**。维度2（plan 可行性）、维度3（spec 与 plan 一致性）、维度4（Execution Groups 合理性）因 plan.md 缺失而无法执行。

---

## 按维度检查

### 维度1：spec 完整性

#### 1.1 目标是否明确 — ✅ 通过

> 用户需要一次彻底的渲染管线重构，确保所有模式下信息展示格式一致、语义清晰、实时反馈直观。

Background 章节直接点明了问题域和解决目标，一句话说清楚。Functional Requirements 的 8 个 F 项精确对应问题域各方向。

#### 1.2 范围是否合理 — ✅ 通过

Out of Scope 明确列出了 7 条不在范围内的项：
- 进程管理逻辑（spawn.ts）
- 模型选择逻辑（model.ts）
- agent 发现逻辑（agents.ts）
- pi-tui 组件库
- 其他扩展（goal/todo）
- data format 变化
- api surface 变化

范围定义合理，没有过界或不足。

#### 1.3 验收标准是否可量化 — ⚠️ 见 MUST FIX #1

AC1-AC6 总体以 checkbox 形式列出了可验证的验收点，格式好。但存在一处**数值冲突**：

- **F5** 声明 `当前 COLLAPSED_ITEM_COUNT = 10 保持`（全局常量）
- **AC3** 要求「每步最多显示最后 5 个 display items（collapsed）」

两个互相矛盾。实现者无法判断 collapse 后是显示 10 条（F5 生效）还是 5 条（AC3 生效）。需统一。

**判定：** AC 设计范式合格，但一处具体数值冲突导致量化不一致 → MUST FIX

#### 1.4 是否标记了 `[待决议]` 项 — ✅ 通过

全文未发现 `[待决议]` 标记。所有功能需求清晰不做条件性设想。无待决议风险。

#### 补充观察：F6 移除范围的条件性

F6 说移除 `getActiveJobs()`、`getJobEvents()`、`getSessionJobFiles()` 方法「如无其他用途」。这是一个实现时才能确认的条件。如果这些方法在 SpawnManager 内部有其他调用点，移除会破坏内部逻辑。建议在 spec 层面确认或标记这些方法的调用关系。**标为 LOW**，不影响 verdict。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md: F5 ↔ AC3 | **COLLAPSED_ITEM_COUNT 数值冲突**: F5 声明全局 `COLLAPSED_ITEM_COUNT = 10`，AC3 要求 chain 模式的 collapsed 下「每步最多显示最后 5 个 display items」。10 vs 5 直接矛盾 | 方案 A：统一为 10，AC3 改为「每步最多显示最后 10 个 display items（同全局配置）」；方案 B：若 chain 确实需要不同值，在 F5 中注明「Chain 模式例外，每步显示 5 条」 |
| 2 | LOW | spec.md: F6 | **移除条件未落实**: `getActiveJobs()`、`getJobEvents()`、`getSessionJobFiles()` 的移除加注了「如无其他用途」，但未确认是否有其他调用者。如果这些方法被 `session_shutdown` 或其他内部路径引用，移除会破坏 | 在 F6 中明确「经排查，这些方法仅被 collect_subagent 工具使用」，或者改为「方法保留（供 cleanup 用），仅移除工具注册」 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过。本报告仅 1 条 MUST FIX，未达 SKILL 循环上限
> - **LOW**：建议修复，不阻塞

---

## 结论

**需修改后重审。**

存在 1 条 MUST FIX（F5 与 AC3 数值冲突），1 条 LOW（F6 移除条件不明确）。此外 plan.md 缺失，建议补充 plan.md 后启动第 2 轮完整评审。

---

## Summary

计划评审（spec 完整性）完成，第 1 轮，1 条 MUST FIX，需修改后重审。
