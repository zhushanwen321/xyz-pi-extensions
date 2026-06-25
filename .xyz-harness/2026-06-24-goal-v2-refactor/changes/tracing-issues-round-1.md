# Tracing: Issues Round 1

追踪对象：issues.md ↔ system-architecture.md ↔ spec.md
4 视角：覆盖性 / 方案完整性 / 优先级一致性 / 前沿清晰度

---

## 1. Issue 覆盖性

### system-architecture.md §7 删除清单 → issues 映射

| 删除项 | 对应 Issue | 状态 |
|--------|-----------|------|
| `engine/task.ts` | #1 | ✅ |
| `adapters/tool-adapter.ts` | #1 | ✅ |
| `adapters/actions.ts` | #1 | ✅ |
| `command-adapter.ts::handleAbort` | **无** | ❌ **GAP-1** |
| GoalRuntimeState.tasks | #1 | ✅ |
| GoalRuntimeState.stallCount | #6 | ✅ |
| BudgetConfig.maxTurns | #6 | ✅ |
| BudgetConfig.maxStallTurns | #6 | ✅ |

### system-architecture.md §7 Handler 分支级删除 → issues 映射

| 分支级删除 | 对应 Issue | 状态 |
|-----------|-----------|------|
| handleAllTasksDone maxTurnsReached→complete | #6 | ✅ |
| handleNoTasksOrMaxTurns maxTurnsReached→cancelled | #6 | ✅ |
| handleMaxTurnsReached 整个函数 | #6 | ✅ |
| handleStallAndContinuation stallCount++→blocked | #6 | ✅ |

### system-architecture.md §7 行为变更 → issues 映射

| 行为变更 | 对应 Issue | 状态 |
|---------|-----------|------|
| handleSet 拒绝覆盖非终态旧 goal | #11 | ✅ |
| checkBudgetOnTurnEnd 只做 warning/steering | #8 | ✅ |

### system-architecture.md §10 挑战/决策 → issues 映射

| 决策 | 对应 Issue | 状态 |
|------|-----------|------|
| D-A1: event-adapter 拆分 | #4 | ✅ |
| D-A2: service.ts 保持单文件 | 内化在重构中 | ✅（非 issue 级） |
| D-A3: duck-typed API | #7 | ✅ |
| D-A4: 显式转换表 | #2 | ✅ |
| D-A5: BudgetConfig 精简 | #2 + #6 | ✅ |

### spec.md FR → issues 映射

| FR | 对应 Issue | 状态 |
|----|-----------|------|
| FR-1: task+todo 合并 | #1 + #7 | ✅ |
| FR-2: goal_control | #3 | ✅ |
| FR-3: Paused 状态 | #2 | ✅ |
| FR-4: 权限三分层 | #2 + #3 + #6 | ✅（分散覆盖） |
| FR-4: 删 /goal abort | **无** | ❌ **GAP-1** |
| FR-4: 删 cancel_goal | #1（goal_manager 删除连带） | ✅ |
| FR-5: budget 单一检查点 | #5 | ✅ |
| FR-6: completion audit | #10 | ✅ |
| FR-7: plan↔goal 联动 | #9 | ✅ |

### GAP 列表

| ID | 类型 | 描述 |
|----|------|------|
| GAP-1 | **F** | `/goal abort` 命令删除（`command-adapter.ts::handleAbort`）在 issues.md 无对应 issue。架构设计 §7 删除清单和 spec FR-4 都明确要求删除，但 #1 只覆盖 goal_manager tool，#11 只覆盖 /goal set 拒绝。需补充到 #1 或新增 issue。 |

---

## 2. 方案完整性

### P0 Issues

| Issue | 方案数 | 取舍决策 | 评价 |
|-------|--------|---------|------|
| #1 | 2（一步删除 vs 分步废弃） | 选 A | ✅ 完整 |
| #2 | 2（显式转换表 vs 宽松守卫） | 选 A | ✅ 完整 |
| #3 | 2（独立文件 vs 内联 service） | 选 A | ✅ 完整 |
| #4 | 2（6 文件拆分 vs 单文件分区） | 选 A | ✅ 完整 |

### P1 Issues

| Issue | 方案数 | 取舍决策 | 评价 |
|-------|--------|---------|------|
| #5 | 2（persistState 单一 vs 双检查点） | 选 A | ✅ 完整 |
| #6 | 2（直接删除 vs soft limit） | 选 A | ✅ 完整 |
| #7 | 2（duck-typed vs TodoPort） | 选 A | ✅ 完整 |
| #8 | 2（只 warning vs soft auto-complete） | 选 A | ✅ 完整 |

### P2 Issues

| Issue | 方案数 | 取舍决策 | 评价 |
|-------|--------|---------|------|
| #9 | 1（LLM 判断 + duck-typed） | 选 A | ⚠️ 无替代方案 |
| #10 | 0（"纯 prompt 改动"） | N/A | ⚠️ **GAP-2** |
| #11 | 0（"直接改 handleSet"） | N/A | ✅ 合理（简单逻辑改动，不需要方案对比） |
| #12 | 0（"加分支"） | N/A | ✅ 合理（trivial 改动） |

### GAP 列表

| ID | 类型 | 描述 |
|----|------|------|
| GAP-2 | **K** | #10 completion audit prompt 说"纯 prompt 改动，无方案对比"，但 prompt 是核心行为变更的关键载体。至少应讨论：(a) 硬编码在 contextInjectionPrompt vs (b) 独立 prompt 文件 + 配置化。当前方式可行但应明确为什么不需要方案对比（因为 prompt 只有一个消费方且没有配置需求）。 |

