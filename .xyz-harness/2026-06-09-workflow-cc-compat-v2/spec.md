---
verdict: pass
---

# Workflow CC 兼容性修复 + Structured Output 可靠性 + TUI 重构

## Background

本项目 `extensions/workflow/` 实现了一个 workflow 执行引擎，脚本格式参考了 Claude Code 的 Workflow 工具但存在多处不兼容和可靠性问题。

### 当前问题

1. **Structured Output 几乎必定失败**：workflow agent 调用 `agent(prompt, {schema})` 时，子进程的 LLM 经常不调用 structured-output 工具，导致 `parsedOutput` 为 undefined，workflow 直接报错中断。这是阻塞 workflow 正常使用的 P0 问题。

2. **CC 格式不兼容**：Claude Code 生成的 workflow 脚本（如 `review-fix-loop.js`）无法在 Pi 上正确执行。具体包括 phases 类型过滤、`args` 变量名、parallel/pipeline 签名差异。

3. **TUI 展示粗糙**：Claude Code 有三层 TUI（Footer 最小化 → 全屏两栏 → Agent 详情页），Pi 只有单层 widget 平铺，无 phase 分组、无交互导航。

### 数据来源

- Claude Code 注入提示词：`docs/research/claude-code-prompts/` 全部文件
- 差距分析：`docs/research/claude-code-prompts/workflow-gap-analysis.md`
- Claude Code 生成的脚本：`.claude/workflows/review-fix-loop.js`
- Pi 生成的脚本：`.pi/workflows/review-fix-loop.js`

## Functional Requirements

### FR-1: Structured Output 可靠性 [P0]

**FR-1.1: system prompt 级注入**
当 `agent()` 传入 `schema` 时，将 structured-output 调用指令写入临时文件，通过 `--append-system-prompt <文件路径>` 注入到子进程的 system prompt。Pi 的 `resolvePromptInput` 会自动检测文件路径并读取内容。

临时文件存放位置：`<sessionDir>/workflow-tmp/so-<callId>.txt`，生命周期与 session 一致（session 结束时统一清理）。

**FR-1.2: schema JSON 安全传递**
schema JSON 写入临时文件，通过文件路径传递给 `--append-system-prompt`，避免命令行长度限制和特殊字符问题。

**FR-1.3: 失败自动重试**
当 schema 存在但子进程未产生 structured-output 结果且无任何工具调用时，自动重试一次（加强 system prompt 强调）。

**副作用处理**：Claude Code 无内置策略，靠脚本自身保证节点幂等性。Pi 同理——重试时第一次调用的文件系统副作用会保留，workflow 脚本需自行处理幂等性（如写入前检查文件是否存在、使用唯一文件名等）。

**FR-1.4: hasToolCall 盲区修复**
当 schema 存在、子进程调用了其他工具但没调 structured-output 时，当前逻辑不报错（认为"agent 还在工作中"）。需要增加检测：如果子进程已经完成（exit code 0）且 `parsedOutput` 仍为空，应视为失败。

### FR-2: CC 格式兼容性 [P1]

**FR-2.1: phases 类型扩展**
`config-loader.ts` 的 `WorkflowMeta.phases` 从 `string[]` 扩展为 `(string | {title: string, detail?: string})[]`。regex 解析和 filter 逻辑同步更新。

**FR-2.2: `args` 全局别名**
在 worker-script 中注入 `args` 作为 `$ARGS` 的别名，使 CC 脚本中的 `args` 直接可用。

**FR-2.3: phase 传递到 trace node**
`agent()` 调用时自动将当前 `_currentPhase` 值注入到 opts，传递到 `ExecutionTraceNode.phase` 字段，供 TUI 按 phase 分组。

**显式 phase 覆盖**：当 `agent()` 第二个参数包含 `phase` 字段时（CC 格式：`agent(prompt, {phase: 'Review', schema})`），显式值覆盖全局 `_currentPhase`。worker-script 解析 secondArg 时增加 `phase` 字段提取。

