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

> **[铁律] 本阶段不进入代码级细节。** 不做代码级 API 签名/时序图/DB schema（属 ⑤design-code-arch），
> 不做 Issue 拆分（属 ③design-issues），不做性能/成本量化（属 ④design-nfr）。架构决策落到
> `system-architecture.md` 为止，向下只给约束（grep 规则、Port 清单、不变式），不给实现。

**统摄 metric：复杂度归位** — 所有决策回问「复杂度是否归位到正确的地方？」模型复杂度集中 aggregate 而非散落？反模式本质都是「复杂度没在正确的地方」。

### 边界划分原则（核心版，完整版见 `references/architecture-perspectives.md` 顶部）

> **边界 = 捕获一个不对称**（变化率 / 所有权 / 失效域 / 语言的差异）。边界的代价必须与它捕获的不对称相匹配；
> 没有不对称可捕获的边界 = 零价值（伪 port / 空壳层 / 空壳模块）。这就是「复杂度归位」的操作化。

三层边界，同一原则三个代价台阶——**代价越高，配得上的不对称要越大**：

| 边界 | 跨越代价 | 判据 |
|------|---------|------|
| 模块 | import（最廉） | 2+ 改动原因=该拆 |
| 层 | interface/port（中） | 依赖指向稳定方；核心层零外部依赖 |
| 系统 | 进程/契约+团队（最贵） | 同一 Ubiquitous Language？同团队？同部署节奏？ |

常见事故：过早微服务（模块级不对称、划了系统级边界）/ 分了层却 god module（层划了、模块没跟上）。
**Port ≠ interface**：port 让结构边界（编译期 import，指向稳定方）与控制边界（运行期调用流，§9 泳道图）
反向——domain 结构上依赖 port、运行时通过 port 调用 infra。不能反转的 interface = 伪 port。
**证伪三连**（删/翻/挪）见 perspectives 文档。

## 执行流程

按 `../design-shared/references/loop-skeleton.md`（共享参考目录）的 6 步循环执行。**（loop-method.md 的方法论仅 clarity 首次 read，本阶段无需 read。）**

**Step 1（交互+建模初稿）— Grilling 遍历架构决策树：**

> **[状态追踪]** 开始时调 `design_status start_phase architecture` 标记阶段开始（会校验 clarity 已 completed）。
> **有 `design_status` tool 优先用 tool**：`design_status(action: start_phase, phase: architecture)`；**无 tool（Claude Code/Cursor/shell）用 CLI**：`design-status start-phase architecture`。CLI 完整用法见 loop-skeleton.md「CLI 完整用法」。
>
> **[按 loop-skeleton Step 1.0]** grilling 前先获取已确认决策：
>
> **[复杂度档位]** 先读 `_progress.md` 的 `complexity_tier`：**L1 档跳过 context-builder**（主 agent 直读 decisions.md + 必问决策点引用的上游章节）；L2/L3 派 context-builder。追踪/审查/重建帧的降级见 loop-skeleton「复杂度自评与降级档位·三档执行矩阵」。本阶段上游较多，派 **context-builder subagent**（fresh）读 `{topic_dir}/decisions.md`（本 topic 已确认决策）+ 相关长期文档（NFR.md/ADR/ARCHITECTURE.md）+ 上游 .md，输出「阶段工作摘要」（不可推翻决策清单 + 设计树入口 + 接口契约）注入主 agent context。**grilling 不得重新确认已 confirmed 决策**；每个 D 类决策拍板后按 Step 1.2 即时 append decisions.md。

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
2. **搭便车改造清单（候选，⑤骨架验证后最终确认）** — business-goal→system-goal 转换时发现的"趁机可做的重构"，逐个问用户本轮是否做（候选意向）。用户对范围/风险拍板意向，但**真实工作量要到⑤骨架验证才能确定**——⑤发现某项远超预期会回流本阶段重新确认范围。【D】**清单写入 §1 表，每项标 `候选` 状态**（状态流转见 deliverable-template §1 说明：候选→待⑤确认→已纳入/已回流/打回）。
3. **Seam/port 真伪边界** — 哪些依赖值得做 port（可替换性 vs 复杂度成本）。agent 按启发式标"假设 seam"，但"真 seam 还是删掉"是用户取舍。【D-不可逆】
4. **领域模型边界争议** — aggregate vs DTO、有状态机 vs 无状态，有真实不确定性时逐个问。【D-不可逆】
5. **状态机严格度** — 显式转换表（紧，早暴露错误）还是只守终态（松，灵活）？用户偏好。【D】

> 其余（依赖 4 类分类启发式、命名、不变式推导、Context Map 画法）= agent 自决。

**Step 1 收尾 — 方案对齐检查点 [MANDATORY]：**

