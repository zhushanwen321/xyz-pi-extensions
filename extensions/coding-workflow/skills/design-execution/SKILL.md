---
name: design-execution
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

按 `../design-shared/references/loop-skeleton.md`（共享参考目录）的 6 步循环执行。**（loop-method.md 的方法论仅 clarity 首次 read，本阶段无需 read。）**

**Step 1（交互+初稿）— Grilling 遍历 Wave 依赖树：**

> **[状态追踪]** 开始时调 `design_status start_phase execution` 标记阶段开始（会校验 code-arch 已 completed）。
> **有 `design_status` tool 优先用 tool**：`design_status(action: start_phase, phase: execution)`；**无 tool（Claude Code/Cursor/shell）用 CLI**：`design-status start-phase execution`。CLI 完整用法见 loop-skeleton.md「CLI 完整用法」。
>
> **[按 loop-skeleton Step 1.0]** grilling 前先获取已确认决策：
>
> **[复杂度档位]** 先读 `_progress.md` 的 `complexity_tier`：**L1 档跳过 context-builder**（主 agent 直读 decisions.md + 必问决策点引用的上游章节）；L2/L3 派 context-builder。追踪/审查/重建帧的降级见 loop-skeleton「复杂度自评与降级档位·三档执行矩阵」。本阶段上游较多，派 **context-builder subagent**（fresh）读 `{topic_dir}/decisions.md`（本 topic 已确认决策）+ 相关长期文档（NFR.md/ADR/ARCHITECTURE.md）+ 上游 .md，输出「阶段工作摘要」（不可推翻决策清单 + 设计树入口 + 接口契约）注入主 agent context。**grilling 不得重新确认已 confirmed 决策**；每个 D 类决策拍板后按 Step 1.2 即时 append decisions.md。

> **提问从宽：** Wave 编排、依赖推导、串并行多为技术推导，agent 自决为主。仅当出现"是否需要 Prefactor Wave""哪些 P3 真延后""并行组是否真不冲突"等只有用户能判断的点时才 ask_user。

```
Wave 编排（根：从时序图推导）
├── Wave 0: Prefactor → 是否有让后续更易的前置重构？
├── Wave 1: 首个垂直切片（P0/P1）
│   ├── 切穿哪些层？→ schema→API→逻辑→测试 全切
│   ├── blocked_by？→ Wave 0 or 无
│   └── subagent 配置 → 注入哪些上下文/读取哪些文件
├── Wave 2-N: 后续切片 → 并行还是串行？（看时序图依赖+文件冲突）
├── Wave N+1: 验收 Wave → blocked_by 所有功能 Wave，必须最后
│   └── 职责：读测试验收清单全量→跑测试→全 PASS 才算实现完成（闭环闸门）
└── P3 延后项 → 标注「后续迭代」+ 理由
```

遍历纪律：先走 Prefactor Wave（如有）和 P0 Wave——它们是后续 Wave 的依赖根。
从 code-architecture.md §4 时序图推导：功能 B 调用功能 A → Wave(B) blocked_by Wave(A)；同文件被多时序修改→必须串行。
**编排末端强制加 Wave N+1「验收 Wave」**（blocked_by 所有功能 Wave），它不做功能开发，只读测试验收清单全量→跑测试→全 PASS 才算实现完成（设计→实现的闭环闸门）。
**[MANDATORY] ④性能混沌类缓解项编排（接收 nfr 路由契约）：** 从④回灌表筛 `验收方式=性能混沌` 的缓解项，编排为**独立 perf/chaos Wave 或 pre-prod gate**（不混入功能 Wave——性能/混沌测试需独立负载·故障注入环境，与功能测试不同层）。该 Wave blocked_by 相关功能 Wave。无性能混沌类缓解项则跳过并注明。
按 `references/vertical-slice.md` 垂直切片原则（不水平切片，每 Wave 切穿所有层可独立验证）。
**[MANDATORY] 定稿必须含「测试验收清单」章节**——把⑤test-matrix 全量用例（来源 A 功能 + 来源 B NFR）按归属 Wave 列全，作为实现期的 Definition of Done。
初稿用 `references/deliverable-template.md`。

**Step 1 末尾 — 机器结构检查前置自跑（零成本提速）：** 初稿写完后，主 agent 立即自跑 `python3 ${SKILL_DIR}/scripts/check_execution.py {topic_dir} --no-consistency-final`（`--no-consistency-final` 跳过 6c 总闸门检查——该文件 Step 6c 才产出，未到 6c 前必缺失），FAIL 当场修低级硬伤（验收清单缺用例/末尾验收 Wave 缺 blocked_by），不必等 Step 6。
> **与 Step 6 审查的分工**：此处只杀机器可证的结构硬伤；Step 6 才是质量门（含红队反过度编排）。两者不替代——Step 6 的 check_execution.py exit 1 仍硬阻断判 FAIL。
>
> **测试验收清单可脚本生成草稿（减写）：** `python3 ${SKILL_DIR}/scripts/check_execution.py {topic_dir} --generate-manifest` 读⑤§6 test-matrix 自动生成清单行（用例 ID/UC/来源/断言/执行层），「功能归属 Wave」列留空给 agent 从⑤§4时序图推导填入。生成后 agent 只补该列 + 校对，不必从零写。

