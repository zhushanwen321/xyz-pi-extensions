---
verdict: CHANGES_REQUESTED
reviewer: subagent (issues-review)
date: 2026-06-24
---

# Issues.md 审查报告

## 判定：CHANGES_REQUESTED

5 维审查结果：

| 维度 | 结果 | 说明 |
|---|---|---|
| 1. 内部一致性 | FAIL | HTML 与 markdown 存在 3 处硬矛盾 |
| 2. 上游对齐 | PASS | 所有架构删除项/行为变更均有 issue 覆盖 |
| 3. 可执行性 | PASS | DAG 无环，可直接编排 Wave |
| 4. 完整性 | PASS | 7/8 有方案对比，#12 理由充分 |
| 5. 可视化质量 | FAIL | HTML 有统计/分类错误，DAG 图正确 |

---

## 1. 内部一致性 — FAIL

### D1: #5 Blocked by 矛盾

| 文档 | #5 Blocked by |
|---|---|
| issues.md | `#4` |
| issues.html | `#4, #7` |
| DAG graph | `#7 --> #5` |

DAG 图与 HTML 一致（#7→#5），但 markdown 正文只写 `#4`。需统一。

**影响**：下游编排如果按 markdown 执行，会漏掉 #7 依赖，导致 Wave 编排错误。

### D2: #9 P 级标签不一致

| 文档 | #9 P 级 |
|---|---|
| issues.md 标题 | "P2 Issues（重要）" |
| issues.html badge | `badge-p2`（蓝色） |
| issues.html 位置 | P1 section 内 |
| issues.html TL;DR | "P1×8"（含 #9） |

HTML 把 #9 放在 P1 section 里，但用 P2 badge 标记。TL;DR 统计也错误地计入 P1。

### D3: HTML 导航统计错误

```html
<li><a href="#p2">P2 延后 (3)</a></li>  <!-- P2 写成 P3 内容 -->
```

- 导航说 "P2 延后 (3)" — 但 P2 只有 #9（1 个），3 个是 P3
- 缺少 `#p2` section（#9 被错误放在 P1 section）
- TL;DR："P0×4 + P1×8 + P3×3" → 应为 "P0×4 + P1×7 + P2×1 + P3×3"（共 15 项计数，但实际只有 12 issue）

---

## 2. 上游对齐 — PASS

### 覆盖矩阵

| system-architecture.md §7 删除项 | 覆盖 issue |
|---|---|
| engine/task.ts | #1 |
| adapters/tool-adapter.ts | #1 |
| adapters/actions.ts | #1 |
| command-adapter.ts::handleAbort | #1（验收标准提及） |
| GoalRuntimeState.tasks | #1 |
| GoalRuntimeState.stallCount | #6（验收标准） |
| BudgetConfig.maxTurns | #6（验收标准） |
| BudgetConfig.maxStallTurns | #6（验收标准） |

| §7 行为变更 | 覆盖 issue |
|---|---|
| handleSet 拒绝覆盖 | #11 |
| checkBudgetOnTurnEnd 只做 warning | #8 |

| §5 状态流转 | 覆盖 issue |
|---|---|
| paused 新增 + VALID_TRANSITIONS | #2 |
| 终态集合定义 | #2 |

| §10 决策 | 覆盖 issue |
|---|---|
| D-A1 拆分策略 | #4 |
| D-A3 duck-typed | #7 |
| D-A4 显式转换表 | #2 |
| D-A5 BudgetConfig 精简 | #6 |
| D23 单一检查点 | #5 |
| D25 /goal set 拒绝 | #11 |
| D21/D22 删自动终态 | #6 |
| D26/D27 plan 联动 | #9 |
| D28 stall 退化 | #6 |

全部覆盖，无遗漏。

---

## 3. 可执行性 — PASS

### Wave 编排验证

```
Wave 1: #1, #2（并行，无依赖）
Wave 2: #3（依赖 #1）, #11, #12（依赖 #2）
Wave 3: #4（依赖 #2, #3）
Wave 4: #5, #6, #7, #8（依赖 #4；#5 额外依赖 #7 如按 DAG）
Wave 5: #10（依赖 #7）, #9（依赖 #7）
```

注意：Wave 4 中 #5 与 #7 的并行关系取决于 D1 的修复结果。若 #5 确实依赖 #7，则 #5 应移到 Wave 5 或 #7 完成后执行。

每个 issue 有：
- 明确的 blocked by
- 方案选择 + 理由
- 验收标准（可 grep/typecheck 验证）

---

## 4. 完整性 — PASS

| P 级 | issue | 有方案对比 | 说明 |
|---|---|---|---|
| P0 | #1 | Yes | A vs B |
| P0 | #2 | Yes | A vs B |
| P0 | #3 | Yes | A vs B |
| P0 | #4 | Yes | A vs B + 行为等价表 |
| P1 | #5 | Yes | A vs B |
| P1 | #6 | Yes | A vs B |
| P1 | #7 | Yes | A vs B |
| P1 | #8 | Yes | A vs B |
| P1 | #10 | Yes（简） | 硬编码 vs 独立文件 |
| P1 | #11 | Yes（简） | 直接改逻辑 |
| P1 | #12 | **No** | "简单改动，不需方案对比" |
| P2 | #9 | Yes | A only（推荐） |

#12（widget paused/blocked 显示）无方案对比，但理由充分（status suffix 加两个分支，无歧义空间），不阻塞。

---

## 5. 可视化质量 — FAIL

### DAG 图 — 正确

Mermaid 语法正确，依赖关系与 issues.md 一致（#1→#3→#4, #2→#4, #4→#5/#6/#8, #7→#5/#10）。颜色分类正确（p0 红/p1 黄/p2 蓝）。

### HTML 页面问题

1. **TL;DR 统计错误**："P1×8" → 应为 "P1×7"
2. **#9 分类错误**：在 P1 section 内但用 P2 badge
3. **P2 section 缺失**：应有独立 `<section id="p2">` 包含 #9
4. **导航标签**："P2 延后 (3)" → P2 只有 1 个 issue（#9），3 个是 P3
5. **P1 卡片 #5 依赖错误**：写了 `#4, #7` 与 markdown `#4` 不一致

---

## 修复建议

### 必须修复（阻塞下游）

1. **D1**: 统一 #5 的 blocked by。建议在 issues.md 中补上 `#7`（DAG 已有此边），并说明理由（budget checkProgress 在 #7 后才有 ProgressInput）
2. **D2+D3**: 在 issues.html 中：
   - #9 移到独立 P2 section
   - TL;DR 改为 "P0×4 + P1×7 + P2×1 + P3×3"
   - 导航改为 "P2 (1)" + "P3 延后 (3)"

### 建议修复

3. P3 区分清楚：导航中 P2 和 P3 分开列出
