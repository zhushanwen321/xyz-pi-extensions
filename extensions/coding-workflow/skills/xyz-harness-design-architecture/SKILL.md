---
name: xyz-harness-design-architecture
description: >-
  Use when the user says "系统设计", "架构设计", "architecture design",
  "领域建模", "domain modeling", "模块划分", "状态机", or has finished
  requirements.md and needs to model the system. Produces
  system-architecture.md. Design Step 2 of 6.
  Not for business requirements/use-case work (Step 1), issue decomposition
  with priorities (Step 3), or code-level API/sequence design (Step 5).
  Not for writing code.
---

## 核心目标

将业务目标转换为系统目标（含搭便车改造目标），完成：统一语言、分层架构、模块划分、Context 边界、领域建模、状态机流转。

**统摄 metric：复杂度归位** — 所有决策回问「复杂度是否归位到正确的地方？」模型复杂度集中 aggregate 而非散落？反模式本质都是「复杂度没在正确的地方」。

## 执行流程

按 `references/shared-loop.md`（位于 design-clarity skill 的 references 目录）的 6 步循环执行。

**Step 1（交互+建模初稿）— Grilling 遍历架构决策树：**

```
系统设计立场（根：核心计算是什么？）
├── 分层决策 → DDD 4 层 or 三层？（看核心计算是业务规则还是技术编排）
├── 领域建模 → 有状态机？aggregate/实体 or DTO？
│   └── Status 枚举 + Reason 字段（正交）+ 不变式守卫
├── 模块拆分 → 按变化轴（问「会因为什么改」，答 2+ 原因=该拆）
└── 外部依赖 → 4 类分类决定 port（In-process/Local-sub/Remote-owned/True-external）
```

先定模式（refactor 有代码先读行为契约 / greenfield 最小澄清），核心建模三问（核心计算/状态机/变化轴）。
Seam 纪律：一个 adapter=假设 seam；两个 adapter=真 seam。
初稿用 `references/deliverable-template.md`。

**Step 2（追踪）— 派 fresh-context subagent，按 `references/architecture-perspectives.md` 的 5+1 视角追踪：**
模型完整性 / 状态正交性 / 分层纪律 / 依赖边界 / 变化轴 / 行为契约(refactor 专用)。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 shared-loop.md。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 system-architecture.md；按 design-clarity skill 的 `references/visual-deliverable.md` 渲染 system-architecture.html（主角图：分层架构图+状态机图）。**

**Step 6（审查）— 派 fresh-context 审查 subagent，5 维评审，报告写 `changes/review-architecture.md`。APPROVED 才交接。**

## Phase Loop 机制

- 收敛失败 → 回 Step 3 补充交互更新模型
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛

## Self-Check

**[MANDATORY] 禁止在未完成 shared-loop 全流程（含 Step 6 审查 APPROVED）时声称完成。**

- [ ] system-architecture.md 存在，frontmatter 含 `verdict: pass`
- [ ] system-architecture.html 存在，分层图+状态机图正确渲染
- [ ] `changes/tracing-round-{N}.md` 存在
- [ ] `changes/review-architecture.md` 存在且 verdict: APPROVED
- [ ] 业务目标→系统目标转换完整，搭便车目标标注来源
- [ ] 设计立场回答了「核心计算是什么」
- [ ] 核心模型标注类型+不变式+建模理由；状态机 Status/Reason 正交、终态不可逆
- [ ] §11 所有 grep AC 实际可运行；Context Map/泳道图存在
- [ ] 所有特化决策有「违反什么+为什么合理」

## 本地目录覆盖规则

- **主目录：** `.xyz-harness/`（项目根）
- **子目录：** `${yyyy-MM-dd}-${主题简短标题}`
- **路径：** `.xyz-harness/${主题}/system-architecture.md` + `.html`
- **不同主题不同子目录，禁止混放。** 单次写入超 1000 字优先拆分子文档。

## 下游衔接

审查 APPROVED 后向用户交接（按 shared-loop.md Step 6 格式）：

```
✅ ②系统设计概要 已完成并通过独立审查。
   产出：system-architecture.md + system-architecture.html
   审查报告：changes/review-architecture.md（verdict: APPROVED）
下一步：③Issue 拆分 — 系统设计→具体问题，P0-P3 优先级 + 方案对比
调用：/xyz-harness-design-issues
是否现在进入下一步？
```

用户确认后才加载下一 skill。完整设计流程见 `docs/design-workflow-guide.md`。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