> **为何只在 ②做、①clarity 不做：** 架构是高耦合系统——分层×状态机×seam×领域边界 5 个独立答案拼起来的整体，可能与用户脑中想的不一样。用户必须在初稿交给独立 subagent（Step 2）前看到整体形态，否则整体偏差会一路污染 ③④⑤⑥。clarity 阶段业务目标低耦合、可加可减，不需要此检查点。

5 个必问点 grilling 完毕后、写初稿前，**必须**做一次整体对齐：

1. **合成 30 秒方案摘要** — 把 5 个答案拼成一段可速读的整体（分层选择 + 核心建模 + 状态机形态 + 主要边界 + 搭便车范围），让用户看"拼起来长什么样"，而非 5 个孤立答案。
2. **边界三台阶速览** — 用核心目标的边界表，把当前设计的三类边界各列一行：

   | 台阶 | 当前设计里的边界 | 捕获的不对称 | 代价匹配？ |
   |------|----------------|-------------|-----------|
   | 模块 | {列出主要模块} | {为何独立} | {是/否} |
   | 层 | {分层选择} | {变化率差异} | {是/否} |
   | 系统 | {Context Map 里的边界} | {语言/团队/部署} | {是/否} |

   对每行问一句删/翻/挪（见 perspectives 证伪三连）：去掉会塌缩吗？方向能反吗？能滑动吗？**让用户一次看全三台阶，而非在 #1#3#4 三个碎片问题里拼。**
3. **ask_user 整体确认** — "以上是拼起来的整体方案 + 边界速览，这是你脑中想的方向吗？" 用户点头才写初稿；用户说"不对"→ 回到具体必问点修正，不带着整体偏差进 Step 2。

> 这个检查点不是新 Step——是 Step 1 的收尾动作，不改动 loop-skeleton 的 6 步骨架。Step 2 的 subagent 找 gap（完整性），但**整体方向对不对是用户的判断**，不能外包给 subagent。

**Step 1 末尾 — 机器检查前置自跑 [RECOMMENDED]：**

方案对齐检查点通过、初稿写完后，主 agent 立即自跑 `scripts/check_architecture.py <topic_dir>`（exit 0 才进 Step 2）。

**与 Step 6 审查的分工：** Step 1 末自跑 = 早反馈（占位符/缺章节/verdict 缺失/状态机 Status/Reason 漏标等低级硬伤，在交给 Step 2 subagent 前就修掉，避免 subagent 追着低级错误跑）；Step 6 审查 subagent 仍复跑一次做最终门（**不取消，硬阻断铁律不变**）。同一脚本两道关：Step 1 末是「早修低级伤」，Step 6 是「最终门」。

**Step 2（追踪）— 派 3 个 fresh-context subagent 并行，各戴一个认知帧（2 视角）：**

5+1 视角是 6 副异质认知眼镜。一个 subagent 串行戴 6 副，每换一帧要 re-orient，后半程吃前半程的残留预设（confirmation bias 沿视角链累积）。拆成 3 组并行，每个只聚焦一个认知帧——分组映射 + 交叉验证点 + **降级判据（简单项目可降到 2 组/1 组，Step 1 末自评）**见 `references/architecture-perspectives.md`「并行分组」。默认 3 组，CRUD 单层无状态机等简单项目按判据降级。

| 组（认知帧）| 追踪视角 | 写入 |
|-------------|---------|------|
| 建模帧 | 1 模型完整性 + 2 状态正交性 | `tracing-round-{N}-modeling.md` |
| 结构帧 | 3 分层纪律 + 4 依赖边界 | `tracing-round-{N}-structure.md` |
| 演进帧 | 5 变化轴 + 6 行为契约（greenfield 视角6 降级→只跑视角5）| `tracing-round-{N}-evolution.md` |

3 个 subagent **各自独立 fresh context**（互不继承），并行派发。每个的 task prompt 沿用 loop-skeleton Step 2 模板，但：
- `read architecture-perspectives.md` 后**只追踪本组的 2 视角**（其余视角不扫，避免越组重复）
- 产出写到本组专属 tracing 文件
- 遇疑似多余边界，用 preamble 的删/翻/挪证伪三连

**交叉验证（主 agent 汇总时做）：** 3 组 gap 汇总后，识别**交叉命中**——同一边界/模型被两组独立报告（如「粒度错配」建模帧视角1 + 演进帧视角5 都报、「伪边界」结构帧视角3 + 演进帧视角5 都报）。交叉命中标 `[CROSS-VALIDATED]`，**优先级最高**——两个独立 context 都盯上了，不是单方盲区。

