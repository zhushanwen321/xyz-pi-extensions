---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-28T23:00:00"
  target: ".xyz-harness/2026-05-28-infinite-context-engine/spec.md"
  verdict: fail
  summary: "Spec 完整性评审完成，第1轮，3条MUST FIX（架构可行性 + 数据存储 + 竞态保护），需修改后重审"

statistics:
  total_issues: 8
  must_fix: 3
  must_fix_resolved: 0
  low: 3
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md → FR-2.6"
    title: "turn_end 同步阻塞与无缝执行矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md → FR-1.3 / FR-4.3"
    title: "原始段数据存储路径机制不明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "spec.md → FR-2.1 / FR-2.6"
    title: "压缩执行期间递归触发保护缺失"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "spec.md → Background"
    title: "缺少简洁独立的 Objective 小节"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "spec.md → FR-2.3"
    title: "\"内联摘要\" 术语未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "spec.md → FR-3.2"
    title: "CustomMessage 类型未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: INFO
    location: "spec.md → Complexity Assessment"
    title: "~1200 行估算与功能复杂度匹配"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: INFO
    location: "spec.md 全局"
    title: "未提及 GUI _render 协议兼容"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审（Spec 完整性）v1

## 评审记录

- **评审时间**: 2026-05-28 23:00
- **评审类型**: 计划评审（仅 Spec，无 Plan.md）
- **评审对象**: `.xyz-harness/2026-05-28-infinite-context-engine/spec.md`
- **方法论**: xyz-harness-expert-reviewer「模式一：计划评审」第 1 项（spec 完整性）
- **项目约束**: CLAUDE.md（Pi Extension 架构规范）

> **说明**：本次评审仅收到 spec.md（无 plan.md），因此仅执行"模式一：计划评审"中的第 1 维度——**spec 完整性**。第 2-6 维度（plan 可行性、spec/plan 一致性、Execution Groups、接口契约、后端设计）因缺少 plan.md 暂不评估。

---

## 1. spec 完整性 — 逐项审查

### 1.1 目标是否明确

**结论: ⚠️ 部分通过**

Background 段落详细说明了问题背景（LLM 上下文窗口限制、长时间 Agent 会话中的上下文膨胀）和方案概要（基于段-树的上下文管理、LLM 驱动压缩、recall 检索）。问题描述清晰，方案方向正确。

**问题**: Background 混合了"问题背景"和"方案简介"，没有一个独立的、一段话能说清楚的 **Objective** 小节。当前内容中，读者需要从背景段落中自己提炼目标。建议增加独立的 `## Objective` 小节，一句话定义本扩展要解决的问题和核心方法。

---

### 1.2 范围是否合理

**结论: ✅ 通过**

- FR-1 到 FR-6 覆盖了完整的功能链路：段索引 → 树压缩 → Context 组装 → Recall 检索 → 命令
- `Out of Scope` 章节清晰列出了 9 项不包含的内容，边界明确
- MVP 范围适度——不包含语义搜索、跨 session 记忆、L1/L2 高级压缩等，避免过度工程
- 6 个 FR 的粒度适中，每个可独立实现和测试

**关键风险（已标记为 MUST_FIX #1）：**

FR-2.6 描述压缩在 `turn_end` handler 中**同步执行**（3-10 秒），同时称"不停止对话"。在 Pi 的事件驱动模型中，`turn_end` handler 的同步阻塞会冻结整个事件循环——LLM 调用、工具执行、TUI 渲染全部暂停。Project CLAUDE.md 明确了"扩展在 Pi 进程内执行，不是独立进程"，意味着没有独立线程可以后台执行。这直接影响功能可行性：

- 如果同步阻塞 3-10 秒，用户看到的不是"状态消息"而是"Pi 卡住了"
- 如果使用异步，Pi 的 `turn_end` handler 签名是否支持 promise？是否需要在 context handler 中触发？
- 如果拆分到下一个 `turn_start` 或使用 background subagent，时序设计需要重新说明

**建议**：明确以下之一：
1. 采用异步执行（确认 Pi API 支持 async handler）
2. 改为在 `turn_start`/`context` handler 之间拆分：context 检测、turn_end 只设标志、下一个 context handler 前完成压缩
3. 或承认短暂阻塞是可接受的，更新"不停止对话"的描述

---

### 1.3 验收标准是否可量化

**结论: ✅ 通过**

AC-1 到 AC-6 覆盖了所有 6 个 FR，每条 AC 均可通过集成测试或人工操作验证：

