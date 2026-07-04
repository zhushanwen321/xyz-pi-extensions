---
name: full-clarity
description: >-
  Use when the user says "澄清需求", "clarify requirements", "需求分析",
  "业务建模", "use case", "start design", or is at the beginning of the
  full workflow and needs to define what to build before how to build it.
  Produces requirements.md. Step 1 of 6.
  Not for system/architecture design, API definition, tech-stack selection,
  database schema, or coding — those belong to Steps 2-6. Not for pure
  technical refactors with no business change.
---

## 核心目标

明确**业务目标**（不碰系统实现）：达成路线、业务用例、数据流转、功能清单、UI/UX、系统间关联。

> **[铁律] 本阶段不考虑系统实现。** 不做技术栈选型、架构设计、API 定义、数据库建模。
> 技术约束（如「必须用 Postgres」）只记录到 Constraints 不展开。

## 执行流程

按 `../full-shared/references/loop-skeleton.md`（6 步操作速查）的流程执行。**首次执行本工作流时，先 read `../full-shared/references/loop-method.md`** 了解 Grilling 提问法等方法论。本阶段特有内容：

**Step 1（交互+初稿）— Grilling 遍历业务目标树：**

> **[MANDATORY 判定复杂度档位]** ①是首阶段，负责按 loop-skeleton「复杂度自评」（6 信号打分）判定本 topic 的 `complexity_tier`（L1/L2/L3），写入 `_progress.md` frontmatter。创建 `_progress.md` 用 `references/_progress-template.md` 骨架。判定后 ask_user 确认一次（用户可覆盖）。后续所有阶段读此档位驱动降级。
>
> **[MANDATORY 创建决策账本]** ①是首个设计阶段，负责创建 `{topic_dir}/decisions.md`（空骨架，直接用 `references/decisions-template.md`）。后续所有阶段的 confirmed 决策都 append 到此文件。
>
> **[状态追踪]** 开始时调 `design_status start_phase clarity` 标记阶段开始（会校验 init 已 completed）。
> **有 `design_status` tool 优先用 tool**：`design_status(action: start_phase, phase: clarity)`；**无 tool（Claude Code/Cursor/shell）用 CLI**：`design-status start-phase clarity`。CLI 完整用法见 loop-skeleton.md「CLI 完整用法」。
>
> **[按 loop-skeleton Step 1.0]** grilling 前，①是首阶段（decisions.md 刚创建为空），直接进入 Step 1.1 grilling。每个 D 类决策 ask_user 拍板后，按 Step 1.2 即时 append 到 decisions.md。

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

**Step 1 末尾 — 机器结构检查前置（零成本提速）：** 初稿写完后，主 agent 调 `cw(action=clarify)` 触发 CW gate 的机器检查，FAIL 当场修低级硬伤（占位符没替换/章节缺/每 UC 缺 AC/系统实现越界/frontmatter verdict 缺），不必等 Step 6。
> **与 Step 6 审查的分工**：此处只杀机器可证的结构硬伤（快、CW gate 自动跑）；Step 6 才是质量门（fresh subagent 跑）。两者不替代——Step 6 审查前 CW gate 的机器检查 FAIL 仍硬阻断。

**Step 2（追踪）— 2 个并行 fresh-context subagent：5 视角追踪 + 禁读产出物异质重建。**

> **业务视角，非实现视角。** 追踪中发现实现层问题（API 契约、状态机、技术架构），记录为「移交②系统设计处理」，不在本阶段展开。
>
> **为何加禁读重建（提质附带提速）：** ① 是业务根，遗漏全链放大（下游⑤时序图都基于①用例集，①漏一个用例=下游全在为不完整前提做精致打磨）。现有 5 视角都读同一份 requirements.md 初稿——**同源盲区**：初稿漏的用例，5 视角查不出（视角2查的是"已列用例是否完整"，不是"该列而未列的用例"）。范式照搬③issues 的 A 角色（fog-of-war.md 论证的「同源盲区靠 fresh context 他证对抗」）。与 5 视角并行跑（共 2 个 subagent），比现状串行快。

