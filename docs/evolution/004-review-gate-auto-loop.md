# 004: Review-Gate 自动循环审查机制

> **⚠️ SUPERSeded — 本文档已被以下文档取代：**
> - 各 Phase 详细规格：`docs/phase-specs/phase-{1-4}-*.md`
> - 统一分析范式：`docs/review-gate-phase-analysis-playbook.md`
> - 架构决策记录：`docs/adr/018-review-gate-auto-loop.md`
>
> 本文档的以下设计已变更：
> - Phase 1/2/4 Review-Gate：从"单次检查无循环"改为"Workflow 循环"
> - Phase 4：去掉 Review-Gate，改为 Test-Fix Loop Workflow
> - Phase-Gate：从"统一 workflow 循环 doc-fix"改为"2 步（脚本检查 + AI Agent 防伪造）"
>
> 请以上述 phase-specs 和 playbook 为准。

Status: ~~active~~ superseded

## Phase 划分决策

保持 `spec → plan → dev → test → pr` 不变，不进一步拆分。

**判断标准**：Phase 边界 = 粗粒度的质量门控点。每次 phase 切换意味着一次 gate cycle（review-gate + phase-gate）、一次 compact、一次状态持久化和恢复。拆得越细，固定成本占比越高。

Phase 内部用步骤编排（review-gate 循环、parallel subagent）表达细粒度控制，不需要用 phase 边界。

### 拒绝的拆分方案

| 提议 | 决定 | 理由 |
|------|------|------|
| plan → dev-plan + test-plan | 不拆 | 共享 spec 上下文，test case 从 dev plan 的 execution group 映射，拆开增加协调成本 |
| dev → tdd-test + tdd-code | 不拆 | TDD 循环粒度是分钟级，不适合提升为 phase 级门控；N 个 execution group × 2 = 2N 次 gate cycle |
| test → integration-test + e2e-test | 不拆 | E2E 是 CI 层面的事，不是 coding workflow 的事；有需要加 phase 内部 step |

## Context

### 问题

当前 coding-workflow 5 个阶段（spec/plan/dev/test/pr）的内容质量审查存在 3 个结构性缺陷：

1. **主 agent 自审自己**（confirmation bias）— expert-reviewer skill 由主 agent 读取后"假装"自己是 reviewer，缺乏独立性
2. **无循环动力** — gate retry 只针对脚本检查（tsc/eslint/gate.py），content quality review 只做一次
3. **gate 反欺诈 ≠ 内容质量** — `dispatchReviewSubagent` 验证产出物真实性，不评估内容质量

### 目标

引入 **review-gate** 机制：主 agent 提交产出物 → review-gate 自动 dispatch 独立 subagent 进行审查 → 发现问题则修复 → 重新审查 → 直到无问题 → 自动进入 phase-gate。

核心思路借鉴 "review → fix → re-review 直到 review 无问题" 的循环模式。

## Decision

### 两层 Gate 设计

每个 phase 有两层 gate，职责不同：

| Gate | 审查内容 | 模式 |
|------|---------|------|
| **Review-Gate** | 需求/内容质量 | Phase 1/2/4: 单次检查；Phase 3: 循环 workflow |
| **Phase-Gate** | 文档格式 + 防造假 | 所有 Phase: 统一 workflow |

**执行顺序**：Review-Gate 通过 → 自动触发 Phase-Gate。

**Review-Gate 的两种模式**：

```
Phase 1/2/4（需求审查，无循环）:
  subagent 检查需求完整性
  → FAIL: 列出待澄清问题，回退到上游步骤
  → PASS: 自动触发 phase-gate

Phase 3（代码审查，循环 workflow）:
  ┌─ parallel review ─┐
  │  reviewer_1..N     │
  └───────────────────┘
          ↓
  sync（去重+排序+依赖分析 → fix-plan.md）
          ↓
  fix worker（串行修复 + git commit）
          ↓
  must_fix > 0 ? → Round N+1 : passed
```

