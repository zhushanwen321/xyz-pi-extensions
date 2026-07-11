# Red Team Review — Mid-Detail Deliverables (Deletion Test)

> Reviewer: 独立红队（反过度编排）
> 审查对象: issues.md / non-functional-design.md / code-architecture.md / execution-plan.md
> 方法: 逐项 deletion test（不做会怎样？）

---

## 判定: CHANGES_REQUESTED

**阻断项 1 个（Issue #4 / Wave 3 架构不可行），警告 3 个。**

---

## 1. Issue 审查

### #1 sync 删除 — PASS

**Deletion test**: 不删会怎样？sync 模式阻塞父 agent、无法并行 fan-out、并发池优先级逻辑复杂。删除理由充分。依赖链正确（#2/#3 依赖 #1）。

无异议。

### #2 并发池分层配额 — PASS（附建议）

**Deletion test**: 不做分层会怎样？固定 maxConcurrent 在嵌套场景下，深层 agent 可能耗尽池资源。分层 `max(1, maxConcurrent-depth)` 是合理的线性退化策略。

**建议**: 当前代码 `concurrency-pool.ts` 只有 78 行，接口改造后预计仍 <100 行。方案 A（改接口）可行，但 `acquire(depth)` 的语义不如 `acquire(effectiveSlots)` 直观——调用方需要理解"depth"的含义。考虑是否在接口层直接暴露 `effectiveSlots` 计算，让 pool 只做纯并发控制。

非阻断，保留为建议。

### #3 通知合并 — PASS（附警告，见 §5）

**Deletion test**: 不合并会怎样？两套通知机制并存（notifier.ts + pending-notifications），维护成本增加。合并理由充分。

**但**: notifier.ts 有 212 行生产级代码（滑动窗口合并 60s、去重 TTL、followUp 唤醒语义）。删除它不是"合并"，是"替换"——pending-notifications 扩展需要重建这些行为。详见 §5 警告。

### #4 双重记账一致性 — BLOCKER

**Deletion test**: 不做会怎样？

**核心问题**: `WorkflowRun` 在 `extensions/workflow/` 中，`ExecutionRecord` 在 `extensions/subagents/` 中。`subagent-service.ts` 当前 **零引用** `WorkflowRun`（grep 确认）。这不是模块内的状态统一，是 **跨 extension 的状态同步**。

deliverables 的方案 A「SubagentService 统一管理两侧状态」要求 `subagent-service.ts` 直接操作 `WorkflowRun`——这违反了 extension 边界。subagents 不应该 import workflow 的内部类型。

**为什么是 blocker**:
1. **架构不可行**: subagents → workflow 是跨 extension 依赖，不在 `extension-dependencies.json` 中声明，且反向依赖（workflow 依赖 subagents）已有。加反向依赖会形成循环。
2. **当前代码不存在此问题**: `subagent-service.ts` 不引用 `WorkflowRun`，说明当前架构中两侧本来就不耦合。"T1 只保证正常路径两侧一致"的前提——两侧在哪里？subagents 内部只有 `ExecutionRecord` 一侧。
3. **Wave 3 的所有 test case（T3.1-T3.3, T-NFR-6~8）都基于这个不成立的前提**。

**修正方案**:
- 如果"两侧"指的是 `ExecutionRecord`（subagents）+ `pending-notifications` entries（pending-notifications 扩展），那这是 EventBus 事件契约的事，不是 SubagentService 管两侧状态。
- 如果"两侧"指的是 workflow 的 `WorkflowRun` 节点状态 + subagents 的 `ExecutionRecord`，那应由 **workflow 扩展** 消费 `pending:unregister` 事件来同步，不是让 subagents 反向耦合。
- **无论哪种方案，Issue #4 的当前设计都需要重写**。

### #5 全量测试 — PASS（附建议）

**Deletion test**: 不做全量回归会怎样？可能遗漏 sync 删除的副作用。合理。

**建议**: Wave 4 不产出代码，只是跑测试。它不是 Wave，是 gate。可以合并到每个 Wave 的验收步骤中，或者作为 closeout 的前置条件。独立一个 Wave 增加了执行计划的长度但不增加价值。

---

## 2. NFR 缓解项审查

