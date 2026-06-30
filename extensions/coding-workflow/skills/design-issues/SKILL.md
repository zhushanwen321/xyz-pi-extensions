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

按 `../design-shared/references/loop-skeleton.md`（共享参考目录）的 6 步循环执行。**（loop-method.md 的方法论仅 clarity 首次 read，本阶段无需 read。）**

**Step 1（交互+初稿）— Grilling 遍历 issue 决策树：**

> **[状态追踪]** 开始时调 `design_status start_phase issues` 标记阶段开始（会校验 architecture 已 completed）。
> **有 `design_status` tool 优先用 tool**：`design_status(action: start_phase, phase: issues)`；**无 tool（Claude Code/Cursor/shell）用 CLI**：`design-status start-phase issues`。CLI 完整用法见 loop-skeleton.md「CLI 完整用法」。
>
> **[按 loop-skeleton Step 1.0]** grilling 前先获取已确认决策：
>
> **[复杂度档位]** 先读 `_progress.md` 的 `complexity_tier`：**L1 档跳过 context-builder**（主 agent 直读 decisions.md + 必问决策点引用的上游章节）；L2/L3 派 context-builder。追踪/审查/重建帧的降级见 loop-skeleton「复杂度自评与降级档位·三档执行矩阵」。本阶段上游较多，派 **context-builder subagent**（fresh）读 `{topic_dir}/decisions.md`（本 topic 已确认决策）+ 相关长期文档（NFR.md/ADR/ARCHITECTURE.md）+ 上游 .md，输出「阶段工作摘要」（不可推翻决策清单 + 设计树入口 + 接口契约）注入主 agent context。**grilling 不得重新确认已 confirmed 决策**；每个 D 类决策拍板后按 Step 1.2 即时 append decisions.md。

```
Issue 决策图（根：从 system-architecture 的挑战推导）
├── P0 阻塞项（前沿，必须先做）
│   └── 每 issue → 方案 A/B/C → 取舍（给强观点）→ blocked_by 依赖边
├── P1 核心项（同 P0 结构）
├── P2 重要项（迷雾，标注 ? 先不展开）
└── P3 延后项（后续迭代）
```

遍历纪律：先走 P0 前沿，方案对比做完再走 P1。迷雾中的 P2/P3 标注 `?` 不强求展开。
**生成候选 issue 先按 4 轴扫**（见 `references/fog-of-war.md`「拆分维度 checklist」：状态§5/模块§7/边界§8/挑战§10 + 兜底）→ 再标 P 级。**P 级不是拆分维度，先用轴扫再标 P 级**，否则天然不 MECE。
从 system-architecture.md 的 §5 状态流转 / §7 模块划分 / §8 Context Map / §10 挑战推导 issue。
按 `references/fog-of-war.md` 构建决策图（不一次性列完）。按 `references/issue-template.md` 写方案对比。
复杂根本性 issue 用 DESIGN-IT-TWICE（3+ 并行 subagent 发散）。初稿用 `references/deliverable-template.md`（**含「上游覆盖核验」表——每个②元素必须对应 issue 或标 N/A+理由，这是 Step2 独立重建能 diff 的前提**）。

**Step 1 必问决策点（代码答不了，逐个 ask_user；本阶段 agent 最易自作主张，务必逐条问）：**

1. **P0/P1 划线** — 每个候选阻塞项问："不做它，后续真的无法推进 / 目标真的无法达成吗？" P 级依赖用户对**业务优先级**的判断，不能 agent 凭技术启发式定。这是本阶段最高频被 agent 吞掉的决策。【D】
2. **取舍原则的局部例外** — 全局默认"长期架构优先、较少考虑成本"，但每个 P0/P1 issue 要问："这里是否仍然适用？有没有成本其实重要的例外？"【D】
3. **DESIGN-IT-TWICE 的最终选定** ⭐ — 凡触发并行 subagent 发散的根本性架构选择，**最终选定必须 ask_user**，不能 agent 给完 opinionated 推荐就记录进 issues.md。（当前 issue-template 让 agent "选择+记录"，这是最大的提问漏洞）【D-不可逆】
4. **迷雾展开判断** — fog-of-war"前沿清晰即停"，但"够不够清晰 / 还有没有没说的需求"必须问用户，不能 agent 自判收敛。【K/D】
5. **P3 延后项逐条确认** — 每个标 P3 的问用户是否同意延后 + 理由（用户可能说"这个其实重要"）。【D】

