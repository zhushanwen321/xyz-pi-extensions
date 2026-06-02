---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-31T22:00:00"
  target: ".xyz-harness/2026-05-30-context-engineering-plugin/spec.md"
  verdict: fail
  summary: "Spec 评审完成，第1轮，5条 MUST FIX（2条 AC 缺失、3条 Pi API 兼容性问题），需修改后重审"

statistics:
  total_issues: 10
  must_fix: 5
  low: 4
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md > Acceptance Criteria"
    title: "FR-8（压缩动作日志）缺少对应 AC"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md > Acceptance Criteria"
    title: "FR-9（配置与启停）缺少对应 AC"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "spec.md > FR-4"
    title: "FR-4 LLM 摘要调用机制与 Pi Extension API 不兼容"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "spec.md > FR-8"
    title: "FR-8 日志输出机制与 context 事件 API 不匹配"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: MUST_FIX
    location: "spec.md > FR-4 + C-6"
    title: "L1 异步摘要的结果应用机制未定义"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "spec.md > FR-7"
    title: "FR-7 使用 chars/4 估算但 ctx.getContextUsage() 已提供精确值"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "spec.md > Constraints"
    title: "压缩流水线处理顺序未显式声明"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: LOW
    location: "spec.md > FR-5"
    title: "recall_context 在 session reload 后的错误处理未说明"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 9
    severity: LOW
    location: "spec.md > FR-1, FR-7"
    title: "轮 (turn) 的定义模糊，影响 protectRecentTurns 行为"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 10
    severity: INFO
    location: "spec.md > FR-4"
    title: "pi.getModel() 返回 Model 数据对象而非模型名称字符串"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 评审 v1

## 评审记录
- 评审时间：2026-05-31 22:00
- 评审类型：计划评审（spec only，无 plan.md）
- 评审对象：`.xyz-harness/2026-05-30-context-engineering-plugin/spec.md`
- 参考文档：`CLAUDE.md`（项目约束）、`docs/evolution/001-context-compression-redesign.md`（设计背景）、Pi Extension API 源码（`pi-mono/packages/coding-agent/src/core/extensions/types.ts`）

---

## 一、Spec 完整性检查（6 要素）

| 要素 | 状态 | 说明 |
|------|------|------|
| **Outcomes（目标）** | ✅ 通过 | 目标明确：在 context 事件中做渐进式压缩预处理，降低上下文消耗速率。一段话说清楚。 |
| **Scope boundaries（范围边界）** | ✅ 通过 | C-1/C-2/C-3 清晰划界：不替代原生 compact、不修改 session entries、原始内容不持久化。 |
| **Constraints（约束）** | ✅ 通过 | C-1 到 C-7 共 7 条约束，覆盖与原生 compact 的关系、数据修改范围、性能要求、消息结构安全。 |
| **Decisions made（已做决策）** | ✅ 通过 | 明确决策了：用 context 事件而非 session_before_compact、内存 Map 存储而非文件、不跨 session 持久化。 |
| **Task breakdown（任务拆分）** | ⚠️ 不适用 | 这是 spec 阶段，task breakdown 属于 plan.md 的职责。Complexity Assessment 提供了合理的工作量预估。 |
| **Verification（验证标准）** | ❌ 不通过 | AC 只覆盖 FR-1 到 FR-7（8 条 AC），**FR-8 和 FR-9 没有对应的 AC**。详见 Issue #1 和 #2。 |

---

## 二、FR 一致性检查

逐对检查 FR 之间的潜在冲突：

| FR 对 | 检查结果 |
|--------|---------|
| FR-1 (过期) vs FR-4 (LLM 摘要) | ✅ 互斥。FR-4 明确说"未过期但超过阈值"，不会双重处理同一条消息。 |
| FR-1 (过期) vs FR-7 (紧急) | ⚠️ FR-7 忽略 expireMinutes 但保留了 protectRecentTurns。概念一致，但"轮"的定义模糊（Issue #9）。 |
| FR-6 (配对) vs 所有压缩操作 | ✅ C-5 保证配对安全，校验失败时安全降级。设计合理。 |
| FR-4 (LLM 调用) vs C-6 (性能) | ❌ 根本矛盾。FR-4 需要调用 LLM，但 Pi Extension API 没有提供 LLM 调用能力（Issue #3）。 |
| FR-2 (bash 截断) vs FR-7 (紧急) | ⚠️ FR-7 只提 toolResult，bash execution 消息在 L2 模式下是否也被紧急处理？spec 未明确。 |

---

## 三、AC 覆盖矩阵

