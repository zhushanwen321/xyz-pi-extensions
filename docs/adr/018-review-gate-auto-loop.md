# ADR 018: Review-Gate 自动循环审查机制

## Status

Proposed

## Context

当前 coding-workflow 5 个阶段的内容质量审查存在结构性缺陷：

1. **主 agent 自审自己**（confirmation bias）— expert-reviewer skill 由主 agent 读取后"假装"自己是 reviewer
2. **无循环动力** — gate retry 只针对脚本检查，content quality review 只做一次
3. **gate 反欺诈 ≠ 内容质量** — `dispatchReviewSubagent` 验证产出物真实性，不评估内容质量

## Decision

引入 **review-gate**：独立 subagent 循环审查，直到 must_fix=0 自动通过。

### 三层编排

| 层级 | 内容 | 实现方式 |
|------|------|---------|
| 第 1 层 | 5-phase 整体流程 | Pi Extension tool（现有） |
| 第 2 层 | phase 内部步骤 | 主 agent 按 SKILL.md 执行（现有） |
| 第 3 层 | gate 内部循环 | Workflow Extension script（新增） |

### Gate Pipeline

每个 phase 按配置顺序执行 gate 链：

```
Phase N 完成 → gate[0].run() → gate[1].run() → ... → 全部通过 → Retrospect → 下一 Phase
```

Phase 配置声明 gate 链：

```typescript
{ phase: 1, gates: ["review-gate", "phase-gate"] }
{ phase: 3, gates: ["review-gate", "phase-gate"] }
{ phase: 5, gates: ["phase-gate"] }
```

### 隔离原则

**每个 phase 的 review-gate 隔离运行，互不干扰：**

1. **状态文件隔离**：`{topic_dir}/.review-gate-p{N}.json`（N = phase 编号），每个 phase 独立的状态文件
2. **交付物隔离**：reviewer 产出写入 `{topic_dir}/changes/reviews/phase-{N}/` 子目录
3. **逻辑隔离**：每个 phase 有独立的 review-gate workflow script（或同一 script 通过 phase 参数切换行为），不共享循环状态

### Subagent 构造方式

采用 **agent.md + task prompt 分离** 模式：agent.md 定义角色和方法论（稳定），放在 `~/.pi/agent/agents/` 下自动发现和加载；task prompt 注入动态上下文（每轮不同），由 workflow script 构造。

### Reviewer Agent 文件规划

| Phase | Agent 文件 | 来源 |
|-------|-----------|------|
| 1 Spec | `spec-reviewer.md` | **新建**，参考 superpowers spec-document-reviewer |
| 2 Plan | `plan-reviewer.md` | **新建**，参考 superpowers plan-document-reviewer |
| 3 Dev | 现有 5 个 SKILL.md | **不新建**，已有专项 reviewer |
| 4 Test | `test-reviewer.md` | **新建**，基于 expert-reviewer 测试评审模式 |

### Review-Gate 内部节点

```
Round N:
  单 reviewer Phase (1/2/4): review → fix（2 节点）
  多 reviewer Phase (3):      parallel review → sync → fix（3 节点）
  → Round N+1 或 passed
```

关键决策：Review 和 Fix 分离，Fix 由独立 subagent 执行（消除 confirmation bias），单 worker 串行修复（避免文件冲突）。

### Retrospect 执行方式

Retrospect subagent **fork 主 session 的对话历史**后执行复盘。需要之前所有阶段的对话记忆来评估：

- Phase 执行质量（是否偏离 spec/plan）
- Harness 体验（工具是否好用、流程是否顺畅）
- 教训提炼（什么该做没做、什么做了不该做）

### 各 Phase 的 Review-Gate 配置

| Phase | Reviewer Skill | 审查维度 |
|-------|---------------|---------|
| 1 Spec | `xyz-harness-expert-reviewer`（计划评审模式） | spec 完整性、AC 可量化、FR/NFR 覆盖 |
| 2 Plan | `xyz-harness-expert-reviewer`（计划评审模式） | spec↔plan 一致性、任务覆盖 |
| 3 Dev | 5 个专项 reviewer（BLR/Standards/Taste/Robustness/Integration） | 业务逻辑、规范、品味、健壮性、集成 |
| 4 Test | `xyz-harness-expert-reviewer`（测试评审模式） | 覆盖度、断言有效性 |
| 5 PR | 不引入 | 纯汇总 |

### 各 Phase 流程变更

#### Phase 1 Spec

```
Step 1-6（产出 spec.md）                ← 不变
    ↓
review-gate                             ← 替代 "Spec Review" 章节
    ↓
phase-gate                              ← 替代 "Gate Handoff"（自动化）
    ↓
Retrospect（fork session）               ← 不变
    ↓
git push + Phase Transition              ← 不变
```

SKILL.md 改动：删除 "Spec Review" + "Gate Handoff" 章节，改为 "完成后调用 review-gate"。

#### Phase 2 Plan

同理，删除 "Plan Review" + "Gate Handoff" 章节。

#### Phase 3 Dev

删除 "Five-Step Specialized Review" + "Gate Handoff" 章节。5 维度 reviewer 由 review-gate workflow script 内部并行 dispatch。

#### Phase 4 Test

删除 review 相关步骤 + "Gate Handoff" 章节。

#### Phase 5 PR

不变，不引入 review-gate。

## Consequences

### 正面

- Reviewer 独立于主 agent，消除 confirmation bias
- 循环机制确保内容质量问题在进入下一 phase 前被修复
- 每个 phase 的 review 逻辑隔离，独立演化
- Retrospect 有完整对话记忆，复盘质量更高

### 负面

- 每个 phase 增加 1-3 轮 subagent 调用的 token 消耗
- SKILL.md 改造后主 agent 需适应新流程

### 风险

- 最大 3 轮限制可能强制通过 — 警告 + 人工介入兜底
- Reviewer 的 must_fix 判定可能不一致 — 统一 YAML frontmatter 格式约束
