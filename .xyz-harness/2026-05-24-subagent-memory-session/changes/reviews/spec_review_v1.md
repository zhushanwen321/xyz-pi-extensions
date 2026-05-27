---
review:
  type: spec_review
  round: 1
  timestamp: "2026-05-24T16:00:00"
  target: ".xyz-harness/2026-05-24-subagent-memory-session/spec.md"
  verdict: fail
  summary: "Spec 完整性评审完成，第1轮，2条 MUST FIX，需修改后重审"

statistics:
  total_issues: 5
  must_fix: 2
  must_fix_resolved: 0
  low: 1
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-2"
    title: "--fork CLI 参数未经验证，是整个 memory 创建机制的基础假设"
    status: open
    raised_in_round: 1
    resolved_in_roll: null
  - id: 2
    severity: MUST_FIX
    location: "spec.md:FR-3 / FR-4"
    title: "并发写入同一 memory session 文件的竞态条件未处理"
    status: open
    raised_in_round: 1
    resolved_in_roll: null
  - id: 3
    severity: LOW
    location: "spec.md:Complexity Assessment"
    title: "改动范围预估过于乐观，FR-7 渲染改动额外涉及 widget.ts"
    status: open
    raised_in_round: 1
    resolved_in_roll: null
  - id: 4
    severity: INFO
    location: "spec.md:AC-5"
    title: "\"主 session 目录被清理\"的触发机制在 spec 中未确证"
    status: open
    raised_in_round: 1
    resolved_in_roll: null
  - id: 5
    severity: INFO
    location: "spec.md:FR-6"
    title: "FR-6 的 tool description 更新缺少对应的 AC 验证"
    status: open
    raised_in_round: 1
    resolved_in_roll: null
---

# Spec 完整性评审 v1

## 评审记录

- 评审时间：2026-05-24 16:00
- 评审类型：Spec 完整性评审
- 评审对象：`.xyz-harness/2026-05-24-subagent-memory-session/spec.md`

## 检查维度：Spec 完整性

### 1.1 目标是否明确

**结论：通过。**

Background 清晰地描述了问题：subagent 每次调用是冷启动（`--no-session`），对于需要深度项目理解或多轮迭代的任务效率低下。核心目标（在 subagent 扩展上增加 `memory` 参数实现持久化 session）用一句话可以说清楚：

> "让 subagent 拥有持久化的 session 文件，可以在多次调用间复用自己的工作记忆。"

### 1.2 范围是否合理

**结论：通过。**

- `memory` 参数非空时才进入有状态模式，空值时完全不影响现有行为
- Constraints 章节明确声明"不改变现有行为"、"不新增外部依赖"、"单文件改动范围"
- FR-7 的 renderCall/renderResult 展示也在合理范围内
- 没有过度设计（如 TTL 清理、显式管理命令等）

### 1.3 验收标准是否可量化

**结论：通过，但 AC-5、AC-7 有轻微缺陷（见下文 INFO 问题）。**

| AC | 可量化性 | 评语 |
|----|---------|------|
| AC-1 | ✅ | 有明确的 given/when/then，可写测试：创建文件 + CLI 参数 + 返回字段 |
| AC-2 | ✅ | 复用已有文件的检测可测 |
| AC-3 | ✅ | 不变性测试：对比改动前后的行为 |
| AC-4 | ✅ | 给定的输入 (`my agent/task:refactor`) 输出可精确断言 |
| AC-5 | ⚠️ | 依赖的清理机制未定义，见 INFO #4 |
| AC-6 | ✅ | `npx tsc --noEmit` 通过，明确可测 |
| AC-7 | ✅ | `npm run lint` 通过，明确可测 |

### 1.4 是否标记了 [待决议] 项

**结论：通过。**