**Phase-Gate 统一模式**（所有 phase 相同）：

```
Phase-Gate Workflow:
  1. 循环: doc-review-and-fix（直到无 MUST-FIX）
  2. 固定脚本: Python gate script
  3. 防造假检查
  4. 通过 → dispatch retrospect subagent
```

**为什么 Phase 1/2/4 的 Review-Gate 不做循环**：
审查的是人类可判断的需求完整性，失败的根因是理解不足，需要回到上游步骤重新讨论。subagent 循环无法解决"需求没想清楚"的问题。

**为什么 Phase 3 的 Review-Gate 做循环**：
审查的是代码质量，失败的根因是代码错误，subagent 可以自动修复。

### 5 阶段适配性

| 阶段 | Review-Gate | Review-Gate Agent | Phase-Gate |
|------|-------------|-------------------|------------|
| Phase 1 Spec | ✅ 单次检查 | `spec-requirements-reviewer.md` | ✅ workflow |
| Phase 2 Plan L1 | ✅ 单次检查 | `plan-requirements-reviewer.md` | ✅ workflow |
| Phase 2 Plan L2 | ✅ 并行检查 | `plan-requirements-reviewer.md` + `plan-bl-requirements-reviewer.md` | ✅ workflow |
| Phase 3 Dev | ✅ 循环 workflow | 5 个现有 SKILL.md | ✅ workflow |
| Phase 4 Test | ✅ 单次检查 | `test-requirements-reviewer.md` | ✅ workflow |
| Phase 5 PR | ❌ 不引入 | — | ✅ workflow |

### Phase 3 Dev 的 5 维度审查

| 维度 | Subagent 读取 Skill | 依赖关系 | 批次 |
|------|---------------------|---------|------|
| BLR（业务逻辑） | `xyz-harness-business-logic-reviewer` | 无 | Batch 1 |
| Standards（规范） | `xyz-harness-standards-reviewer` | 无 | Batch 1 |
| Taste（品味） | `ts-taste-check` 或 `rust-taste-check` | 无 | Batch 1 |
| Robustness（健壮性） | `xyz-harness-robustness-reviewer` | 无 | Batch 1 |
| Integration（集成） | `xyz-harness-integration-reviewer` | 依赖 BLR 输出 | Batch 2 |

Batch 1 的 4 个 reviewer 并行 dispatch，Batch 2 在 Batch 1 完成后串行 dispatch。

### 隔离原则

每个 phase 的 review-gate 隔离运行，互不干扰：

1. **状态文件隔离**：`{topic_dir}/.review-gate-p{N}.json`（N = phase 编号），每个 phase 独立
2. **交付物隔离**：reviewer 产出写入 `{topic_dir}/changes/reviews/phase-{N}/` 子目录
3. **逻辑隔离**：每个 phase 有独立的 reviewer 配置（skill + task prompt），不共享循环状态

示例：Phase 3 的状态文件

```json
// .review-gate-p3.json
{
  "phase": 3,
  "rounds": [
    {
      "round": 1,
      "reviewer": "xyz-harness-business-logic-reviewer",
      "must_fix": 3,
      "fixed": 3
    },
    {
      "round": 1,
      "reviewer": "xyz-harness-standards-reviewer",
      "must_fix": 1,
      "fixed": 1
    },
    {
      "round": 2,
      "reviewer": "xyz-harness-business-logic-reviewer",
      "must_fix": 0,
      "fixed": 0
    }
  ],
  "status": "passed",
  "total_rounds": 2
}
```

### 循环终止条件

1. `must_fix = 0` → 通过
2. 最大 3 轮 → 强制通过（附带警告）
3. 连续 2 轮 must_fix 不降 → 人工介入

### 通过后流转

- 如果后面还有 step → 反馈主 agent 执行下一步
- 如果是最后一步 → 自动提交到 phase-gate（`coding-workflow-gate`）
- phase-gate 通过后 → **fork 主 session** dispatch Retrospect subagent

### Retrospect 执行方式

