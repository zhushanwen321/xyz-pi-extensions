---
name: xyz-harness-spec-clarify
description: >-
  Use when starting Phase 1 of a coding workflow to transform a vague user
  requirement into a validated spec.md via a convergence loop. Triggers:
  "spec clarify", "clarify requirements", "澄清需求", "收敛需求", "Phase 1",
  "build spec model", "需求不清晰". Not for: implementation (Phase 3+),
  debugging, code review, or tasks with an already-approved spec.
---

## 核心原则

1. **Model first, spec second** — 先建结构化模型（`clarification.md`）验证，再生成 spec.md。不先写 spec 再检查。
2. **Trace don't ask** — 不是"我该问什么"，而是"我能不能追踪完这条路径"。追踪卡住的地方就是遗漏。
3. **5 perspectives are forcing functions** — User Journey / Data Lifecycle / API Contract / State Machine / Failure Path。5 个视角都走完才能声称"完整"。详见 `references/scenario-tracing.md`。
4. **One question at a time** — 逐个解决 gap，不一次性抛出所有问题。
5. **Verify before asserting** — 模型中每个事实必须标注来源（code/discussion/assumption）。assumption 必须后续验证或标 `[UNVERIFIED]`。

## 机制：收敛循环

本 skill 用**收敛循环**替代线性 checklist。流程在「模型构建 → 场景追踪 → gap 发现 → gap 解决」之间循环，直到追踪不再产生新 gap。

| | 线性 checklist | 收敛循环（本 skill） |
|---|---|---|
| 遗漏发现时机 | 最后 review 时 | 构建过程中自我暴露 |
| 停止条件 | checklist 完成 | 追踪无新 gap |
| 回退成本 | 高（已写 spec） | 低（只改模型） |

**Auto Mode：** coding-workflow 扩展自动管理 loop。gate 内嵌 gap-analysis subagent 做二次检查——如果 gate 发现新 gap，退回 AI 解决后重新 gate（gate 内部实现由 orchestrator 管理，本 skill 不关心）。

<HARD-GATE>
[MANDATORY] Do NOT invoke any implementation skill or write any code until the spec has been generated, reviewed, and approved. Applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## 流程地图

```
Round 1: Foundation（一轮）
  └ read references/foundation-round.md
      Step 1-3: Quick Overview → Clarifying Questions → Approach Selection

Round 2+: Convergence Loop（多轮迭代）
  └ read references/convergence-loop.md（主循环流程）
      ├ Step 4: Build/Update Model   → references/clarification-model.md
      ├ Step 5: 5-Perspective Tracing → references/scenario-tracing.md
      ├ Step 6-7: Gap 管理           → references/gap-management.md
      └ Step 8: Convergence Check     → 收敛则退出，否则回 Step 4

Exit: Spec Generation
  └ references/convergence-loop.md 的 Step 9 → 调用 coding-workflow-gate(phase=1)
```

## 路由表

按当前所处阶段 read 对应文件。不要一次全部加载——按需加载节省 context。

| 当前阶段 / 要做的事 | read |
|---|---|
| Phase 1 刚启动，做 Round 1 基础 | `references/foundation-round.md` |
| 进入 Round 2+ 收敛循环 | `references/convergence-loop.md` |
| 做 5 视角场景追踪 | `references/scenario-tracing.md` |
| 构建 / 更新 `clarification.md` 模型 | `references/clarification-model.md` |
| 分类 / 优先级 / 解决 / Tracker Gap | `references/gap-management.md` |
| 生成 spec.md（循环退出） | `references/convergence-loop.md` → Step 9 |
| 不在 coding-workflow 中独立使用 | `references/foundation-round.md` 末尾 |

## 产出物

- `{topicDir}/clarification.md` — 结构化模型（模型结构见 `references/clarification-model.md`）
- `{topicDir}/spec.md` — 最终规格说明（含 frontmatter: verdict/clarification_rounds/model_version/gaps）

<!-- LOCAL-OVERRIDE:START -->
## 本地目录覆盖规则

与 xyz-harness-brainstorming skill 的 LOCAL-OVERRIDE 规则完全一致。产出目录：`.xyz-harness/${yyyy-MM-dd}-${主题}/`。
<!-- LOCAL-OVERRIDE:END -->

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产出不可用 | 必须严格遵守，不得删除或削弱 |
| `<HARD-GATE>` | 不可逾越的硬门禁。违反将导致后续所有 phase 失败 | 绝对不允许跳过 |