无 `[待决议]` 标记项，所有设计决策都有明确方案。但有两项隐含假设可能构成潜在风险（见下方 MUST FIX）。

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | spec.md:FR-2 | **`--fork` CLI 参数未经验证**。FR-2 的机制核心依赖 Pi 运行时支持 `--fork <主session文件>` CLI 参数。如果 Pi 不支持此参数，整个首次调用 session 创建机制无法实现。这是整个 spec 的基础假设。 | 验证 Pi 是否支持 `--fork`。如果不支持，定义替代方案（如 cp / symlink / SessionManager API）。 |
| 2 | MUST FIX | spec.md:FR-3 / FR-4 | **并发写入同一 memory session 文件的竞态条件未处理**。如果两个 subagent 使用相同的 `memory` 值并发运行（parallel 模式中各自指定同一 memory），会同时写入同一个 `.mem-*.jsonl` 文件，导致 session 文件损坏或数据交错。 | 明确是否允许同一 memory 并发（如禁止、加锁、或使用不同文件后缀做写隔离）。 |
| 3 | LOW | spec.md:Complexity Assessment | **改动范围预估过于乐观**。声称"核心改动集中在两个文件（spawn.ts + index.ts）"，但 FR-7 要求 renderCall/renderResult 展示 memory 状态。项目架构（CLAUDE.md）规定渲染逻辑在 `widget.ts`，这意味着至少需要改动三个文件。 | 在 Complexity Assessment 中标注 FR-7 渲染改动涉及 `widget.ts`，或说明将渲染逻辑内联在 `index.ts` 中。 |
| 4 | INFO | spec.md:AC-5 | **"主 session 目录被清理"的触发机制未确证**。AC-5 描述的是"跟随清理"但 spec 未说明清理事件何时/如何触发。如果清理是手动操作，那 AC 描述的是自然结果而非可验证条件。 | 补充清理机制的说明，或调整 AC-5 措辞聚焦于"session 文件位于同一目录"（这是可验证的）。 |
| 5 | INFO | spec.md:FR-6 | **FR-6 的描述更新缺少 AC 验证**。FR-6 明确要求更新工具 description，但 AC-6 / AC-7 只验证类型检查和 ESLint，没有 AC 验证 description 内容是否正确更新。 | 新增 AC 验证 tool description 中包含 memory 使用指引。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

### MUST FIX 详细说明

#### 问题 #1：`--fork` CLI 参数未经验证

**位置**：FR-2 第 1 条子项

**问题**：
```
1. 从主 agent 的当前 session fork 一个新 session 文件
   - 使用 `--fork <主session文件>` CLI 参数
```

这个机制是 FR-2 的基石，但 spec 没有提供任何证据表明 Pi 运行时支持 `--fork` CLI 参数。如果 Pi 不支持：
- 另一种方案是直接 `fs.copyFile` 拷贝 session 文件（需要考虑 session 文件是否处于写入中）
- 或者通过 SessionManager API 创建新 session

**验证方法**：在 Pi 的文档或源码（`pi --help`）中查找 `--fork` 支持。

**修改方向**：
- 确认 `--fork` 存在，在 spec 中补充该参数的确认引用
- 或定义替代方案并更新 FR-2 的描述

#### 问题 #2：并发写入同一 memory session 文件的竞态条件未处理

**位置**：FR-3、FR-4

**问题**：

FR-5 明确允许 parallel 模式下各 task 指定相同的 `memory`：
```
parallel 和 chain 模式中，每个 task item 可以各自指定不同的 memory（或留空）
```

但同一份 "可以指定不同 memory" 的措辞隐含允许指定相同 memory。当两个 subagent 使用 `--session <同一文件>` 同时写入时，JSONL 文件可能出现交错写入。session 文件通常以 append 方式写入，Node.js 的 `fs.appendFile` 在不同进程间没有原子性保证。

**验证方法**：确认 Pi 的 session 文件写入模式，检查是否存在进程级文件锁或 append 原子性保障。

**修改方向**：
- 明确禁止同一 memory 的并发使用（推荐，因为 memory 旨在支持主 agent 串行编排的多轮子任务，不适合并行）
- 或在 FR-4 中加入并发防护策略（如 UUID-based 文件后缀做写隔离，读取时合并）

## 结论

**需修改后重审。**

两项 MUST FIX 都涉及 spec 的基础设计假设——`--fork` CLI 参数的存在性和并发安全策略。这两个问题不解决将直接影响实现方案的可行性。

## Summary

Spec 完整性评审完成，第1轮，2条 MUST FIX，需修改后重审。