Retrospect subagent **fork 主 session 的对话历史**后执行复盘，而非 fresh context。需要之前所有阶段的完整对话记忆来评估：

- Phase 执行质量（是否偏离 spec/plan）
- Harness 体验（工具是否好用、流程是否顺畅）
- 教训提炼（什么该做没做、什么做了不该做）

实现方式：`runSingleAgent()` 使用 `context: 'fork'` 参数。

### Subagent 构造方式

采用 **agent.md + task prompt 分离** 模式：

- **agent.md** 定义角色和方法论（稳定），放在 `~/.pi/agent/agents/` 下自动发现和加载
- **task prompt** 注入动态上下文（每轮不同），由 workflow script 构造

workflow script 的 `agent()` 调用时，agent.md 自动作为 system prompt，task prompt 通过 `prompt` 参数传入。

## Review-Gate 内部流程

### 节点编排

```
Round N:
  ┌─ Node 1: Parallel Review ──────────────┐
  │  reviewer_1 (read-only) → issues_1      │  ← workflow parallel()
  │  reviewer_2 (read-only) → issues_2      │
  │  reviewer_N (read-only) → issues_N      │
  └─────────────────────────────────────────┘
                      ↓
  ┌─ Node 2: Sync ──────────────────────────┐
  │  合并所有 review 报告                    │
  │  去重 + 排序 + 依赖分析                  │  ← 1 个 agent 调用
  │  产出 fix-plan.md                        │
  └─────────────────────────────────────────┘
                      ↓
           must_fix > 0 ?
           YES ↓            NO → passed
  ┌─ Node 3: Fix Worker ───────────────────┐
  │  读取 fix-plan.md                       │
  │  按优先级串行修复所有问题                 │  ← 1 个 agent 调用
  │  修复完成后 git commit                   │
  └─────────────────────────────────────────┘
                      ↓
              Round N+1 (re-review)
```

### 关键设计决策

1. **Review 和 Fix 分离**：reviewer 只读不写，fix worker 只写不改 review。职责清晰，review 可并行。
2. **Fix 由独立 subagent 执行**（非主 agent），消除 confirmation bias。fix 结果由下一轮 reviewer 重新审查形成闭环。
3. **Fix 单 worker 串行**：代码修复的文件依赖关系复杂，并行修复冲突风险 > 串行等待成本。先用单 worker 验证流程，有性能数据再优化。
4. **Git commit 是 checkpoint**：fix worker 修复完立即 commit，下一轮 reviewer 基于新 commit 审查。

### Sync 节点职责

| 操作 | 为什么需要 |
|------|----------|
| **去重** | BLR 和 Robustness 可能标记同一函数的同一问题 |
| **排序** | Standards 的 lint 错误先于 Taste 的品味问题修复（品味依赖代码稳定） |
| **依赖分析** | 标注哪些问题涉及同一文件/函数，需要一起修复 |
| **生成 fix-plan.md** | fix worker 需要合并后的问题清单，不是 N 份独立报告 |

### 各 Phase 的 Gate 配置

| Phase | Review-Gate | Phase-Gate |
|-------|------------|------------|
| 1 Spec | 单次 subagent（spec-requirements-reviewer.md），失败回退 brainstorming | workflow: 循环 deliverables-reviewer.md → script → 防造假 |
| 2 Plan L1 | 单次 subagent（plan-requirements-reviewer.md），失败回退 plan 编写 | workflow: 循环 deliverables-reviewer.md → script → 防造假 |
| 2 Plan L2 | 并行 subagent（plan-requirements + plan-bl-reviewer），失败回退 plan 编写 | workflow: 循环 deliverables-reviewer.md → script → 防造假 |
| 3 Dev | 循环 workflow: parallel 5 reviewer → sync → fix，最多 3 轮 | workflow: 循环 deliverables-reviewer.md → script → 防造假 |
| 4 Test | 单次 subagent（test-requirements-reviewer.md），失败回退 test 编写 | workflow: 循环 deliverables-reviewer.md → script → 防造假 |

