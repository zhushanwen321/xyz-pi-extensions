---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-27T16:00:00"
  target: ".xyz-harness/2026-05-27-self-evolution-phase3/spec.md"
  verdict: fail
  summary: "Spec 完整性评审完成，第1轮，1条 MUST FIX（架构约束冲突），4条 LOW，2条 INFO"

statistics:
  total_issues: 7
  must_fix: 1
  must_fix_resolved: 0
  low: 4
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md Constraints §「不依赖 subagent extension: 直接使用 Node.js child_process.spawn」"
    title: "child_process.spawn 违反 CLAUDE.md 架构约束"
    description: >
      spec Constraints 明确声明 "直接使用 Node.js child_process.spawn" 启动 LLM Judge 子进程。
      但 CLAUDE.md 运行环境约束规定：「扩展不能依赖 fs 之外的 Node.js 原生模块（网络、child_process 等由 Pi 核心控制）。subagent 是已知例外」。
      evolution-engine 不是 subagent extension，直接使用 child_process.spawn 违反项目架构约束。
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: LOW
    location: "spec.md FR-2 §System Prompt 模板"
    title: "templates/ 目录位置与 CLAUDE.md 约定的扩展结构不一致"
    description: >
      CLAUDE.md 推荐的扩展结构为 src/templates.ts（TypeScript 模板模块），spec 使用根目录
      templates/ 加 .txt 文本文件。技术上可工作（通过 fs.readFileSync 加载），但偏离了项目约定模式。
      建议统一为 src/templates.ts 或至少注明理由。
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "spec.md FR-7 §自动触发规则"
    title: "FR-7 自动触发规则存在除零风险"
    description: >
      「Token 效率下降」比较最近 7 天均值 vs 前 7 天均值；「错误率突升」比较最近 3 天
      failures/total vs 前 30 天均值。当对应窗口无 session 或无 tool calls 时，分母为 0，
      导致除零异常。未指定这种边缘情况的处理策略。
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "spec.md AC-1"
    title: "AC-1「至少产生 1 条可操作建议」依赖真实数据量"
    description: >
      在数据量小或用户习惯已优化的场景下，LLM Judge 可能返回 0 条建议。此时 AC-1 将无法通过，
      但这不是系统缺陷。建议明确「0 条建议也为合格通过」的特殊处理逻辑，或者为测试环境
      准备可预测的 mock 数据。
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "spec.md FR-1 Step 4"
    title: "临时文件目录未指定"
    description: >
      "构建 LLM Judge 输入并写入临时文件" 未明确临时文件路径。使用系统 /tmp 可能被清理，
      使用 evolution-data/ 下的临时目录需要自行清理。建议指定一个确定的位置和清理策略。
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "spec.md FR-7 §自动触发规则"
    title: "Auto-trigger flag 无自动清理机制"
    description: >
      flag 文件在触发条件不再满足后不会被自动清理。用户可能看到已恢复指标的过期提示。
      建议每日分析时，若条件不再满足则删除对应 flag 文件。
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: INFO
    location: "spec.md FR-1 §命令参数表 — `--sample`"
    title: "`--sample` 参数语义不明确"
    description: >
      `--sample` 描述为「抽样 session 数」，但未说明该参数是对 analyze.py 的透传
      （修改 analyze.py 调用参数），还是对 analyze.py 输出报告的后续子集化
      （不修改 analyze.py 调用，只裁剪报告数据）。两种语义导致的行为不同。
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Spec 完整性评审 v1

## 评审记录
- 评审时间：2026-05-27 16:00
- 评审类型：Spec 完整性评审
- 评审对象：`.xyz-harness/2026-05-27-self-evolution-phase3/spec.md`
- 项目约束参考：`CLAUDE.md`
- 评审方法论：xyz-harness-expert-reviewer 模式一（计划评审）第 1 项「spec 完整性」

---

## 方法论说明

本次评审依据 `xyz-harness-expert-reviewer` 的「模式一：计划评审」执行，聚焦于第 1 项检查维度（spec 完整性），同时包含第 5 项（与项目架构约束的一致性）。plan.md 未提供，因此第 2-4 项（plan 可行性、一致性、Execution Groups）不在本次范围内。

---

## 1. Spec 完整性

### 1a. 目标是否明确

**通过。** Background 和 Functional Requirements 清晰描述了合并 Phase 3 + Phase 4 + Phase 5.5 的目标，架构分层图简洁直观，一句话可概括："搭建 evolution-engine Extension，实现信号分析 → LLM Judge 审批 → Applier 应用的闭环"。

### 1b. 范围是否合理

