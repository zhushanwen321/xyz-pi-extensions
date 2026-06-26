---
name: design-nfr
description: >-
  Use when the user says "非功能性设计", "NFR", "副作用分析", "风险评估",
  "non-functional design", "安全性分析", "性能分析", or has finished issues.md
  and needs to analyze side effects of the chosen solutions. Produces
  non-functional-design.md. Design Step 4 of 6.
  Not for issue decomposition/priorities (Step 3) or code architecture (Step 5).
  Not for writing code. Not for defining new features — only analyzing existing
  solutions' side effects.
---

## 核心目标

Step 3 的 issue 解决方案对系统有什么**副作用**？如何解决？

每个方案的架构/模块/模型改动都引入非功能性影响。本阶段系统识别并设计缓解，避免「功能能跑但系统不可靠」。

**7 维度**（详见 `references/nfr-dimensions.md`）：系统安全 / 业务数据安全 / 性能 / 并发控制 / 稳定性·高可用 / 兼容性 / 可观测性。

## 执行流程

按 `design-shared/references/loop-skeleton.md`（共享参考目录）的 6 步循环执行。**（loop-method.md 的方法论仅 clarity 首次 read，本阶段无需 read。）**

**Step 1（交互+初稿）— Grilling 遍历副作用分析树：**

> **[状态追踪]** 开始时调 `design_status start_phase nfr`（CLI: `design-status start-phase nfr`）标记阶段开始（会校验 issues 已 completed）。

```
副作用分析（根：每个 issue 的已决策方案）
├── Issue #1 → 方案 A
│   ├── 安全 / 数据 / 性能 / 并发 / 稳定性 / 兼容性 / 可观测性（每维度给推荐）
│   └── 不适用 → 写理由（防偷懒跳过）
├── Issue #3 → 方案 B（同 7 维度）
└── 残余风险 → 接受理由 + 监控方式
```

遍历纪律：一个 issue 的 7 维度走完再走下一个 issue（每方案副作用独立）。
不确定性高的副作用（并发死锁/缓存命中率）→ 标记为需⑤骨架验证，不纯靠脑力推演（见 `references/nfr-dimensions.md`）。
初稿用 `references/deliverable-template.md`。

**Step 2（追踪）— 拆两部分：正向追踪 + 回灌指针重建器（反向覆盖）：**

视角1（副作用覆盖性）+ 视角2（缓解可行性）是正向核查（像 ①⑤⑥，单 agent 串行够）。但视角3（回灌完整性）是**反向覆盖问题**——主 agent 声明「去 ③ 新 issue #7」时若漏建/写错编号，自己填表也查不出（同源自证），需 fresh context 他证。

**① 正向追踪（单 fresh subagent，沿用 loop-skeleton Step 2）：** 视角1 副作用覆盖性（每已决策方案评估 7 维度？不适用有理由？）/ 视角2 缓解可行性（缓解方案可落地？残余风险可接受？）。产出 `tracing-round-{N}.md`。

**② 回灌指针重建器（新增 1 fresh subagent，只做视角3，反向重建）：**

> **时序约束（决定能查什么）：** ④ 执行时③ issues.md 已存在、⑤ code-arch 尚未产出。
> - **③ 指针（即时承诺，本重建器查）**：④ 说「去 ③ 新 issue #N」→ 从 issues.md 反向核对 #N 真实存在
> - **⑤ 指针（延期承诺，④ 查不了）**：⑤ 还没写。但这条闭环已被 ⑤ 接住——⑤ code-arch §6「来源 B：NFR 风险→用例映射表」+ ⑤ Step2 反向核对每条 `验收方式=代码测试` 的缓解项有 ≥1 对应用例。**④ 不重复查 ⑤，只对现在能查的 ③ 指针负责。**

**重建器机制：** 读 issues.md（③，不先读 ④ 回灌表——避免被锚定）重建「issues.md 里有哪些 issue」，再读 ④ 回灌表，对每条「回灌去向=③issue」的行 diff。产出三态 gap：
- **PHANTOM**：④ 说「去 ③ 新 issue #7」但 issues.md 无 #7（漏建/写错编号）
- **MISMATCH**：④ 说「新 issue #7 是 P1」但 issues.md 里 #7 是 P2 / 标题不符（属性不一致）
- **ORPHAN**（反向）：issues.md 有 issue 声称来自 ④ 回灌，但 ④ 回灌表无对应登记（仅当 issues.md 有来源标注时查；当前 issue-template 无此字段则跳过）

