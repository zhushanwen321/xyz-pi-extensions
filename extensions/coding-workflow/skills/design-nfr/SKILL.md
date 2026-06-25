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

按 `references/loop-skeleton.md`（位于 design-clarity skill 的 references 目录）的 6 步循环执行。**（loop-method.md 的方法论仅 clarity 首次 read，本阶段无需 read。）**

**Step 1（交互+初稿）— Grilling 遍历副作用分析树：**

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

**Step 2（追踪）— 派 fresh-context subagent，按 3 视角追踪：**
副作用覆盖性（每已决策方案评估 7 维度？不适用有理由？）/ 缓解可行性（缓解方案可落地？残余风险可接受？）/ **回灌完整性（每条缓解项是否登记了回灌去向 + **验收方式**？去 ⑤的是否标注到章节？验收方式=代码测试的是否附 NFR-AC？去 ③的是否新建了 issue？）**。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 loop-skeleton.md。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 non-functional-design.md；派 fresh subagent 渲染 non-functional-design.html（机制见 loop-skeleton.md Step 5b）（主角图：风险矩阵热力图 issue×7维度 ✅⚠️❌着色）。**

**Step 6（审查）— 派 fresh-context 审查 subagent，5 维评审，报告写 `changes/review-nfr.md`。APPROVED 才交接。**

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
- [ ] `changes/tracing-round-{N}.md` 存在
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