**通过。** 8 个 Functional Requirements 覆盖了核心闭环的每个环节：
- FR-1: 主流程编排
- FR-2: Judge 模板定义
- FR-3: 应用引擎
- FR-4: 续批支持
- FR-5: 数据查看
- FR-6: 回滚
- FR-7: 自动触发
- FR-8: 自动分析降级

Out of Scope 明确排除了 5 个后续阶段的功能和 `_render` 协议，边界清晰。无 `[待决议]` 项。

### 1c. 验收标准是否可量化

**基本通过，有一条边缘情况未明确（见 Issue #4）。** 各 AC 大多满足可验证条件：
- AC-2: 明确的 JSON 字段校验
- AC-3: 明确的行为和错误处理
- AC-4: 精确的计数输出
- AC-5: 具体的文件创建条件
- AC-6: pending.json 的持久化行为
- AC-7: 明确的恢复和记录行为
- AC-1: 模糊点——「至少 1 条建议」依赖真实数据量

### 1d. `[待决议]` 项

**无。** spec 中没有标记任何待决议项，也无不明确的开放性问题。

---

## 2. 与 CLAUDE.md 架构约束的一致性

这是本 spec 最关键的合规检查点。逐条对比：

### 2.1 【MUST FIX】child_process.spawn 架构冲突

**CLAUDE.md 约束：**
> 扩展不能依赖 fs 之外的 Node.js 原生模块（网络、child_process 等由 Pi 核心控制）。subagent 是已知例外——它使用 child_process.spawn 启动独立 Pi 进程

**Spec 声明：**
> Constraints: 不依赖 subagent extension: 直接使用 Node.js child_process.spawn

**冲突分析：** evolution-engine Extension **不是 subagent extension**，不能以「已知例外」的名义使用 `child_process.spawn`。Spec 主动排除了对 subagent extension 的依赖，却又需要 `child_process.spawn` 的功能，形成了一个矛盾——既要马儿跑，又要马儿不吃草。

**必须选择的修复方向之一：**
1. 将 evolution-engine 声明为第二个 child_process 例外，在 CLAUDE.md 中更新约束文本
2. 转而依赖 subagent extension（在 `package.json` 中声明依赖），通过 subagent tool 调度 Judge 子进程
3. 由 Pi 核心提供 `pi.spawnSubprocess()` 或类似 API（需要与 Pi 核心协调）

### 2.2 扩展结构一致性

**CLAUDE.md 推荐结构：**
```
<extension>/
  index.ts
  package.json
  src/
    index.ts
    state.ts
    templates.ts
    widget.ts
    commands.ts
```

**Spec 隐含结构：**
- 使用根目录 `templates/` 加 `.txt` 文件存放 prompt 模板
- 其余组件（commands、widget 等）未指定，推测遵循规范

**评估：** `templates/` vs `src/templates.ts` 是约定偏移，但非架构违规。文本文件更便于独立迭代 prompt 而不改动代码，有一定合理性。建议在 spec 或后续 plan 中明确说明选择理由。（Issue #2 - LOW）

### 2.3 其他约束一致性

| CLAUDE.md 约束 | Spec 符合性 | 备注 |
|---|---|---|
| 扩展在 Pi 进程内执行 | ✅ | evolution-engine 本身在进程内，子进程是 Judge |
| Session 隔离（闭包/entries） | ✅ | FR-7 使用 session_start 事件，未引入模块级可变状态 |
| 状态持久化（appendEntry） | ✅ | history.jsonl 通过文件系统记录，不在 entries 中 |
| Tool 设计规范 | N/A | spec 定义的是 commands 而非 tools，不受此约束 |
| TUI 渲染规范 | ✅ | 指定 TUI 交互，未违反渲染规范 |
| `_render` 协议 | ✅ | Out of Scope 明确排除，首版仅 TUI |
| TypeScript 规范 | ✅ | 无冲突 |
| taste-lint 规范 | ✅ | 无冲突 |

---

## 3. 边界条件和错误场景覆盖

逐条检查 spec 中各 FR 的错误处理声明：

