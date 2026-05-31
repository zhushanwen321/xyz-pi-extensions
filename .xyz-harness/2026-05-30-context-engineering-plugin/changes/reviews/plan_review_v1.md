---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-31T12:00:00"
  target: ".xyz-harness/2026-05-30-context-engineering-plugin/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，3条MUST FIX，需修改后重审"

statistics:
  total_issues: 9
  must_fix: 3
  must_fix_resolved: 0
  low: 5
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md:Task 1 Step 2 (loadConfig)"
    title: "settings.jsonl vs settings.json 文件名和解析逻辑双重错误"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md:Interface Contracts → processL0 签名"
    title: "processL0 Interface Contract 缺少 turnBoundaries 参数"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: MUST_FIX
    location: "plan.md:Wave Schedule vs Dependency Graph"
    title: "Wave Schedule 与 Dependency Graph 矛盾，并行/串行冲突"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md:Task 5 Step 2 (context event handler)"
    title: "context 事件处理器未包含 try-catch 错误处理"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md:Task 2 Step 1 (crypto.randomUUID)"
    title: "crypto 模块可能受 CLAUDE.md 限制（仅允许 fs）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: LOW
    location: "use-cases.md:UC-3 → emergencyCompress()"
    title: "UC-3 引用 emergencyCompress() 但 Interface Contracts 定义为 processL2()"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 7
    severity: LOW
    location: "plan.md:Interface Contracts → CompressionStats"
    title: "CompressionStats 缺少 validationFailed 字段"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 8
    severity: LOW
    location: "plan.md:File Structure vs Complexity Assessment"
    title: "File Structure 7 文件（无 widget.ts）vs Complexity Assessment 5-6 文件（含 widget.ts）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 9
    severity: INFO
    location: "plan.md:Task 6"
    title: "单元测试仅覆盖 compressor.ts，config/recall-store/commands 无独立测试"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-31 12:00
- 评审类型：计划评审（模式一）
- 评审对象：`spec.md` + `plan.md` + `e2e-test-plan.md` + `use-cases.md` + `non-functional-design.md`

## 1. Spec 完整性

| 维度 | 评估 |
|------|------|
| 目标明确性 | ✅ 一段话说清楚了：在 `context` 事件中渐进式压缩消息，降低上下文消耗，不替代原生 compact |
| 范围合理性 | ✅ L0/L1/L3 三级分层 + recall + 统计 + 配置，边界清晰，不过大不过小 |
| AC 可量化性 | ✅ 10 条 AC 全部有 Given/When/Then 结构，可写测试验证 |
| 待决议项 | ✅ 无 `[待决议]` 标记 |
| 约束完整性 | ✅ C-1 至 C-9 覆盖了不替代 compact、不修改 entries、不持久化、配对安全、性能、流水线顺序、turn 定义等关键约束 |

**Spec 整体评价：完整、一致、可执行。无 spec 层面问题。**

## 2. Plan 可行性

### 2.1 任务拆分

| Task | 粒度 | 步骤数 | 可独立执行 |
|------|------|--------|-----------|
| Task 1 骨架+配置 | 适中 | 4 | ✅ |
| Task 2 Recall Store | 适中 | 3 | ✅ 依赖 Task 1 |
| Task 3 压缩引擎 | 偏大 | 7 | ✅ 依赖 Task 2，核心逻辑集中 |
| Task 4 配对校验 | 适中 | 4 | ✅ 依赖 Task 3 |
| Task 5 扩展入口 | 适中 | 6 | ✅ 依赖 Task 4 |
| Task 6 端到端验证 | 适中 | 3 | ✅ 依赖 Task 5 |

Task 3 有 7 步但每步职责清晰（辅助函数→L0→L1→L2→主函数→类型检查→commit），可接受。

### 2.2 依赖关系

依赖链 Task 1→2→3→4→5→6 逻辑正确：
- Task 2（recall-store）需要 Task 1（类型定义）
- Task 3（compressor）需要 Task 2（store）
- Task 4（配对校验）修改 Task 3 的文件
- Task 5（入口）需要所有上游模块
- Task 6（测试）需要完整实现

