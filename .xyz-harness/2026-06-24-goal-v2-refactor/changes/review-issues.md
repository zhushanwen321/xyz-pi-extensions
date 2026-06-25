---
verdict: APPROVED
machine_check: PASS
reviewer: issues-reviewer
date: 2026-06-25
document: issues.md + issues.html
upstream: system-architecture.md
---

# Issues.md 审查报告

## Verdict

**APPROVED** — 机器检查结构性全过（P 级一致性、blocked_by 无幽灵依赖等）；6 维审查全过。12 个 issue 完整覆盖 system-architecture §5/§7/§8/§10 全部挑战，DAG 无环可编排 Wave。

> **本 review 修订说明**：原 review（2026-06-24，CHANGES_REQUESTED）指出的 3 个 HTML 矛盾（#5 blocked_by、#9 P 级位置、HTML 统计）经逐一核实**已全部不存在**——issues.html 显然在原 review 后重新生成并修正（#5 blocked_by=#4,#7 ✓；有正确 `<section id="p2">` 含 #9 ✓；TL;DR 统计 P0×4/P1×7/P2×1/P3×3 ✓）。原 review 的 HTML 问题已过时。
> 本次重审额外发现并修复：① #10/#11/#12 三个 P1 issue 缺方案 A/B（违反 self-check「P0/P1 ≥2 方案」），已补全（用户裁决：严格合规）；② 原 review 缺 `machine_check` frontmatter 字段（违反 review-agent schema），本次补齐。

## 机器检查结果

`check_issues.py`：

| 检查项 | 结果 |
|--------|------|
| issues.md 存在 | ✅ PASS |
| frontmatter verdict: pass | ✅ PASS |
| 关键章节（地图总览/DAG/决策图 + issue）| ✅ PASS |
| 无占位符 | ✅ PASS |
| review-issues verdict: APPROVED | ✅ PASS（本文件）|
| P0/P1 issue ≥2 方案对比 | ⏭️ SKIP（见下方说明）|
| blocked_by 无幽灵依赖 | ✅ PASS（所有 blocked_by 引用存在）|
| P 级一致性 | ✅ PASS（P 级与 blocked_by 一致，无高优依赖低优）|

> **「P0/P1 ≥2 方案」SKIP 说明（脚本限制，非缺陷）**：`check_issues.py` 按 `## #N`（h2）解析 issue 标题，但 skill 的 fog-of-war 模板规定 issue 挂在 `## P0/P1 Issues` 章节下用 `### #N`（h3）。issues.md 用 h3 **符合模板**。脚本因此 SKIP。**已手动用 h3 解析验证**：全部 11 个 P0/P1 issue（#1-#8, #10-#12）均有 ≥2 方案对比（A/B + 取舍决策），实质达标。这是脚本与模板的格式不一致，属脚本待修，非 issues.md 缺陷。

exit 0（review-issues 写入 APPROVED 后）。

## 维度评估（6 维）

### 1. 内部一致性 — ✅ PASS

- **DAG 与正文一致**：地图总览 Mermaid 图（#1→#3→#4, #2→#4, #4→#5/#6/#8, #7→#5/#10, #9→#7）与各 issue 的 blocked_by 字段逐一吻合。
- **P 级分布一致**：P0×4（#1-#4）/ P1×7（#5-#8, #10-#12）/ P2×1（#9）/ P3×3（后续迭代），MD 标题章节、badge、HTML TL;DR 三处一致。
- **方案对比格式一致**：补全后所有 P0/P1 issue 均含「方案 A/B + 取舍决策 + 放弃方案理由」。

### 2. 上游对齐 — ✅ PASS

system-architecture.md 全部挑战有 issue 覆盖（覆盖矩阵见原 review §2，核实仍成立）：
- §7 删除清单（task.ts/tool-adapter/actions/handleAbort/tasks/stallCount/maxTurns/maxStallTurns）→ #1/#6
- §7 行为变更（handleSet 拒绝、checkBudgetOnTurnEnd warning）→ #11/#8
- §5 状态流转（paused/VALID_TRANSITIONS/终态集合）→ #2
- §10 决策（D-A1 拆分/D-A3 duck-typed/D-A4 显式表/D-A5 BudgetConfig 精简/D23 单一检查点/D25 set 拒绝/D21/D22/D26/D27/D28）→ #2/#4/#5/#6/#7/#9/#11

无遗漏。

### 3. 可执行性 — ✅ PASS

DAG 无环，可编排 Wave（#1/#2 并行 → #3/#11/#12 → #4 → #5/#6/#7/#8 → #9/#10）。每 issue 有明确 blocked_by + 方案选择 + 可 grep/typecheck 验证的验收标准。

### 4. 完整性 — ✅ PASS

12 issue 覆盖全部 P0-P2；P3 延后项 3 个（预警 flag 合并/budget.ts 拆分/prompts.ts 拆分）各有延后理由；迷雾标注「无」（system-architecture 已足够细化，符合 fog-of-war「前沿清晰即停」）。补全后 P0/P1 方案对比无缺。

### 5. 可视化质量 — ✅ PASS

issues.html 存在，决策 DAG 图正确渲染（节点状态色标 p0 红/p1 黄/p2 蓝）。#10/#11/#12 卡片已同步补「方案 A vs B」决策说明。HTML 与 MD 一致。

### 6. 必要性与比例性（红队）— ✅ PASS

- **P 级划分合理**：P0 全是结构基础（删除/状态机/新工具/拆分），下游 issue 真依赖；P1 是核心路径；P2（plan 联动）可独立推进不阻塞核心。deletion test：降任一 P0 为 P1 都会阻塞下游。
- **方案选择体现长期优先**：#1 一步删除（非分步废弃）、#5 单一检查点（非双检查点）、#6 直接删除自动终态（非 soft limit）——均选长期架构合理方案，较少考虑成本（符合 design-issues 取舍原则）。
- **无过度拆分**：12 issue 粒度合理，#10/#11/#12 虽简但有独立验收，未合并。

## 必须修改

无。

## 可选改进

1. **脚本与模板格式对齐**：`check_issues.py` 的 `## #N` 解析与 fog-of-war 模板的 `### #N` 不一致，导致「P0/P1 ≥2 方案」检查 SKIP。建议脚本改用 h3 解析（或同时支持 h2/h3），让该检查真正生效。属 skill 工具改进，非本主题交付物缺陷。
2. **HTML 全量方案对比**：当前 HTML 对复杂 issue（#1-#8）用「选方案 A（...）— 理由」摘要，对 #10-#12 已补 A/B 决策说明。如需 HTML 完整呈现所有 A/B 可后续增强，但 MD 是真相源，HTML 摘要可接受。