**重建器 Task prompt：**

```
你是独立回灌指针重建 subagent。上下文与主 agent 隔离。
1. read issues.md（③，真相源）—— 重建「issues.md 里真实存在哪些 issue（编号+P级+标题）」
2. read non-functional-design.md 的「缓解项回灌登记」表
3. 对每条「回灌去向」含 ③issue 的行，核对指向的 #N 是否真实存在于 issues.md：
   PHANTOM（#N 不存在）/ MISMATCH（P级或标题不符）/ ORPHAN（issues.md 有来源标注但④无登记，若有）
4. ⑤ 指针不查（⑤尚未产出，闭环由⑤来源B接住）
5. 每条 gap 标类型（F/K/D）。写入 {topic_dir}/changes/tracing-round-{N}-backfeed.md
```

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 loop-skeleton.md。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 non-functional-design.md；派 fresh subagent 渲染 non-functional-design.html（机制见 loop-skeleton.md Step 5b）（主角图：风险矩阵热力图 issue×7维度 ✅⚠️❌着色）。**

**Step 6（审查）— 派 fresh-context 审查 subagent（按 design-shared/references/review-agent.md 规范，先跑 `scripts/check_nfr.py` 机器检查，FAIL 硬阻断），6 维评审（含红队维度），报告写 `changes/review-nfr.md`（frontmatter 含 verdict + machine_check）。APPROVED 后进 Step 6b 反哺检查（回扫 ①②③上游），再交接。**

## Phase Loop 机制

- 收敛失败 → 回 Step 3 补充分析
- 副作用无法缓解 → 回 Step 3 重新选方案（D 类 issue 可能改答案）
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- **反哺触发上游修订**（详见 loop-skeleton.md Step 6b）→ 上游 .md 更新后，本阶段可能需重新对齐 → 回 Step 2 重追踪
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛

## Self-Check

**[MANDATORY] 禁止在未完成 loop-skeleton 全流程（含 Step 6 审查 APPROVED）时声称完成。**

- [ ] non-functional-design.md 存在，frontmatter 含 `verdict: pass`
- [ ] non-functional-design.html 存在，风险矩阵热力图正确渲染（✅⚠️❌着色）
- [ ] `changes/tracing-round-{N}.md` 存在（正向追踪）
- [ ] **`changes/tracing-round-{N}-backfeed.md` 存在（回灌指针重建，含 PHANTOM/MISMATCH diff）**
- [ ] `changes/review-nfr.md` 存在且 verdict: APPROVED
- [ ] issues.md 的每已决策方案评估了 7 维度（不适用有理由）
- [ ] 标注的风险都有缓解方案或显式列为残余风险（接受理由）
- [ ] 无 ❌（不可接受）项——如有则已回 Step 3 重新选方案
- [ ] 不确定性高的副作用标记为需⑤骨架验证（有验证要点记录）
- [ ] **缓解项回灌登记表存在**，每条缓解有明确去向（⑤章节 / ③新issue / 运维项）
- [ ] **每条缓解标了验收方式**（代码测试/骨架约束/运维项三选一）；代码测试类附 NFR-AC（归属 UC + 断言摘要）
- [ ] **回灌到 ③的新 issue 已在 issues.md 中出现**（双向可查）

## 本地目录覆盖规则

- **主目录：** `.xyz-harness/`（项目根）
- **子目录：** `${yyyy-MM-dd}-${主题简短标题}`
- **路径：** `.xyz-harness/${主题}/non-functional-design.md` + `.html`
- **不同主题不同子目录，禁止混放。** 单次写入超 1000 字优先拆分子文档。

## 下游衔接

审查 APPROVED 后向用户交接（按 loop-skeleton.md Step 6 格式）：

> **[状态追踪]** 交接前调 `design_status complete_phase nfr`（CLI: `design-status complete-phase nfr`）收尾——自动校验 non-functional-design.md + verdict:pass + review APPROVED，过了才标 completed。

```
✅ ④非功能性设计 已完成并通过独立审查。
   产出：non-functional-design.md + non-functional-design.html
   审查报告：changes/review-nfr.md（verdict: APPROVED）
下一步：⑤代码架构设计 — 工程目录/契约/包管理/类方法时序图
调用：/design-code-arch
是否现在进入下一步？
```

用户确认后才加载下一 skill。完整设计流程见 `docs/design-workflow-guide.md`。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