| AC | 验证方式 | 可量化性 |
|----|---------|---------|
| AC-1 段管理 | 测试: 检查 entries、文件、段边界 | 高 — 有明确的二进制结果 |
| AC-2 树压缩 | 测试: 检查触发、数据结构、降级 | 高 — LLM 输出 JSON 可校验 |
| AC-3 Context 组装 | 测试: 检查 messages 数组内容、顺序、裁剪 | 高 — 可断言 message 结构 |
| AC-4 Recall 工具 | 测试: 调用工具校验返回值 | 高 — 输入输出明确 |
| AC-5 命令 | 人工: TUI 显示内容验证 | 中 — 需 E2E 验证 |
| AC-6 兼容性 | 测试: Pi 原生 compaction 和 getContextUsage | 高 — API 返回值可断言 |

无"提升用户体验"类模糊描述，所有 AC 均有明确的判定标准。 ✅

---

### 1.4 是否标记了 `[待决议]` 项

**结论: ✅ 通过（无待决议项）**

spec 全文未出现 `[待决议]`、`TBD`、`TODO` 等标记。所有设计决策均已明确：
- 触发条件（70% tree-context）
- 保留窗口（最近 2 段 / 8 turn）
- 展平算法（BFS per level, newest-to-oldest）
- 预算裁剪策略（从最深最老开始砍）
- 降级机制（subagent 失败/超时）
- Token 估算算法（chars/4）

无开放的架构决策待定项，设计决策程度充分。 ✅

---

## 2. 发现的问题

### MUST FIX

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 1 | MUST FIX | FR-2.6 / 第 2 章 | **turn_end 同步阻塞与"不停止对话"矛盾**。FR-2.6 说压缩在 `turn_end` handler 中同步执行（3-10 秒），同时宣称"不停止对话"。但 Pi 扩展运行在 Pi 主进程内（CLAUDE.md 明确约束），同步阻塞 3-10 秒会冻结整个事件循环——LLM 调用、工具执行、TUI 渲染全部暂停。用户看到的是"Pi 卡住了"而非"状态消息"。 | 明确异步执行方案：(1) 确认 Pi 的 `turn_end` handler 是否支持 async（返回 Promise），(2) 或改为 `context` handler 中检测 → `turn_end` 标记 → 下一轮的 `context` handler 前完成压缩的拆分模型，(3) 或承认短暂阻塞可接受并更新措辞。 |
| 2 | MUST FIX | FR-1.3 / FR-4.3 | **原始段数据存储路径机制不明确**。FR-1.3 说段原始数据写入 `.pi/infinite-context/<sessionId>/seg_N.json`（文件系统），FR-4.3 说 recall 从 `ctx.sessionManager.getEntries()` 和这些文件获取。但 spec 未界定两个存储介质的分工：(a) 哪些数据走 session entries，哪些走文件？(b) `.pi/infinite-context/` 目录由谁创建、何时清理（Out of Scope 说"段原始数据文件的自动 GC"不在范围内，但未说明是否会上线前手动 GC）？(c) 文件写入是否与 CLAUDE.md 约束（仅允许 fs 原生模块）兼容？fs 允许但路径归属需明确。 | 明确存储分层：(1) **session entries** 存元数据（段索引、树结构、TurnIndex；customType="ic-segment"/"ic-tree"/"ic-turn"），(2) **文件系统** 存原始 messages 内容（因为单段可能很大，不适合每次遍历 entries 全量读取）。同时说明 `.pi/infinite-context/` 目录的生命周期管理和清理策略。 |
| 3 | MUST FIX | FR-2.1 / FR-2.6 | **压缩递归触发保护缺失**。FR-2.1 说 context handler 检测 tree-context ≥70% 时设置 `needsCompression` 标志，FR-2.6 说 `turn_end` 执行压缩（通过 subagent 调用主模型 LLM）。但 context handler 在**每次 LLM 调用前运行**——包括 subagent 主模型 LLM 调用。压缩执行期间，subagent 请求主模型时会再次触发 context handler，若此时 `needsCompression` 仍为 true，可能递归触发压缩。spec 未说明此保护机制。 | 在 context handler 中加入守卫：正在执行压缩时跳过触发判断。例如用 `isCompressing` 标志，压缩开始前设置，压缩完成后清除。context handler 检测到此标志时不设 `needsCompression`、不估算 tree-context（或估算但不下发标志）。 |