| FR | AC | 状态 | 说明 |
|----|-----|------|------|
| FR-1 过期清理 | AC-1 | ✅ 覆盖 | Given/When/Then 完整，可测试 |
| FR-2 bash 截断 | AC-2 | ✅ 覆盖 | 阈值和首尾保留量明确 |
| FR-3 thinking 清理 | AC-3 | ✅ 覆盖 | 空闲时间条件清晰 |
| FR-4 LLM 摘要 | AC-7 | ✅ 覆盖 | 摘要质量有量化标准（≤500 字符） |
| FR-5 Recall | AC-5 | ✅ 覆盖 | 完整性和无损性可验证 |
| FR-6 配对安全 | AC-4 | ✅ 覆盖 | 孤儿检测可自动化验证 |
| FR-7 紧急压缩 | AC-8 | ✅ 覆盖 | 阈值和忽略条件明确 |
| FR-8 日志统计 | — | ❌ **缺失** | **无 AC，无法验证**（Issue #1） |
| FR-9 配置启停 | — | ❌ **缺失** | **无 AC，无法验证**（Issue #2） |
| — | AC-6 | ✅ 额外 | 不干扰原生 compact 的集成验证 |

**结论：9 个 FR 中有 2 个缺少 AC。AC 覆盖率 78%（7/9）。**

---

## 四、Constraints 合理性检查

| 约束 | 合理性 | 说明 |
|------|--------|------|
| C-1 不替代原生 Compact | ✅ | 避免了 tree-compact 的核心问题。正确决策。 |
| C-2 不修改 Session Entries | ✅ | 确保磁盘数据完整性。压缩只影响内存中的消息副本。 |
| C-3 原始内容不持久化 | ✅ | 合理的范围控制。recall 随 session 存活。 |
| C-4 配置格式 | ✅ | 嵌套结构清晰，L0/L1/L2 可独立配置。 |
| C-5 ToolCall/ToolResult 配对安全 | ✅ | 安全降级策略正确。线性扫描校验可行。 |
| C-6 性能约束 | ⚠️ | L0 < 5ms 合理。但 L1 "异步不阻塞"与 FR-4 的实现矛盾（Issue #5）。 |
| C-7 不修改消息结构 | ✅ | 只改 content 字段，不动元数据。这是配对安全的基础。 |

---

## 五、Pi Extension API 兼容性检查

**验证方法**：读取 Pi 源码 `pi-mono/packages/coding-agent/src/core/extensions/types.ts`，逐项对照 spec 假设。

### 5.1 `context` 事件

```typescript
// Pi 源码确认
export interface ContextEvent {
    type: "context";
    messages: AgentMessage[];
}
export interface ContextEventResult {
    messages?: AgentMessage[];
}
```

**结论**：`context` 事件存在，可修改并返回 messages。spec 的核心假设正确。✅

### 5.2 LLM 调用能力

检查了整个 `ExtensionAPI` 接口（types.ts L1084-L1400+），**没有发现 LLM 调用 API**：
- `getModel()` 返回 `Model<any>` 数据对象（包含 id, name, contextWindow 等字段），没有 `call()`/`complete()` 方法
- 没有 `callLLM()`、`complete()`、`stream()` 等方法
- `registerProvider()` 中的 `streamSimple` 是 provider 注册用的，不是给扩展调用的

CLAUDE.md 也明确约束：
> 扩展不能依赖 fs 之外的 Node.js 原生模块（网络、child_process 等由 Pi 核心控制）

**结论**：FR-4 的 LLM 摘要在当前 Extension API 下不可实现。❌ **Issue #3**

### 5.3 Context Usage 估算

```typescript
// Pi 源码确认
export interface ContextUsage {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
}
// ExtensionContextActions 中:
getContextUsage: () => ContextUsage | undefined;
```

**结论**：`ctx.getContextUsage()` 已提供精确的 token 数和百分比。spec 中 FR-7 使用 chars/4 启发式估算是不必要的，且与 evolution doc 的自我批评矛盾。⚠️ **Issue #6**

### 5.4 工具注册和命令注册

- `registerTool()` ✅ 支持 `recall_context` 注册
- `registerCommand()` ✅ 支持 `/context-engineering` 和 `/context-stats` 注册

### 5.5 事件中的 context 访问

`context` 事件 handler 签名：`ExtensionHandler<ContextEvent, ContextEventResult>`

handler 接收 `(event: ContextEvent, ctx: ExtensionContext)`，`ctx` 包含 `getContextUsage()` 和 `getModel()`。但不能异步等待 LLM 调用完成后修改返回值——handler 必须同步返回 `ContextEventResult`。

---

## 六、C-5 工具配对安全实现可行性

`_validateToolPairing()` 的实现方案：