| 编号 | 缓解措施 | Deletion test | 判定 |
|------|---------|--------------|------|
| M-1 | 全量搜索 sync 相关引用 | 不搜可能遗漏 → **合理** | KEEP |
| M-2 | session.jsonl replay 兼容 | 不做会破坏旧 session replay → **合理但低概率** | KEEP（低成本） |
| M-3 | agent .md prompts 清理 | 不清理 AI 还以为有 sync → **合理** | KEEP |
| M-4 | 分层配额 debug 日志 | 不加日志难以诊断 → 但这是开发期调试，不应成为 AC | **降级为可选** |
| M-5 | 保底 1 槽位单测 | 不测保底可能饿死 → **合理** | KEEP |
| M-6 | 排队超时 warn 日志 | 不加 warn 会怎样？固定 maxConcurrent=4 的池，排队 >5s 极罕见。没证据表明这是问题 | **删除** |
| M-7 | emitPendingUnregister payload 扩展 | 不扩展会怎样？事件不含 result/error → 消费方需另查 → **合理** | KEEP |
| M-8 | pending-notifications 适配 | 不适配则通知丢失 → **合理但归属 T3** | KEEP（标注 T3 依赖） |
| M-9 | 确认旧消费方容忍额外字段 | TypeScript 结构类型天然兼容，不需要额外确认 | **删除**（测试语言特性） |
| M-10 | WorkflowRun 同步在 finalizeRecord | 基于 #4 的错误前提 | **随 #4 重写** |
| M-11 | WorkflowRun 同步不走异步回调 | 基于 #4 的错误前提 | **随 #4 重写** |
| M-12 | dispose() 路径 WorkflowRun 终态化 | 基于 #4 的错误前提 | **随 #4 重写** |
| M-13 | finalizeRecord debug 日志 | 不加日志怎样？finalizeRecord 有 B9 兜底，已有 bestEffort 日志 | **删除**（重复现有日志） |

**统计**: 13 项中保留 7 项，删除 3 项（M-6/M-9/M-13），降级 1 项（M-4），随 #4 重写 3 项（M-10~12）。

---

## 3. Wave 拆分审查

### 当前: 5 Waves (0/1/2/3/4)

**Deletion test**: 合并哪些 Wave 不会降低可测试性？

| 合并方案 | 可行性 | 理由 |
|---------|--------|------|
| Wave 0+1 合并 | **可行** | 两者 Blocked by 无、并行组 A。虽然改不同文件，但合并后仍可分步验证（先删 sync，再改 pool）。减少一个 Wave 不增加风险 |
| Wave 2+3 合并 | **不可行** | #3 改 subagent-service.ts 删 notifier，#4 也改 subagent-service.ts 统一生命周期。但 #4 需要重写（见 §1），重写后可能与 #2 的改动冲突 |
| Wave 4 删除 | **可行** | 全量测试是 gate，不是 Wave。每个 Wave 自带验收标准，全量回归放到 closeout 前即可 |

**建议**: Wave 0+1 合并为 Wave 0（sync 删除 + 分层配额），Wave 4 降级为 closeout gate。最终 3 Waves: 0(删sync+分层配额) → 1(通知合并) → 2(双重记账，需重写)。

---

## 4. Test Case 审查

### Deletion test: 不测会怎样？

| 用例 | 判定 | 理由 |
|------|------|------|
| T0.1 start 行为不变 | KEEP | 核心回归 |
| T0.2 background 测试全绿 | KEEP | 核心回归 |
| T0.3 wait 参数删除 | KEEP | breaking change 验证 |
| T1.1~T1.3 分层配额 | KEEP | 新功能验证 |
| T2.1~T2.3 通知合并 | KEEP | 核心功能验证 |
| T3.1~T3.3 双重记账 | **随 #4 重写** | 前提不成立 |
| T-NFR-1 debug 日志 | **删除** | 测试日志输出 = 测试实现细节，换日志框架就废 |
| T-NFR-2 保底 1 槽位 | **合并到 T1.3** | 与 T1.3 重复 |
| T-NFR-3 排队超时 warn | **删除** | 测试 warn 日志 = 测试噪音。没有证据表明排队超时是真实问题 |
| T-NFR-4 payload 扩展 | **合并到 T2.2** | 与 T2.2 重复 |
| T-NFR-5 旧消费方容忍字段 | **删除** | 测试 TypeScript 结构类型兼容性 = 测试语言本身 |
| T-NFR-6~8 WorkflowRun 同步 | **随 #4 重写** | 前提不成立 |
| T-NFR-9 finalizeRecord 日志 | **删除** | 测试现有 B9 日志覆盖，无新增价值 |

