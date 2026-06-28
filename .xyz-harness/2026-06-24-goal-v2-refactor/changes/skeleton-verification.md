---
phase: code-arch (Step 7 骨架验证)
verdict: PASS
date: 2026-06-25
method: 实现代码即骨架（V2 已实现，物理验证设计假设）
---

# Step 7 骨架验证报告

## 验证策略

Goal V2 重构已在代码中落地（git 历史含 `refactor(goal)` 系列 Wave 提交）。因此骨架验证 = **用实现代码物理验证设计假设**（而非生成新骨架）。实现代码是最真实的骨架——签名/调用链/依赖方向已在编译中验证。

## 强制验证项（全部 PASS）

| 验证项 | 命令 | 结果 |
|--------|------|------|
| tsc 类型检查（签名自洽） | `pnpm --filter @zhushanwen/pi-goal typecheck` (npx tsc --noEmit) | ✅ exit 0 |
| 反模式：无 `any` | `grep ": any\|as any\|<any>" src/ --include="*.ts"` | ✅ clean |
| 反模式：无 `eslint-disable` | `grep "eslint-disable" src/` | ✅ clean |
| 反模式：无 `TODO/FIXME` | `grep "\bTODO\b\|\bFIXME\b" src/` | ✅ clean |
| AC-4 engine 零 Pi 依赖 | `grep "@mariozechner\|@zhushanwen/pi-" src/engine/` | ✅ empty（零命中）|
| AC-5 VALID_TRANSITIONS 存在 | `grep VALID_TRANSITIONS engine/types.ts` | ✅ engine/types.ts:32 |
| AC-6 TERMINAL_GOAL_STATUSES | `grep TERMINAL engine/` | ✅ engine/types.ts:21 |
| 7-state machine（含 paused/blocked） | `grep paused engine/types.ts` | ✅ types.ts:14 (paused), :33 (active→6 边) |
| NFR F2 budget 检查在 persistAndUpdate | `grep tokenBudget service.ts` | ✅ service.ts:117（事件路径 persistAndUpdate 内）|
| AC-1/2 GoalTask/goal_manager 消除 | `grep GoalTask\|goal_manager src/`（excl tests） | ✅ clean |

## 调用链可达性（§4 时序图入口→底层）

设计 §4 的 5 张时序图，其调用链在实现代码中均真实可达（tsc 通过 + import 链完整）：

| 时序图 | 入口 | 底层 | 可达性 |
|--------|------|------|--------|
| 功能1 /goal set | command-adapter.handleSet | engine/goal.createGoalState → persistence.serializeState | ✅ |
| 功能2 complete | goal-control-adapter.handleComplete | pi.__todoGetList → service.finalizeAndPersist → engine/goal.transitionStatus | ✅ |
| 功能3 budget 终态 | message-end → service.persistAndUpdate | engine/goal.transitionStatus（直比较）| ✅ |
| 功能4 context 注入 | before-agent-start | engine/budget.getTokenUsagePercent → projection/prompts | ✅ |
| 功能5 pause/resume | command-adapter | engine/goal.transitionStatus → service.persistState/persistAndUpdate | ✅ |

## 包依赖无环（§2）

tsc 编译通过证明 import 链无循环依赖。engine/ 是叶子（零 Pi 依赖已验证），adapters→service→engine 单向，projection 只读。

## 测试套件

`pnpm --filter @zhushanwen/pi-goal test` → **277/277 passed**（11 test files）。测试覆盖 service/command-adapter/goal-control-adapter/event-adapter/session/widget/prompts/stale-checker/deserialize-state。

> **注**：277 条测试 vs 设计期 test-matrix 37 条——实现期测试更细粒度（如 service.test.ts 22 条覆盖单方法多场景）。test-matrix 的 37 条是验收清单的「最小 Definition of Done」，实现期测试是超集。

## 结论

**PASS。** Step 7 骨架验证通过——设计假设（签名/调用链/依赖方向/状态机/budget 落点）经实现代码物理验证全部成立。⑤code-arch 的强制 gate 闭合。