### LOW

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 4 | LOW | Background 章节 | **缺少简洁独立的 Objective 小节**。当前 Background 混合了问题背景和方案简介，没有一段独立的话说清楚"本扩展要做什么"。虽不影响技术理解，但影响文档的可读性和读者快速定位。 | 在 Background 后增加独立的 `## Objective` 小节，如：_"定义一个 Pi 扩展，以段-树结构管理对话上下文。在上下文紧张时通过主模型将历史段组织为分组摘要树，保留当前上下文完整，提供 recall 工具供 LLM 按需检索被压缩的原始内容。"_ |
| 5 | LOW | FR-2.3 | **"内联摘要"术语未定义**。FR-2.3 中 leaf 节点定义说 "leaf 无 summary 时使用该段的 LLM 内联摘要"——"内联摘要"指什么？是段划分时 LLM 自动产生的摘要？还是段中第一条 assistant 消息的前 N 字？或是其他？无定义会造成实现歧义。 | 明确定义"LLM 内联摘要"：(1) 段结束时 LLM 对整段内容的自然语言摘要（由 LLM 在 turn_end 中生成），(2) 或段中第一条 assistant 消息的前 N 字作为 fallback。并说明采集时机（turn_end 时记录还是段创建时实时生成）。 |
| 6 | LOW | FR-3.2 | **CustomMessage 类型未定义**。FR-3.2 说展平时注入 CustomMessage，但未说明在 Pi 的 messages 数组结构中 CustomMessage 的 Role/Content 格式。Pi 的 context handler 中 messages 数组元素的类型是什么（ToolMessage？AssistantMessage？CustomMessage？）？应引用 Pi API 中 messages 类型规范。 | 引用 Pi API 中 context handler messages 数组的元素类型（如 `{ role: "system" | "assistant", content: string }`），或说明使用哪种格式注入树摘要文本。 |

### INFO

| # | 优先级 | 位置 | 描述 |
|---|--------|------|------|
| 7 | INFO | Complexity Assessment | **~1200 行估算与功能复杂度匹配**。6 个 FR 覆盖索引、压缩、组装、检索、命令，核心链路清晰。主要风险点（subagent prompt 设计 + BFS 边界条件）已在 spec 中识别。估算合理。 |
| 8 | INFO | 全篇 | **未提及 GUI _render 协议兼容**。项目 CLAUDE.md 定义了 `_render` 协议（task-list/summary-table/progress/code-block 四种 GUI 渲染描述符），但 spec 中的 TUI 渲染描述（`/tree-compact` 状态消息、`/context-status` 数据展示）未说明是否同步输出 `_render` 描述符供 GUI 消费。MVP 阶段可接受纯 TUI，但建议在 `## Out of Scope` 中注明或在 plan 中决定优先级。 |

---

## 3. 等级判定校准

按方法论中的「等级判定校准规则」回检 MUST FIX：

| 规则 | 本评审 | 判定 |
|------|--------|------|
| 数据丢失 | FR-1.3 存储路径不明确可能导致 recall 无法读取原始数据 → **数据丢失** | ✅ MUST FIX 正确 |
| 功能失效 | FR-2.6 同步阻塞可能导致 Pi 冻结，压缩功能在大会话中不可用 → **功能失效** | ✅ MUST FIX 正确 |
| 递归触发 | FR-2.1 缺少守卫可能导致压缩期间递归触发，造成无限循环或崩溃 → **功能失效** | ✅ MUST FIX 正确 |

三条 MUST FIX 均符合"生产环境导致功能不可用或数据错误"标准，判定合理。

---

## 4. 总结

### 整体评价

spec 整体质量**高**：
- 6 个 FR 覆盖完整功能链路，流程清晰
- 6 个 AC 均可量化验证，无模糊描述
- Out of Scope 边界明确，防止 MVP 阶段范围蔓延
- 8 个 Constraints 覆盖运行时兼容性（不改 Pi 核心、原始数据完整性、性能预算）
- 已验证的 Pi API 映射表和时序说明体现了前期调研充分

### 未覆盖维度说明

因缺少 plan.md，以下维度未评审（需在计划评审第 2+ 轮或补充 plan.md 后评审）：
- **第 2 项**：plan 可行性
- **第 3 项**：spec 与 plan 一致性
- **第 4 项**：Execution Groups 合理性
- **第 5 项**：接口契约审查
- **第 6 项**：后端设计充分性（本扩展无后端任务，N/A）

### 结论

**需修改后重审**。3 条 MUST FIX 涉及：
1. 🔴 turn_end 同步阻塞 → 架构可行性问题，需在 spec 中明确异步方案或更新描述
2. 🔴 存储路径机制 → 数据完整性问题，需明确 session entries 与文件的职责边界
3. 🔴 递归触发保护 → 正确性问题，需在 spec 中加入压缩守卫机制

修复后建议补充 plan.md，启动第 2-6 维度的完整计划评审。

### Summary

Spec 完整性评审完成，第1轮，3条MUST FIX，需修改后重审。