**但 Wave Schedule 存在矛盾**（见 Issue #3）。

### 2.3 工作量估算

6 个 task，7 个新建文件 + 1 个修改，与 L1 复杂度标注匹配。合理。

## 3. Spec 与 Plan 一致性

### 3.1 AC 覆盖矩阵（逐条对照）

| AC | Spec 描述 | Plan Task | 覆盖状态 |
|----|----------|-----------|---------|
| AC-1 | Tool Result 过期清理 | Task 3 (processL0 → expireToolResult) | ✅ |
| AC-2 | Bash 输出截断 | Task 3 (processL0 → truncateBashOutput) | ✅ |
| AC-3 | Thinking 清理 | Task 3 (processL0 → expireThinking) | ✅ |
| AC-4 | ToolCall/ToolResult 配对 | Task 4 (validateToolPairing) | ✅ |
| AC-5 | Recall 完整性 | Task 2 (RecallStore) | ✅ |
| AC-6 | 不干扰原生 Compact | Task 5 (context event 返回消息) | ✅ |
| AC-7 | L1 规则化摘要 | Task 3 (processL1 → condenseToolResult) | ✅ |
| AC-8 | L2 紧急压缩 | Task 3 (processL2) | ✅ |
| AC-9 | 压缩统计命令 | Task 5 (commands.ts) | ✅ |
| AC-10 | 配置与启停 | Task 5 (commands.ts + config.ts) | ✅ |

**10/10 AC 全部覆盖。** Plan 的 Spec Coverage Matrix 和 Spec Metrics Traceability 表与上述对照一致。

### 3.2 Plan 额外工作（spec 未提及）

无。Plan 没有超出 spec 范围的工作。

## 4. Interface Contracts 审查

### 4.1 config 模块

| 检查项 | 结果 |
|--------|------|
| loadConfig 签名 | ⚠️ 文件路径错误（见 Issue #1） |
| parseLevelArgs 签名 | ✅ 完整 |
| ContextEngineeringConfig 结构 | ✅ 与 spec C-4 完全对应 |

### 4.2 recall-store 模块

| 检查项 | 结果 |
|--------|------|
| StoredContent 结构 | ✅ 完整 |
| createRecallStore 工厂 | ✅ 闭包模式，符合 Pi 扩展 session 隔离要求 |
| store/recall/clear 签名 | ✅ 返回类型明确 |

### 4.3 compressor 模块

| 检查项 | 结果 |
|--------|------|
| processL0 签名 | ❌ 缺少 turnBoundaries 参数（见 Issue #2） |
| processL1 签名 | ✅ |
| processL2 签名 | ✅ 包含 turnBoundaries |
| compressContext 签名 | ✅ 但内部调用 processL0 的参数数与签名不一致 |
| validateToolPairing | ✅ |
| findTurnBoundaries | ✅ |
| CompressionStats | ⚠️ 缺少 validationFailed（见 Issue #7） |

### 4.4 AC 覆盖矩阵完整性

Plan 的 Spec Coverage Matrix 包含所有 10 个 adopted AC。无遗漏。

### 4.5 类型传递一致性

`compressContext` → `processL0` 的 messages 类型传递正确（AgentMessage[] in/out）。
`compressContext` → `processL1` → `processL2` 链路中 messages 类型传递正确。
`findTurnBoundaries` 返回的 `TurnBoundary[]` 被 processL2 正确消费。但 **processL0 也需要 TurnBoundary[]**（用于 protectRecentTurns 检查），Interface Contract 中遗漏。

## 5. Execution Groups 合理性

| 检查维度 | 结果 |
|----------|------|
| 分组合理性 | ✅ 单组 BG1，7 个文件（测试 +1），≤ 10 上限 |
| 类型划分 | ✅ 全后端，无混合 |
| 功能关联度 | ✅ 紧密耦合模块（compressor 依赖 config + recall-store，index 依赖全部） |
| 依赖关系 | ✅ BG1 无外部依赖 |
| Wave 编排 | ❌ 与 Dependency Graph 矛盾（见 Issue #3） |
| Subagent 配置 | ✅ Agent/model/注入上下文/读取文件/修改文件全部明确 |
| 上下文充分性 | ✅ 注入了 spec.md + CLAUDE.md + Pi messages.ts + types.ts |