**FR-2.4: parallel() 支持 thunk 数组**
`parallel([...])` 除现有对象参数外，支持 `() => Promise` thunk 数组（CC 格式）。

**FR-2.5: pipeline() 签名扩展**
支持 `pipeline(items, stage1, stage2, ...)` 笛卡尔积模式（CC 格式），保留现有单参数模式向后兼容。

**错误语义**（与 CC 对齐）：单个 item 的某个 stage 抛错时，该 item 的结果为 `null`，跳过后续 stage，其他 item 不受影响。

**FR-2.6: budget 动态函数**
注入 `budget` 全局对象，包含 `total`（静态）、`spent()`（动态）、`remaining()`（动态）。

**实现方式**：主线程在每次 agent 完成后，通过 `parentPort.postMessage({type: 'budget-update', budget: {usedTokens, usedCost}})` 推送预算消耗给 Worker。Worker 中的 `budget` 对象缓存最新值，`spent()` 返回缓存值。

### FR-3: TUI 三层展示 [P2 — 延后到下一阶段]

> **阶段决策**：FR-3 工作量大且不影响 workflow 核心功能。本阶段仅交付 FR-1 + FR-2，FR-3 放到下一迭代。技术可行性已验证，详见 Constraints 章节。
>
> 以下需求保留作为下一阶段的 spec 基础：

**FR-3.1: Footer 最小化展示**
workflow 执行期间，用 `ctx.ui.setFooter()` 显示最小化状态（名称 + 进度 + 状态）。完成后自动清除。不占用 chat input 上方空间。

**FR-3.2: 全屏两栏列表**
`/workflows` 命令进入全屏 overlay（`ctx.ui.custom()`），左栏显示 Phases 分组（含进度），右栏显示当前选中 phase 下的 agent 列表。支持 `↑↓` 在左栏选择 phase，右栏自动过滤。

**FR-3.3: Agent 详情页**
在两栏列表中 `Enter` 选中某个 agent，进入详情页，显示：
- 状态 + 模型 + 耗时 + token 用量
- Prompt 预览（折叠/展开）
- 工具调用活动（最近 N 个 tool call）
- Outcome（agent 的最终文本输出摘要）

**FR-3.4: 交互导航**
全屏 overlay 内支持键盘导航：`↑↓` 选择、`Enter` 进入详情、`Esc` 返回上层、`s` 保存报告。

**FR-3.5: widget 自动消失**
workflow 完成后，setWidget 展示最终状态，但在下一次用户输入时自动清除。

## Acceptance Criteria

### AC-1: Structured Output

- AC-1.1: 给定一个使用 `agent(prompt, {schema})` 的 workflow 脚本，子进程的 system prompt 中包含 structured-output 调用指令
- AC-1.2: 给定 schema 中含特殊字符（引号、换行、反斜杠），注入的 system prompt 不被破坏
- AC-1.3: 给定子进程首次未调用 structured-output 且无其他工具调用，自动重试一次
- AC-1.4: 给定子进程调用了其他工具但未调用 structured-output 且已退出，返回失败（非静默忽略）

### AC-2: CC 兼容性

- AC-2.1: 给定 CC 格式脚本 `export const meta = { phases: [{title:'Review'}, {title:'Fix'}] }`，config-loader 正确解析 phases
- AC-2.2: 给定 CC 脚本中使用 `args.maxIterations`，worker-script 中 `args` 变量可访问
- AC-2.3: 给定脚本中调用 `phase('Review')` 后再调用 `agent()`，trace node 的 `phase` 字段为 `'Review'`
- AC-2.4: 给定 `parallel([() => agent("t1"), () => agent("t2")])`，两个 agent 并发执行
- AC-2.5: 给定 `pipeline([1,2,3], x => agent("process "+x), r => agent("verify "+r))`，3 个 item 各自独立通过两个 stage

### AC-3: TUI [延后到下一阶段，AC 保留作为参考]