> 方案对比的技术分析（改动/优点/缺点）= agent 产出，作为用户决策的参考材料。

**Step 1 末尾 — 机器结构检查前置自跑（零成本提速）：** 初稿（含必问决策点定稿）写完后，主 agent 立即自跑 `python3 ${SKILL_DIR}/scripts/check_issues.py {topic_dir}`，FAIL 当场修低级硬伤（幽灵 #N、空 N/A、❌/待补残留、P0/P1 缺 ≥2 方案、P 级与 blocked_by 不一致），不必等 Step 6。
> **与 Step 6 审查的分工**：此处只杀机器可证的结构硬伤（快、主 agent 自跑）；Step 6 才是质量门（fresh subagent 跑，含语义/盲区/红队评审）。两者不替代——Step 6 的 check_issues.py exit 1 仍硬阻断判 FAIL。

**Step 2（追踪）— 派 fresh-context subagent，对抗主 agent 同源盲区：**

主 agent 写 issues.md（含覆盖核验表）时带着某个盲区——它漏掉的元素，自己填表也填不进，表看起来 100% 覆盖实则是自证。Step2 用 fresh context **他证**：subagent 从 ② 独立重建覆盖表，与主 agent 的表 diff，差异即真 gap。

**派两个异质角色（认知帧不同，不是同名分身）：**

| 角色 | 认知帧 | 输入 | 对抗什么 |
|------|--------|------|----------|
| **A 覆盖重建者**（必跑）| 规范帧（top-down：② 里每个元素**该**对应什么 issue）| **禁读 issues.md（重建阶段）**，只读 ② + CONTEXT.md | L1 注意力盲区 + 同源自证 |
| **B 异常猎手**（条件触发）| 失败帧（bottom-up：每个元素**什么会坏、什么没人处理**）| 读 ② + issues.md | L2 认知同构盲区（类别选择性）|

**角色 B 触发条件**（满足任一即开，否则只跑 A。判据量化见 loop-skeleton「复杂度自评」信号表）：
- **状态复杂度**信号≥中（4+ 状态/单状态机）→ ② §5 含状态转换路径需失败帧扫死角
- **跨边界数**信号≥中（2+ 外部系统依赖）→ §8 有跨进程/跨团队边界需扫异常路径
- ② §10 显含并发·时序·一致性挑战词（grep 确认）
- 无状态单一模块的小改动 → B 不触发，A 足矣。

**角色 A 关键约束：重建覆盖表 T_recon 之前绝不能 read issues.md**——读了就被锚定，回到自证。流程：先从 ② 按 4 轴（与主 agent 同一套，见 fog-of-war.md）独立枚举可拆元素建 T_recon → **重建完才读 issues.md** → 两表逐行 diff。

**gap = 三态 diff（MECE，覆盖问题的完整分类）：**
- **MISSING（漏项）**：T_recon 有、issues.md 无对应 issue（②有元素没被拆）
- **PHANTOM（脱锚）**：issues.md 有 issue、② 查不到根（假冒/越界）
- **MISMATCH（虚覆盖）**：标了对应但内容没真解决（如只写了正常路径，异常分支空缺）

**角色 A Task prompt：**

```
你是独立覆盖重建 subagent。上下文与主 agent 隔离——**重建阶段禁止读 issues.md**。
**决策账本纪律：** decisions.md（作为 context 参数注入）里 status=confirmed 的决策是用户已拍板结论，已 confirmed 决策不得当 gap 重报；有下游新证据推翻须标 `[REVISIT of D-NNN]` + 附新证据走 Step 6b 反哺（D-不可逆须主 agent ask_user）。
1. read system-architecture.md（②，真相源）+ 项目根 CONTEXT.md
2. 按拆分维度 4 轴（状态§5/模块§7/边界§8/挑战§10）从 ② 逐条枚举每个可拆元素，
   对每个判断：需不需要 issue、是什么 issue。建成覆盖表 T_recon。
   （4 轴之外扫 ② 其余章节，凡可拆元素照同样规则处理）
3. **重建完成后**才 read issues.md 的「上游覆盖核验」表。逐行 diff T_recon vs 主 agent 的表。
   产出三类 gap：MISSING（②有issue无）/ PHANTOM（issue有②无根）/ MISMATCH（标覆盖但内容未解决）。
4. 每条 gap 标类型（F/K/D）。写入 {topic_dir}/changes/tracing-round-{N}.md。
```