**① 5 视角追踪 subagent**（1 个 fresh-context，按 loop-skeleton Step 2 模板——decisions.md 作为 context 参数注入 + [REVISIT] 硬规则；读 requirements.md + 上游无 + 项目源码）：

1. **目标可追溯性**（必查，无降级）— 业务目标→达成路线→用例的完整可追溯链。查：孤立用例（无对应目标）/ 孤立目标（无路线或用例支撑）/ 成功标准是否可衡量（「X 达到 Y 指标」而非「做好 X」）。
2. **角色与用例完整性**（必查，无降级）— 所有参与角色及其用例完整。查：隐含 Actor（被提到但未纳入，如审核人/管理员）/ 同一 Actor 不同权限级别是否区分 / **每用例必须答出 主流程+替代+异常 + 前置/后置**（最常漏异常流程）。
3. **数据流完整性**（必查，无降级）— 数据产生→处理→消费→归档/销毁的完整生命周期。查：数据孤岛（产生但无人消费）/ 无源数据（被消费但无人负责产生）/ 敏感级别标注（公开/内部/机密 → 影响④非功能）。
4. **界面场景覆盖**（降级：纯后端/API/无 UI 交互写降级理由跳过）— 用户交互场景完整性（线框/流程级）。查：每用例是否有 UI 场景描述 / 空状态·加载·错误三态交互 / 无 UI 用例（API-only、定时任务）也要描述触发与结果。
5. **跨系统关联**（降级：单系统无外部依赖写降级理由跳过）— 系统间功能依赖关系。查：依赖的外部系统功能逐一列出 / 跨系统交互同步 vs 异步（影响④非功能）/ 外部契约是否稳定（自有可控 vs 第三方不可控）。

> gap 分流（F/K/D）与收敛判定见 `../full-shared/references/loop-skeleton.md` Step 3-4。

> **为何内联：** clarity 的 5 视角较轻量，故内联于本 SKILL；其余阶段（②③④）视角较重，仍各自独立成 references 文件。

**② 禁读产出物异质重建 subagent**（1 个 fresh-context，**禁读 requirements.md**，只读 CONTEXT.md + 项目源码）：

独立重建「Actor 清单 + 用例清单 + 主流程/异常 + 数据流」，与主 agent 初稿 diff。diff 出来的就是同源盲区 gap（标 F/K/D 进 Step3）。产出 `changes/tracing-round-{N}-reconstruct.md`。

**重建器 Task prompt：**

```
你是独立重建 subagent。上下文与主 agent 隔离。**禁止读 requirements.md**（避免被主 agent 初稿锚定）。只读 CONTEXT.md + 项目源码（若有）。
**决策账本纪律：** decisions.md（作为 context 参数注入）里 status=confirmed 的决策是用户已拍板结论，已 confirmed 决策不得当 gap 重报；有下游新证据推翻须标 `[REVISIT of D-NNN]` + 附新证据走 Step 6b 反哺（D-不可逆须主 agent ask_user）。
1. 独立重建：① 有哪些 Actor（含隐含的，如审核人/管理员）② 每个.Actor 有哪些用例 ③ 每用例的主流程+替代+异常 ④ 核心数据流（产生→处理→消费→归档）
2. 重建完成后，才 read requirements.md（主 agent 初稿），与你的重建做 diff
3. diff 出的差异就是同源盲区 gap，逐条标 F/K/D：
   - 你重建有但初稿无（MISSING，最可能是 D-不可逆/未问的业务意图）
   - 初稿有但属性不符（MISMATCH，如缺异常流程）
   - 术语不一致（ACTOR/用例名不统一）
4. 写入 {topic_dir}/changes/tracing-round-{N}-reconstruct.md
```