- AC-3.1: workflow 执行期间，Footer 区域显示进度信息
- AC-3.2: `/workflows` 命令进入全屏 overlay，显示两栏布局
- AC-3.3: 左栏显示 phase 分组，右栏显示选中 phase 的 agent 列表
- AC-3.4: Enter 选中 agent 后显示详情页，包含 prompt/tool calls/outcome
- AC-3.5: Esc 返回上层，workflow 完成后 widget 自动清除

## Constraints

- **向后兼容**：现有 Pi 格式脚本（`const meta = {phases: ['name']}` + `$ARGS`）必须继续工作
- **子进程限制**：workflow agent 运行在 `pi --mode json -p` 子进程中，无法使用主进程的 hook 或 session state
- **TUI API 已验证**：Pi TUI 的 `ctx.ui.custom()` 支持 `handleInput(data)` 键盘事件捕获和动态重绘（通过 Component 的 `render()` 方法）。`KeybindingsManager.matches(data, keybinding)` 可匹配按键。
- **Pi CLI 已验证**：`--append-system-prompt <text>` 参数已支持（`pi --help` 确认），可用于 structured-output 指令的 system prompt 级注入
- **扩展加载已验证**：子进程不传 `--tools`/`--exclude-tools`，会加载所有已安装扩展（包括 structured-output），工具可用
- **临时文件清理**：`<sessionDir>/workflow-tmp/` 目录下的临时文件生命周期与 session 一致。session 结束时由 Pi 统一清理（或由 orchestrator 在 workflow 完成/中止时主动清理）
- **单文件行数上限**：1000 行（`widget.ts` 重构后可能接近上限，需拆分）

### Assumption Audit

| # | 假设 | 验证方式 | 状态 |
|---|------|---------|------|
| 1 | `--append-system-prompt` 支持文件路径 | `pi --help` 确认 | [VERIFIED] |
| 2 | 子进程加载 structured-output 扩展 | 源码：buildArgs 不传 --exclude-tools | [VERIFIED] |
| 3 | `ctx.ui.custom()` 支持键盘交互 | 源码：Component.handleInput(data) | [VERIFIED] |
| 4 | `setWidget` 支持 Component factory | 源码：types.ts 第 164 行重载签名 | [VERIFIED] |
| 5 | `setFooter` 支持 Component factory | 源码：types.ts 第 176 行 | [VERIFIED] |
| 6 | `KeybindingsManager.matches()` 可在 custom overlay 中使用 | custom factory 接收 keybindings 参数 | [VERIFIED] |
| 7 | `--append-system-prompt` 自动检测文件路径 | resolvePromptInput: existsSync → readFile | [VERIFIED] |
| 8 | Claude Code 无重试副作用策略 | CC Workflow 描述仅提及模型级 tool-call retry | [VERIFIED] |
| 9 | Worker 线程可通过 parentPort 接收预算更新 | 已有 budget-warning 消息通道 | [VERIFIED] |

## 业务用例

### UC-1: Review-Fix 循环（跨平台脚本）

- **Actor**: 开发者
- **场景**: 开发者在 Pi 或 Claude Code 中执行 `ultracode 创建一个 review-fix-loop workflow`
- **预期结果**: 同一份 workflow 脚本在两个平台上都能正确执行。agent 调用 structured-output 工具返回 `{review-report, must-fix}`，循环在 must-fix=0 或达到上限时停止。TUI 按 Review/Fix 两个 phase 分组显示进度。

### UC-2: Structured Output 首次失败自动恢复

- **Actor**: workflow 脚本
- **场景**: agent 执行代码审查但首次未调用 structured-output 工具（弱模型忽略 prompt 指令）
- **预期结果**: 系统自动重试一次（加强 system prompt），第二次调用成功返回结构化数据。用户无感知，workflow 正常继续。

### UC-3: /workflows 全屏监控

