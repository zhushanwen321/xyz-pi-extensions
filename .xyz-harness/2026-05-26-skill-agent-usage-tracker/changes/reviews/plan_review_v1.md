---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-27T10:00:00"
  target: ".xyz-harness/2026-05-26-skill-agent-usage-tracker"
  verdict: fail
  summary: "计划评审完成，第1轮，1条MUST FIX，需修改后重审"

statistics:
  total_issues: 4
  must_fix: 1
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md (Task 1, Step 3)"
    title: "Missing defensive guard for empty skillMap per FR-3 — tool_call handler silently skips counting without logging"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "plan.md (Task 1, Step 3)"
    title: "Pseudocode accesses `event.input.path` without type narrowing — relies on `isToolCallEventType` which should be incorporated for type safety"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "e2e-test-plan.md (TS-2)"
    title: "TS-2 only tests single-mode subagent invocation; AC-2 requires parallel and chain mode coverage"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: INFO
    location: "spec.md (FR-3)"
    title: "Pi runtime timing guarantee (before_agent_start fires before all tool_call per turn) is assumed but undocumented in Pi API"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-27 10:00
- 评审类型：计划评审
- 评审对象：Skill & Agent Usage Tracker (spec + plan + e2e-test-plan + use-cases + non-functional-design)
- 评审方法：模式一（计划评审）
- Complexity：L1

---

## 1. Spec 完整性

### 1.1 目标明确性

**通过。** Spec 在一段话内清晰表述了目标：构建一个被动采集扩展，追踪 skill 全文加载和 agent 调用，配以分析 skill。

### 1.2 范围合理性

**通过。** 范围边界清晰：
- Extension 做采集，不注册任何 tool/command/widget（AC-6 明确约束）
- Skill 做分析，不参与数据采集
- 纯被动监听事件，不修改 Pi 状态
- 数据只记录名称和计数，不含路径、参数、对话内容

### 1.3 验收标准可量化

**通过。** 6 条 AC 均可通过实际操作验证（读 skill → 检查文件计数；调 subagent → 检查计数；多 session → 累加验证；写失败 → 检查 stderr；加载 skill → 检查分析报告；/tools 无新增项）。无模糊标准。

### 1.4 待决议项

**无。** Spec 未标记 `[待决议]` 项。

### 1.5 补充观察

FR-3 强依赖 Pi 运行时行为保证（"before_agent_start 在该 turn 的所有 tool_call 之前触发"）。此保证未被 Pi API 文档明确承诺。当前 Pi 事件实现（查询 types.d.ts 确认 `ExtensionEvent` 为 discriminated union）排序正确，但未在 API 层面契约化。已标记为 INFO。

---

## 2. Plan 可行性

### 2.1 任务拆分合理性

**通过。** 3 个 Task：
| # | Task | 文件数 | 类型 | 可独立完成 |
|---|------|--------|------|-----------|
| 1 | Extension event listeners + counting + persistence | 3 | backend | 是 |
| 2 | usage-analyzer SKILL.md | 1 | backend | 是 |
| 3 | Symlink install + manual verification | 0 (2 symlinks) | backend | 是 |

粒度适中，每个 Task 可由一个 subagent 独立完成。

### 2.2 依赖关系正确性

**通过。** BG1, BG2 → BG3。Extension 和 SKILL 可并行开发，安装步骤在两者之后。依赖图清晰。

### 2.3 工作量估算现实性

**通过。** Task 1 是核心（3 文件，~150-200 行 TS），Task 2 是纯 Markdown，Task 3 是链接 + 手动验证。Complexity Assessment 标记为 Low，与实际一致。

### 2.4 遗漏 Task 检查

对照 Spec FR-1 ~ FR-6 逐条检查：

| Spec 需求 | 对应 Task | 状态 |
|-----------|-----------|------|
| FR-1 Skill 使用计数 | Task 1 | ✅ |
| FR-2 Agent 使用计数 | Task 1 | ✅ |
| FR-3 Skill 路径映射 + 防御性 guard | Task 1 | ⚠️ 防御性 guard 部分缺失（见 MUST FIX #1） |
| FR-4 跨 session 持久化 | Task 1 | ✅ |
| FR-5 日志输出 | Task 1 | ✅ |
| FR-6 分析 Skill | Task 2 | ✅ |

### 2.5 Pi API 类型完整性验证

已对照 `@mariozechner/pi-coding-agent` 的类型定义验证所有假设：