**收敛判定（Step 4 复核）：** 各组（3 组或降级后的 2/1 组）都 CONVERGED（无新 gap）才算整轮收敛。**Step 4 收敛复核只重跑「未 CONVERGED 的组」——已 CONVERGED 的组不必重跑（首轮复核和回流后复核均同此规则）**，避免对已收敛的组重复派 fresh context。任一组有新 gap → 回 Step 3 处理后只重跑该组。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 loop-skeleton.md。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 system-architecture.md；派 fresh subagent 渲染 system-architecture.html（机制见 loop-skeleton.md Step 5b）（主角图：分层架构图+状态机图）。**

**Step 6（审查）— 派 fresh-context 审查 subagent（按 ../design-shared/references/review-agent.md 规范，先跑 `scripts/check_architecture.py` 机器检查，FAIL 硬阻断），6 维评审（含红队维度），报告写 `changes/review-architecture.md`（frontmatter 含 verdict + machine_check）。APPROVED 后进 Step 6b 反哺检查（回扫 ①上游），再交接。**

## Phase Loop 机制

- 收敛失败 → 回 Step 3 补充交互更新模型
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- **反哺触发上游修订**（详见 loop-skeleton.md Step 6b）→ 上游 .md 更新后，本阶段可能需重新对齐 → 回 Step 2 重追踪
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛

## Self-Check

**[MANDATORY] 禁止在未完成 loop-skeleton 全流程（含 Step 6 审查 APPROVED）时声称完成。**

- [ ] system-architecture.md 存在，frontmatter 含 `verdict: pass`
- [ ] **`decisions.md` 已读**（Step 1.0 获取已确认决策）+ 本阶段 D 类决策（分层/状态机/seam/领域边界）已即时 append
- [ ] **`changes/backfeed-round-{{N}}.md` 存在**（Step 6b 反哺检查真执行了；entries=0 也算，只要文件产出）
- [ ] system-architecture.html 存在，分层图+状态机图正确渲染
- [ ] `changes/tracing-round-{N}-{modeling|structure|evolution}.md` 存在（3 组并行追踪都执行了）
- [ ] `changes/review-architecture.md` 存在且 verdict: APPROVED
- [ ] 业务目标→系统目标转换完整，搭便车目标标注来源
- [ ] **搭便车 §1 表每项有状态列**（候选/待⑤确认/已纳入/已回流/打回），交接时已向用户显式列出候选清单
- [ ] **方案对齐检查点已执行**（Step 1 收尾）：30 秒方案摘要 + 边界三台阶速览 + 用户整体确认
- [ ] 设计立场回答了「核心计算是什么」
- [ ] 核心模型标注类型+不变式+建模理由；状态机 Status/Reason 正交、终态不可逆
- [ ] §11 所有 grep AC 实际可运行；Context Map/泳道图存在
- [ ] **refactor 模式**：§12 行为契约清单完整（每条标 file:line + 保持/变更/删除，`[CONFLICT]` 已决策）；**greenfield**：§12 写降级理由
- [ ] 所有特化决策有「违反什么+为什么合理」

## 本地目录覆盖规则

- **主目录：** `.xyz-harness/`（项目根）
- **子目录：** `${yyyy-MM-dd}-${主题简短标题}`
- **路径：** `.xyz-harness/${主题}/system-architecture.md` + `.html`
- **不同主题不同子目录，禁止混放。** 单次写入超 1000 字优先拆分子文档。

## 下游衔接

审查 APPROVED 后向用户交接（按 loop-skeleton.md Step 6 格式）：

> **[状态追踪]** 交接前调 `design_status complete_phase architecture` 收尾——自动校验 system-architecture.md + verdict:pass + review APPROVED，过了才标 completed。
> **有 tool 优先用 tool**：`design_status(action: complete_phase, phase: architecture)`；**无 tool 用 CLI**：`design-status complete-phase architecture`。

```
✅ ②系统设计概要 已完成并通过独立审查。
   产出：system-architecture.md + system-architecture.html
   审查报告：changes/review-architecture.md（verdict: APPROVED）
   搭便车候选（待⑤骨架验证确认，届时会再问你）：
     - {每项列一行：改造目标 + 动机 + 当前意向}
     - 无候选 / 或显式列出
下一步：③Issue 拆分 — 系统设计→具体问题，P0-P3 优先级 + 方案对比
调用：/design-issues
是否现在进入下一步？
```

> **搭便车清单显式提醒：** 交接时必须向用户列出当前候选清单（从 §1 表读取状态=`候选`/`待⑤确认` 的行）。让用户在 ②结束时就知道"这些悬挂项，到了 ⑤会再问你一次"——不让清单默默挂到 ⑤ 才被想起。

用户确认后才加载下一 skill。完整设计流程见 `docs/design-workflow-guide.md`。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