| FR | 已覆盖的错误场景 | 遗漏的边缘情况 |
|---|---|---|
| FR-1 (Step 2) | analyze.py 不存在时自动执行 | ✅ covered |
| FR-1 (Step 3) | analyze.py 执行失败时显示错误并终止 | ✅ covered |
| FR-1 (Step 6-8) | Judge 非 JSON 返回的处理 | ✅ covered |
| FR-1 (Step 8) | 非 JSON 时记录 raw output 到 evolution-data | ✅ covered |
| FR-3 (Step 2) | diff 应用失败时跳过并标记 | ✅ covered |
| FR-3 (Step 6) | git commit 失败时 warning | ✅ covered |
| FR-6 | backup 文件不存在时显示错误不执行 | ✅ covered |
| FR-7 Step 1 | 分母为 0 的除零问题 | ❌ 未覆盖 (#3) |
| FR-1 Step 4 | 临时文件路径未指定 | ❌ 未指定 (#5) |
| FR-7 | flag 文件过期后未清理 | ❌ 未覆盖 (#6) |
| FR-1 | `--sample` 参数语义模糊 | ❌ 未明确 (#7) |
| FR-3 | pending.json 为空时的行为 | ❌ 未覆盖 |

**总体评估：** 大部分关键错误路径已被覆盖（analyze.py 失败、Judge 返回异常、diff 冲突、backup 丢失、git 失败），说明 spec 作者有较强的错误处理意识。遗漏的主要是数学边界（除零）和目录管理细节。

---

## 4. 内部矛盾检查

| 检查项 | 结果 | 说明 |
|---|---|---|
| FR-1 与 FR-7 冲突 | ✅ 一致 | FR-7 不自动执行 `/evolve`，仅提示 |
| FR-1 Step 3 与 FR-8 矛盾 | ✅ 一致 | FR-1 是 `/evolve` 命令内的重试，FR-8 是 session_start 的自动分析，场景不同 |
| 术语一致性 | ✅ 一致 | `pending.json`、`history.jsonl`、`auto-trigger.flags/` 命名风格统一 |
| 验收标准与功能需求对应 | ✅ 全覆盖 | AC-1~AC-7 分别对应 FR-1~FR-7 |
| Out of Scope 内容 | ✅ 合理 | 排除项与 Phase 路线图一致，`_render` 排除理由充分（首版仅 TUI） |
| 与 CLAUDE.md 约束 | ❌ 冲突 (#1) | child_process.spawn 使用权限冲突 |

---

## 发现的问题

| # | 优先级 | 位置 | 描述 | 修改方向 |
|---|--------|------|------|---------|
| 1 | **MUST FIX** | spec.md Constraints | `child_process.spawn` 直接使用违反 CLAUDE.md | 三种方案选一：(a) 声明为新例外并在 CLAUDE.md 更新 (b) 依赖 subagent extension 调度 Judge (c) 协调 Pi 核心提供 API |
| 2 | LOW | FR-2 | `templates/` 目录偏离 `src/templates.ts` 约定 | 统一为 `src/templates.ts`，或明确说明使用文本文件的理由 |
| 3 | LOW | FR-7 | 自动触发规则除零风险 | 增加分母为 0 时的降级策略（跳过检查或标记为不可比较） |
| 4 | LOW | AC-1 | 「至少 1 条建议」在数据不足时无法满足 | 增加「0 条建议也为通过」的判定逻辑 |
| 5 | LOW | FR-1 Step 4 | 临时文件目录未指定 | 明确路径为 `evolution-data/tmp/` 或 `${TMPDIR}`，注明清理策略 |
| 6 | INFO | FR-7 | Auto-trigger flag 无自动清理 | 每次检查时若条件不再满足则删除对应 flag 文件 |
| 7 | INFO | FR-1 命令参数表 | `--sample` 语义不明确 | 明确是透传 analyze.py 还是对报告子集化 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程。架构约束冲突，可能影响实现可行性。
> - **LOW**：建议修复，但不阻塞。影响代码质量和健壮性。
> - **INFO**：观察记录，无需操作。

---

## 结论

**需修改后重审。** 存在 1 条 MUST FIX（架构约束冲突），需要在 spec 中明确 evolution-engine 如何合法地使用子进程能力。其余 LOW/INFO 问题可在 plan 阶段或实现阶段处理。

核心问题是：**spec 要求使用 `child_process.spawn` 但 CLAUDE.md 禁止非 subagent 扩展使用——这是必须解决的根本冲突。** 不修复则实现会违反项目架构。

---

## Summary

Spec 完整性评审完成，第1轮，1条 MUST FIX，需修改后重审。

### 总体质量评价

- **优点**：核心流程完整（FR-1~FR-8），验收标准可量化，错误处理覆盖度高，边界划定清晰（Out of Scope 合理），无内部矛盾的术语和逻辑
- **缺点**：存在严重架构约束冲突（child_process.spawn），若干边缘情况未覆盖（除零、临时目录、参数语义）
- **风险**：如果强制将 evolution-engine 列为第二个 child_process 例外，需要在 CLAUDE.md 中明确标注，且需要 Pi 核心维护者的认可