| 类型引用 | 实际定义 | 状态 |
|----------|---------|------|
| `BeforeAgentStartEvent.systemPromptOptions` | `BuildSystemPromptOptions`（非可选）| ✅ |
| `BuildSystemPromptOptions.skills` | `Skill[] \| undefined`（可选） | ✅ |
| `Skill.filePath` | `string` | ✅ |
| `Skill.name` | `string` | ✅ |
| `ReadToolCallEvent.input.path` | `string` | ✅ |
| `CustomToolCallEvent.input` | `Record<string, unknown>` | ✅ |
| `isToolCallEventType` | 类型守卫函数 | ✅ |

所有类型假设与当前 Pi API 一致，无需担心断崖兼容风险。

---

## 3. Spec 与 Plan 一致性

### 3.1 AC 覆盖矩阵

| AC | Plan 映射 | 一致性 |
|----|----------|--------|
| AC-1 Skill 全文加载计数 | Task 1 (tool_call → incrementAndPersist) | ✅ |
| AC-2 Agent 调用计数 | Task 1 (tool_call → agent 解析 → incrementAndPersist) | ✅ |
| AC-3 跨 session 累加 | Task 1 (read-modify-write) | ✅ |
| AC-4 写失败不阻塞 | Task 1 (try-catch) | ✅ |
| AC-5 usage-analyzer skill | Task 2 | ✅ |
| AC-6 纯被动采集 | Task 1 (无 registerTool) | ✅ |

所有 6 条 AC 在 plan 中均有对应实现步骤。

### 3.2 Plan 中无 spec 未提及的额外工作

Plan 无超出 spec 范围的 Task。Task 3（安装 + 验证）属于标准的部署步骤，合理。

### 3.3 AC 与 Task 的可追溯性

每条 AC 都能在 plan 中找到对应的实现步骤（见 Spec Coverage Matrix 表格）。验收标准中的可验证行为都对应了具体的实现细节。

---

## 4. Execution Groups 合理性

### 4.1 分组合理性

| Group | Tasks | 文件数 | 是否≤10 | 评估 |
|-------|-------|--------|---------|------|
| BG1 Extension Core | 1 | 3 create | ✅ 是 | 合理 |
| BG2 Analysis Skill | 1 | 1 create | ✅ 是 | 合理 |
| BG3 Install & Verify | 1 | 0 (2 symlinks) | ✅ 是 | 合理 |

### 4.2 类型划分

所有 Task 均为 backend 类型，无前后端混合问题。✅

### 4.3 功能关联度

- BG1：三个文件（package.json + index.ts + src/index.ts）是标准扩展骨架，关联紧密 ✅
- BG2：单一 SKILL.md 文件 ✅
- BG3：链接 + 验证步骤 ✅

### 4.4 Subagent 配置完整性

| Group | Agent | 注入上下文 | 读取文件 | 创建文件 | 完整性 |
|-------|-------|-----------|---------|---------|--------|
| BG1 | general-purpose (medium) | Task 1 + FR-1~5 + Pi types + todo 参考 | todo/src/index.ts, Pi types | 3 文件 | ✅ |
| BG2 | general-purpose (low) | Task 2 + FR-6 | 无 | 1 文件 | ✅ |
| BG3 | general-purpose (low) | Task 3 + 安装路径 | usage-stats.json | 2 symlinks | ✅ |

### 4.5 Wave 编排

```
Wave 1: BG1 ──┐
         BG2 ──┤
Wave 2:        └──→ BG3
```

Wave 1 并行执行 BG1 + BG2 无冲突（BG1 写入 `usage-tracker/`，BG2 写入 `usage-analyzer/`，不同目录）。✅

### 4.6 上下文充分性

BG1 注入上下文包括 Pi Extension API 类型引用和 `todo/src/index.ts` 作为参考模式。但对于 Task 1 的关键部分（如何正确使用 `isToolCallEventType` 区分 `ReadToolCallEvent` 和 `CustomToolCallEvent`），注入上下文可以更精确（见 LOW #2）。

BG2 单独创建 Markdown 文件，上下文充分。✅

---

