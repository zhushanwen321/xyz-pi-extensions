---
name: design-clarity
description: >-
  Use when the user says "澄清需求", "clarify requirements", "需求分析",
  "业务建模", "use case", "start design", or is at the beginning of the
  design workflow and needs to define what to build before how to build it.
  Produces requirements.md. Design Step 1 of 6.
  Not for system/architecture design, API definition, tech-stack selection,
  database schema, or coding — those belong to Steps 2-6. Not for pure
  technical refactors with no business change.
---

## 核心目标

明确**业务目标**（不碰系统实现）：达成路线、业务用例、数据流转、功能清单、UI/UX、系统间关联。

> **[铁律] 本阶段不考虑系统实现。** 不做技术栈选型、架构设计、API 定义、数据库建模。
> 技术约束（如「必须用 Postgres」）只记录到 Constraints 不展开。

## 执行流程

按 `references/loop-skeleton.md`（6 步操作速查）的流程执行。**首次执行本工作流时，先 read `references/loop-method.md`** 了解 Grilling 提问法等方法论。本阶段特有内容：

**Step 1（交互+初稿）— Grilling 遍历业务目标树：**

```
业务目标（根）
├── G1: {目标} — 成功标准
│   ├── Actor: 谁来达成？
│   │   └── 用例 → 主流程 → 边界场景（发明极端场景测试）
│   ├── 数据: 产生/消费什么？
│   └── 界面: 在哪完成？
└── 约束 & 不做
```

提问焦点：先问目标再问功能；区分「目标」和「方案」；业务用例非技术用例。
即时写入项目根 CONTEXT.md（统一语言）。初稿用 `references/deliverable-template.md`。

**Step 2（追踪）— 派 fresh-context subagent，按 `references/business-perspectives.md` 的 5 视角追踪：**
目标可追溯性 / 角色与用例完整性 / 数据流完整性 / 界面场景覆盖 / 跨系统关联。每视角必须核对或写降级理由。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 loop-skeleton.md。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 requirements.md；派 fresh subagent 渲染 requirements.html（机制见 loop-skeleton.md Step 5b）（主角图：用例图）。**

**Step 6（审查）— 派 fresh-context 审查 subagent，5 维评审，报告写 `changes/review-clarity.md`。APPROVED 才交接。**

## Phase Loop 机制

- 收敛失败（仍有新 gap）→ 回 Step 3
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛，未解决标 `[UNRESOLVED]`

不接入 coding-workflow 的 gate 编排，靠 loop-skeleton 追踪+审查双重机制自证质量。

## Self-Check

**[MANDATORY] 禁止在未实际完成 loop-skeleton 全流程（含 Step 6 审查 APPROVED）的情况下声称完成。**

- [ ] requirements.md 存在，frontmatter 含 `verdict: pass`
- [ ] requirements.html 存在，用例图正确渲染
- [ ] `changes/tracing-round-{N}.md` 存在（追踪真执行了，非主 agent 自圆其说）
- [ ] `changes/review-clarity.md` 存在且 verdict: APPROVED
- [ ] 所有 `[AMBIGUOUS]` 已解决或显式列为待确认
- [ ] **目标→路线→用例可追溯**：每用例能追溯到目标，每目标有用例支撑
- [ ] **未含系统实现**：无 API/数据库 schema/技术架构图（属 Step 2）
- [ ] 用例图（Mermaid）覆盖所有 Actor；数据流图生命周期完整

## 本地目录覆盖规则

- **主目录：** `.xyz-harness/`（项目根）
- **子目录：** `${yyyy-MM-dd}-${主题简短标题}`
- **路径：** `.xyz-harness/${主题}/requirements.md` + `.html`
- **不同主题不同子目录，禁止混放。** 单次写入超 1000 字优先拆分子文档。

## 下游衔接

审查 APPROVED 后向用户交接（按 loop-skeleton.md Step 6 格式）：

```
✅ ①澄清需求 已完成并通过独立审查。
   产出：requirements.md + requirements.html
   审查报告：changes/review-clarity.md（verdict: APPROVED）
下一步：②系统设计概要 — 业务目标→系统目标，统一语言/架构/模块/状态机
调用：/design-architecture
是否现在进入下一步？
```

用户确认后才加载下一 skill。完整设计流程见 `docs/design-workflow-guide.md`。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