**角色 B Task prompt（条件触发时追加）：**

```
你是独立异常猎手 subagent。上下文与主 agent 隔离。假设 issues.md 是错且不全的。
**决策账本纪律：** decisions.md（作为 context 参数注入）里 status=confirmed 的决策是用户已拍板结论，已 confirmed 决策不得当 gap 重报；有下游新证据推翻须标 `[REVISIT of D-NNN]` + 附新证据走 Step 6b 反哺（D-不可逆须主 agent ask_user）。
1. read system-architecture.md（②）+ issues.md
2. 戴失败帧，按 hunting 清单对每个 issue/元素找未覆盖面：
   异常路径(error/fallback/超时/重试/降级) / 边界值(空/单元素/极大极小) /
   并发时序(race/幂等/乱序) / 状态机死角(不可达/缺转移/卡死) /
   删除测试(对每个 issue 问「不做它会怎样」——抓伪 issue)
3. 产出「未处理清单」，每条标 F/K/D。追加到 tracing-round-{N}.md。
```

**为什么 A、B 是真异质（非换名分身）**：A 从 ② 往下推问「该有什么」抓**漏项**；B 从失败模式往上戳问「什么会坏」抓**虚覆盖/伪 issue**。同一元素，A 抓「完全没拆」，B 抓「拆了但没拆干净」。不重叠。

**追踪原 4 视角的新归属**：方案完整性 / 优先级一致性 / 前沿清晰度 由角色 A 在 diff 时顺带核验（读 issues.md 后）；原「覆盖性」视角已升级为 A 的独立重建 diff（更强）。

> **机器化降级空间**：`check_issues.py` 已覆盖「覆盖核验表形式」「P0/P1≥2 方案」「blocked_by 无幽灵」「P级一致性」——即角色 A（覆盖重建者）的机器可判子集，这些可由主 agent 自跑脚本完成，不占 subagent 预算。subagent 只做脚本做不了的：从 ②往下的语义重建 diff（漏项/虚覆盖/伪 issue）+ 失败帧异常猎手（角色 B）。脚本未覆盖前维持 A+B 双角色。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 loop-skeleton.md。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 issues.md；派 fresh subagent 渲染 issues.html（机制见 loop-skeleton.md Step 5b）（主角图：决策 DAG 图，节点状态色标）。**

**Step 6（审查）— 派 fresh-context 审查 subagent（按 ../design-shared/references/review-agent.md 规范，先跑 `scripts/check_issues.py` 机器检查，FAIL 硬阻断），6 维评审（含红队维度），报告写 `changes/review-issues.md`（frontmatter 含 verdict + machine_check）。APPROVED 后进 Step 6b 反哺检查（回扫 ①②上游），再交接。**

## Phase Loop 机制

- 收敛失败 → 回 Step 3 补充方案对比/追踪新 issue
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- **反哺触发上游修订**（详见 loop-skeleton.md Step 6b）→ 上游 .md 更新后，本阶段可能需重新对齐 → 回 Step 2 重追踪
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛

## Self-Check

**[MANDATORY] 禁止在未完成 loop-skeleton 全流程（含 Step 6 审查 APPROVED）时声称完成。**

- [ ] issues.md 存在，frontmatter 含 `verdict: pass`
- [ ] **`decisions.md` 已读**（Step 1.0）+ 本阶段 D 类决策（P0/P1 划线/DESIGN-IT-TWICE 选定/P3 延后）已即时 append
- [ ] **`changes/backfeed-round-{{N}}.md` 存在**（Step 6b 反哺检查真执行了；entries=0 也算，只要文件产出）
- [ ] issues.html 存在，决策 DAG 图正确渲染（状态色标）
- [ ] **「上游覆盖核验」表存在，每行状态为 ✅ 或 N/A（无 ❌ 待补、无空行）**
- [ ] `changes/tracing-round-{N}.md` 存在，**含角色 A 独立重建 diff（MISSING/PHANTOM/MISMATCH）**
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

> **[状态追踪]** 交接前调 `design_status complete_phase issues` 收尾——自动校验 issues.md + verdict:pass + review APPROVED，过了才标 completed。
> **有 tool 优先用 tool**：`design_status(action: complete_phase, phase: issues)`；**无 tool 用 CLI**：`design-status complete-phase issues`。

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
