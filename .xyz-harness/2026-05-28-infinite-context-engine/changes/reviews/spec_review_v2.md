---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-29T00:00:00"
  target: ".xyz-harness/2026-05-28-infinite-context-engine/spec.md"
  verdict: fail
  summary: "Spec 完整性评审完成，第2轮。v1 的 3 条 MUST FIX 全部修复通过，但发现 1 条新的 MUST FIX（拆分-合并策略未定义可能导致数据丢失），需修复后重审"

statistics:
  total_issues: 9
  must_fix: 4
  must_fix_resolved: 3
  low: 3
  low_resolved: 3
  info: 2
  info_resolved: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md → FR-2.6"
    title: "turn_end 同步阻塞与无缝执行矛盾"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "FR-2.2 step 5 改为 `child_process.spawn`（异步）启动独立 Pi 子进程，FR-2.6 明确为异步子进程方式启动，不阻塞事件循环"
  - id: 2
    severity: MUST_FIX
    location: "spec.md → FR-1.3 / FR-4.3"
    title: "原始段数据存储路径机制不明确"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "FR-1.3 新增 3 项 bullet 明确 session entries（元数据：段索引+TurnIndex+树压缩结果）与文件系统（原始 messages）的职责分工"
  - id: 3
    severity: MUST_FIX
    location: "spec.md → FR-2.1 / FR-2.6"
    title: "压缩执行期间递归触发保护缺失"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "FR-1.5 新增 `isCompressing` 并发压缩守卫，turn_end 和 context handler 均检查该标志"
  - id: 4
    severity: MUST_FIX
    location: "spec.md → FR-2.2 step 8"
    title: "上下文超限拆分-合并策略未定义"
    status: open
    raised_in_round: 2
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md → Background"
    title: "缺少简洁独立的 Objective 小节"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "新增 `## Objective` 独立小节"
  - id: 6
    severity: LOW
    location: "spec.md → FR-2.3"
    title: "\"内联摘要\" 术语未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "leaf 节点不再依赖外部来源的\"内联摘要\"，改为 LLM 在树输出中直接提供 summary 字段"
  - id: 7
    severity: LOW
    location: "spec.md → FR-3.2"
    title: "CustomMessage 类型未定义"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "明确为 Pi 内置 CustomMessage，role: 'custom'，customType: 'ic-summary'"
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
  - id: 10
    severity: LOW
    location: "spec.md → FR-2.4 / FR-2.5"
    title: "两处降级 fallback 策略不一致"
    status: open
    raised_in_round: 2
    resolved_in_round: null

---

# 计划评审（Spec 完整性）第 2 轮

## 评审记录

- **评审时间**: 2026-05-29 00:00
- **评审类型**: 计划评审（仅 Spec）
- **评审对象**: `.xyz-harness/2026-05-28-infinite-context-engine/spec.md`
- **方法论**: xyz-harness-expert-reviewer「模式一：计划评审」第 1 项（spec 完整性）
- **本轮任务**: 验证 v1 3 条 MUST FIX 是否修复，检查新增问题

---

## 1. v1 MUST FIX 修复验证

### MUST FIX #1: turn_end 同步阻塞与"不停止对话"矛盾

**状态**: ✅ 已修复

**验证**:
- FR-2.2 step 5: 明确改为"通过 `child_process.spawn`（异步）启动独立 Pi 子进程，传入所有历史段的概要信息"
- FR-2.6: 重写为"压缩在 `turn_end` handler 中以异步子进程方式启动（不阻塞事件循环）"
- 不再使用"同步执行"或类似措辞，整个段描述统一了异步模型

**修复质量**: 高。异步子进程方案符合 CLAUDE.md 中 subagent 扩展使用 `child_process.spawn` 的例外约束。`isCompressing` 守卫确保压缩期间不发生并发。

**确认**: 修复彻底，无残留矛盾。

---

### MUST FIX #2: 原始段数据存储路径机制不明确

**状态**: ✅ 已修复

**验证**:
- FR-1.3 新增 3 项 bullet 的表格，明确分层：
  1. **Session entries (JSONL)**: 段索引 + TurnIndex 映射 + 树压缩结果
  2. **文件系统 (`.pi/infinite-context/`)**: 段原始完整 messages
  3. **生命周期**: MVP 不实现自动 GC（Out of Scope 已声明）
- FR-4.3 同步更新：recall content 从 entries + 文件读取

**修复质量**: 高。职责分割清晰，无歧义。`Out of Scope` 声明了自动 GC 不在范围内，边界明确。

**确认**: 修复彻底。

---

### MUST FIX #3: 压缩递归触发保护缺失

**状态**: ✅ 已修复

**验证**:
- 新增 **FR-1.5 并发压缩守卫** 节，包含：
  - `isCompressing` 布尔标志（闭包变量）
  - `turn_end` 触发压缩前检查，为 true 则跳过
  - 压缩完成（成功或失败/超时）后重置为 false
  - `context` handler 检查 isCompressing，为 true 则不设置 `needsCompression` 标志
- FR-2.2 step 1 显式引用 isCompressing 检查

**修复质量**: 高。三层防护（turn_end skip + context handler skip + 压缩完成后重置），覆盖完整压缩生命周期。

**确认**: 修复彻底。

---

## 2. v1 LOW 修复验证