1. 遍历 `messages: AgentMessage[]`
2. 维护两个 Set：`pendingToolCalls`（assistant 消息中的 toolCall.id）和 `resolvedToolCalls`（toolResult 中的 toolCallId）
3. 每个 assistant 消息的 toolCall 加入 pendingToolCalls
4. 每个 toolResult 的 toolCallId 从 pendingToolCalls 移到 resolvedToolCalls
5. 最终检查：pendingToolCalls 为空（无孤儿 toolCall）

**可行性评估**：✅ 完全可行。线性 O(n) 扫描，满足 C-6 的 < 5ms 要求。安全降级策略（校验失败返回原始消息）合理。

**但有一个前提**：需要确认 `AgentMessage` 类型中 toolResult 消息确实有 `toolCallId` 字段。从 Pi 源码的消息类型定义看，这是标准 OpenAI 兼容格式，应该包含。建议在 plan 阶段做类型验证。

---

## 发现的问题

| # | 优先级 | 位置 | 描述 | 修改建议 |
|---|--------|------|------|---------|
| 1 | MUST FIX | spec.md > Acceptance Criteria | **FR-8 缺少 AC**。FR-8 定义了压缩动作日志（统计 Level 0/1 数量、token 节省、/context-stats 命令），但无 AC 验证这些功能是否正确实现。 | 补充 AC-9 覆盖：统计内容正确性、/context-stats 命令输出格式、TUI 渲染（details）的可用性。 |
| 2 | MUST FIX | spec.md > Acceptance Criteria | **FR-9 缺少 AC**。FR-9 定义了配置启停（/context-engineering on\|off、L0/L1/L2 独立控制），但无 AC 验证。 | 补充 AC-10 覆盖：默认配置加载、命令修改配置、独立级别启停、持久化行为。 |
| 3 | MUST FIX | spec.md > FR-4:L1-3 | **FR-4 LLM 摘要调用机制不可行**。Pi Extension API 没有 LLM 调用能力（无 callLLM/complete/stream 方法）。`getModel()` 返回数据对象，不提供调用能力。CLAUDE.md 约束扩展不能发起网络请求。FR-4 描述的"用 LLM 生成简短摘要"在当前 API 下无法实现。 | 三个可选方向：(a) 将 L1 标记为 Phase 2，先向 Pi 提 feature request 增加 LLM 调用 API；(b) L1 改为用子进程（subagent 模式）调用 LLM，但 context 事件中无法等待子进程返回；(c) L1 改为纯规则化摘要（提取文件路径+函数签名+首尾行），不调 LLM。 |
| 4 | MUST FIX | spec.md > FR-8:L5-6 | **FR-8 日志输出机制与 context 事件不匹配**。FR-8 说"通过 details 返回给 TUI 渲染"，但 `details` 是 tool `execute()` 返回值的字段。`context` 事件的返回类型是 `ContextEventResult { messages?: AgentMessage[] }`，没有 details 字段。 | 改为：(a) 压缩统计存储在扩展闭包变量中，/context-stats 命令从变量读取并用 TUI 渲染；(b) 或通过 `pi.sendMessage()` 发送 CustomMessage 展示统计。删除"通过 details 返回"的描述。 |
| 5 | MUST FIX | spec.md > FR-4 + C-6 | **L1 异步摘要的结果应用机制未定义**。C-6 说"L1 异步但不阻塞 LLM 调用"，但未说明异步完成后摘要如何生效。context 事件 handler 必须同步返回消息——如果 L1 异步调用 LLM，返回时 context 事件早已结束。spec 未回答：异步摘要完成后，是在下次 context 事件中替换？还是根本不会替换？ | 明确定义 L1 生命周期：(a) context 事件中标记候选消息为 pending；(b) 异步 LLM 完成后更新 recall-store 中的摘要；(c) 下次 context 事件中检测到已完成摘要的消息直接使用摘要版本。或者更简单：**将 L1 改为同步，在 context 事件中直接生成摘要**——如果 LLM 调用耗时不可接受，就降级为 L0。 |
| 6 | LOW | spec.md > FR-7:L3-4 | **FR-7 使用 chars/4 启发式估算，但 ctx.getContextUsage() 已提供精确值**。且 evolution doc 第 3.2 节自我批评："chars/4 对中文/代码严重低估"。Pi API 的 `ContextUsage.percent` 直接给出了精确百分比。 | 改为"使用 ctx.getContextUsage() 获取精确上下文使用率"。删除 chars/4 描述。如果 getContextUsage() 返回 null（如 compaction 后），再 fallback 到 chars/4。 |
| 7 | LOW | spec.md > Constraints | **压缩流水线处理顺序未显式声明**。虽然 L0→L1→L2 的渐进式结构在 Background 中有描述，但 Constraints 中没有正式声明处理顺序。实现者可能不清楚：是先做 L0 过期检查再做 bash 截断？还是所有 L0 操作一次性扫描？ | 在 Constraints 中增加 C-8 或在 FR 开头增加"Processing Pipeline"章节，显式声明：(1) L0 全部完成后检查是否需要 L1；(2) L1 完成后检查是否需要 L2；(3) 每级完成后通过配对校验。 |
| 8 | LOW | spec.md > FR-5 | **recall_context 在 session reload 后的错误行为未说明**。C-3 明确原始内容不持久化，session reload 后 Map 清空。但 FR-5 只说"返回原始内容"，未说明 ID 不存在时返回什么。 | 补充 FR-5 的错误处理："ID 不存在（session reload 或 ID 无效）时返回错误信息 `[Content not found. ID: {id}. Session may have been reloaded.]`"，不 throw。 |
| 9 | LOW | spec.md > FR-1:L5, FR-7:L4 | **"轮" (turn) 定义模糊**。FR-1 用"最近 N 轮"，FR-7 用"最近 3 轮"。在 Pi 的消息模型中，一轮可能是：(a) user→assistant（包含所有中间 tool 调用）= 1 turn；(b) 每条消息 = 1 turn。不同理解导致 protectRecentTurns 保护范围差 5-10 倍。 | 在 Constraints 或术语定义中声明："轮 = 从 user 消息到下一个 user 消息之前的所有消息序列（包含中间的 assistant/toolResult/bashExecution 消息）"。 |
| 10 | INFO | spec.md > FR-4:L4 | **pi.getModel() 返回 Model 数据对象**，不是"模型名称字符串"。spec 说"通过 pi.getModel() 获取"模型"，暗示用它来调用 LLM。实际上 `Model<any>` 只是配置数据（id, name, contextWindow, cost 等），没有调用方法。 | 修正措辞为"通过 ctx.getModel() 获取当前模型配置"。在 FR-4 重新设计 LLM 调用机制时此条自然解决。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 七、与设计背景文档的一致性

