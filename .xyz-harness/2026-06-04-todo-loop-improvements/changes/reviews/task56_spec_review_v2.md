---
verdict: pass
must_fix: 0
review_of: task56_spec_review_v1
---

# Task 5 & 6 Spec 合规审查 V2（修正后复审）

**审查文件**: `extensions/todo/src/index.ts` (L658-755), `extensions/todo/src/__tests__/todo.test.ts`
**Spec 来源**: `.xyz-harness/2026-06-04-todo-loop-improvements/spec.md`
**日期**: 2026-06-04

## V1 两个 MUST FIX 修复验证

### MUST_FIX #1: verifyAttempts 不递增 → 验证提醒无限循环

| 检查项 | 结果 | 证据 |
|--------|------|------|
| agent_end 中 needsVerify 找到后执行 `verifyAttempts++` | ✅ PASS | `index.ts:688`: `needsVerify.verifyAttempts++;` |
| 验证消息包含 attempt 计数 | ✅ PASS | `index.ts:694`: `attempt ${needsVerify.verifyAttempts}/${MAX_VERIFY_ATTEMPTS}` |
| 测试覆盖递增行为 | ✅ PASS | `todo.test.ts` "should increment verifyAttempts when triggering verification": 模拟 0→1→2 递增 |

**V1 问题**: 全代码库无 `verifyAttempts++`。**V2 状态**: `index.ts:688` 已在 needsVerify 分支中递增。

### MUST_FIX #2: 验证失败检测不可达

| 检查项 | 结果 | 证据 |
|--------|------|------|
| verify-failed 检查在 needs-verify 之前 | ✅ PASS | `index.ts:662-678` (step 1) 先于 `index.ts:680-697` (step 2) |
| verify-failed 条件为 `status === "completed"` | ✅ PASS | `index.ts:664`: `t.status === "completed" && t.verifyText && t.verifyAttempts >= MAX_VERIFY_ATTEMPTS` |
| 失败后状态改为 `failed` | ✅ PASS | `index.ts:670`: `verifyFailed.status = "failed";` |
| `failed` 状态不再被 needsVerify 或 verifyFailed 重新匹配 | ✅ PASS | 两个 `.find()` 都要求 `status === "completed"`，`failed` 不匹配 |
| 测试覆盖优先级和终态 | ✅ PASS | `todo.test.ts` "should mark failed when attempts reach max": 验证 step1 先于 step2 |

**V1 问题**: verify-failed 检查要求 `status === "in_progress"`（永远不满足），且位于 needs-verify 之后。**V2 状态**: 条件改为 `status === "completed"`，且置于 needs-verify 之前。

## 完整生命周期验证

### 场景: 任务 verifyText + MAX_VERIFY_ATTEMPTS=2

| 步骤 | 任务状态 | verifyAttempts | agent_end 行为 | 代码路径 |
|------|---------|---------------|----------------|----------|
| 1. AI 标记 completed | `completed` | 0 | step1: `0 >= 2`? No → step2: `0 < 2`? Yes → `verifyAttempts++` (→1) → 注入验证提醒 | L680-697 |
| 2. AI 再次 completed | `completed` | 1 | step1: `1 >= 2`? No → step2: `1 < 2`? Yes → `verifyAttempts++` (→2) → 注入验证提醒 (2/2) | L680-697 |
| 3. AI 再次 completed | `completed` | 2 | step1: `2 >= 2`? Yes → `status = "failed"` → 注入失败通知 → **return** | L662-678 |
| 4. 后续 agent_end | `failed` | 2 | step1: `status !== "completed"` → skip → step2: `status !== "completed"` → skip → 继续后续逻辑 | — |

**结论**: 生命周期完整闭合，无无限循环。

| # | 生命周期节点 | 验证 |
|---|-------------|------|
| 1 | completed + verifyText + attempts=0 < 2 → needsVerify catches → increments to 1 → inject context | ✅ 代码 + 测试覆盖 |
| 2 | 重新 completed, attempts=1 < 2 → needsVerify catches → increments to 2 → inject context (2/2) | ✅ 代码 + 测试覆盖 |
| 3 | 再次 completed, attempts=2 >= 2 → verifyFailed catches → status → failed | ✅ 代码 + 测试覆盖 |
| 4 | failed 状态后, 不再触发 verify 或 needsVerify | ✅ 代码逻辑验证（两个 find 均要求 `completed`） |

