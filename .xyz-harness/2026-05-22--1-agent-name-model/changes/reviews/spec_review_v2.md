---
verdict: pass
must_fix: 0
---

statistics:
  total_issues: 3
  must_fix: 0
  must_fix_resolved: 1
  low: 1
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md: F5 section ↔ AC3 section"
    title: "COLLAPSED_ITEM_COUNT 全局常量与 Chain 模式限制冲突"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "F5 新增按模式映射表：Single=10/COLLAPSED_ITEM_COUNT, Parallel=10/COLLAPSED_ITEM_COUNT, Chain=5/CHAIN_COLLAPSED_ITEM_COUNT。AC3 的 5 条限制与 F5 Chain=5 一致。无需进一步修改。"

  - id: 2
    severity: LOW
    location: "spec.md: F6 section / Constraints"
    title: "SpawnManager 方法移除的条件性未落实"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "Constraints 新增「Collect 移除范围」行，明确限定为「仅移除工具注册和相关测试」，保留 cleanup 方法。F6 的「如无其他用途」措辞虽仍存在，但被更高优先级的 Constraints 覆盖，无歧义。"

  - id: 3
    severity: LOW
    location: "spec.md: AC2"
    title: "lastActivityTime 术语未定义"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    notes: "AC2 第二项：Running 状态的 agent 行要求显示 `lastActivityTime`，该术语在全文（F1-F8、其他 AC、Constraints）中未出现，亦无定义或数据来源说明。实现者不清楚它指什么属性。建议：(1) 在 F4 的 parallel 表格说明中增加对 lastActivityTime 的定义，或 (2) 如非必要，从 AC2 移除该要求，仅保留 elapsed。"

---

# Spec 评审 Round 2

## 评审记录

- 评审时间：2026-05-22 12:30
- 评审轮次：第 2 轮
- 评审类型：计划评审（仅 spec 完整性）
- 评审对象：`.xyz-harness/2026-05-22--1-agent-name-model/spec.md`（修改后）

---

## Round 1 MUST FIX 验证

### 问题 #1：COLLAPSED_ITEM_COUNT 数值冲突 — ✅ 已解决

**原始问题：** F5 声明全局 `COLLAPSED_ITEM_COUNT = 10`，AC3 要求 chain 模式的 collapsed 下「每步最多显示最后 5 个 display items」。10 vs 5 直接矛盾。

**当前状态：** F5 已修改为按模式显式列出独立的常量和默认值：

| 模式 | 常量 | 默认值 |
|------|------|--------|
| Single | `COLLAPSED_ITEM_COUNT` | 10 |
| Parallel | `COLLAPSED_ITEM_COUNT` | 10 |
| Chain | `CHAIN_COLLAPSED_ITEM_COUNT` | 5 |

采用「模式独立常量」方案（Review v1 建议的方案 B），用不同常量名避免歧义。AC3 的「每步最多显示最后 5 个 display items」与 F5 Chain=5 完全一致。**MUST FIX 已关闭。**

---

## Round 1 LOW 项验证

### 问题 #2：F6 移除条件未落实 — ✅ 已解决

**原始问题：** F6 说移除方法「如无其他用途」，但未确认是否有其他调用者。

**当前状态：** Constraints 表新增：
> **Collect 移除范围** — `不删除 SpawnManager 中 cleanup 方法，仅移除工具注册和相关测试`

这一行提供了明确的约束边界：
- 移什么：工具注册代码、相关测试
- 保留什么：cleanup 方法、session_shutdown 清理
- F6 的「如无其他用途」措辞虽仍存在，但 Constraints 行具有更高权威性，实现者可遵从约束。
- 建议：F6 中「（如无其他用途）」可改为「（保留内部 cleanup，仅移除工具注册）」，不过不影响 verdict。

**LOW 已关闭。**

---

## Round 2 新增发现

### 问题 #3（LOW）：lastActivityTime 术语未定义

**位置：** AC2 — Parallel 模式验收标准，「Running 的 agent 行显示 elapsed + lastActivityTime」

**问题描述：** `lastActivityTime` 在全文（F1-F8、其他 AC、Constraints）中找不到定义或数据来源说明。

- F4 的 parallel 表格说明只写了「表格展示所有 agent」+ AC2「agent 名 + icon + duration + turns + tokens + cost」
- F2 只定义了 elapsed 的实时更新
- 实现者无法判断 `lastActivityTime` 应该来自：
  - 最后一个 tool call 的时间戳？
  - 最后一个 text output 的时间戳？
  - Message 数组的最后一个元素的 timestamp？
  - 某个 TUI 框架提供的内置属性？

**影响范围：** 低度。AC2 的可执行性受影响（该检查项无明确判断标准），但不影响其他 F 项或 AC 项。如果有明确的实现者对 `lastActivityTime` 的约定共识，可安全忽略。

**建议修复方式（任选其一）：**
1. 在 F4 的 parallel 模式说明中增加定义：「lastActivityTime 指最后一个 dispaly item 的时间戳，格式 HH:MM:SS」
2. 如非设计必需，从 AC2 中移除此项

**优先级：** LOW — 不阻塞验收，但建议明确的 spec 比依赖实现者推测好。

---

## 维度检查回顾

### 维度1：spec 完整性

| 检查项 | 状态 | 备注 |
|--------|------|------|
| 1.1 目标是否明确 | ✅ | Background 节说清问题域和设计目标 |
| 1.2 范围是否合理 | ✅ | Out of Scope 明确 7 条范围外项；Constraints 覆盖 Collect 移除边界 |
| 1.3 AC 是否可量化 | ⚠️ LOW #3 | AC2 的 `lastActivityTime` 未定义，轻微影响可量化性；其余 AC 可量化 |
| 1.4 是否有 [待决议] | ✅ | 无 |
| **MUST FIX（Round 1）** | ✅ **已解决** | F5 数值冲突已修复 |
| **LOW（Round 1）** | ✅ **已解决** | F6 移除条件由 Constraints 限定 |

---

## 结论

**verdict: pass.**

1 条 MUST FIX 已解决（F5 数值冲突 → 各模式独立常量 + 显式映射表）。1 条 LOW 已解决（F6 移除条件由 Constraints 限定）。新增 1 条 LOW（lastActivityTime 未定义），不阻塞验收。

最终 MUST FIX 计数：**0**。满足 PASS 条件。