> **机器化降级空间**：CW gate 的机器检查已覆盖「UC≥1 AC」「不含系统实现（①铁律）」——即 5 视角里视角1（目标可追溯性）的机器可判子集，这些由 CW gate 在 `cw(action=clarify)` / `cw(action=detail)` 调用时自动完成，不占 subagent 预算。subagent 只做机器做不了的：禁读产出物的异质重建（Actor/用例/异常流程的语义盲区发现）。机器检查未覆盖的视角2-5 仍需 subagent。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 loop-skeleton.md。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 requirements.md；派 fresh subagent 渲染 requirements.html（机制见 loop-skeleton.md Step 5b）（主角图：用例图）。**

**Step 6（审查）— 派 fresh-context 审查 subagent（按 `../full-shared/references/review-agent.md` 规范，CW gate 的机器检查 FAIL 硬阻断），6 维评审（含红队维度），报告写 `changes/review-clarity.md`（frontmatter 含 verdict + machine_check）。APPROVED 后进 Step 6b 反哺检查（①无上游，反哺检查直接 pass），再交接。**

## Phase Loop 机制

- 收敛失败（仍有新 gap）→ 回 Step 3
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- **反哺触发下游修订本阶段 .md**（详见 loop-skeleton.md Step 6b）→ 本阶段 .md 被改后，下游需重新对齐
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛，未解决标 `[UNRESOLVED]`

不接入 coding-workflow 的 gate 编排，靠 loop-skeleton 追踪+审查+反哺三重机制自证质量与文档一致性。

## Self-Check

**[MANDATORY] 禁止在未实际完成 loop-skeleton 全流程（含 Step 6 审查 APPROVED）的情况下声称完成。**

- [ ] requirements.md 存在，frontmatter 含 `verdict: pass`
- [ ] **`decisions.md` 已创建**（①负责创建空骨架，Step 1 的 D 类决策已即时 append）
- [ ] requirements.html 存在，用例图正确渲染
- [ ] `changes/tracing-round-{N}.md` 存在（5 视角追踪真执行了，非主 agent 自圆其说）
- [ ] `changes/tracing-round-{N}-reconstruct.md` 存在（禁读重建真执行了——① 的同源盲区防线）
- [ ] `changes/review-clarity.md` 存在且 verdict: APPROVED
- [ ] 所有 `[AMBIGUOUS]` 已解决或显式列为待确认
- [ ] **目标→路线→用例可追溯**：每用例能追溯到目标，每目标有用例支撑
- [ ] **每 UC 有 ≥1 条 AC**（正常/异常/边界可验证，非占位符）
- [ ] **未含系统实现**：无 API/数据库 schema/技术架构图（属 Step 2）
- [ ] 用例图（Mermaid）覆盖所有 Actor；数据流图生命周期完整

## 本地目录覆盖规则

- **主目录：** `.xyz-harness/`（项目根）
- **子目录：** `${yyyy-MM-dd}-${主题简短标题}`
- **路径：** `.xyz-harness/${主题}/requirements.md` + `.html`
- **不同主题不同子目录，禁止混放。** 单次写入超 1000 字优先拆分子文档。

## 下游衔接

审查 APPROVED 后向用户交接（按 loop-skeleton.md Step 6 格式）：

> **[状态追踪]** 交接前调 `design_status complete_phase clarity` 收尾——自动校验 requirements.md + verdict:pass + review APPROVED，过了才标 completed。
> **有 tool 优先用 tool**：`design_status(action: complete_phase, phase: clarity)`；**无 tool 用 CLI**：`design-status complete-phase clarity`。

```
✅ ①澄清需求 已完成并通过独立审查。
   产出：requirements.md + requirements.html
   审查报告：changes/review-clarity.md（verdict: APPROVED）
下一步：②系统设计概要 — 业务目标→系统目标，统一语言/架构/模块/状态机
调用：/full-architecture
是否现在进入下一步？
```

用户确认后才加载下一 skill。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