- **Actor**: 开发者
- **场景**: 长时间运行的 workflow，开发者想查看详细进度
- **预期结果**: 输入 `/workflows` 进入全屏两栏视图。左栏看到 Review(4/4) + Fix(3/3) 的 phase 进度。选中 Review phase 后右栏显示 4 个 agent 的状态和耗时。Enter 选中 review-2 后看到完整 prompt、23 个工具调用列表、和 outcome 摘要。

## Complexity Assessment

**整体复杂度**：中等偏高

| 模块 | 复杂度 | 原因 |
|------|--------|------|
| FR-1 Structured Output | 低 | 改动集中在 `buildArgs()` 和 `spawnAndParse()`，逻辑清晰 |
| FR-2 CC 兼容 | 低-中 | 多处小改动，每处 < 20 行。pipeline 笛卡尔积稍复杂 |
| FR-3 TUI 重构 | 高 | 全新交互式 UI，需验证 Pi TUI 能力边界，可能需要 300+ 行 |

**风险点**：
1. `ctx.ui.custom()` 的键盘交互能力未经验证，可能需要降级方案
2. `pipeline(items, stage1, stage2)` 的笛卡尔积实现需要仔细设计错误传播语义
3. widget.ts 重构后行数可能超限，需要拆分文件

## 实现范围外 (Out of Scope)

- `workflow()` 嵌套调用（CC 支持 1 层嵌套，Pi 暂不支持）
- `opts.isolation: 'worktree'` per-agent worktree 隔离
- `opts.agentType` 与 agent 注册表的深度集成
- ESM 模块系统支持（`import/export` 语法）
- `/workflows s save` 报告保存（P3）
- workflow resume（已有实现，不在本次范围内）
- **FR-3 TUI 重构**（本阶段延后，下一阶段交付）

## 下阶段参考：TUI 技术方案

> 以下为 FR-3 TUI 重构的实现参考，供下一阶段直接使用。

### Pi TUI 交互能力（已验证）

| API | 能力 | 使用方式 |
|-----|------|----------|
| `ctx.ui.custom(factory)` | 全屏 overlay，接收 `(tui, theme, keybindings, done)` | 两栏列表 + 详情页 |
| `Component.handleInput(data)` | 键盘事件捕获 | `↑↓` 导航 / `Enter` 确认 / `Esc` 返回 |
| `KeybindingsManager.matches(data, keybinding)` | 按键匹配 | `matches(data, 'tui.select.up')` |
| `ctx.ui.setFooter(factory)` | Footer 区域 Component | 执行时最小化展示 |
| `ctx.ui.setWidget(key, factory)` | Widget 区域 Component | 完成后最终状态 |
| `done(result)` 回调 | 退出 overlay 并返回值 | Esc 返回时调用 `done(undefined)` |

### 三层 TUI 实现方案

```
Layer 1: setFooter() — 执行时最小化
  factory(tui, theme, footerData) → Component
  显示: "★ review-fix-loop · 3/7 agents · 5m32s"
  完成: setFooter(undefined) 清除

Layer 2: ctx.ui.custom() — 全屏两栏
  factory(tui, theme, kb, done) → 两栏 Component
  左栏: phases 列表（来自 ExecutionTraceNode.phase 分组）
  右栏: 当前 phase 下的 agents
  handleInput: kb.matches(data, 'tui.select.up/down') 移动高亮
  Enter: 进入 Layer 3
  Esc: done(undefined) 退出

Layer 3: ctx.ui.custom() — agent 详情
  factory(tui, theme, kb, done) → 详情 Component
  内容: model + tokens + duration + prompt preview + tool calls + outcome
  Enter: 展开/折叠 prompt
  Esc: done(undefined) 返回 Layer 2
```

### Phase 分组数据源

`ExecutionTraceNode` 增加 `phase?: string` 字段后，TUI 按 phase 聚合 trace nodes：
```typescript
const byPhase = new Map<string, ExecutionTraceNode[]>();
for (const node of traceNodes) {
  const phase = node.phase || 'default';
  byPhase.set(phase, [...(byPhase.get(phase) || []), node]);
}
```
