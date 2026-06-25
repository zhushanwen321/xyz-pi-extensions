---
verdict: APPROVED
machine_check: PASS
note: >
  2026-06-25 schema 复审 + 补全：加 machine_check 字段（同 ①②③④⑤模式）。
  本次补全了 MANDATORY 的「测试验收清单」章节（37 用例 = ⑤test-matrix 全量，按 Wave 归属）+
  Wave 7 验收 Wave（blocked_by Wave 1-6，闭环闸门）+ changes/consistency-final.md（Step 6c 总闸门，verdict: CONSISTENT）。
  check_execution.py 现已 8/8 PASS。原 5 维 APPROVED 结论仍成立。
---

# 执行计划审查

## Verdict
**APPROVED** — 5 维均过。计划内部自洽、上游全对齐（12 issue 全覆盖、依赖闭合、NFR F2 落点正确）、可执行（D1 切分保证每 Wave typecheck 可达）、可视化清晰。关键事实声明已逐一对现状源码验证无误。仅有 cosmetic 级建议，不阻挠交接。

## 维度评估

### 1. 内部一致性 ✅

**DAG 图 ↔ 调度表 ↔ Wave 详情 ↔ 决策记录** 四处自洽：
- DAG 边 `W1→W2→W3→W4, W4→W5, W4→W6` 与调度表 6 行的 Blocked by 列完全一致
- 每个 Wave 详情的「并行关系」与调度表「Wave 内部」列一致（W1 串行、W2 并行、W3 单、W4 串行、W5 串行、W6 串行；W5∥W6 跨 Wave）
- 决策记录 D0-D3 与 Wave 详情交叉引用准确：
  - D1（#2 收窄/#6 扩大）→ Wave 1 #2 验收明确「不含字段删除」+ Wave 4 #6 验收含「12 文件使用点全清」✅
  - D0（checkProgress 三阶段）→ Wave 1 #1 文件影响含「checkProgress 函数体清理…暂置默认值」+ Wave 4 #7「改签名接收 ProgressInput」✅
  - D2（4 函数归 agent-end.ts）→ Wave 4 #6 文件影响列 `event-handlers/agent-end.ts` ✅
  - D3（与 code-architecture §6 差异）→ Wave 划分以本计划为准 ✅

**验收标准与文件影响一致**：每个 Wave 的验收 checklist 覆盖该 Wave 声明的文件改动点（grep 命令、typecheck、行为等价点、LOC 上限）。

### 2. 上游对齐 ✅

**12 issue 全覆盖，无遗漏**：
| Issue | Wave | blocked_by (issues.md) | Wave 内位置满足? |
|-------|------|------------------------|------------------|
| #1 | 1 | 无 | ✅ |
| #2 | 1 | 无 | ✅ |
| #3 | 2 | #1 (W1) | ✅ |
| #4 | 3 | #2,#3 (W1,W2) | ✅ |
| #5 | 5 | #4,#7 (W3,W4) | ✅ |
| #6 | 4 | #4 (W3) | ✅ |
| #7 | 4 | #1 (W1) | ✅ |
| #8 | 5 | #4 (W3) | ✅ |
| #9 | 6 | #7 (W4) | ✅ |
| #10 | 6 | #7 (W4) | ✅ |
| #11 | 2 | #2 (W1) | ✅ |
| #12 | 2 | #2 (W1) | ✅ |

依赖闭包完全满足，无 issue 被放到其依赖之前的 Wave。

**文件级依赖精度补充（Wave 4 callout）**：issues.md #7 只标 blocked_by #1，但实际还依赖 #3（goal-control-adapter.ts 由 #3 创建）和 #4（before-agent-start.ts 由 #4 拆出）。计划显式 callout 说明 Wave 编排已覆盖（#3 W2 / #4 W3 先于 #7 W4）。这是优于 issues.md 的精度提升。✅

**NFR F2 落点正确**：budget 终态检查在 `persistAndUpdate`（事件路径）。Wave 5 #5 文件影响明确写「修改 service.ts persistAndUpdate: 加 budget 终态直比较」+ callout 重申架构事实。已对照 non-functional-design.md #5「事务边界」段确认一致。✅

**D3 修正 code-architecture §6 的真实错误**：§6 把 #5（blocked_by #7）与 #7 同放 Wave 4，违反依赖。本计划拆为 #7 W4 / #5 W5，并通过依赖闭合追踪验证。这是实质修正，非 cosmetic。✅

**源码取证验证（关键事实声明逐一核对）**：
- 「12 文件 54 处」stallCount/maxTurns 使用点 → 实测 12 个非测试源文件、54 处 ✅
- event-adapter.ts 737 行 → 实测 737 ✅
- checkProgress 在 budget.ts line 159 → 实测 line 159 ✅
- 4 函数（handleStallAndContinuation/handleAllTasksDone/handleNoTasksOrMaxTurns/handleMaxTurnsReached）调用链在 agent_end 主流程（line 454 调用、587-690 定义）→ 实测 line 454/568/572/576 调用、587/631/663/690 定义 ✅
- NFR #7 声明「todo 未导出 __todoGetList」→ grep 零命中 ✅

### 3. 可执行性 ✅

**subagent 配置完整**：每个 Wave 的 Subagent 配置表含 Agent / 注入上下文 / 读取文件 / 修改创建四项。注入上下文精确到章节号（spec UC-x、issues #x、code-architecture §x、clarification Dx），fresh subagent 拿到即可定位。