## Reviewer Agent 设计

### 设计原则

- 每个 phase 的 reviewer 提示词分开，做成独立的 agent.md
- agent.md 定义角色、方法论、输出格式（稳定部分）
- task prompt 注入动态上下文：phase、round、文件路径、上一轮 review 报告（变化部分）
- 参考 superpowers 项目的 document review system 设计（`spec-document-reviewer-prompt.md`、`plan-document-reviewer-prompt.md`）

### Agent 文件规划

| Phase | Review-Gate Agent | Phase-Gate Agent |
|-------|-------------------|-----------------|
| 1 Spec | `spec-requirements-reviewer.md` | `deliverables-reviewer.md`（通用） |
| 2 Plan L1 | `plan-requirements-reviewer.md` | `deliverables-reviewer.md` |
| 2 Plan L2 | `plan-requirements-reviewer.md` + `plan-bl-requirements-reviewer.md` | `deliverables-reviewer.md` |
| 3 Dev | 5 个现有 SKILL.md + `sync-agent.md` | `deliverables-reviewer.md` |
| 4 Test | `test-requirements-reviewer.md` | `deliverables-reviewer.md` |

### Agent.md 结构模板

以 spec-reviewer 为例：

```markdown
---
name: spec-reviewer
description: "Reviews spec documents for completeness, consistency, and clarity."
---

# Spec Reviewer

你是 spec 文档审查专家。你的职责是验证 spec 是否完整、一致、可执行。

## 审查维度
| 类别 | 检查项 |
|------|--------|
| 完整性 | TODO/placeholder/TBD、缺失的错误处理、缺失的边界条件 |
| 一致性 | 内部矛盾、冲突的需求描述 |
| 清晰度 | 歧义需求——能否被两种方式解读 |
| 范围 | 是否聚焦单一实施计划 |
| YAGNI | 未要求的功能、过度设计 |

## 校准原则
只标记会在 plan 阶段导致实际问题的缺陷。
措辞改进、风格偏好不标记。

## 输出格式
（YAML frontmatter 统一格式，复用 expert-reviewer 的格式规范）
```

### Workflow Script 调用示例

```javascript
// agent.md 自动作为 system prompt
// task prompt 注入动态上下文
const result = await agent({
  prompt: `审查 ${topicDir}/spec.md（第 ${round} 轮）。
           产出写入 ${topicDir}/changes/reviews/phase-1/spec-review-v${round}.md。
           ${round > 1 ? `上一轮审查报告：${prevReviewPath}。继承 issues，标记已修复项。` : ''}`,
  description: `spec-reviewer-r${round}`,
});
```

### Sync Agent 提示词

Sync agent 的 system prompt 硬编码在 workflow script 中或作为独立 md 文件：

```
你是 Review Sync Agent。合并多个 reviewer 的审查报告，生成统一修复计划。
1. 读取所有 reviewer 报告的 YAML frontmatter 和 Markdown 正文
2. 去重：不同 reviewer 标记同一位置同一问题的合并为一条
3. 排序：Standards → BLR → Robustness → Taste/Integration
4. 标记依赖关系：哪些问题涉及同一文件/函数
5. 生成 fix-plan.md
```

### Fix Worker 提示词

```
你是 Fix Worker。按 fix-plan.md 修复所有问题。
约束：
1. 严格按优先级顺序修复
2. 只修 fix-plan 中列出的问题，不扩大范围
3. 不重构、不优化、不顺手改其他代码
4. 修复完成后 git commit
5. 无法修复的问题标记 skipped 并说明原因
```

## 三层编排与 Workflow Extension

coding-workflow 有三层编排需求：

| 层级 | 编排内容 | Workflow 适配性 |
|------|---------|---------------|
| **第 1 层** | 整体 5-phase 流程（spec→plan→dev→test→pr） | ❌ 不适合 |
| **第 2 层** | phase 内部步骤（如 dev: 预检→TDD→测试→review-gate→phase-gate） | ⚠️ 部分适合 |
| **第 3 层** | gate 内部循环（review-gate: 循环 review-fix 直到通过） | ✅ 最适合 |