| # | 问题 | 状态 | 说明 |
|---|------|------|------|
| 4 | 缺少 Objective 小节 | ✅ 已修复 | 新增 `## Objective` 独立小节："构建一个 Pi 扩展，通过 LLM 驱动的树结构上下文压缩，使 AI coding agent 永远不会触达上下文窗口上限…" |
| 5 | "内联摘要"未定义 | ✅ 已修复 | FR-2.3 leaf 改为 "leaf 必须有 `summary` 字段（由 LLM 在树输出中直接提供，不依赖外部来源）"，消除了未定义术语 |
| 6 | CustomMessage 类型未定义 | ✅ 已修复 | FR-3.2 补充 "Pi 内置 agent message 类型，`role: "custom"`，`customType: "ic-summary"`" |

---

## 3. 新发现的问题

### MUST FIX

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 4 | **MUST FIX** | FR-2.2 step 8 | **拆分-合并策略未定义，可能导致数据丢失**。原文："如果单次请求上下文超出 subagent 窗口，拆分为 2 个请求分别执行后合并结果。" 存在以下未定义点：(1) "2" 是硬编码 magic number，不随实际上下文大小变化——若上下文超出窗口 5 倍，2 次拆分仍不够；(2) 拆分策略未定义：按什么标准将段划分到 2 组？时间顺序对半？按 token 估算均分？(3) 合并策略未定义：2 个独立 LLM 调用各生成一棵树，合并时可能产生重复 segId、遗漏 segId、或结构冲突（两棵树的 group 边界不一致）。直接导致实现阶段出现竞态条件或数据丢失。 | (1) 改为动态分片：`Math.ceil(totalTokens / maxWindowTokens)` 计算出需要拆几片（不硬编码 2）；(2) 明确定义拆分策略，如"按 token 估算值将 Segments 均匀分配到 N 组，保证每组 token ≤ 窗口阈值，段不能跨组拆分"；(3) 明确定义合并策略，如"各组树直接挂在同一个虚拟根节点下作为 siblings，组之间不再交叉压缩"；或(4) 承认 N>1 拆分超出 MVP 范围，`Out of Scope` 声明"超大上下文分段压缩（N>1）"，MVP 中超出 subagent 窗口时降级到规则 fallback。 |

### LOW

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 10 | LOW | FR-2.4 / FR-2.5 | **两处降级 fallback 策略不一致**。FR-2.4（校验失败重试超限后）的 fallback：所有段保留为独立 leaf，摘要取段内**第一条 assistant 消息的前 200 字**。FR-2.5（subagent 失败）的 fallback：所有历史段只保留**用户消息的第一句话**作为摘要，工具调用全部丢弃。两处都是"subagent 无法完成压缩"后的降级处理，但 fallback 内容不同（assistant 消息前 200 字 vs 用户消息第一句话）。虽然后者是有意更激进的降级（subagent 本身失败了），但实现者可能在代码复用中混淆。 | 统一描述：FR-2.5 可引用 FR-2.4 的 fallback 基准，说明在 subagent 失败时进一步激进化的增量差异（丢弃工具调用），避免完全不同的策略表述。 |

### 其他观察

- `api.on("turn_end")` 问题 #1 中异步子进程的**结果获取机制**未在 spec 中描述（子进程如何将结果传回主进程？stdout 流解析？写入文件然后主进程轮询？`child_process` 的 `exit` 事件？）。虽然这属于实现细节，但对于异步架构来说是一个关键设计点。建议在 plan.md 中明确。
- 时序图或状态流程描述仍然缺失。v1 中未要求，v2 中可考虑在 plan.md 中增加一个简化状态图（段创建 → 压缩触发 → 子进程异步 → 校验 → 树切换），帮助理解异步流程。
- `ctx.getContextUsage()` 限制在 FR-3.1 和 C-8 中均提到了，但 AC-6 的第二个 checkbox 描述为"Pi 的 `getContextUsage()` 返回值不受影响（已知限制，`/context-status` 提供真实数据）"。建议校准措辞：**不受影响** = Pi 本身逻辑正确，但对我们来说是不准确的（因为我们的压缩未反映在内）。可改为"不反映我们的压缩"。

---

## 4. 总结

### 整体评价

修复质量 **高**。v1 的三条 MUST FIX 全部彻底修复：
1. 异步子进程化解了同步阻塞矛盾
2. 清晰的存储分层解决了数据路径歧义
3. `isCompressing` 守卫三方位覆盖递归触发风险

v1 的三条 LOW 也全部修复（Objective 小节、术语定义、类型说明）。

**新增 1 条 MUST FIX**：FR-2.2 step 8 的拆分-合并策略未定义——如果超大上下文的场景发生，实现者不知道如何分、如何合，可能产生数据丢失或结构不一致。这是比 v1 问题更具体的设计细节问题，但同样可能导致功能不可用。

### 等级判定校准

| 规则 | 本评审 | 判定 |
|------|--------|------|
| 数据丢失 | 拆分策略不当导致 segId 重复/遗漏 → **数据丢失** | ✅ MUST FIX 正确 |
| 功能失效 | 超大上下文无法完成压缩 → **功能失效** | ✅ MUST FIX 正确 |

### 建议优先级

1. **🔴 MUST FIX**: 修复 FR-2.2 step 8 拆分-合并策略
2. **🟡 LOW**: 统一 FR-2.4 / FR-2.5 降级策略描述
3. **ℹ️ INFO**: plan.md 中补充异步子进程通信机制和状态流程图

### 结论

**Fail — 需修改后重审**。v1 3 条 MUST FIX 全部修复通过，但发现 1 条新的 MUST FIX（FR-2.2 step 8 拆分-合并策略未定义）。修复后即可通过。

### Summary

Spec 完整性评审第 2 轮：v1 的 3 条 MUST FIX 全部修复通过（异步子进程 + 存储分层 + isCompressing 守卫），新增 1 条 MUST FIX 关于 FR-2.2 step 8 拆分-合并策略未定义，需修复后重审。
