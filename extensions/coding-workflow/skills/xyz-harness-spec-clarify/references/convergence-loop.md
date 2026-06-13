# Round 2+: 收敛循环

收敛循环在「模型构建 → 场景追踪 → gap 发现 → gap 解决」之间循环，直到追踪不再产生新 gap。

**步骤编号说明：** Round 1 是 Step 1-5（见 foundation-round.md）。Round 2+ 从 Step 6 开始连续编号，与 Round 1 不重叠。

**两层循环结构：** 收敛循环包含两层嵌套的循环，必须区分清楚：

- **外层循环（跨轮）**：Step 6 → 7 → [内层] → 10。外层每走一遍 = 一轮模型迭代（model_version +1）。
- **内层循环（单轮内）**：Step 8 → 9 → 8 → 9 …。在当前轮内解决所有 gap，包括用户回答触发的新 gap，直到当前轮追踪出的 gap 全部 resolved。只有内层清空后，才进入 Step 10 判断是否需要开新一轮。

```
═══ 外层循环（每轮 = 一次模型迭代，model_version +1）═══
Step 6: Build/Update Model    → 结构化模型
Step 7: 5-Perspective Tracing → 5 视角枚举所有场景 + 分支
  ┌─ 内层循环（单轮内，直到本轮 gap 全部 resolved）──────┐
  │ Step 8: Gap Discovery  → 从追踪卡住点提取 gap           │
  │ Step 9: Gap Resolution → 解决 gap（用户回答可能触发新 gap）│
  │   └ 新 gap? → 回 Step 8 继续（不开新一轮）              │
  └─────────────────────────────────────────────────────┘
Step 10: Convergence Check    → 收敛 → 进入 Step 11; 未收敛 → 回 Step 6
═══ 外层循环结束 ═══
```

**为什么分两层：** Step 9 解决一个 gap 时，用户回答或代码扫描结果经常暴露新的 gap（典型：「支付失败后退款」→「退款的金额计算规则？」）。这些新 gap 属于**同一追踪上下文**，应该就地解决而不是塞到下一轮重新建模。只有当模型本身需要结构性更新（新增实体、改状态机）时，才回 Step 6 开新一轮。

## Step 6: Build/Update Model

创建/更新结构化模型文件 `clarification.md`。模型是 spec 的骨架，所有后续追踪基于此模型。

模型结构、五个维度、构建与更新规则详见 `clarification-model.md`。

**Decomposition Map 与 Deferred 维护：**
- Round 2 首次构建模型时，Round 1 产出的 Decomposition Map 已在文件开头，不需重建
- 追踪过程中发现新的方面（原 Map 未覆盖）→ 追加到 Decomposition Map，标注清晰度
- Defer-Ext 项在追踪中**浅追踪**（记录存在性 + 扩展点要求，不深入细节），确保 plan 阶段有设计依据
- 每轮更新时同步 Deferred Items 章节（新增 / 状态变更）

## Step 7: 5-Perspective Scenario Tracing

[MANDATORY] 这是核心遗漏发现机制。每个视角强制枚举所有操作，沿路径追踪，在卡住的地方标记 gap。

追踪规则、视角适用性降级、Deferred 项处理、五个视角的完整追踪模板详见 `scenario-tracing.md`。

## Step 8: Gap Discovery & Classification

**[内层循环开始点]** 从 Step 7 的追踪（或 Step 9 回流的新 gap）中提取所有 `[GAP]` 标记，分类并记录到 Gap Tracker。

Gap 分类（F/K/D）、优先级（P0/P1/P2）、Tracker 格式、卡住信号、密度指标详见 `gap-management.md`。

提取完进入 Step 9 解决。解决过程中产生的新 gap 会回流到这里继续提取。

## Step 9: Gap Resolution

**[内层循环主体]** 按优先级从高到低解决 gap。

F/K/D 三类的解决方式详见 `gap-management.md` 的「Gap 解决」章节。

**单轮内循环规则：** 解决一个 gap 后，检查是否触发新 gap（用户回答 / 代码扫描结果暴露新问题）。如果触发新 gap，**不开新一轮**，而是回流到 Step 8 继续提取并解决——这构成内层循环（Step 8↔9）。只有当本轮所有 gap（包括回流产生的）都 resolved 后，才进入 Step 10 做收敛判断。

**回流 gap 的处理：** 回流的新 gap 直接进入当前轮的 Gap Tracker，优先级沿用 P0/P1/P2 规则。它们不需要重新触发 Step 7 的 5 视角追踪——追踪是为了发现 gap，回流 gap 已经是明确的 gap。

## Step 10: Convergence Check

**[外层循环判断点]** 只有内层循环清空后（本轮 Step 8-9 无 open gap）才执行收敛判断。

[MANDATORY] **收敛条件（全部满足）：**

1. 5 个视角的场景追踪全部完成（每个视角至少覆盖了所有核心操作）
2. Gap Tracker 中无 `status: open` 的 P0/P1 gap
3. 最近一轮没有发现新的 P0/P1 gap
4. 模型版本号 ≥ 2（至少经过一轮迭代）

**未收敛 → 回 Step 6**，更新模型后重新追踪。重新追踪时：
- 只追踪**本轮新增或修改**的路径
- 已追踪且无变化的路径跳过（记录"与前一轮一致"）

**Stagnation 保底：** 连续 3 轮 gap 数量不降（新发现的 ≥ 已解决的），强制收敛。未解决的 gap 标记为 `[UNRESOLVED]`，在 spec 中标注并交给 review 阶段处理。Stagnation 原因分析见 `gap-management.md`。

---

## NEEDS_USER：gate 退回后的局部澄清

