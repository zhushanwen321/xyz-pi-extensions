---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-30T22:00:00"
  target: ".xyz-harness/2026-05-30-progressive-tree-compaction/spec.md"
  verdict: pass
  summary: "Spec 评审完成，第1轮通过，0条MUST FIX，3条LOW，2条INFO"

statistics:
  total_issues: 5
  must_fix: 0
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: LOW
    location: "spec.md > FR-6 触发流程"
    title: "needsCompressionRef 生命周期不完整"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "spec.md > FR-2 预估公式"
    title: "旧树大小(tokenCount) 来源未明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "spec.md > AC 覆盖"
    title: "FR-6 触发时机缺少负向验收标准"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: INFO
    location: "spec.md > AC-5"
    title: "偏差容许范围 ±20pp 较宽，建议说明设计意图"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "spec.md > FR-3/FR-4"
    title: "树宽度长期增长无上限讨论"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-30 22:00
- 评审类型：计划评审（Spec 完整性专项）
- 评审对象：`.xyz-harness/2026-05-30-progressive-tree-compaction/spec.md`

## 评审方法

按 xyz-harness-expert-reviewer 的「计划评审」检查维度第 1 项 **spec 完整性**逐项审查：
- 目标明确性
- 范围合理性
- 验收标准可量化
- `[待决议]` 项风险评估
- FR 内部一致性
- AC 对 FR 的覆盖矩阵

## 逐项审查结果

### 1. 目标明确性 — ✅ 通过

> "将 Tree Compactor 改造为渐进式压缩引擎：每次只压缩最老的一批段，按目标压缩比（20-50%）动态计算压缩范围，产出追加到现有树上，树深度不增长。"

一句话清晰描述了做什么（渐进式压缩）、怎么做（动态范围 + 追加式树）、约束（深度不增长）。三个痛点（压缩比不可控、无分层意识、保留窗口固定）与方案一一对应。

### 2. 范围合理性 — ✅ 通过

- **不过大**：4 个源文件修改，7 个 FR，5 个 AC。单 extension 模块内部改造。
- **不过小**：覆盖了从触发时机到压缩输出到上下文注入的完整链路。
- **有明确边界**：Constraints C-1 ~ C-4 明确了不做什么（阻塞主对话、精确预估、破坏向后兼容）。
- Complexity Assessment 标注了 Risk: Medium 和验证方式（真实 session 数据），合理。

### 3. 验收标准可量化 — ✅ 通过（附建议）

| AC | 可量化 | 判定值 |
|----|--------|--------|
| AC-1 | ✅ | 50-70%→8段, 80-90%→2段, >90%→1段 |
| AC-2 | ✅ | 比例 <20% 继续累加, 20-50% 停止, 全累加完未达标则提交 |
| AC-3 | ✅ | group 数量完整, summary 未修改, 深度 == 2 |
| AC-4 | ✅ | leaf 摘要数 == 已压缩段数, 不含 seg_N.json |
| AC-5 | ✅ | ±20pp 偏差, 单次输出 ≥ 200 tokens |

所有 AC 都可以写测试验证，无"提升用户体验"类模糊描述。

### 4. 待决议项 — ✅ 无

无 `[待决议]` 标记。所有设计决策已确认。

### 5. FR 内部一致性 — ✅ 通过

| FR | 输入 | 输出 | 下游消费者 |
|----|------|------|-----------|
| FR-6 触发时机 | turn_end + context usage | 触发信号 | → FR-1 |
| FR-1 保留窗口 | context usage % | 保留段列表 | → FR-2 |
| FR-2 压缩范围 | 保留段列表 + 旧树大小 | 待压缩段集合 | → FR-3/FR-5 |
| FR-3 树结构 | LLM 压缩输出 | 追加后的树 | → FR-4 |
| FR-4 上下文注入 | 完整树结构 | 注入 messages | 主对话 LLM |
| FR-5 提示词 | 待压缩段 + 旧树 group 列表 | LLM prompt | LLM 压缩调用 |
| FR-7 失败处理 | 异常 | 重试/fallback | 依赖已有逻辑 |

数据流向清晰，无断裂或循环依赖。

### 6. AC 覆盖矩阵

