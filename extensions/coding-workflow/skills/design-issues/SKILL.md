---
name: design-issues
description: >-
  Use when the user says "issue拆分", "问题分解", "issue decomposition",
  "方案对比", "tradeoff analysis", "优先级排序", or has finished
  system-architecture.md and needs to break it into prioritized issues with
  solution comparisons. Produces issues.md as a fog-of-war decision map.
  Design Step 3 of 6.
  Not for business requirements (Step 1) or architecture modeling (Step 2).
  Not for non-functional risk analysis (Step 4) or code-level design (Step 5).
---

## 核心目标

将系统设计的初步结论转换为**更细节的模块和更具体的问题**，每个带 P0-P3 优先级（MoSCoW）和方案对比取舍。

> **取舍原则：优先长期、合理的架构设计，提供高可扩展性。较少考虑成本。**

## 执行流程

按 `references/loop-skeleton.md`（位于 design-clarity skill 的 references 目录）的 6 步循环执行。**（loop-method.md 的方法论仅 clarity 首次 read，本阶段无需 read。）**

**Step 1（交互+初稿）— Grilling 遍历 issue 决策树：**

```
Issue 决策图（根：从 system-architecture 的挑战推导）
├── P0 阻塞项（前沿，必须先做）
│   └── 每 issue → 方案 A/B/C → 取舍（给强观点）→ blocked_by 依赖边
├── P1 核心项（同 P0 结构）
├── P2 重要项（迷雾，标注 ? 先不展开）
└── P3 延后项（后续迭代）
```

遍历纪律：先走 P0 前沿，方案对比做完再走 P1。迷雾中的 P2/P3 标注 `?` 不强求展开。
从 system-architecture.md 的 §5 状态流转 / §7 模块划分 / §8 Context Map / §10 挑战推导 issue。
按 `references/fog-of-war.md` 构建决策图（不一次性列完）。按 `references/issue-template.md` 写方案对比。
复杂根本性 issue 用 DESIGN-IT-TWICE（3+ 并行 subagent 发散）。初稿用 `references/deliverable-template.md`。

**Step 2（追踪）— 派 fresh-context subagent，按 4 视角追踪：**
issue 覆盖性（每个挑战有对应 issue？）/ 方案完整性（每个 P0/P1 有 ≥2 方案+取舍？）/ 优先级一致性（P 级与 blocked_by 一致？）/ 前沿清晰度（迷雾该展开吗？）。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 loop-skeleton.md。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 issues.md；派 fresh subagent 渲染 issues.html（机制见 loop-skeleton.md Step 5b）（主角图：决策 DAG 图，节点状态色标）。**

**Step 6（审查）— 派 fresh-context 审查 subagent，5 维评审，报告写 `changes/review-issues.md`。APPROVED 才交接。**

## Phase Loop 机制

- 收敛失败 → 回 Step 3 补充方案对比/追踪新 issue
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛

## Self-Check

**[MANDATORY] 禁止在未完成 loop-skeleton 全流程（含 Step 6 审查 APPROVED）时声称完成。**

- [ ] issues.md 存在，frontmatter 含 `verdict: pass`
- [ ] issues.html 存在，决策 DAG 图正确渲染（状态色标）
- [ ] `changes/tracing-round-{N}.md` 存在
- [ ] `changes/review-issues.md` 存在且 verdict: APPROVED
- [ ] 所有 P0/P1 issue 有 ≥2 方案对比+取舍决策（按 issue-template.md）
- [ ] P 级与 blocked_by 一致（P0 不依赖 P2/P3）；取舍体现「长期架构优先」
- [ ] 复杂根本性 issue 用了 DESIGN-IT-TWICE 并行发散（有 tracing 记录）
- [ ] 迷雾 issue 标注 `?`，不强行展开

## 本地目录覆盖规则

- **主目录：** `.xyz-harness/`（项目根）
- **子目录：** `${yyyy-MM-dd}-${主题简短标题}`
- **路径：** `.xyz-harness/${主题}/issues.md` + `.html`
- **不同主题不同子目录，禁止混放。** 单次写入超 1000 字优先拆分子文档。

## 下游衔接

审查 APPROVED 后向用户交接（按 loop-skeleton.md Step 6 格式）：

```
✅ ③Issue 拆分 已完成并通过独立审查。
   产出：issues.md + issues.html
   审查报告：changes/review-issues.md（verdict: APPROVED）
下一步：④非功能性设计 — issue 解决方案的副作用分析 + 缓解（7 维度）
调用：/design-nfr
是否现在进入下一步？
```

用户确认后才加载下一 skill。完整设计流程见 `docs/design-workflow-guide.md`。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
