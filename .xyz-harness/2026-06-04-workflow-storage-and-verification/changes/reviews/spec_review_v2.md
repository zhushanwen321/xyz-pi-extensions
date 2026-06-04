---
review:
  type: spec_review
  round: 2
  timestamp: "2026-06-04T14:00:00"
  target: ".xyz-harness/2026-06-04-workflow-storage-and-verification/spec.md"
  verdict: pass
  summary: "v1 的 4 个问题全部修复，额外 AgentPool 设计问题也已修正为 callback 模式"
  parent_review: spec_review_v1.md

statistics:
  total_issues: 4
  must_fix: 0
  must_fix_resolved: 4
  low: 0
  info: 0
  extra_checks: 1
  extra_checks_pass: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-3.4 — state.ts exec trace node ref"
    title: "ExecutionTraceNode interface 行号引用错误，引用的实际是 WorkflowInstance 体"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "state.ts:78-86 → state.ts:65-75，与实际 ExecutionTraceNode 接口位置匹配"
  - id: 2
    severity: LOW
    location: "spec.md:FR-3.4 — state.ts serializeInstance ref"
    title: "serializeInstance 行号范围 172-188 略偏，实际函数体为 170-185"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "state.ts:172-188 → state.ts:170-185，与实际函数体匹配"
  - id: 3
    severity: LOW
    location: "spec.md → index.ts:100-129 reconstructState ref"
    title: "reconstructState 行号范围 100-129 略偏，实际函数体为 99-124"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "index.ts:100-129 → index.ts:99-124，与实际函数体匹配"
  - id: 4
    severity: INFO
    location: "spec.md:Self-Check"
    title: "Self-Check 说'覆盖 9 个 status'，但当前 7 个 + state_lost = 8，非 9"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "改为'覆盖 8 个 status(7 现有 + state_lost)'，数学正确"

extra_checks:
  - id: E1
    title: "AgentPool 设计改为 callback 模式"
    status: pass
    description: |
      v1 设计一致性检查指出 AgentPool 无 ExtensionAPI 引用，FR-4.3 代码示例中
      this.pi.sendUserMessage 不可行。

      v2 spec 已修正为 callback 模式：
      1. AgentPoolOptions 新增 onSoftLimitReached 回调字段
      2. AgentPool 构造函数接收并保存回调（不持有 ExtensionAPI）
      3. maybeEmitSoftWarning() 调用 this.onSoftLimitReached?.() 而非直接调 pi
      4. orchestrator 构造 AgentPool 时注入回调，回调内调 this.pi.sendUserMessage(...)
      5. AC-4.6 显式声明"AgentPool 本身不直接持有 ExtensionAPI 引用"

      设计解耦清晰，AgentPool 保持纯逻辑，ExtensionAPI 引用留在 orchestrator 层。
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-06-04 14:00
- 评审类型：v1 修复验证（只读审查，不修改 spec）
- 评审对象：`.xyz-harness/2026-06-04-workflow-storage-and-verification/spec.md`
- 前序评审：`spec_review_v1.md`

---

## 1. v1 问题逐项验证

### #1 MUST_FIX → 已修复 ✅

| 维度 | v1 | v2 |
|------|-----|-----|
| 位置 | FR-3.4 `state.ts:78-86` | FR-3.4 `state.ts:65-75` |
| 问题 | 78-86 实际是 WorkflowInstance 接口体 | — |
| 修正 | — | 改为 65-75，与 ExecutionTraceNode 接口完全匹配 |
| AC-3.4 联动 | 同步引用了错误行号 | AC-3.4 中 `ExecutionTraceNode interface(state.ts:65-75)` 已同步修正 |

### #2 LOW → 已修复 ✅

| 维度 | v1 | v2 |
|------|-----|-----|
| 位置 | FR-3.4 `state.ts:172-188` | FR-3.4 `state.ts:170-185` |
| 问题 | 行号范围偏移 2 行 | — |
| 修正 | — | 改为 170-185，与 serializeInstance 函数体精确匹配 |

### #3 LOW → 已修复 ✅

| 维度 | v1 | v2 |
|------|-----|-----|
| 位置 | FR-1.4 `index.ts:100-129` | FR-1.4 `index.ts:99-124` |
| 问题 | 行号范围偏移 5 行 | — |
| 修正 | — | 改为 99-124，与 reconstructState 函数体精确匹配 |

### #4 INFO → 已修复 ✅

| 维度 | v1 | v2 |
|------|-----|-----|
| 位置 | Self-Check 枚举值覆盖 | Self-Check 枚举值覆盖 |
| 问题 | "覆盖 9 个 status"，7+1=8 非 9 | — |
| 修正 | — | 改为"覆盖 8 个 status(7 现有 + state_lost)" |

---

## 2. 额外验证：AgentPool callback 模式

v1 设计一致性检查（第 5 节 FR-4）指出 AgentPool 无 ExtensionAPI 引用，spec 中 `this.pi.sendUserMessage` 不可行。

**v2 验证结果：通过 ✅**

v2 spec 已将 AgentPool 设计从直接持有 ExtensionAPI 改为纯 callback 模式：

1. **接口声明**（FR-4.3）：`AgentPoolOptions` 新增 `onSoftLimitReached?` 回调字段，类型为 `(info: { runName, totalCalls, budget }) => void`
2. **构造函数**：`AgentPool` 保存回调引用（`private readonly onSoftLimitReached?`），不持有 ExtensionAPI
3. **触发逻辑**：`maybeEmitSoftWarning()` 调用 `this.onSoftLimitReached?.()` 触发回调
4. **orchestrator 注入**：`this.agentPool = new AgentPool({ onSoftLimitReached: ({ ... }) => { this.pi.sendUserMessage(...) } })`
5. **AC-4.6 显式约束**："AgentPool 本身**不直接**持有 ExtensionAPI 引用"

依赖方向正确：orchestrator → AgentPool（callback），而非 AgentPool → ExtensionAPI（反向依赖）。

---

## 3. Spec 自检声明验证

Self-Check 中的声明与实际代码位置交叉验证：

| 声明 | 实际 | 状态 |
|------|------|------|
| `state.ts:18-25` WorkflowStatus | lines 17-24（近似匹配） | ✅ |
| `state.ts:65-75` ExecutionTraceNode | 精确匹配 | ✅ |
| `state.ts:107-122` SerializedWorkflowInstance | 存在，字段匹配 | ✅ |
| `state.ts:170-185` serializeInstance | 精确匹配 | ✅ |
| `index.ts:99-124` reconstructState | 精确匹配 | ✅ |
| `index.ts:556-569` exact match + sendUserMessage | lines 548-570，关键行匹配 | ✅ |
| 覆盖 8 个 status（7 现有 + state_lost） | 7 + 1 = 8 | ✅ |

---

## 4. 结论

### 判定

**verdict: pass** — v1 的 4 个问题全部修复，额外 AgentPool 设计问题也已修正为 callback 模式。无遗留 MUST_FIX。

### 修复质量评估

| 修复项 | 质量 | 说明 |
|--------|------|------|
| #1 行号修正 | 优秀 | FR-3.4 和 AC-3.4 两处同步修正，无遗漏引用点 |
| #2 行号修正 | 优秀 | 精确匹配函数体 |
| #3 行号修正 | 优秀 | 精确匹配函数体 |
| #4 数字修正 | 优秀 | 语义也更清晰（"7 现有 + state_lost"） |
| AgentPool callback | 优秀 | 架构解耦，依赖方向正确，AC-4.6 增加显式约束 |

spec 现在可以进入 plan 阶段。