| FR | AC 覆盖 | 说明 |
|----|---------|------|
| FR-1 保留窗口 | AC-1 | ✅ 直接覆盖，含 3 个阈值 + 活跃段保护 |
| FR-2 压缩范围 | AC-2, AC-5 | ✅ AC-2 覆盖范围逻辑，AC-5 覆盖压缩比稳定性 |
| FR-3 树结构 | AC-3 | ✅ 直接覆盖，3 个子判定 |
| FR-4 上下文注入 | AC-4 | ✅ 直接覆盖，含 leaf 计数 + 排除原始内容 |
| FR-5 提示词 | 间接 (AC-3, AC-5) | ⚠️ 无直接 AC，见 Issue #3 |
| FR-6 触发时机 | 隐式 (AC-1) | ⚠️ 无负向 AC，见 Issue #3 |
| FR-7 失败处理 | 无 | 可接受，依赖已有逻辑无新增行为 |

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | LOW | spec.md > FR-6 | **needsCompressionRef 生命周期不完整** — 触发流程中检查了 `needsCompressionRef.value` 但未说明该 ref 何时被置为 true、何时被重置为 false。流程图的条件分支层级也不够清晰（`≥ 50% → 检查 ref` 和 `已有树且 isCompressing → 跳过` 是并列还是嵌套？）。 | 补充一句说明 ref 的置位/复位时机，或将流程图改为 if-else 伪代码消除层级歧义。例如：`if (usage ≥ 50% && !isCompressing) { trigger }` |
| 2 | LOW | spec.md > FR-2 | **旧树大小(tokenCount) 来源未明确** — 预估公式中 "旧树大小(tokenCount)" 出现但未说明这个值如何获取。是从树节点数量 × 固定 token/节点估算？还是运行时从 context usage API 读取？Complexity Assessment 提到 `segment-tracker.ts` 新增 `getTokenCounts()` 方法，但 FR 正文未引用。 | 在 FR-2 中补充一句来源说明，例如："旧树大小由 segment-tracker 的 getTokenCounts() 提供，基于树的 group/leaf 节点数量 × 固定 token 估算值计算"。 |
| 3 | LOW | spec.md > AC 覆盖 | **FR-6 触发时机缺少负向验收标准** — FR-6 定义了"上下文 < 50% 不触发"的行为，但没有对应的 AC 来验证这个负向场景。现有 AC-1 只测"给定某占用率，保留 N 段"（隐含压缩已触发），未验证"不触发"场景。同样，FR-5 的提示词变更（添加旧树 group 列表）无直接 AC 验证其存在性。 | 考虑在 AC 中增加一条："上下文占用 < 50% 时不触发压缩，树结构无变化"。FR-5 的 AC 覆盖通过 AC-3（旧 group 未修改）和 AC-5（压缩比稳定）间接验证，可接受。 |
| 4 | INFO | spec.md > AC-5 | **偏差容许范围 ±20pp 较宽** — 目标区间 20-50%，偏差 ±20pp 意味着实际比例可以在 0-70% 范围内。这使 AC-5 很容易通过。 | 可能是有意设计（C-4 说了预估允许误差、后续自动修正），建议在 AC-5 处加一句注释说明设计意图，避免后续读者误认为是遗漏。 |
| 5 | INFO | spec.md > FR-3/FR-4 | **树宽度长期增长无上限讨论** — FR-3 保证深度固定为 2，但 group 数量随压缩次数线性增长。spec 给了 5 个 group 的示例（~1063 tokens），未讨论 50+ 次压缩后的规模（~5000+ tokens）。 | 当前 scope 内无需处理（每个 group 仅 ~25 tokens），但可作为未来优化的已知边界。建议在 Constraints 或 Complexity Assessment 中加一条 note。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### 结论

**通过。** Spec 完整性良好：目标清晰、范围合理、验收标准可量化、无待决议项、FR 间数据流一致。5 条 LOW/INFO 级建议可在实现阶段酌情处理，不阻塞 plan 编写。

### Summary

Spec 评审完成，第1轮通过，0条MUST FIX，3条LOW（触发流程细节、预估公式数据源、AC 负向覆盖），2条INFO（偏差范围意图、树宽度长期增长）。
