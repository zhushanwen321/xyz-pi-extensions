---
name: xyz-harness-design-execution
description: >-
  Use when the user says "执行计划", "execution plan", "wave编排",
  "任务拆分", "交付计划", "sprint 规划", or has finished code-architecture.md
  and needs to split the work into executable waves. Produces
  execution-plan.md. Design Step 6 of 6.
  Not for code architecture design (Step 5). Not for writing code itself —
  this plans the execution sequence, it does not execute it.
---

## 核心目标

将代码架构（Step 5）拆分为多个 **Wave**，每个 Wave 粒度约为**一个 subagent 可高度专注完成**的开发单元。

1. **Wave 拆分** — 每个功能/垂直切片 = 一个 Wave
2. **依赖推导** — 从 Step 5 类方法时序图推导 Wave 间依赖（时序已到方法级，依赖可梳理）
3. **串并行编排** — 明确哪些可并行、哪些必须串行
4. **最终列表** — 共多少 Wave、串行还是并行

> **关键优势：** Step 5 时序图已细化到类方法级，Wave 依赖关系能**直接从时序图读出**。

## 执行流程

按 `references/shared-loop.md`（位于 design-clarity skill 的 references 目录）的 6 步循环执行。

**Step 1（交互+初稿）— Grilling 遍历 Wave 依赖树：**

```
Wave 编排（根：从时序图推导）
├── Wave 0: Prefactor → 是否有让后续更易的前置重构？
├── Wave 1: 首个垂直切片（P0/P1）
│   ├── 切穿哪些层？→ schema→API→逻辑→测试 全切
│   ├── blocked_by？→ Wave 0 or 无
│   └── subagent 配置 → 注入哪些上下文/读取哪些文件
├── Wave 2-N: 后续切片 → 并行还是串行？（看时序图依赖+文件冲突）
└── P3 延后项 → 标注「后续迭代」+ 理由
```

遍历纪律：先走 Prefactor Wave（如有）和 P0 Wave——它们是后续 Wave 的依赖根。
从 code-architecture.md §4 时序图推导：功能 B 调用功能 A → Wave(B) blocked_by Wave(A)；同文件被多时序修改→必须串行。
按 `references/vertical-slice.md` 垂直切片原则（不水平切片，每 Wave 切穿所有层可独立验证）。
初稿用 `references/deliverable-template.md`。

**Step 2（追踪）— 派 fresh-context subagent，按 3 视角追踪：**
切片独立性（每 Wave 可独立验证？非水平切片？）/ 依赖闭合（Wave 依赖从时序图完整推导？）/ 并行安全（同并行组真不改同一文件？）。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 shared-loop.md。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 execution-plan.md；按 design-clarity skill 的 `references/visual-deliverable.md` 渲染 execution-plan.html（主角图：Wave 依赖 DAG 图，标注并行组）。**

**Step 6（审查）— 派 fresh-context 审查 subagent，5 维评审，报告写 `changes/review-execution.md`。APPROVED 才交接。**

## Phase Loop 机制

- 收敛失败 → 回 Step 1 调整 Wave 编排
- 依赖推导不出 → 回 Step 5 补充时序图细节
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛

## Self-Check

**[MANDATORY] 禁止在未完成 shared-loop 全流程（含 Step 6 审查 APPROVED）时声称完成。**

- [ ] execution-plan.md 存在，frontmatter 含 `verdict: pass`
- [ ] execution-plan.html 存在，Wave DAG 图正确渲染（并行组标注）
- [ ] `changes/tracing-round-{N}.md` 存在
- [ ] `changes/review-execution.md` 存在且 verdict: APPROVED
- [ ] Wave DAG 图存在，节点+blocked_by 边清晰；调度表完整（切片/P级/依赖/并行组/说明）
- [ ] 垂直切片——每 Wave 切穿所有层可独立验证（无水平切片）
- [ ] 依赖从时序图推导（有调用证据）；并行安全（同组不改同一文件）
- [ ] P0 在最前 Wave，P3 标注「后续迭代」+理由；Prefactor Wave（如有）为后续铺路
- [ ] 每 Wave 的 subagent 配置完整（注入上下文/读取文件/修改文件）

## 本地目录覆盖规则

- **主目录：** `.xyz-harness/`（项目根）
- **子目录：** `${yyyy-MM-dd}-${主题简短标题}`
- **路径：** `.xyz-harness/${主题}/execution-plan.md` + `.html`
- **不同主题不同子目录，禁止混放。** 单次写入超 1000 字优先拆分子文档。

## 下游衔接

**设计工作流全部完成并通过独立审查。** 审查 APPROVED 后向用户交接：

```
✅ ⑥执行计划 已完成并通过独立审查。
   产出：execution-plan.md + execution-plan.html
   审查报告：changes/review-execution.md（verdict: APPROVED）

🎉 设计工作流（6 步）全部完成！
下一步：编码实现
   方式 A（推荐）：接入 coding-workflow — 启动 Phase 流程
   方式 B：手动执行 — 每个 Wave 派一个 fresh subagent
是否现在开始编码？
```

用户确认后才开始编码。完整设计流程见 `docs/design-workflow-guide.md`。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