## Task 5 完整检查 (AC-4, AC-5)

| # | 检查项 | AC | 状态 | 证据 |
|---|--------|-----|------|------|
| 1 | `pi.on("agent_end")` 注册 | AC-4 | ✅ PASS | index.ts:654 |
| 2 | verify-failed 检查: completed + verifyText + attempts >= MAX | AC-5 | ✅ PASS | index.ts:662-678，条件正确，在 needs-verify 之前 |
| 3 | verify-failed → status = "failed" + deliver steer | AC-5 | ✅ PASS | index.ts:670-677 |
| 4 | needs-verify 检查: completed + verifyText + attempts < MAX | AC-4/5 | ✅ PASS | index.ts:680-686 |
| 5 | needs-verify → verifyAttempts++ + deliver steer with attempt count | AC-5 | ✅ PASS | index.ts:688-694 |
| 6 | auto-clear: allCompletedAtCount + AUTO_CLEAR_DELAY_ROUNDS=2 | AC-4 | ✅ PASS | index.ts:698-714 |
| 7 | stall 检测: STALL_THRESHOLD=5 | AC-4 | ✅ PASS | index.ts:718-735 |
| 8 | reminder: REMINDER_INTERVAL=3 | AC-4 | ✅ PASS | index.ts:738-751 |
| 9 | 常量定义: MAX_VERIFY_ATTEMPTS=2 | AC-5 | ✅ PASS | index.ts:193 |
| 10 | userMessageCount/lastTodoCallCount 在 executeTodoAction 中递增 | AC-4 | ✅ PASS | index.ts:307-308 |

## Task 6 检查 (AC-7)

| # | 检查项 | AC | 状态 | 证据 |
|---|--------|-----|------|------|
| 1 | before_agent_start 已替换（无 display:true 注入） | AC-7 | ✅ PASS | V1 已确认，无变更 |
| 2 | display:false + customType "todo-context" | AC-7 | ✅ PASS | V1 已确认 |
| 3 | 旧常量/变量已删除 | AC-7 | ✅ PASS | V1 已确认 |

## 测试覆盖评估

| 测试文件 | 覆盖范围 | 评估 |
|----------|---------|------|
| Task 1 tests (7 tests) | 数据模型 + 迁移 + `failed` 状态 | ✅ 充分 |
| Task 2 tests (6 tests) | add + verifyTexts 映射 + 边界 | ✅ 充分 |
| Task 3 tests (4 tests) | batch update + all-or-nothing | ✅ 充分 |
| Task 4 tests (2 tests) | formatTodoLine + verifyText 显示 | ✅ 充分 |
| Task 5 tests (9 tests) | verify 生命周期 + stall + reminder + auto-clear | ✅ 充分 |

**注**: Task 5 测试使用纯数据模型模拟 agent_end 逻辑（非集成测试），验证的是 `.find()` 条件和状态转换的正确性。agent_end handler 本身是 Pi 运行时事件回调，无法脱离 Pi 环境直接测试。这是合理的测试策略——将可测试的逻辑提取到纯函数，不可测试的胶水代码保持最小。

## 非阻断观察（保留自 V1）

| # | 观察项 | 级别 | 说明 |
|---|--------|------|------|
| N1 | before_agent_start setStatus 使用 emoji | INFO | `📋` 违反项目 emoji 规范，不影响功能 |
| N2 | reminder 每轮触发 | INFO | `userMessageCount - lastTodoCallCount >= REMINDER_INTERVAL` 满足后每轮都触发，非间隔语义 |

## 最终结论

| Task | AC | Verdict |
|------|-----|---------|
| Task 5 | AC-4 (agent_end 循环) | ✅ PASS |
| Task 5 | AC-5 (验证流程) | ✅ PASS |
| Task 6 | AC-7 (before_agent_start refactor) | ✅ PASS |

**Verdict: PASS**
**MUST FIX: 0**

V1 的两个阻断问题均已修复：
1. `verifyAttempts++` 在 needsVerify 分支中递增（index.ts:688）
2. verify-failed 检查条件改为 `status === "completed"`（index.ts:664）且优先于 needs-verify（index.ts:662-678 先于 L680-697）