**Step 2（追踪）— 2 组并行 fresh-context subagent（认知帧内聚，用 `wait:false` 同消息派发，见 loop-skeleton「subagent 派发工程规范」）：**

> **为何拆 2 组（不拆 4）**：3 个结构视角（切片独立性/依赖闭合/并行安全）同属"Wave 图结构审计"认知域，fresh context 已消除对话偏误，同域内一个 subagent 顺序切换帧的帧内偏误很低，拆 4 = 4x IO 换不来等量盲区消除（过度并行）。测试/实现闭环跨读⑤test-matrix↔⑥清单，是不同认知帧，独立成组。
>
> **组 A 机器化降级空间**：Wave 编排脚本化（`check_execution.py` 生成器 + 结构检查）后，结构三视角（切片独立性/依赖闭合/并行安全）可退化为机器自检。当脚本已覆盖这三项时，Step 2 只派组 B（测试闭环，1 个 subagent）即可，从 2 组并行降为单组——主 agent 自跑 `check_execution.py` 的结构检查替代组 A，省一个 subagent。脚本未覆盖前维持 2 组。

| 组（认知帧） | 视角 | 主读 |
|---|---|---|
| **组 A：编排结构审计** | 切片独立性 + 依赖闭合 + 并行安全 | Wave 定义 + ⑤§4 时序图 + blocked_by + 文件影响集 + 并行组 |
| **组 B：测试闭环审计** | 测试闭环 + 实现闭环 | ⑤test-matrix ↔ ⑥测试验收清单 |

**组 A 详细检查**：每 Wave 可独立验证？非水平切片？/ Wave 依赖从时序图完整推导？/ 同并行组真不改同一文件？
**组 B 详细检查**：每 Wave 标注覆盖的⑤test-matrix 用例 ID（含来源 B NFR 用例），并集=全部？每个时序图 alt/else 异常分支落在某 Wave 覆盖里？/「测试验收清单」用例 ID 集合 = ⑤test-matrix 全量？末尾验收 Wave blocked_by 所有功能 Wave？每个功能 Wave 覆盖的用例 ID 都在清单出现？清单的「测试执行层」列与⑤§6 来源 B「强制层级」一致？

产出：组 A 写 `tracing-round-{N}-structure.md`，组 B 写 `tracing-round-{N}-testclosure.md`。轻量项目（单 Wave）可降级为单 agent。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 loop-skeleton.md。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 execution-plan.md；派 fresh subagent 渲染 execution-plan.html（机制见 loop-skeleton.md Step 5b）（主角图：Wave 依赖 DAG 图，标注并行组）。**

**Step 6（审查）— 派 2 组并行 fresh-context 审查 subagent（对齐组 ‖ 红队组，按 `../design-shared/references/review-agent.md` 规范 + loop-skeleton「subagent 派发工程规范」用 `wait:false` 同消息派发）。两组都先跑 `scripts/check_execution.py` 机器检查（FAIL 硬阻断），再各跑认知帧：对齐组 5 维（内部一致性/上游对齐/可执行性/完整性/可视化）写 `changes/review-execution.md`，红队组 1 维（必要性/比例性，反过度设计）写 `changes/review-execution-redteam.md`。两组 APPROVED 后进 Step 6b 反哺检查（回扫①-⑤上游），再进 Step 6c。轻量项目可降级单组（`review_mode: single`，见 loop-skeleton Step 6 降级条款）。**

**Step 6c（全文档一致性终检）— 仅⑥阶段：编码前的总闸门。** 派独立 fresh-context subagent，读取①-⑥全部 .md + CONTEXT.md + ⑤骨架代码，按 6 维做跨文档一致性审计（详见 `references/consistency-check.md`）。产出 `changes/consistency-final.md`（verdict: CONSISTENT / INCONSISTENT）。INCONSISTENT → 矛盾当 gap 回相应阶段 Step 3。**CONSISTENT 才允许交接编码。**

## Phase Loop 机制

- 收敛失败 → 回 Step 1 调整 Wave 编排
- 依赖推导不出 → 回 Step 5 补充时序图细节
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- **一致性终检 INCONSISTENT → 矛盾当 gap 回相应阶段 Step 3**（用例链断回⑤/⑥，决策被推翻回②/③ Step 6b 反哺流程，NFR 没落地回⑤/⑥，骨架漂移回⑤）
- **反哺触发上游修订**（详见 loop-skeleton.md Step 6b）→ 上游 .md 更新后，本阶段可能需重新对齐 → 回 Step 2 重追踪
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛

## Self-Check

**[MANDATORY] 禁止在未完成 loop-skeleton 全流程（含 Step 6 审查 APPROVED + Step 6c 一致性终检 CONSISTENT）时声称完成。**

- [ ] execution-plan.md 存在，frontmatter 含 `verdict: pass`
- [ ] **`decisions.md` 已读**（Step 1.0）+ 本阶段 D 类决策（Prefactor 必要性/并行组划分/P3 延后）已即时 append
- [ ] **`changes/backfeed-round-{{N}}.md` 存在**（Step 6b 反哺检查真执行了；entries=0 也算，只要文件产出）
- [ ] execution-plan.html 存在，Wave DAG 图正确渲染（并行组标注）
- [ ] `changes/tracing-round-{N}.md` 存在
- [ ] `changes/review-execution.md` 存在且 verdict: APPROVED（对齐组）；并行模式另需 `changes/review-execution-redteam.md` verdict: APPROVED（红队组）
- [ ] **`changes/consistency-final.md` 存在且 verdict: CONSISTENT**（Step 6c 总闸门）
- [ ] Wave DAG 图存在，节点+blocked_by 边清晰；调度表完整（切片/P级/依赖/并行组/说明）
- [ ] **末尾验收 Wave 存在，blocked_by 所有功能 Wave**（DAG 末端，必须最后，闭环闸门）
- [ ] 垂直切片——每 Wave 切穿所有层可独立验证（无水平切片）
- [ ] 依赖从时序图推导（有调用证据）；并行安全（同组不改同一文件）
- [ ] P0 在最前 Wave，P3 标注「后续迭代」+理由；Prefactor Wave（如有）为后续铺路
- [ ] 每 Wave 的 subagent 配置完整（注入上下文/读取文件/修改文件）
- [ ] **「测试验收清单」章节存在**，用例 ID 集合 = ⑤test-matrix 全量（来源 A 功能 + 来源 B NFR），每条标归属 Wave
- [ ] **每 Wave 标注覆盖的⑤test-matrix 用例 ID（含 NFR 来源 B），并集 = 全部 test-matrix 用例**（测试闭环）
- [ ] **④每条 `验收方式=性能混沌` 的缓解项有归属 Wave（独立 perf/chaos Wave 或 pre-prod gate），不悬空**（接收 nfr 路由契约）

## 本地目录覆盖规则

- **主目录：** `.xyz-harness/`（项目根）
- **子目录：** `${yyyy-MM-dd}-${主题简短标题}`
- **路径：** `.xyz-harness/${主题}/execution-plan.md` + `.html`
- **不同主题不同子目录，禁止混放。** 单次写入超 1000 字优先拆分子文档。

## 下游衔接

**设计工作流全部完成并通过独立审查 + 一致性终检。** 审查 APPROVED 且一致性终检 CONSISTENT 后向用户交接：

> **[状态追踪]** 交接前调 `design_status complete_phase execution` 收尾——自动校验 execution-plan.md + verdict:pass + review APPROVED + consistency CONSISTENT，过了才标 completed（全流程完成）。
> **有 tool 优先用 tool**：`design_status(action: complete_phase, phase: execution)`；**无 tool 用 CLI**：`design-status complete-phase execution`。

```
✅ ⑥执行计划 已完成并通过独立审查 + 全文档一致性终检。
   产出：execution-plan.md + execution-plan.html（含「测试验收清单」）
   审查报告：changes/review-execution.md（verdict: APPROVED）
   一致性终检：changes/consistency-final.md（verdict: CONSISTENT）

🎉 设计工作流（6 步 + 骨架验证 + 一致性终检）全部完成！
下一步：编码实现
   ⚠️ 编码完成的定义 = 测试验收清单全绿（末尾验收 Wave 不绿 = 未完成）
   ⚠️ 编码全绿后须 /design-closeout 收尾——把稳定结论沉淀进长期文档（ARCHITECTURE/PRODUCT/NFR/ADR/TEST-STRATEGY），否则随 topic 归档流失。
      编码完成 ≠ 真正 Done；编码完成 + 沉淀归档 = Done（闭合设计→实施→沉淀管道）。
   方式 A（推荐）：接入 coding-workflow — 启动 Phase 流程（Phase-test gate 以测试验收清单为验收基线）
   方式 B：手动执行 — 每个 Wave 派一个 fresh subagent；末尾验收 Wave 最后跑
   偏离通道：编码中发现用例设计错误/不可行，走 [DEVIATED] 登记（原因+用户确认），不可静默跳过
是否现在开始编码？
```

用户确认后才开始编码。完整设计流程见 `docs/design-workflow-guide.md`。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