**统计**: 18 个 test case 中保留 8 个核心用例，删除 5 个（测试日志/语言特性/重复），随 #4 重写 4 个，合并 2 个到已有用例。

---

## 5. 警告: notifier.ts 删除风险

**保留 notifier.ts 是否更简单？**

notifier.ts 提供 3 个关键行为:
1. **滑动窗口合并** (60s): 多个 background 完成合并为一条消息，避免 LLM 被密集通知轰炸
2. **去重 TTL** (60s): 同 id 短时间内不重复通知
3. **deliverAs:"followUp" + triggerTurn**: 当前 streaming 结束后唤醒父 agent

删除 notifier.ts 后，pending-notifications 扩展需要重建这 3 个行为。但:
- pending-notifications 扩展的当前实现未知（不在本次 deliverables 中）
- R-3/R-4 将此风险标记为"转 T3"——但 T3 的范围和能力未确认
- 如果 T3 不实现滑动窗口合并，多个 background 密集完成时 LLM 会收到 N 条独立通知

**建议**: 保留 notifier.ts，让 pending-notifications 扩展 **消费** notifier 的输出（通过 EventBus），而不是 **替代** notifier。Notifier 内部改为 emit `pending:unregister` 事件 + 自己的合并逻辑。这样 notifier.ts 的核心逻辑不动，只改输出通道。

这是 **短期方案**（保留 notifier 作为过渡），长期方案等 pending-notifications 扩展能力确认后再迁移。但短期方案的风险远低于直接删除。

---

## 6. 分层配额设计审查

**是否过度设计？直接用固定 maxConcurrent 是否足够？**

分析: 当前 `concurrency-pool.ts` 78 行，改造后预计 <100 行。`max(1, maxConcurrent-depth)` 公式简单、可预测、有保底。不是过度设计。

但有一个微妙问题: `acquire(depth)` 的语义假设调用方知道自己的 depth。当前代码中 `record.depth` 来自 `createRecordForMode`，这个 depth 是 fork depth（`MAX_FORK_DEPTH=10`），不是并发池的逻辑深度。如果未来 fork depth 和并发池深度需要解耦（比如某些 fork 不进池），这个接口会成为负担。

**结论**: 当前可接受。如果 fork depth 和池深度需要解耦，那是未来重构的事。

---

## 7. 汇总

| 维度 | 判定 | 说明 |
|------|------|------|
| Issue #1 sync 删除 | PASS | 无异议 |
| Issue #2 分层配额 | PASS | 建议小改 |
| Issue #3 通知合并 | PASS+WARN | notifier.ts 删除风险高，建议保留 |
| **Issue #4 双重记账** | **BLOCKER** | 跨 extension 耦合，前提不成立，需重写 |
| Issue #5 全量测试 | PASS | 建议降级为 gate |
| NFR 缓解项 | 7/13 KEEP | 删除 3 项，降级 1 项，随 #4 重写 3 项 |
| Wave 拆分 | 5→3 建议 | 合并 0+1，删除 4，保留 2+3 |
| Test cases | 18→8+4 重写 | 删除 5 个日志/语言测试 |

### 必须修改

1. **Issue #4 / Wave 3**: 重写双重记账设计。明确"两侧"是什么，不能让 subagents 反向依赖 workflow。由 workflow 扩展消费 EventBus 事件来同步。
2. **Wave 3 test cases (T3.x, T-NFR-6~8)**: 随 Issue #4 重写。

### 建议修改（非阻断）

3. **保留 notifier.ts**，改为 emit EventBus 事件，不直接删除。
4. **合并 Wave 0+1**。
5. **删除 M-6/M-9/M-13** 和对应的 test cases。
6. **Wave 4 降级为 closeout gate**。