对照 `docs/evolution/001-context-compression-redesign.md`：

| 设计背景中的方案 | spec 对应 | 一致性 |
|-----------------|----------|--------|
| 方向 A：增强原生 Compaction | C-1 不替代原生 compact | ✅ 一致 |
| Level 0: 零成本清理 | FR-1, FR-2, FR-3 | ✅ 一致 |
| Level 1: LLM 摘要 | FR-4 | ⚠️ spec 继承了 LLM 调用假设，但 API 不支持 |
| Level 2: 紧急压缩 | FR-7 | ✅ 一致 |
| 反抖动保护 | 未在 spec 中体现 | ⚠️ evolution doc 建议但 spec 未采纳，可接受 |
| 熔断器（连续 N 次失败停止） | 未在 spec 中体现 | ⚠️ 同上 |
| Identifier Preservation | FR-4 提到"保留文件路径、函数名" | ✅ 部分采纳 |
| Recall 机制 | FR-5 | ✅ spec 新增，evolution doc 未提及 |

**总体评价**：spec 基本忠实于 evolution doc 的方向 A 方案，但继承了 LLM 调用假设未经验证。evolution doc 中的反抖动和熔断器未纳入 spec，这是一个遗漏但不阻塞（可作为后续迭代）。

---

## 八、spec 设计亮点

1. **C-1 不替代原生 compact** — 避免了 tree-compact 的核心教训，是最重要的架构决策
2. **C-5 配对校验 + 安全降级** — 校验失败返回原始消息，不做破坏性操作。这是正确的防御式设计
3. **C-2 不修改 Session Entries** — 压缩只影响内存副本，保证磁盘数据完整性
4. **FR-5 Recall 机制** — 压缩不等于丢弃，LLM 可按需恢复。这个设计参考了 Claude Code 的 memory recall 思路
5. **三级渐进压缩** — L0→L1→L2 从零成本到激进，避免一刀切

---

## 结论

**需修改后重审。**

spec 的整体架构方向正确（不替代原生 compact、渐进式压缩、配对安全），但在两个维度存在阻塞问题：

1. **AC 完整性**：FR-8 和 FR-9 缺少 AC，无法验证这两个功能的正确性
2. **API 兼容性**：FR-4 的 LLM 调用、FR-8 的 details 输出、L1 异步机制——三个问题都与 Pi Extension API 的实际能力不匹配。这不是 spec 的设计问题，而是对 API 能力的假设错误

建议优先解决 Issue #3（FR-4 LLM 机制），因为它是最大的架构风险——如果 L1 不可行，整个分级压缩策略需要调整。Issue #1 和 #2（AC 补充）相对简单。

### Summary

Spec 评审完成，第1轮，5条 MUST FIX（2条 AC 缺失、3条 Pi API 兼容性问题），需修改后重审。