当自动化阶段的 review-loop 发现需要用户决策的问题（如「支付失败后应退款还是重试？」），会返回 NEEDS_CLARIFICATION。此时**不重开整个收敛循环**，而是做局部澄清：

**轻量澄清流程：**
1. 读取退回的 gap-analysis / sufficiency 维度报告，定位具体问题
2. 针对每个待澄清项，用 `ask_user` 问一个具体问题（不是重新走 Round 1）
3. 用户回答后，更新 clarification.md 对应维度 + Gap Tracker
4. 重新调用 `coding-workflow-gate(phase=1)`——已通过的维度不重跑（增量收敛）

**与 Round 2+ 的区别：** Round 2+ 是完整的「模型构建 → 5 视角追踪 → gap 解决」循环，用于 AI 主动发现遗漏。NEEDS_USER 是针对 gate 发现的**特定问题**做局部澄清，用户体验是简短 Q&A（1-3 个问题），不是重新开始。

**触发条件：** 只有 `mayNeedUser=true` 的维度（gap-analysis、sufficiency）可以触发 NEEDS_USER。其他维度（真实性、一致性、形式合规）不会中断用户。

**何时升级为完整 Round 2+（不走 NEEDS_USER 局部澄清）：**

NEEDS_USER 假设 gate 退回的 gap 是「补充答案」性质的——问 1-3 个问题就能解决。但有些 gap 暴露的是全新结构性遗漏，局部澄清不够。升级判定标准（满足任一即升级）：

1. **新实体/新状态机**：gate 发现的 gap 涉及 clarification.md 五维度中未建模的实体或状态转换（例如「缺失退款实体」而模型里根本没有退款）
2. **新视角覆盖**：gate 发现的 gap 暴露某个视角整个没追踪过（例如 gap-analysis 发现「失败路径完全没追踪」而非「某个失败分支漏了」）
3. **gap 数量超阈值**：gate 一次退回 ≥4 个相互关联的 gap（说明不是个别遗漏，是某个领域整体没想透）
4. **跨维度关联**：退回的 gap 同时影响多个维度（既是 gap-analysis 又是 sufficiency 退回，且指向同一模型缺陷）

升级后的流程：回 Step 6 重建受影响维度的模型 → 重新追踪相关视角。**不是全局重开**——只重建 gate 指出的缺陷领域，其他已收敛部分保留。

不满足以上任一条件的 gap 走标准 NEEDS_USER 局部澄清。

---

## Step 11: Spec Generation（退出）

从验证后的模型生成 `spec.md`。

**生成规则：**
1. 模型的 Entity 部分 → spec 的数据模型章节
2. 模型的 Operation 部分 → spec 的功能需求章节
3. 模型的 State Machine → spec 的行为约束章节
4. 模型的 Constraint → spec 的约束章节
5. 场景追踪的 Main Path → spec 的业务用例
6. Gap Tracker 的已解决 Decision → spec 的决策记录
7. Gap Tracker 的 UNRESOLVED → spec 中标记 `[AMBIGUOUS]`
8. Deferred Items 章节 → spec 的 "Deferred / 扩展点" 章节（原样复制，约束 plan 阶段设计扩展点）

**spec.md 必须包含 YAML frontmatter：**

```yaml
---
verdict: pass
clarification_rounds: {N}
clarification_model_version: {V}
complexity: {L0/L1/L2}
total_gaps_found: {N}
gaps_resolved: {N}
# 以下仅 L1/L2 子系统 spec 需要
parent:
  topic_dir: {相对路径}
  spec: {父 spec 路径}
  manifest: {manifest 路径}
contract_section: {api-contracts.md 中的锡点}  # 子系统 spec 专用
---
```

L0 单 spec 不需要 parent/children/contract_section 字段。L1/L2 系统级 spec 额外需要 `children` 列表（见 phase spec FR-SC3）。

生成后调用 `coding-workflow-gate(phase=1)`（gate 内部执行 gap-analysis/review-loop/retrospect，由 orchestrator 管理，本 skill 不关心 gate 内部实现）。

### gap-analysis 维度的完整性 checklist

自动化阶段的 gap-analysis 维度会独立验证 clarification.md 模型完整性。skill 在生成 spec 前可自检以下点，减少 gate 退回：

- [ ] Decomposition Map 中所有 Must-Now 项已转为 clear（或标记为 UNRESOLVED 并记录原因）
- [ ] 5 个视角的场景追踪全部完成（不适用视角已记录降级理由，见 scenario-tracing.md）
- [ ] Gap Tracker 中无 P0/P1 open gap（P2 可 defer）
- [ ] 所有 `[UNVERIFIED]` assumption 已验证或标记为风险
- [ ] Deferred Items 每项都有明确的扩展点要求描述

**gap 流转规则（skill 自查 vs gate 独立复核）：**

skill 内 Round 2+ 的 Gap Tracker 与 gate 的 gap-analysis 维度检查的是**同一套 gap**，但职责不同，不是重复劳动：

| | skill 收敛循环（Round 2+） | gate D0 gap-analysis 维度 |
|---|---|---|
| **定位** | AI 自查 | 独立复核 |
| **执行者** | 主 agent（带着完整对话上下文） | 独立 subagent（只读 clarification.md + 源码） |
| **优势** | 有讨论上下文，理解意图 | 无确认偏误，从零审视模型 |
| **作用** | 主动发现尽可能多的 gap，迭代收敛 | 校验 skill 是否真的收敛，兼底 |

如果 gate 仍发现新 gap，说明 skill 收敛循环有盲点（典型：主 agent 对自己构建的模型有确认偏误，或某个视角追踪不够深入）。此时走 NEEDS_USER 局部澄清或升级为完整 Round 2+（见上文升级判定），不是重开整个收敛循环。