## 5. 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | plan.md (Task 1, Step 3) — tool_call handler pseudocode | 缺少 FR-3 要求的空 skillMap 防御性 guard。Spec FR-3 明确要求"tool_call 处理中若映射表为空，跳过匹配并输出 console.error 日志"。Plan 的 tool_call handler 只检查 `initialized` 标记，但未在 `initialized=true && skillMap.size===0` 时输出日志。 | 在 tool_call handler 中，`if (!initialized) check` 之后增加：`if (skillMap.size === 0) { console.error("[usage-tracker] Skill map empty, cannot match read paths"); return; }`。同时在 before_agent_start 中将 `initialized = true` 的赋值移到 `skillMap.size > 0` 条件之后，或分别追踪 map 构建状态和是否触发过事件。 |
| 2 | LOW | plan.md (Task 1, Step 3) — tool_call handler pseudocode | Plan 伪代码直接写 `event.input.path` 和 `event.input.tasks?.forEach`，但 `ToolCallEvent` 是联合类型（8 种变体）。要安全地访问 `ReadToolCallEvent.input.path` 和 `CustomToolCallEvent.input`，需使用 `isToolCallEventType("read", event)` 和 `isToolCallEventType("subagent", event)` 类型守卫进行类型收窄。不加守卫时 TypeScript 无法推断 `input` 的具体结构。 | 将 tool_call handler 中的 `if event.toolName === "read"` 改为 `if isToolCallEventType("read", event)`，对 subagent 同理。 |
| 3 | LOW | e2e-test-plan.md (TS-2) | TS-2 只覆盖了单 agent 模式（`input.agent`），但 AC-2 要求"无论 single/parallel/chain 模式"都计数。缺少 parallel（`tasks[].agent`）和 chain（`chain[].agent`）模式的测试场景。 | 为 TS-2 补充两个附加步骤：2a) 触发 parallel mode subagent 调用并验证所有 agent 均计数；2b) 触发 chain mode subagent 调用并验证 chain 中所有 agent 均计数。 |
| 4 | INFO | spec.md (FR-3) | Spec 依赖"Pi 运行时保证 before_agent_start 在该 turn 的所有 tool_call 之前触发"这一时序保证。该保证不在 Pi Extension API 的类型或文档中显式声明。目前 Pi 的事件分发机制（基于 `ExtensionEvent` discriminated union）确实遵循此顺序，但如果未来重构事件分发顺序，依赖此保证的扩展可能静默失效。 | 在 spec 中添加备选方案说明：如果时序保证不成立（即 tool_call 在 before_agent_start 之前触发），防御性 guard（空 skillMap 时跳过 + console.error）提供最基本的可靠性保障。可考虑将初试化检查改为"on-demand 构建"模式作为长期安全网。 |

---

## 6. 其他维度检查

### 6.1 项目架构合规性（对照 CLAUDE.md）

| 约束 | Plan 是否满足 | 说明 |
|------|-------------|------|
| 扩展目录结构 (`{index.ts, package.json, src/index.ts}`) | ✅ | usage-tracker/ 完全匹配 |
| 扩展工厂函数 `export default function xxxExtension(pi: ExtensionAPI)` | ✅ | Plan 的 factory 签名正确 |
| 模块级 `let` 变量共享问题 | ✅ | skillMap + initialized 在闭包内，before_agent_start 重建 |
| 无自定义 `node_modules` | ✅ | 只用了 fs/path/os（Node built-in）+ Pi API |
| 无 tool/command/widget 注册 | ✅ | AC-6 明确承诺 |
| 单文件 ≤ 1000 行 | ✅ | 3 文件合计预计 ~200 行 |
| 单函数 ≤ 80 行 | ✅ | 各 handler 都很短 |

### 6.2 数据持久化设计合规性

| FR-4 约束 | Plan 实现 | 评估 |
|-----------|----------|------|
| 写入前重新读取 | `incrementAndPersist` 每轮 read-modify-write | ✅ |
| 写入失败 console.error | catch 块 | ✅ |
| 不阻塞 Pi 主流程 | try-catch 无 propagate | ✅ |
| 路径固定 | `~/.pi/agent/usage-stats.json` | ✅ |
| 已知限制文档化 | Plan 在 Key implementation notes 中提及 | ✅ |

### 6.3 Use Cases 与 Spec 一致性

UC-1 覆盖了完整的用户场景，AP-1/AP-2 覆盖了数据文件不存在/为空两种异常路径。Module Boundaries 清晰划分了 extension 与 skill 的职责。✅

### 6.4 Non-Functional Design 一致性

5 个维度（稳定性、数据一致性、性能、业务安全、数据安全）分析充分。与 plan 的 read-modify-write 策略一致。无矛盾。✅

---

## 7. 结论

**需修改后重审。**

当前存在 1 条 MUST FIX（plan.md 缺少 FR-3 要求的空 skillMap 防御性 guard），2 条 LOW（类型守卫优化 + 测试覆盖缺口），1 条 INFO（时序假设备案）。

修复 MUST FIX 后，plan 整体质量良好：spec-plan 一致性完整、Execution Groups 划分合理、API 类型验证通过、架构规范合规、持久化策略周全。

---

## Summary

计划评审完成，第1轮，1条MUST FIX，需修改后重审。
