---
phase: spec
verdict: pass
---

# Phase 1 Retrospect — subagent-tui

## 维度一：Phase 执行质量

### 做得好的

1. **调研充分**：研究了 Claude Code 源码（`agentColorManager`、`spawnMultiAgent`、`forkSubagent`）、Codex CLI、OpenCode 的并行执行模式，还用 anysearch 做了外部调研。这不是闭门造车的设计。
2. **澄清问题到位**：9 个澄清问题覆盖了边界条件（颜色排除、chain 复用、总耗时定义），避免后期返工。
3. **架构决策有理有据**：选择方案 C（数据模型+渲染分离）有明确的理由——`renderResult` 约 200 行且即将膨胀，分离后每层可独立理解。
4. **自我修复**：自审阶段发现了 chain 渲染复用和 `totalDurationMs` 定义两个问题并修复。
5. **不碰约束明确**：5 项"不改"清单清晰，颜色排除被反复确认。

### 问题与偏差

| # | 问题 | 严重度 | 影响 |
|---|------|--------|------|
| R1 | **spec.md 缺少 YAML frontmatter**（`verdict: pass`） | 中 | gate check 会失败，Phase 2 流程受阻 |
| R2 | **spec 缺少标准章节**：没有 Background、Functional Requirements、Acceptance Criteria、Constraints、Complexity Assessment 等标准 section | 中 | plan 阶段缺少结构化的验收标准，依赖设计细节隐含推导 |
| R3 | **无独立 spec_review 文件**：自审在对话中完成，未按流程产出 `spec_review_v1.md` | 低 | 审查过程不可追溯，但自审内容已内嵌在 spec 改进中 |
| R4 | **Six-element completeness check 和 [AMBIGUITY] 标记未执行**：spec 中有模糊表述未被标记 | 中 | "表格式汇总"、"Ctrl+O to expand" 等表述隐含了 UI 交互假设，未显式讨论 |
| R5 | **spec 路径用了 `.superpowers/` 而非 `.xyz-harness/`** | 低 | 路径不一致，但不影响功能 |
| R6 | **无 infrastructure-scan.md**：代码分析在对话中完成，未独立产出 | 低 | 不可追溯，但分析质量没问题 |

### R4 具体模糊点

以下 spec 表述在实际实现时可能产生歧义：

1. **"collapsed 模式不再显示 tool call 细节"** — 当前 `renderResult` collapsed 模式是显示 tool call 的（`renderDisplayItems(displayItems, COLLAPSED_ITEM_COUNT)`），spec 要改成表格式汇总行。这是行为变更还是仅对并行模式？single/chain 的 collapsed 模式是否保留 tool call 显示？
   - **推测**：仅影响 parallel collapsed，single/chain 不变。spec 未显式说明。

2. **`lastActivityTime` 的更新时机** — spec 说"每次收到 `message_end` 或 `tool_result_end` 事件时更新"，但实际 `runSingleAgent` 的事件解析中没有显式的事件类型字段，而是通过 `type` 和 `message` 的组合推断。具体映射需要在实现时确认。

3. **"Ctrl+O to expand"** — 这是 Pi TUI 的内置功能还是需要代码实现？当前代码中已经使用了这个文案（`theme.fg("muted", "(Ctrl+O to expand)")`），所以应该是 TUI 内置。

4. **`ThrottleState.forceEmit()` 的调用时机** — spec 说"单个 agent 完成时调用"，但 `emitParallelUpdate` 内部是在 `runSingleAgent` 的 `onUpdate` 回调和完成后各调用一次。需要确认 forceEmit 的精确插入点。

## 维度二：Spec 内容质量

### 结构评估

spec 的核心内容（6 个优化项 + 视图模型 + 函数清单）是高质量的：
- 每个优化项都有数据模型变更、实现逻辑、显示格式、代码示例
- 视图模型定义完整，字段含义清晰
- 函数清单有职责描述，chain 复用策略明确

### 缺失项

1. **验收标准**（Acceptance Criteria）— 没有明确的"完成 = X"标准。建议补充：
   - AC1：并行执行时 TUI 显示每个 agent 的耗时
   - AC2：streaming 更新频率 <= 500ms
   - AC3：collapsed 并行模式显示表格式汇总
   - AC4：任意 agent 失败时 `isError: true`
   - AC5：`getFinalOutput` 能从多条 assistant 消息中找到有效输出
   - AC6：临时文件超过 1 小时被自动清理

2. **复杂度评估**（Complexity Assessment）— 未按 L1/L2 标准评估。实际这是 **L1**：单文件修改，无跨服务依赖，无新存储引擎。plan 不需要前后端拆分。

3. **风险评估**— 没有讨论可能的实现风险：
   - `lastActivityTime` 在 JSON stream 解析中的精确挂载点
   - `ThrottleState` 对 single/chain 模式的影响（spec 只提到 parallel 的节流，single/chain 是否也需要？）
   - 视图模型重构对现有 single/chain 渲染的回归风险

## 建议（Phase 2 前修复）

### 必须修复

1. **补 spec YAML frontmatter** — `verdict: pass`
2. **补充 Acceptance Criteria 章节** — 基于 R4 中的 6 条 AC

### 建议修复

3. **明确 R4.1** — parallel collapsed 改表格，single/chain collapsed 保留 tool call 显示
4. **确认 single/chain 的节流策略** — spec 未提及，当前 single 模式也有 `emitUpdate`，是否也加节流？

### 可以跳过

5. 补 infrastructure-scan.md — 已过时，跳过
6. spec 路径迁移到 `.xyz-harness/` — 不影响执行，跳过

## 总结

Phase 1 的**设计质量很高**（调研充分、决策有据、约束清晰），但**流程合规性有缺口**（缺少 frontmatter、标准章节、formal review）。核心风险不在设计本身，而在 spec 到 plan 的传递——缺少结构化验收标准会让 plan 的任务边界模糊。

建议在进入 Phase 2 之前花 5 分钟补齐 frontmatter + AC 章节，然后直接进 plan。