### 第 1 层：整体编排 — 保持 Pi Extension tool

不适合用 workflow，原因：

1. **需要主 agent 与用户交互** — spec/plan 阶段需要多轮对话确认需求和方案，workflow 的 `agent()` 是单向调用
2. **状态管理复杂** — WorkflowState（phaseResults、gateInProgress...）需要在 `before_agent_start` 事件中注入 steering prompt，workflow script 没有这个能力
3. **工具调用依赖** — coding-workflow 注册的 gate/init/phase-start tool 无法在 workflow script 内调用

### 第 2 层：phase 内部 — 保持现状

部分适合（纯 subagent 调度），但涉及主 agent 交互和 tool 调用的步骤不行。保持由主 agent 按 SKILL.md 指导执行。

### 第 3 层：gate 内部 — 用 Workflow Extension 实现

review-gate 的循环逻辑完美匹配 workflow extension 的能力模型：

- `agent()` = 独立 `pi --mode json` 子进程 → reviewer 天然 fresh context
- `parallel()` → Phase 3 的 4 个 reviewer（BLR/Standards/Taste/Robustness）并行
- `pipeline()` → Batch 1 完成后串行执行 Batch 2（Integration）
- callCache → pause/resume 时跳过已完成的 reviewer
- budget 控制 → 防止 review 循环消耗过多 token

实现方式：`coding-workflow-gate` tool 内部，gate 脚本检查通过后，调用 WorkflowOrchestrator.run() 启动一个 review-gate workflow script。循环逻辑在 workflow script 内用 while 循环实现。

### 已知限制

| 限制 | 解决方案 |
|------|----------|
| `agent()` 无法读取 SKILL.md 作为 system prompt | 在 prompt 中内联 reviewer 指导，或扩展 agent() 支持 skill 参数 |
| fix worker 需要写文件 | `agent()` 通过 pi 的工具能力写文件 |
| review-gate 状态需持久化 | workflow 返回结果后由 gate tool 写 `.review-gate.json` |
| phase-gate 的 Python 脚本检查无法在 workflow 内运行 | phase-gate 保持现有机制 |

## Gate 可扩展性设计

### Gate Pipeline 抽象

将 gate 机制抽象为有序 gate 链，支持未来扩展：

```
Gate Pipeline（phase 配置声明）
├── Gate 1: review-gate（内容质量，subagent 循环）  ← 新增
├── Gate 2: phase-gate（脚本检查 + 反欺诈）         ← 现有
└── Gate N: future-gate（用户自定义）               ← 扩展点
```

### 核心接口

```typescript
interface Gate {
  name: string;
  run(ctx: GateContext): Promise<GateResult>;
}

interface GateContext {
  phase: number;
  topicDir: string;
  state: WorkflowState;
  skillResolver: SkillResolver;
  signal?: AbortSignal;
}

interface GateResult {
  passed: boolean;
  fixGuidance?: string;
  details?: Record<string, unknown>;
}
```

### Phase 配置声明 gate 链

```typescript
const PHASES: PhaseConfig[] = [
  { phase: 1, name: "Spec", gates: ["review-gate", "phase-gate"] },
  { phase: 3, name: "Dev",  gates: ["review-gate", "phase-gate"] },
  { phase: 5, name: "PR",   gates: ["phase-gate"] },
];
```

### 统一循环语义

所有 gate 都支持 `max_rounds` 循环，phase-gate 设 `max_rounds: 1`（等价于不循环）：

```
for each gate in phase.gates:
  for round 1..max_rounds:
    result = gate.run(ctx)
    if passed → break (下一个 gate)
    if round < max_rounds → 主 agent 修复后重新调用
    else → 强制通过（警告）
  all gates passed → 进入下一 phase
```

### 用户扩展方式

在项目 `.xyz-harness/gates.yaml` 中声明自定义 gate：

