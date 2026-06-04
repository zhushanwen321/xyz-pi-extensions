---
review:
  type: plan_review
  round: 2
  timestamp: "2026-06-04T22:30:00"
  target: ".xyz-harness/2026-06-04-workflow-storage-and-verification/plan.md"
  verdict: "pass"
  summary: "V1 三条 MUST_FIX 全部修复，无新增问题"

verdict: pass
must_fix: 0
---

# 计划评审 v2

## 评审记录
- 评审时间：2026-06-04 22:30
- 评审类型：计划评审（第 2 轮，修复验证）
- 评审对象：`plan.md` + `e2e-test-plan.md` + `test_cases_template.json`
- 前次评审：`plan_review_v1.md`（verdict: fail, 3 MUST_FIX）

## V1 MUST_FIX 修复验证

### Issue #1: AC-1.5 幽灵引用 → FIXED

**原始问题：** plan.md AC Coverage Matrix、e2e-test-plan.md E2E-1 coverage、test_cases_template.json TC-1-08 均引用了 spec 中不存在的 "AC-1.5"。

**修复验证：**

| 文件 | 验证方法 | 结果 |
|------|---------|------|
| plan.md | `grep -n "AC-1.5" plan.md` → 0 匹配 | ✅ 原 AC-1.5 行已改为 `FR-1.5 (backward compat)`，Data Flow 列标注 `(no separate AC; covered by AC-1.3 notify + skip)` |
| e2e-test-plan.md | `grep -n "AC-1.5" e2e-test-plan.md` → 0 匹配 | ✅ E2E-1 coverage 改为 `AC-1.1, AC-1.2, AC-1.3, AC-1.4 (FR-1.5 backward compat 由 AC-1.3 覆盖)` |
| test_cases_template.json | `grep -n "AC-1.5" test_cases_template.json` → 0 匹配 | ✅ TC-1-08 title 改为 `reconstructState ignores old workflow-state entries`，description 改为 `FR-1.5 backward compat (covered by AC-1.3)` |

### Issue #2: File Structure 表 BG2-T4 遗漏 index.ts → FIXED

**原始问题：** File Structure 表 BG2-T4 行只列出 `orchestrator.ts`（modify），遗漏 `index.ts`，与任务描述和 Subagent 配置矛盾。

**修复验证：**

| 验证点 | 结果 |
|--------|------|
| `grep -n "BG2-T4" plan.md` 第 26 行：`\| extensions/workflow/src/index.ts \| modify \| BG2-T4 \|` | ✅ 已添加 index.ts modify 行 |
| BG2-T4 任务描述包含 "跨文件变更说明" | ✅ 注明 BG2-T4 改 `reconstructState` 区域（`index.ts:99-124`），BG3-T5 改 `session_start` handler + `workflow-run` tool 区域，通过行号范围隔离 |
| BG2-T4 Subagent 配置 "修改/创建文件" 包含 index.ts | ✅ 与 File Structure 表一致 |

### Issue #3: Data Flow Chain 缺 maybeEmitSoftWarning 调用链 → FIXED

**原始问题：** Data Flow Chain 的 AgentPool 部分只展示了 `dispatch() → totalCallCount += 1`，缺少 `maybeEmitSoftWarning` → `onSoftLimitReached` → `pi.sendUserMessage` 的完整流转。

**修复验证：**

| 验证点 | 结果 |
|--------|------|
| `grep -n "maybeEmitSoftWarning" plan.md` 第 193 行在 Data Flow Chain 中 | ✅ |
| Data Flow Chain 包含完整链路：`dispatch() real spawn → totalCallCount += 1 → maybeEmitSoftWarning(runName, budget) → threshold check → onSoftLimitReached?.({...}) → WorkflowOrchestrator 构造时注入 callback → pi.sendUserMessage(...)` | ✅ |
| AgentPool 独立构造器代码块展示 orchestrator 层 callback 注入 | ✅ |

## Grep 验证结果

```
$ grep -n "AC-1.5" plan.md e2e-test-plan.md test_cases_template.json
(no output, exit code 1)  → 0 matches ✅

$ grep -n "maybeEmitSoftWarning" plan.md
79:  ... maybeEmitSoftWarning (private) ...        → Interface Contracts 签名
193: └─ maybeEmitSoftWarning(runName, budget)       → Data Flow Chain
396: 6. Add private maybeEmitSoftWarning ...        → BG1-T3 Implementation outline
397: 7. Call maybeEmitSoftWarning after each ...    → BG1-T3 Implementation outline
→ Data Flow Chain 中可见 ✅

$ grep -n "BG2-T4" plan.md | head -20
25: orchestrator.ts | modify | BG2-T4              → 原有
26: index.ts | modify | BG2-T4                     → 新增 ✅
```

## 无新增问题

本次修复仅涉及文档准确性调整，不引入新的架构、接口或依赖变更。Plan 的设计完整性、Spec-Plan 一致性、Interface Contracts、测试覆盖均在 v1 中已确认 PASS，修复后未引入回归。

## 结论

**verdict: pass**

V1 的 3 条 MUST_FIX 全部修复验证通过，无新增问题。计划可进入执行阶段。
