---
review:
  type: spec_review
  round: 3
  timestamp: "2026-05-29T00:00:00"
  target: ".xyz-harness/2026-05-28-infinite-context-engine/spec.md"
  verdict: fail
  summary: "v2 MUST FIX #4 已修复（FR-2.2 step 8 选择方案4：降级到规则 fallback，不做拆分合并），但 AC-2 的旧 checkbox 未同步更新，与 FR-2.2 step 8 矛盾。需修复后重审。"

statistics:
  total_issues: 6
  must_fix: 1
  must_fix_resolved: 1
  low: 3
  low_resolved: 0
  info: 2
  info_resolved: 0

issues:
  - id: 4
    severity: MUST_FIX
    location: "spec.md → FR-2.2 step 8"
    title: "拆分-合并策略未定义（v2 MUST FIX #4）"
    status: resolved
    raised_in_round: 2
    resolved_in_round: 3
    resolution: "FR-2.2 step 8 改为：超出 subagent 窗口时降级到规则 fallback（同 FR-2.5），不做拆分合并。理由：段概要数据量远小于 subagent 窗口，超限仅在极端场景下发生，此时规则 fallback 已足够。选择了 v2 建议的方案(4)。"
  - id: 11
    severity: MUST_FIX
    location: "spec.md → AC-2"
    title: "AC-2 checkbox 与 FR-2.2 step 8 矛盾"
    status: open
    raised_in_round: 3
    resolved_in_round: null
    resolution: null
  - id: 10
    severity: LOW
    location: "spec.md → FR-2.4 / FR-2.5"
    title: "两处降级 fallback 策略不一致"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 12
    severity: LOW
    location: "spec.md → AC-2"
    title: "AC-2 首条 checkbox 位置错误：\"每次新 user message 触发新 Segment 创建\" 属于 AC-1 段管理，放在 AC-2 树压缩中不合理"
    status: open
    raised_in_round: 3
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "spec.md → Complexity Assessment"
    title: "~1200 行估算与功能复杂度匹配"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: INFO
    location: "spec.md 全局"
    title: "未提及 GUI _render 协议兼容"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审（Spec 完整性）第 3 轮

## 评审记录

- **评审时间**: 2026-05-29 00:00
- **评审类型**: 计划评审（仅 Spec）
- **评审对象**: `.xyz-harness/2026-05-28-infinite-context-engine/spec.md`
- **方法论**: xyz-harness-expert-reviewer「模式一：计划评审」第 1 项（spec 完整性）
- **本轮任务**: 验证 v2 唯一 MUST FIX #4 是否已修复，检查新引入问题

---

## 1. v2 MUST FIX #4 修复验证

### MUST FIX #4: 拆分-合并策略未定义（FR-2.2 step 8）

**状态**: ✅ 已修复

**v2 原文（有问题的旧文本）**:
> "如果单次请求上下文超出 subagent 窗口，拆分为 2 个请求分别执行后合并结果。"

**v2 发现的未定义问题**:
1. "2" 是硬编码 magic number，不随实际上下文大小变化
2. 拆分策略未定义：按什么标准将段划分到 2 组？
3. 合并策略未定义：2 颗独立树合并时可能产生重复 segId、遗漏 segId、结构冲突

**当前 spec 文本** (FR-2.2 step 8):
> "如果单次请求上下文超出 subagent 模型窗口，降级到规则 fallback（同 FR-2.5），不执行拆分合并。MVP 阶段不做复杂的多请求拆分——段概要数据量远小于 subagent 上下文窗口，超限仅在极端场景下发生，此时规则 fallback 已足够。"

**修复方案**: 选择了 v2 建议的选项(4)——承认 N>1 拆分超出 MVP 范围，超出 subagent 窗口时降级到规则 fallback。

**修复评估**:

| 维度 | 评估 | 说明 |
|------|------|------|
| 完整性 | ✅ 完整 | 明确回答了 v2 提出的「超限怎么办」问题 |
| 合理性 | ✅ 合理 | 段概要信息（segmentIndex + userMessage + turnRange）每条几十 token，100 段也仅几千 token，低于任何 LLM 窗口。超限仅在极端情况发生，规则 fallback 兜底合理 |
| 边界清晰 | ✅ 清晰 | "MVP 阶段不做" 明确界定了范围，未来可扩展 |
| 一致性 | ❌ 有漏洞 | AC-2 checkbox 未同步更新（详见下方新 MUST FIX） |

**确认**: MUST FIX #4 的核心问题已解决。但引入了新的 AC 不一致问题。

---

## 2. 新发现的问题