```yaml
gates:
  - name: security-gate
    type: subagent
    reviewer_md: security-reviewer
    phases: [3, 4]
    max_rounds: 2
```

## 改造范围

### 新增

| 文件 | 说明 |
|------|------|
| `tool-handlers.ts` 新增 handler | Gate Pipeline 执行器：按 PhaseConfig.gates 顺序执行 gate 链 |
| `review-dispatcher.ts` 新增方法 | `dispatchContentReview()` — 按 phase 选择 reviewer 并 dispatch |
| `gates/` 目录 | Gate 实现（review-gate.ts、phase-gate.ts），实现 Gate 接口 |
| `review-gate.workflow.js` | Review-gate 的 workflow script（第 3 层编排） |

### 修改

| 文件 | 说明 |
|------|------|
| `xyz-harness-brainstorming/SKILL.md` | 删除 Spec Review 章节，改为"完成后调用 review-gate" |
| `xyz-harness-writing-plans/SKILL.md` | 删除 Plan Review 章节，改为"完成后调用 review-gate" |
| `xyz-harness-phase-dev/SKILL.md` | 删除 Five-Step Specialized Review 章节，改为"完成后调用 review-gate" |
| `xyz-harness-phase-test/SKILL.md` | 删除 review 相关步骤，改为"完成后调用 review-gate" |

### 不变

| 文件 | 说明 |
|------|------|
| `xyz-harness-phase-pr/SKILL.md` | 不引入 review-gate |
| `xyz-harness-gate/SKILL.md` | phase-gate 不变（脚本检查 + 反欺诈） |
| `xyz-harness-gate-reviewer/SKILL.md` | 反欺诈审查不变 |

## 职责分离

| 机制 | 审查内容 | 失败行为 | 执行者 |
|------|---------|---------|--------|
| **Review-Gate** | 需求完整性/代码质量 | Phase 1/2/4: 回退上游步骤；Phase 3: 循环修复 | 独立 subagent |
| **Phase-Gate** | 文档格式 + 防造假 | 循环修复直到通过 | Workflow（循环 doc-fix → script → 防造假） |

执行顺序：Review-Gate 通过 → 自动进入 Phase-Gate。

## Consequences

### 正面

- 主 agent 不再自审自己，review 独立性有保障
- 循环机制确保内容质量问题在进入下一阶段前被修复
- spec/plan 阶段的问题不会传递到 dev 阶段（指数级降低修复成本）

### 负面

- 每个 phase 增加 1-3 轮 subagent 调用的 token 消耗
- Phase 3 的 5 维度审查如果并行 dispatch，需要新增 `runParallelAgents()` 实现
- SKILL.md 改造后，主 agent 需要适应新的调用流程

### 风险

- 最大 3 轮限制可能导致质量问题被强制通过 — 通过警告机制和人工介入兜底
- reviewer subagent 的 must_fix 判定可能不一致 — 通过统一的 YAML frontmatter 格式约束

## Phase 1 Spec 详细变更

### 当前流程

```
Step 1-6（产出 spec.md）
    ↓
Spec Review（主 agent dispatch subagent，最多 3 轮）
    ↓
Retrospect（gate PASS 后 dispatch）
    ↓
git push
    ↓
Gate Handoff（用户手动在独立 session 检查 gate）
    ↓
Phase Transition（告知用户）
```

### 变更后流程

```
Step 1-6（产出 spec.md）                ← 不变
    ↓
review-gate                             ← 替代 "Spec Review" 章节
    ↓
phase-gate                              ← 替代 "Gate Handoff"（自动化）
    ↓
Retrospect（fork session）               ← 不变，改用 fork
    ↓
git push + Phase Transition              ← 不变
```

### SKILL.md 改动

| 章节 | 操作 |
|------|------|
| "Spec Review (独立审查)" | **删除**（整个章节 + spec_review 输出格式） |
| "Retrospect (复盘)" | **保留**，微调：fork session 执行 |
| "阶段完成提交" | **保留** |
| "Gate Handoff" | **删除**（自动流转） |
| "Phase Transition" | **简化**（不再手动切换 session） |