## 6. 后端设计充分性

| 检查维度 | 结果 |
|----------|------|
| 实现理由 | ✅ 每个步骤解释了"为什么"（如 L1 fallback 原因、配对校验安全降级） |
| 存储选型 | ✅ 内存 Map + 不持久化，spec 已约束 |
| 边界条件 | ⚠️ 基本覆盖，但 config 加载失败只返回默认值，缺少日志提示 |
| 非功能性 | ✅ non-functional-design.md 覆盖了稳定性/性能/安全 |

## 7. 与 Pi Extension API 兼容性

| API 用法 | 兼容性 |
|----------|--------|
| `pi.on("context", ...)` | ✅ Pi Extension API 标准事件 |
| `pi.registerTool(...)` | ✅ 用于 recall_context |
| `pi.registerCommand(...)` | ✅ 用于 /context-engineering 和 /context-stats |
| `pi.appendSystemPrompt(...)` | ✅ 告知 LLM recall 工具 |
| `pi.on("session_start", ...)` | ✅ 重置闭包状态 |
| `ctx.getContextUsage()` | ⚠️ plan 假设返回 `{ percent: number } | null`，需对照 Pi types.ts 验证实际签名 |
| `event.messages` | ⚠️ plan 假设 context 事件返回 messages 列表且可修改后返回，需验证事件签名 |
| `AgentMessage` 类型 | ⚠️ plan 假设有 toolResult/bashExecution/assistant 等 message variant，需验证 messages.ts 中的实际联合类型 |

**说明：** plan 在 Subagent 配置中指定了读取 `messages.ts` 和 `types.ts`，实现时会对照真实类型。上述 ⚠️ 项不影响 plan 正确性，但实现时需确认。

## 8. settings.jsonl 读取可行性

**结论：可行，但 plan 的实现方案有误（Issue #1）。**

- 扩展能使用 `fs` 模块（CLAUDE.md 明确允许）
- `settings.jsonl` 是 JSON Lines 格式，每行一个 JSON 对象
- 需要 `fs.readFileSync` → 按行 split → 逐行 `JSON.parse` → 找到含 `context-engineering` key 的行
- plan 写的是 `settings.json` + `JSON.parse`（整个文件解析），文件名和解析逻辑都不对

## 9. 测试框架约束