**验收可测试**：
- grep 命令具体（`grep -rn "GoalTask|create_tasks|..."`、`grep -rn "stallCount|maxTurns|..."`）✅
- typecheck 命令统一（`pnpm --filter @zhushanwen/pi-goal typecheck`）✅
- Wave 3 行为等价 checklist（6 handler 关键行为点表）可逐项手动验证 ✅
- Wave 6 LOC 上限检查（prompts.ts ≤ 400）可量化 ✅

**D1 切分使每 Wave typecheck 可达**：核心正确性。#2 只加状态不删字段 → Wave 1 末 stallCount/maxTurns 字段仍在但编译通过；#6 在 Wave 4 一次性删字段+使用点+控制流 → Wave 4 末彻底清除。中间 Wave 2/3 不会被「字段已删但使用点未清」卡红区。已逻辑验证。✅

**Wave 2 并行安全性**：#3（goal-control-adapter.ts + index.ts）/ #11（command-adapter.ts）/ #12（widget.ts）文件不交集 → 实测确认无重叠 ✅

**Wave 5 ∥ Wave 6 文件不交集**：Wave 5 改 agent-end.ts/service.ts/command-adapter.ts；Wave 6 改 prompts.ts/before-agent-start.ts/index.ts/extensions/plan/ → 实测确认无重叠 ✅

### 4. 完整性 ✅

**覆盖完整**：
- P3 延后项：4 项列出（预警 flag 合并 / budget.ts 拆分 / prompts.ts 拆分 / 多 session），含延后理由，且 prompts.ts 项注明「Wave 6 破 400 则提前触发」的激活条件 ✅
- Prefactor Wave 评估：明确结论「不需要」+ 3 条理由 ✅
- 执行顺序强制约束：DAG 不可跳过，明确写出 `W1→W2→W3→W4→(W5∥W6)` ✅
- 每 Wave 完成后的三步闭环（typecheck / 验收 checklist / commit）✅

**决策记录覆盖追踪 gap**：D0(gap8) / D1(gap1+gap7) / D2(gap2) / D3(gap5) 四项均实质。gap 3/4/6 未在决策记录出现——无追踪源可查证，但已记录的 4 项决策均直接修正了真实的范围/归属/依赖问题，不影响交接。

**Watch 项有监控指令**：Wave 6 prompts.ts LOC 风险（code-architecture §6 已标 Watch）在 Wave 6 详情重复提醒「执行时监控，超限则拆分」，验收标准含 LOC 检查 ✅

### 5. 可视化质量 ✅

**Mermaid DAG 正确**：
- 6 节点（W1-W6）✅
- 依赖边：W1→W2→W3→W4，W4→W5，W4→W6（5 条，与 md 一致）✅
- 并行组高亮：classDef parallel 应用于 W2/W5/W6（W2 内部并行、W5∥W6 跨 Wave 并行；W4 内部串行故不高亮）✅
- legend 说明高亮语义准确 ✅
- mermaid 语法合法（`graph LR` + 节点定义 + 链式边 + classDef + class）✅

**结构清晰可读**：
- TL;DR hero 卡片（5 条要点）+ TOC（11 个锚点）+ 6 个 Wave 卡片（统一 wave-tag 标识）✅
- 调度表 / 并行约束 / Prefactor 评估 / 依赖推导依据 分块清晰 ✅
- 决策记录：D1/D0 标「⭐ 关键决策」红色高亮，D2/D3 普通蓝 ✅
- callout 分级（ok/warn/key）语义正确 ✅

**无死链/空章节/占位符**：所有 TOC 锚点对应 section id 存在；P3 表格 4 行有内容；执行交接两种方式均有说明。✅

## 必须修改
无。

## 可选改进

1. **并行组命名跳号（A→C，缺 B）**：调度表 Wave 2 标「并行组 A」、Wave 5/6 标「并行组 C」。推测是早期草案遗留。不影响执行（Wave 5/6 同组表示彼此并行，语义正确），但读起来会疑惑「B 去哪了」。建议统一为 A（Wave 2）/ B（Wave 5∥6），或直接用描述性命名（如「Wave 内并行」「跨 Wave 并行」）。

2. **subagent 文件数超标提示**：Wave 1 #1（改 ~10 文件）和 Wave 4 #6（改 12 文件）超出项目 CLAUDE.md 的 subagent「≤5 文件 / 3000 行」 guideline。计划已说明这是 TS 强类型约束下的原子删除（删字段定义必须同步删全部使用点），无法拆分而不破 typecheck——理由成立。但建议在 Wave 1/Wave 4 详情加一句显式风险提示：「此 issue 改动文件数超 guideline，因 TS 字段删除的原子性约束不可拆分；执行时若 subagent 上下文吃紧，可考虑分文件批次提交（仍保持单 typecheck 闭环）」。当前仅 #1 注明了「全量清理非局部改动」，#6 未注明。

3. **跨扩展改动版本协调提示（Wave 6 #9）**：#9 改 `extensions/plan/`（暴露 `pi.__planStart`）和 todo（#7 改 `extensions/todo/`）。这是跨 extension 改动，涉及各自 changeset/version bump。issues.md 已定义此为 issue 范围，计划无需重述，但执行交接段加一句「Wave 4 #7 / Wave 6 #9 涉及 todo/plan extension 改动，需同步各自 changeset」会更稳。

以上三项均为 cosmetic/防御性建议，不构成阻挠理由。计划已达可交接质量。
