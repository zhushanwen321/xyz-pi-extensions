---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-25T18:30:00"
  target: ".xyz-harness/2026-05-25-pi-workflow-feasibility/spec.md"
  verdict: fail
  summary: "Spec 完整性审查，第1轮，2条 MUST_FIX，需修改后重审"

statistics:
  total_issues: 5
  must_fix: 2
  must_fix_resolved: 0
  low: 3
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:D1 章节"
    title: "Worker 线程使用违反 CLAUDE.md 扩展约束"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "spec.md:Constraints → 子进程执行"
    title: "Subagent 扩展内部耦合，缺少接口抽象层"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "spec.md:D3 / FR3 章节"
    title: "DAG 术语与设计描述矛盾"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "spec.md:Constraints → 兼容约束"
    title: "Claude Code Workflow 兼容性范围模糊"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md:Complexity Assessment → TUI 面板"
    title: "Pi TUI API 依赖未标记为 [待决议]"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 完整性审查 v1

## 评审记录

- 评审时间：2026-05-25 18:30
- 评审类型：计划评审（Spec 完整性维度）
- 评审对象：`.xyz-harness/2026-05-25-pi-workflow-feasibility/spec.md`

---

## 审查方法论

依据 `xyz-harness-expert-reviewer` SKILL.md 模式一（计划评审）第 1 项「spec 完整性」的四维标准：

1. **目标明确性** — 一段话能说清楚要做什么
2. **范围合理性** — 不过大不过小，有明确边界
3. **验收标准可量化** — 能写测试验证
4. **[待决议] 项** — 如有需评估风险

同时对照项目 `CLAUDE.md` 架构约束进行合规审查。

---

## 审查结果

### 1. 目标明确性 ✅

目标清晰：*"在 Pi 上实现兼容 Claude Code Workflow JS 脚本格式的通用多 Agent 编排引擎"*。Background 段落的动机描述充分，成功定义中的 7 条项目具体可验证。

### 2. 范围合理性 ✅

有明确的 `Out of Scope (P0)` 表格，列出 6 项未来扩展。FR1-FR10 的划分覆盖了核心需求但有适度边界，不过大。Constraints 章节中的技术/兼容/安全约束进一步圈定了范围。

### 3. 验收标准可量化 ✅

AC1-AC7 全部采用 checkbox 格式，每项包含具体、可观测的测试点。例如 AC1 的 4 个检查点（返回 runId / 顺序执行 / 面板显示 / 结果通知）都可以直接写测试验证。没有出现"提升用户体验"类模糊描述。

### 4. [待决议] 项 ⚠️

**未发现显式 `[待决议]` 标记。** 但 Complexity Assessment 中 TUI 面板的风险项 "Pi TUI API 需确认支持" 属于未确认的依赖，应当标记为 `[待决议]`（见 #5）。

---

## 发现的问题

### #1 MUST_FIX: Worker 线程使用违反 CLAUDE.md 扩展约束

**位置**：`spec.md → D1: Worker 线程执行 JS 脚本`

**问题描述**：
Spec D1 决策选择 Node.js `worker_threads` 模块作为 JS 脚本执行容器。项目 `CLAUDE.md` 「关键约束 → 运行环境」明确规定：

> *扩展不能依赖 fs 之外的 Node.js 原生模块（网络、child_process 等由 Pi 核心控制）。**subagent 是已知例外**——它使用 `child_process.spawn` 启动独立 Pi 进程*

`worker_threads` 是 Node.js 原生（built-in）模块，与 `child_process` 同级，不属于 `fs`。项目只对 `child_process` 给了 subagent 一个已知例外。Workflow Extension 使用 `worker_threads` 需要：

1. 要么在 CLAUDE.md 中增加 `worker_threads` 为已知例外（或作为 subagent 例外的扩展）
2. 要么在 spec 中明确说明为什么 `worker_threads` 不违反该约束（例如：Pi 运行时在创建 Worker 线程时不做模块拦截）

**影响**：如果 Pi 运行时确实限制了扩展可用的 Node.js 内置模块，此设计将导致实现阶段运行时失败。即使技术上可行，也应记录架构决策。

**修改方向**：
- 在 D1 中新增风险说明："`worker_threads` 不在 CLAUDE.md 允许的 Node.js 原生模块列表中，需要确认 Pi 运行时是否允许扩展使用。如果受限，备选方案为 `vm` 模块（隔离性较弱）或独立 subprocess（通信开销较大）。"
- 或将 `worker_threads` 添加到 CLAUDE.md 的已知例外列表。

---

### #2 MUST_FIX: Subagent 扩展内部耦合，缺少接口抽象层

**位置**：`spec.md → Constraints → 子进程执行` / `Complexity Assessment → Agent Executor`

**问题描述**：
Spec 多处直接引用 Subagent Extension 的内部实现细节：

- *"复用 Subagent Extension 的 `spawn pi --mode json` + JSONL 解析机制"*
- *"直接复用 Subagent Extension 的 `runSingleAgent()`"*
- *"全局 agent 子进程并发数上限 4（与 Subagent Extension 一致）"*
- *"复用 Subagent Extension 的 `taskComplexity` + `model` 选择机制"*

Subagent Extension 是 `xyz-pi-extensions` 中的另一个独立扩展，其内部 API（如 `runSingleAgent()`）未暴露为公共接口。如果 Subagent Extension 在其他迭代中修改了内部实现（如重命名函数、改变参数签名、重构并发控制），Workflow Extension 将直接损坏。

**影响**：两个扩展形成紧耦合，违反"扩展独立可安装"的设计目标（CLAUDE.md 概述）。