- Task 6 Step 1 明确指定 vitest ✅
- 测试文件位于 `src/__tests__/compressor.test.ts` ✅
- e2e-test-plan.md 中手动测试使用运行中 Pi 验证 ✅
- 无 `node:test` 引用 ✅

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md:Task 1 Step 2 | **settings.jsonl vs settings.json 不一致**。Spec C-4 明确配置源为 `settings.jsonl`（JSON Lines 格式），但 plan Task 1 Step 2 写的是 `~/.pi/agent/settings.json` + `JSON.parse`。文件名和解析逻辑都不对。`settings.jsonl` 每行一个 JSON 对象，不能直接 `JSON.parse` 整个文件。 | 1. 修正文件名为 `~/.pi/agent/settings.jsonl`。2. 修正解析逻辑：readFileSync → split('\n') → 逐行 JSON.parse → find line with `context-engineering` key。3. 在 Interface Contracts 的 loadConfig 边界条件中补充 JSONL 解析失败处理。 |
| 2 | MUST FIX | plan.md:Interface Contracts → processL0 | **processL0 缺少 turnBoundaries 参数**。FR-1 要求 tool_result 过期时检查 `protectRecentTurns`（"不过期条件：tool_result 属于最近 N 轮"），但 processL0 的 Interface Contract 签名为 `(messages, config, store, now)` 只有 4 个参数。Task 3 Step 5 实现调用代码 `processL0(messages, config.l0, store, Date.now(), boundaries)` 传了 5 个参数。签名与调用不一致会导致实现偏差。 | 修正 processL0 签名为 `(messages: AgentMessage[], config: L0Config, store: RecallStore, now: number, turnBoundaries: TurnBoundary[])`。同步更新 Spec Coverage Matrix 中 AC-1 的 data flow 描述。 |
| 3 | MUST FIX | plan.md:Wave Schedule | **Wave Schedule 与 Dependency Graph 矛盾**。Dependency Graph 显示 Task 1→2→3→4→5→6 严格串行（Task 2 depends on Task 1, Task 4 depends on Task 3），但 Wave Schedule 将 Task 1/2 放入 Wave 1（暗示并行）、Task 3/4 放入 Wave 2（暗示并行）。BG1 的 Execution Flow 已正确声明"串行执行"。 | 两种修正方案任选其一：方案 A — 删除 Wave Schedule 整节（BG1 已明确串行，Wave Schedule 提供的额外信息为零）。方案 B — 修正为每 Wave 单 Task：Wave 1=Task1, Wave 2=Task2, ..., Wave 6=Task6。 |
| 4 | LOW | plan.md:Task 5 Step 2 | **context 事件处理器未包含 try-catch**。non-functional-design.md 声明"context 事件中任何异常均被 try-catch 包裹，错误只记录日志不传播"，但 Task 5 Step 2 的实现步骤中没有提到 try-catch。compressContext 抛异常会导致 Pi 进程崩溃或阻断 LLM 调用。 | 在 Task 5 Step 2 补充：context 事件处理器体用 try-catch 包裹 compressContext 调用，catch 中 log 错误并返回 `{ messages: event.messages }`（原始消息）。 |
| 5 | LOW | plan.md:Task 2 Step 1 | **crypto.randomUUID() 可能受 CLAUDE.md 限制**。CLAUDE.md 说"扩展不能依赖 fs 之外的 Node.js 原生模块"。虽然 `crypto` 在 Node.js 运行时中始终可用（且 `crypto.randomUUID()` 在 Node 19+ 可作为全局使用），但 CLAUDE.md 的字面约束排除了它。 | 两种方案：1. 确认 Pi 运行时 Node.js 版本 ≥ 19，使用全局 `crypto.randomUUID()`（无需 import）。2. 用 `Math.random().toString(36).slice(2, 10)` 生成 8 字符随机 ID，无需 import 任何模块。 |
| 6 | LOW | use-cases.md:UC-3 | **命名不一致**。UC-3 引用 `emergencyCompress()` 方法名，但 Interface Contracts 定义为 `processL2()`。两者指同一函数但名称不同。 | 将 UC-3 的 `emergencyCompress()` 统一为 `processL2()`。 |
| 7 | LOW | plan.md:CompressionStats | **CompressionStats 缺少 validationFailed 字段**。Task 4 Step 2 说"校验失败时...在 stats 中标记 validationFailed: true"，但 CompressionStats 数据定义中只有 5 个字段，无 `validationFailed`。 | 在 CompressionStats 中添加 `validationFailed: boolean`。 |
| 8 | LOW | plan.md:File Structure | **文件数不一致**。File Structure 表列出 7 个文件（index.ts, package.json, src/index.ts, src/config.ts, src/recall-store.ts, src/compressor.ts, src/commands.ts），不含 widget.ts。但 spec Complexity Assessment 说"5-6"文件并提到 widget.ts。 | 统一为 File Structure 的 7 文件（不含 widget.ts），修正 Complexity Assessment 的数字和描述。Widget 功能（命令的 TUI 渲染）由 commands.ts 内联处理，不需要独立文件。 |
| 9 | INFO | plan.md:Task 6 | **单元测试仅覆盖 compressor.ts**。config.ts（loadConfig/parseLevelArgs）、recall-store.ts（store/recall/clear）、commands.ts（命令解析）没有独立单元测试。L1 复杂度下可通过集成测试和手动验证覆盖，但 config.ts 的 JSONL 解析逻辑和 commands.ts 的参数解析是容易出错的纯函数，适合单元测试。 | 建议在 Task 6 中补充 config 和 recall-store 的基础测试（各 2-3 个 case），或明确标注"通过手动验证覆盖"。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

## 结论

需修改后重审。

## Summary

计划评审完成，第1轮，3条MUST FIX（settings 文件名/解析逻辑错误、processL0 签名不完整、Wave Schedule 矛盾），需修改后重审。
