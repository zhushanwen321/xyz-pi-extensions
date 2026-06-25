---
name: design-architecture
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

按 `references/loop-skeleton.md`（位于 design-clarity skill 的 references 目录）的 6 步循环执行。**（loop-method.md 的方法论仅 clarity 首次 read，本阶段无需 read。）**

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

**Step 1 必问决策点（代码答不了，逐个 ask_user；其余 = agent 自决，审查时暴露）：**

1. **核心计算的复杂度预期** — "核心是业务规则编排（→DDD4层）还是技术流程编排（→三层）？未来会不会长出复杂规则/策略引擎？" 代码只看现状，"会不会长出"是用户对未来复杂度的判断，决定分层深度（不可逆）。【D-不可逆】
2. **搭便车改造清单（候选，⑤骨架验证后最终确认）** — business-goal→system-goal 转换时发现的"趁机可做的重构"，逐个问用户本轮是否做（候选意向）。用户对范围/风险拍板意向，但**真实工作量要到⑤骨架验证才能确定**——⑤发现某项远超预期会回流本阶段重新确认范围。【D】
3. **Seam/port 真伪边界** — 哪些依赖值得做 port（可替换性 vs 复杂度成本）。agent 按启发式标"假设 seam"，但"真 seam 还是删掉"是用户取舍。【D-不可逆】
4. **领域模型边界争议** — aggregate vs DTO、有状态机 vs 无状态，有真实不确定性时逐个问。【D-不可逆】
5. **状态机严格度** — 显式转换表（紧，早暴露错误）还是只守终态（松，灵活）？用户偏好。【D】

> 其余（依赖 4 类分类启发式、命名、不变式推导、Context Map 画法）= agent 自决。

**Step 2（追踪）— 派 fresh-context subagent，按 `references/architecture-perspectives.md` 的 5+1 视角追踪：**
模型完整性 / 状态正交性 / 分层纪律 / 依赖边界 / 变化轴 / 行为契约(refactor 专用)。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 loop-skeleton.md。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 system-architecture.md；派 fresh subagent 渲染 system-architecture.html（机制见 loop-skeleton.md Step 5b）（主角图：分层架构图+状态机图）。**

**Step 6（审查）— 派 fresh-context 审查 subagent（按 design-clarity/references/review-agent.md 规范，先跑 `scripts/check_architecture.py` 机器检查，FAIL 硬阻断），6 维评审（含红队维度），报告写 `changes/review-architecture.md`（frontmatter 含 verdict + machine_check）。APPROVED 后进 Step 6b 反哺检查（回扫 ①上游），再交接。**

## Phase Loop 机制

- 收敛失败 → 回 Step 3 补充交互更新模型
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- **反哺触发上游修订**（详见 loop-skeleton.md Step 6b）→ 上游 .md 更新后，本阶段可能需重新对齐 → 回 Step 2 重追踪
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛

## Self-Check

**[MANDATORY] 禁止在未完成 loop-skeleton 全流程（含 Step 6 审查 APPROVED）时声称完成。**

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

审查 APPROVED 后向用户交接（按 loop-skeleton.md Step 6 格式）：

```
✅ ②系统设计概要 已完成并通过独立审查。
   产出：system-architecture.md + system-architecture.html
   审查报告：changes/review-architecture.md（verdict: APPROVED）
下一步：③Issue 拆分 — 系统设计→具体问题，P0-P3 优先级 + 方案对比
调用：/design-issues
是否现在进入下一步？
```

用户确认后才加载下一 skill。完整设计流程见 `docs/design-workflow-guide.md`。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