### MUST FIX

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 11 | **MUST FIX** | AC-2 | **AC-2 checkbox 与 FR-2.2 step 8 矛盾**。FR-2.2 step 8 已明确改为"降级到规则 fallback，不执行拆分合并"，但 AC-2 仍保留旧 checkbox：`- [ ] 上下文超限时拆分为 2 个请求`。这是 spec 内部自相矛盾——一个地方说降级 fallback，另一个地方说拆分为 2 个请求。实现者不知道该遵守哪个。 | 将 AC-2 的该条 checkbox 改为：`- [ ] 上下文超限时降级到规则 fallback（不执行拆分合并）` |

### LOW

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 10 | LOW | FR-2.4 / FR-2.5 | **两处降级 fallback 策略不一致**（v2 遗留，未修复）。FR-2.4（校验失败 fallback）：所有段保留为独立 leaf，摘要取**第一条 assistant 消息的前 200 字**。FR-2.5（subagent 失败 fallback）：只保留**用户消息的第一句话**作为摘要，工具调用全部丢弃。两处都是"subagent 无法完成压缩"后的降级，但摘要来源和详细程度完全不同。虽然后者故意更激进（subagent 本体失败了），但实现者可能在代码复用中混淆。 | 两处对齐表述结构：FR-2.5 显式引用 FR-2.4 的 fallback 作为基准，然后说明差异（丢弃工具调用）。或统一为一种 fallback 策略，用"是否丢弃工具调用"作为参数区分两个场景。 |
| 12 | LOW | AC-2 | **AC-2 首条 checkbox 位置错误**：`- [ ] 每次新 user message 触发新 Segment 创建` 描述的是段索引管理行为，属于 AC-1（段管理）的范畴，放在 AC-2（树压缩）下不合理。 | 将其移到 AC-1 下。AC-1 已有 `- [ ] 每次新 user message 触发新 Segment 创建`，但 AC-2 第一条重复了这个条目。核实现有 AC-1 列表是否已包含，如已包含则直接从 AC-2 删除。 |

---

## 3. 未变动但已有关注

v1/v2 遗留的以下问题本评审未涉及，但仍在 open 状态：

| # | 优先级 | 说明 |
|---|--------|------|
| 8 | INFO | Complexity Assessment ~1200 行估算（观察性，无需修复） |
| 9 | INFO | GUI _render 协议兼容（已知 OOS） |

---

## 4. 总结

### 修复验证

- **v2 MUST FIX #4（拆分-合并策略未定义）** ✅ 已修复。FR-2.2 step 8 明确选择了 v2 建议的方案(4)：超出 subagent 窗口时降级到规则 fallback，不做拆分合并。理由充分（段概要数据量远小于模型窗口），边界声明清晰（MVP 阶段不做）。

### 仍存在的问题（本轮）

- **MUST FIX × 1**: AC-2 checkbox 与 FR-2.2 step 8 矛盾——AC-2 仍写着"拆分为 2 个请求"，但正文已改为"降级 fallback"。spec 内部不一致，必须修复。
- **LOW × 2**: (10) 两处降级 fallback 策略不一致（v2 遗留）；(12) AC-2 首条 checkbox 位置错误。

### 等级判定

| 规则 | 本评审 | 判定 |
|------|--------|------|
| 逻辑矛盾 | AC-2 说"拆分为 2 个请求"，FR-2.2 step 8 说"不执行拆分合并"→ **spec 内部逻辑矛盾，实现者无可适从** | ✅ MUST FIX 正确 |

### 建议优先级

1. **🔴 MUST FIX**: 修复 AC-2 checkbox 与 FR-2.2 step 8 的矛盾——将"上下文超限时拆分为 2 个请求"改为"上下文超限时降级到规则 fallback（不执行拆分合并）"
2. **🟡 LOW**: 统一 FR-2.4 / FR-2.5 降级策略描述，避免实现混淆
3. **🟡 LOW**: 将 AC-2 首条重复/错误位置的 checkbox 移到 AC-1

### 结论

**Fail — 需修改后重审**。v2 MUST FIX #4 已正确修复（FR-2.2 step 8 选择了降级 fallback 方案），但修复后 AC-2 checkbox 未同步更新，导致 spec 内部前后矛盾。修复 AC-2 后即可通过。

### Summary

Spec 完整性评审第 3 轮：v2 MUST FIX #4（拆分-合并策略未定义）已修复——FR-2.2 step 8 改为超出 subagent 窗口时降级到规则 fallback，不做拆分合并。但修复后 AC-2 的旧 checkbox 未同步更新（仍写"拆分为 2 个请求"），与 FR-2.2 step 8 产生矛盾，新增 1 条 MUST FIX。修复后即可 pass。