---

## 3. 优先级一致性

### blocked_by 与 P 级一致性

| Issue | P 级 | blocked_by | 一致性 |
|-------|------|-----------|--------|
| #1 | P0 | 无 | ✅ |
| #2 | P0 | 无 | ✅ |
| #3 | P0 | #1 (P0) | ✅ |
| #4 | P0 | #2 (P0), #3 (P0) | ✅ |
| #5 | P1 | #4 (P0) | ✅ |
| #6 | P1 | #4 (P0) | ✅ |
| #7 | P1 | #1 (P0) | ✅ |
| #8 | P1 | #4 (P0) | ✅ |
| #9 | P2 | #7 (P1) | ✅ |
| #10 | P2 | #7 (P1) | ✅ |
| #11 | P2 | #2 (P0) | ⚠️ **GAP-3** |
| #12 | P2 | #2 (P0) | ⚠️ **GAP-3** |

### P0 不依赖 P2/P3

✅ 所有 P0 依赖都是 P0→P0 或无依赖。

### GAP 列表

| ID | 类型 | 描述 |
|----|------|------|
| GAP-3 | **D** | #11（/goal set 拒绝）和 #12（widget 状态显示）标记为 P2，但它们是 P0 状态机变更（#2 paused 状态）的直接行为结果。#11 的拒绝逻辑是 D25 明确决策的行为变更；#12 的 paused/blocked 显示是新状态的必要可视化。这两个更接近 P1（核心实现的一部分），不是"重要但可延后"的 P2。建议：#11 → P1，#12 → P1，或至少标注"P2-early"（P0 完成后立即做）。 |

---

## 4. 前沿清晰度

### 迷雾该展开吗？

issues.md 声称"无迷雾"，但实际上存在未完全展开的区域：

| 区域 | 当前状态 | 是否该展开 |
|------|---------|-----------|
| #1 改动面（~15 文件） | 只有 grep 验收标准，未列出具体文件 | 不需要——grep 验收已足够，具体文件在实施时发现 |
| #2 VALID_TRANSITIONS 表维护 | 架构文档有完整 7×7 表定义 | 不需要——定义已明确 |
| **#4 行为等价性验证** | 验收标准写"行为不变"但无具体方法 | **应该展开** — **GAP-4** |
| **#7 降级时具体行为** | 只说"undefined=降级" | **应该展开** — **GAP-5** |

### P2/P3 合理性

| Issue | 标记 | 合理性 |
|-------|------|--------|
| #9 plan↔goal 联动 | P2 | ✅ 合理——可选增强，goal 不依赖 plan 也能工作 |
| #10 completion audit | P2 | ⚠️ 偏低——prompt 是核心行为变更的载体，P2 意味着可延后，但 completion audit 是 Codex 对标的关键差距 |
| #11 /goal set 拒绝 | P2 | ⚠️ 偏低——见 GAP-3 |
| #12 widget 显示 | P2 | ⚠️ 偏低——见 GAP-3 |
| P3: 预警 flag 合并 | P3 | ✅ 合理——收益低，4 个 flag 不影响功能 |
| P3: budget.ts 拆分 | P3 | ✅ 合理——180 LOC 不需要拆 |
| P3: prompts.ts 拆分 | P3 | ✅ 合理——370 LOC 按投影层职责统一归类 |

### GAP 列表

| ID | 类型 | 描述 |
|----|------|------|
| GAP-4 | **K** | #4 验收标准"6 个事件 handler 功能与拆分前等价"缺少验证策略。737 行拆成 6 文件后如何确认行为不变？建议：(a) 拆分前先写集成测试（如果有），(b) 或至少列出每个 handler 的关键行为点作为手动验收 checklist。当前项目无测试覆盖（vitest 只在 statusline 等包有），行为等价只能靠 typecheck + 手动验证。应在 issue 中显式标注这个风险。 |
| GAP-5 | **F** | #7 说"__todoGetList 返回 undefined 时 goal 降级运行"，但未定义降级时的具体行为：budget checkProgress 跳过 progress 检查？complete action 拒绝（已有定义）？contextInjectionPrompt 不显示进度？建议在 #7 方案 A 的改动中补充：`ProgressInput = undefined` 时 budget.ts 的 checkProgress 行为（跳过 progress 相关检查，只做 token/time budget）。 |

---

## GAP 汇总

| ID | 类型 | 严重度 | 描述 | 建议修复 |
|----|------|--------|------|---------|
| GAP-1 | **F** | 高 | `/goal abort` 删除无对应 issue | 补充到 #1 或新增 issue |
| GAP-2 | **K** | 低 | #10 缺方案对比 | 补一句"为什么不需要"即可 |
| GAP-3 | **D** | 中 | #11/#12 P2 偏低 | 升 P1 或标 P2-early |
| GAP-4 | **K** | 中 | #4 行为等价验证策略缺失 | 补验证 checklist |
| GAP-5 | **F** | 中 | #7 降级行为未定义 | 补 ProgressInput=undefined 时 budget.ts 行为 |

---

## 总结

issues.md 整体质量高——12 个 issue 覆盖了架构设计的绝大部分删除项和行为变更，P0/P1 都有方案对比，优先级链基本一致。

主要缺口：
1. **GAP-1（高）**：`/goal abort` 删除被遗漏，这是架构设计 §7 删除清单和 spec FR-4 都明确要求的
2. **GAP-3（中）**：#11/#12 的 P2 标记与它们作为 P0 直接结果的定位不匹配
3. **GAP-4/5（中）**：#4 和 #7 的验收标准有模糊地带需要展开