## Goal Extension 协作：自动化任务追踪

### 问题

Goal 模式需要用户手动触发 `/goal` 命令启动，AI 无法主动发起。但 coding-workflow 的 Phase 2 需要在进入时自动初始化任务追踪（根据 L1/L2 复杂度生成不同的任务列表）。

### 方案：Goal Extension 导出编程 API

Goal extension 新增导出函数 `initializeGoalFromExternal()`，供 coding-workflow 等 extension 在 tool handler 内部直接调用，绕过 `/goal` 命令的限制。

**Goal Extension 侧改动**：

```typescript
// goal/src/index.ts 新增导出
export function initializeGoalFromExternal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  objective: string,
  tasks: string[],
  budget?: Partial<BudgetConfig>,
): void {
  // 1. 创建 goal state（复用 createInitialState）
  // 2. 写入 tasks（生成 id、status=pending）
  // 3. 持久化到 SessionManager（pi.appendEntry）
  // 4. 更新 widget（statusline 显示）
}
```

**Coding-Workflow 侧调用**：

```typescript
// coding-workflow/lib/tool-handlers.ts
import { initializeGoalFromExternal } from "@zhushanwen/pi-goal";

// executePhaseStartTool 中，Phase 2 compact 后的 steering prompt 注入
if (state.currentPhase === 2) {
  const complexity = assessComplexity(state.topicDir); // 读 spec 判断 L1/L2
  const taskList = complexity === "L2" ? L2_TASKS : L1_TASKS;
  initializeGoalFromExternal(pi, ctx, "Phase 2: 完成 plan 阶段交付物", taskList);
  // goal state 已创建，主 agent 后续调用 goal_manager.update_tasks 即可追踪
}
```

**任务列表定义**：

```typescript
const L1_TASKS = [
  "Write plan.md (with Execution Groups)",
  "Write e2e-test-plan.md + test_cases_template.json",
  "Write use-cases.md + non-functional-design.md",
];

const L2_TASKS = [
  "Write plan.md (architecture overview)",
  "Write plan-api-contract.md",
  "Write plan-backend.md + plan-frontend.md",
  "Write interface_chain.json",
  "Write e2e-test-plan.md + test_cases_template.json",
  "Write use-cases.md + non-functional-design.md",
];
```

**为什么不用方案 2（直接写 entry）**：goal state 的 schema 由 goal extension 私有定义，直接写 `pi.appendEntry("goal-state", ...)` 会导致 schema 不兼容风险。通过导出函数调用，类型安全有保障，schema 变更时编译器报错。

### 适用范围

| Phase | 是否自动初始化 Goal | 说明 |
|-------|-------------------|------|
| Phase 1 Spec | ❌ 用户手动 `/goal` | brainstorming 需求未定时不宜自动创建任务，手动触发更准确 |
| Phase 2 Plan | ✅ 自动初始化 | 入口注入 L1 默认任务，评估为 L2 后通过 add_tasks 追加额外任务 |
| Phase 3 Dev | ✅ 自动初始化 | 按 spec+plan 的 Execution Groups 生成任务：TDD测试→Wave编码→多轮测试→commit |
| Phase 4 Test | ❌ 用户手动 `/goal` | 任务较少 |
| Phase 5 PR | ❌ 不需要 | 纯汇总 |

## 实施优先级

1. **Goal Extension 导出 `initializeGoalFromExternal()`** — 基础设施（Phase 2/3 都需要）
2. **Gate Pipeline 抽象 + 接口定义** — 基础设施
3. **Phase 3 Dev review-gate（workflow script）** — 收益最大，验证第 3 层编排
4. **Phase 1-2 Spec/Plan review-gate** — 纯文档循环代价低
5. **Phase 4 Test review-gate** — 观察 Phase 3 效果后决定
6. **用户自定义 gate 扩展** — gates.yaml 加载