**修改方向**：
- 定义抽象接口层：提取 `AgentExecutorService` 或类似接口，由两个扩展共同依赖
- 或在 spec 中明确文档化：Subagent Extension 需要一个稳定的公共 API（例如 `executeAgent(opts): Promise<AgentResult>`），Workflow Extension 只依赖该公共 API
- 考虑将这个接口提取到共享模块（如 `shared/` 或第三个基础扩展）

---

### #3 LOW: DAG 术语与设计描述矛盾

**位置**：`spec.md → D3 / FR3`

**问题描述**：
Spec 使用"Directed Acyclic Graph"（DAG）术语来描述执行轨迹，但 FR3.3 和 D3 明确说明：

> *DAG 图是简单的线性节点序列（callId 递增），不含显式边或拓扑排序。执行顺序完全由 Worker 中的 JS 控制流决定*

线性序列不是图（无边），更不是有向无环图（无方向关系）。术语"DAG"会误导读者认为存在节点间的显式依赖关系。

**影响**：术语误导性，可能在实现和文档中引发混淆。

**修改方向**：
- 将"执行轨迹（call log）"或"调用日志序列"作为主要术语
- 如果仍想使用 DAG 术语（可能为未来扩展），需增加说明："当前实现为线性序列，但数据结构设计为可扩展为显式 DAG"

---

### #4 LOW: Claude Code Workflow 兼容性范围模糊

**位置**：`spec.md → FR1 / Constraints → 兼容约束`

**问题描述**：
Spec 在多次提到"兼容 Claude Code Workflow JS 脚本格式"，但存在以下差异未明确：

1. **子进程机制不同**：Claude Code Workflow 使用 `child_process.fork()`，Pi 使用 `pi --mode json` spawn
2. **API 签名差异**：Claude Code 的 `agent()` API 可能包含 Pi 没有的参数（如 `config`, `maxTokens`）
3. **$ARGS 传递方式不同**：Claude Code 通过 CLI 参数传递，Pi 通过 Tool 参数 / Command 参数传递

Spec 没有定义"兼容"的具体含义——是文件格式兼容？API 签名兼容？行为语义兼容？

**影响**：实现者不清楚兼容到什么程度，可能导致过度兼容（额外工作量）或兼容不足（用户期望不满足）。

**修改方向**：
- 增加 "Compatibility Level" 章节，明确声明兼容范围（如：仅兼容 `meta` 格式 + `agent()`/`parallel()`/`pipeline()` 函数名，不保证参数签名和行为完全一致）
- 或在 FR1.2 中细化，列出一致和不一致的方面

---

### #5 LOW: Pi TUI API 依赖未标记为 [待决议]

**位置**：`spec.md → Complexity Assessment → TUI 面板`

**问题描述**：
Complexity Assessment 表格中，"TUI 面板"组件的风险点标记为 "Pi TUI API 需确认支持"。这是一项未确认的外部依赖——Pi TUI 的 `registerShortcut` 和 `custom()` overlay API 在当前版本中是否可用、行为是否符合 spec 预期，尚未验证。

然而 spec 正文中没有使用 `[待决议]` 标记此依赖。按照方法论要求，未确认的依赖应当显式标记。

**影响**：实现阶段可能发现 TUI API 能力不足，需要重新设计交互方案。

**修改方向**：
- 在 FR5.4 末尾添加 `[待决议：Pi TUI API 的 registerShortcut 和 custom() overlay 在当前版本中是否支持 Ctrl+P/X/R 快捷键]`
- 或在 Constraints 中增加一条：`[待决议：TUI 交互方案依赖 Pi TUI API 能力，如果 registerShortcut 不支持全部按键，需 fallback 到纯 overlay 方案]`

---

## 全局评估

### 六要素覆盖率

| 要素 | 状态 | 说明 |
|------|------|------|
| **Outcomes** (目标/成功定义) | ✅ | Background + 成功定义 7 条 |
| **Scope** (FRs + Out of Scope) | ✅ | FR1-10 + Out of Scope 表格 |
| **Constraints** (技术/兼容/安全) | ✅ | 三个约束维度，清晰 |
| **Decisions** (架构决策) | ⚠️ | D1-D4 覆盖了核心决策，但缺少 `worker_threads` 与 CLAUDE.md 的冲突说明 |
| **Acceptance Criteria** | ✅ | AC1-AC7 可量化可测试 |
| **Risks** ([待决议] 项) | ⚠️ | 无显式 [待决议] 标记，但存在未确认的 TUI API 依赖 |

### 其他检查

- **功能需求 → 验收标准可追溯性**：FR1→AC1(部分), FR2→AC1, FR3→AC2, FR4→AC2, FR5→(仅在AC1提及), FR6→AC5, FR7→AC4, FR8→AC6, FR9→(无对应AC), FR10→(无对应AC)
  - FR9（_render 协议）和 FR10（生命周期）没有对应的 AC 覆盖。建议为 FR9 和 FR10 增加 AC。
- **逻辑一致性**：整体一致，DAG 术语矛盾已标注
- **CLAUDE.md 架构合规**：`worker_threads` 使用不符合 CLAUDE.md 约束（#1）

---

## 结论

**需修改后重审。** Spec 结构完整、需求清晰，但存在 2 条 MUST_FIX：

1. **`worker_threads` 使用违反 CLAUDE.md 扩展约束** — 必须解决架构合规性问题
2. **Subagent 扩展内部耦合** — 需要定义接口抽象层

另有 3 条 LOW 建议（术语、兼容性范围、[待决议] 标记），虽不阻塞流程但建议在下一版本中修复。

### Summary

Spec 完整性审查完成，第1轮，2条 MUST_FIX，需修改后重审。
