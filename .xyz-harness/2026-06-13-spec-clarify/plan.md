---
verdict: pass
complexity: L1
---

# Spec-Clarify Skill 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将现有 spec-clarify skill（旧设计，7 文件 1081 行，主 agent 自追踪）改造为 Phase 1 唯一入口，内化 brainstorming 的交互提问 + 新的独立 subagent 隔离追踪机制。

**Architecture:** 单一 skill 改造。主 agent 负责 Quick Overview + 交互提问 + 写 spec 初稿 + gap 分流处理；独立 subagent（隔离上下文）负责 5 视角追踪 + 收敛复核。brainstorming skill 保留不动（其他地方可能引用）。改 index.ts 路由 Phase 1 → spec-clarify。

**Tech Stack:** Markdown（skill 文件）+ TypeScript（index.ts 1 行路由）+ 零代码逻辑

## References 读者分层（设计前提）

新设计的核心改变是追踪职责分离，references 的读者必须分层：

| 文件 | 读者 | 定位 |
|------|------|------|
| SKILL.md | 主 agent | 路由 + 交互提问流程 + 派 subagent 指令模板 |
| references/subagent-tracing.md | 独立 subagent | 隔离追踪执行流程（新文件，核心） |
| references/scenario-tracing.md | 独立 subagent | 5 视角模板和强制检查项 |
| references/gap-management.md | 主 agent + subagent | F/K/D 分类 + 卡住信号 + Stagnation |
| references/clarification.md | 主 agent | 轻量模型格式说明（写初稿用） |

## File Structure

| File | Action | Description |
|------|--------|-------------|
| `skills/xyz-harness-spec-clarify/SKILL.md` | rewrite | 精简路由，内化 brainstorming 交互提问 + 派 subagent 指令 |
| `skills/xyz-harness-spec-clarify/references/subagent-tracing.md` | create | 独立 subagent 隔离追踪流程（新设计核心） |
| `skills/xyz-harness-spec-clarify/references/scenario-tracing.md` | modify | 删除旧机制引用（decompose/gate），保留 5 视角核心 |
| `skills/xyz-harness-spec-clarify/references/gap-management.md` | rewrite | 精简为 F/K/D + 卡住信号 + Stagnation |
| `skills/xyz-harness-spec-clarify/references/clarification.md` | rewrite | 轻量模型格式（不强制五维度） |
| `skills/xyz-harness-spec-clarify/references/foundation-round.md` | delete | 含 complexity-assess/L0-L2，已砍 |
| `skills/xyz-harness-spec-clarify/references/requirement-decomposition.md` | delete | 含 decompose/manifest/children，已砍 |
| `skills/xyz-harness-spec-clarify/references/convergence-loop.md` | delete | 旧两层循环，内容融入 SKILL.md + subagent-tracing.md |
| `extensions/coding-workflow/index.ts` | modify:54 | skillName brainstorming → spec-clarify |
| `extensions/coding-workflow/commands/track.md` | modify:21,23,39 | 引用 brainstorming → spec-clarify |

**文件总数：** 10（5 create/rewrite + 2 modify + 3 delete）

## 文件职责与引用关系（替代 Interface Contracts）

本任务无代码接口，用文件引用关系代替：

```
index.ts:54 (路由) ──loads──> SKILL.md (Phase 1 入口)
                                  │
                  ┌───────────────┼───────────────┐
                  ▼               ▼               ▼
          (主 agent 读)    (主 agent 读)    (派 subagent 时
          clarification.md  gap-management.md  注入 task prompt)
                                                  │
                              ┌───────────────────┴───────────┐
                              ▼                               ▼
                      subagent-tracing.md            scenario-tracing.md
                      (subagent 读)                  (subagent 读)
```

**删除的引用链：** foundation-round.md / requirement-decomposition.md / convergence-loop.md 被删除后，SKILL.md 中不得残留对它们的 read 指令。

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC-1: 主 agent 不追踪，subagent 隔离追踪 | adopted | Task 1, 2, 7 |
| AC-2: 收敛由独立 subagent 复核判定 | adopted | Task 2 |
| AC-3: F 类二次确认，K/D 直接问用户 | adopted | Task 1, 4 |
| AC-4: 简单需求也适用，1-2 轮收敛 | adopted | Task 1, 5 |
| AC-5: 无 L1/L2、无两层循环、无升级判定 | adopted | Task 6 |

## Execution Groups

#### BG1: spec-clarify skill 改造（单一 Group）

**Description:** 纯 Markdown + 1 行 TS 路由改动，无前后端分离，无并行需求。所有 task 串行执行。

**Tasks:** Task 1, Task 2, Task 3, Task 4, Task 5, Task 6, Task 7, Task 8, Task 9

**Files (预估):** 10 个文件（5 create/rewrite + 2 modify + 3 delete）

**执行方式:** 主 agent 直接执行（纯文档，无需 subagent 链）。每个 task 完成后运行该 task 的验证命令。

**Dependencies:** 无（单一 Group 内串行）

---

## Task 1: 重写 SKILL.md（核心路由 + 交互提问 + 派 subagent 指令）

**Type:** skill-doc

**Files:**
- Rewrite: `extensions/coding-workflow/skills/xyz-harness-spec-clarify/SKILL.md`

**覆盖 AC:** AC-1（主 agent 不追踪）, AC-3（F 类二次确认）, AC-4（简单需求适用）

**前置依赖:** 无

- [ ] **Step 1: 写 YAML frontmatter**

```yaml
---
name: xyz-harness-spec-clarify
description: >-
  Phase 1 (spec) of the xyz-harness workflow. Interactive clarification to
  build spec draft, then delegates systematic gap-finding to an isolated
  subagent that traces 5 perspectives independently. Solves the core problem
  of clarification omissions. Triggers: "start Phase 1", "spec phase",
  "write spec", "brainstorm", "clarify requirements", "澄清需求".
  Not for: implementation (Phase 3+), debugging, code review, or tasks
  with an already-approved spec.
---
```

- [ ] **Step 2: 写 Dev-flow 上下文表 + HARD-GATE**

复用 brainstorming 的结构：
- Dev-flow 上下文表（Phase 1 spec-clarify，上游用户需求，下游 writing-plans）
- Phase Loop 机制（Gate FAIL 回 Step 6，Review FAIL auto，Auto Mode 说明）
- HARD-GATE：禁止在 spec 通过前写代码
- Agent/Skill 关联表

Agent/Skill 关联表的关键行（替代 brainstorming 版本）：

| 步骤 | 执行者 | Agent | Skill | 方式 |
|------|--------|-------|-------|------|
| Step 1: Quick Overview | 主 agent | — | 无 | < 30s 浏览 |
| Step 2: 交互提问 + 写初稿 | 主 agent | — | spec-clarify (本 skill) | ask_user 逐个提问 |
| Step 3: 5 视角隔离追踪 | 独立 subagent | general-purpose | spec-clarify (subagent-tracing + scenario-tracing) | task prompt 指定 read |
| Step 4: gap 分流处理 | 主 agent | — | spec-clarify (本 skill) | F 二次确认，K/D 问用户 |
| Step 5: 收敛复核 | 独立 subagent | general-purpose | spec-clarify (subagent-tracing) | task prompt 指定 read |
| Step 6: spec 定稿 | 主 agent | — | 无 | 调用 coding-workflow-gate |

- [ ] **Step 3: 写核心原则章节**

```markdown
## 核心原则

1. **交互与追踪分离** — 主 agent 做交互（提问、给方案、写初稿），独立 subagent 做追踪（5 视角强制枚举）。主 agent 不做系统追踪——它带着对话上下文有确认偏误。
2. **5 视角是 forcing function** — User Journey / Data Lifecycle / API Contract / State Machine / Failure Path。每个视角必须核对或写降级理由。详见 references/scenario-tracing.md。
3. **F 类二次确认** — Fact gap 先经主 agent 确认（过滤误报），两边都认才问用户。K/D 直接问用户。详见 references/gap-management.md。
4. **收敛靠独立复核** — 停止条件是"独立 subagent 跑完 5 视角无新 gap"，不靠主 agent 自我判断。
5. **一次一个问题** — 用 ask_user 逐个解决 gap，不一次性抛出所有问题。
```

- [ ] **Step 4: 写流程地图（6 步）**

流程地图必须明确标注两个执行上下文（主 agent vs 独立 subagent）。关键内容：

```
[主 agent: 交互上下文]
  Step 1: Quick Overview → 浏览项目，< 30s
  Step 2: 交互提问 → ask_user 逐个提问，写 spec 初稿 + 轻量 clarification.md
                    （刻意不做 5 视角追踪）
  ↓ 产出：spec 初稿 + clarification.md

[独立 subagent: 隔离上下文，只读需求+初稿+代码]
  Step 3: 5 视角强制追踪 → 独立重跑，卡住点 = gap，分类返回（F/K/D）
  ↓ 产出：gap 列表

[主 agent: 回到交互上下文]
  Step 4: gap 分流处理
    F 类 → 二次确认：两边都认→问用户；主 agent 否定→丢弃
    K 类 → 直接问用户
    D 类 → 给方案对比
  Step 5: 收敛判定 → 再派独立 subagent 追踪，无新 gap 则收敛
  Step 6: spec 定稿 → 调用 coding-workflow-gate(phase=1)
```

路由表（read 对应 reference 的时机）。

- [ ] **Step 5: 写 Step 1-2 的交互提问流程（内化 brainstorming）**

从 brainstorming SKILL.md 的以下章节内化（不是复制全文，是提取核心并适配新流程）：
- Step 1: Quick Overview（ls + package.json + README + CONTEXT.md，< 30s）
- Step 2: Progressive Questioning 的 Question Hierarchy（Purpose→Core Behavior→Boundaries 三层）
- Question Quality Guidelines（用 ask_user、优先多选、一次一个问题、避免抽象问题）
- On-demand Deep Scan（按需 dispatch 只读 subagent 扫描具体模块）

关键适配点：brainstorming 的 Step 3-5（Propose approaches / Present design / Assumption Audit）仍保留，但放在 Step 2 的提问之后、写初稿之前。

- [ ] **Step 6: 写 Step 3 的派 subagent 指令模板**

这是新设计的核心。SKILL.md 必须包含明确的 subagent dispatch 指令：

```markdown
## Step 3: 派独立 subagent 做 5 视角追踪

[MANDATORY] 主 agent 不自己做追踪。必须派一个隔离上下文的 subagent。

### Subagent 派发配置

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Context | fresh（隔离上下文，不继承主 agent 对话历史）|
| 读取文件 | references/subagent-tracing.md + references/scenario-tracing.md + spec 初稿 + clarification.md + 相关源码 |
| 产出 | gap 列表（写入 changes/tracing-round-{N}.md）|

### Task prompt 模板

你是独立需求追踪 subagent。你的上下文与主 agent 隔离——你不知道主 agent 和用户聊了什么，只根据以下材料独立追踪：

1. read references/subagent-tracing.md（你的执行流程）
2. read references/scenario-tracing.md（5 视角追踪模板）
3. read {topic_dir}/spec.md（spec 初稿）
4. read {topic_dir}/clarification.md（已知信息）
5. 按需 read 相关源码验证事实

按 5 视角逐一追踪，卡住的地方就是 gap。每个 gap 标注类型（F/K/D）和具体问题。
将结果写入 {topic_dir}/changes/tracing-round-{N}.md。
```

- [ ] **Step 7: 写 Step 4 的 gap 分流处理（F/K/D）**

明确 F 类二次确认的指令：

```markdown
## Step 4: gap 分流处理

收到 subagent 返回的 gap 列表后，按类型处理：

### F 类（Fact）— 二次确认
对每个 F gap，主 agent 拿着对话上下文判断事实是否成立：
- 两边都确认 → 转为具体问题问用户
- 主 agent 否定（代码已废弃/理解有偏差）→ 丢弃，不问用户

### K 类（Knowledge）— 直接问用户
生成具体的、有上下文的问题。不要问"退款怎么处理"，要问"代码里有 refund 表但状态只有 pending/completed——退款是部分还是全额？退款后订单状态变什么？"

### D 类（Decision）— 给方案对比
提供 2-3 选项 + trade-off，让用户选择。记录决策 + 推理过程。

### 处理完所有 gap 后
更新 spec 初稿和 clarification.md，进入 Step 5 收敛复核。
```

- [ ] **Step 8: 写 Step 5-6（收敛复核 + 定稿）+ 交付物 + 验证清单**

Step 5 收敛复核：再派一次独立 subagent（同 Step 3 配置），无新 gap 则收敛。Stagnation 保底：连续 3 轮强制收。

Step 6 定稿：整理 frontmatter，调用 coding-workflow-gate(phase=1)。

交付物：spec.md（含 frontmatter verdict: pass）+ clarification.md（轻量）。

- [ ] **Step 9: 删除所有对旧 references 的引用**

SKILL.md 中不得出现以下 read 指令（文件已删除）：
- references/foundation-round.md
- references/requirement-decomposition.md
- references/convergence-loop.md

- [ ] **Step 10: Commit**

```bash
git add extensions/coding-workflow/skills/xyz-harness-spec-clarify/SKILL.md
git commit -m "refactor(spec-clarify): rewrite SKILL.md as Phase 1 entry with interactive + isolated-tracing split"
```

**验证:**
```bash
# 检查无旧 references 引用残留
grep -c "foundation-round\|requirement-decomposition\|convergence-loop" extensions/coding-workflow/skills/xyz-harness-spec-clarify/SKILL.md
# 预期: 0
```

---

## Task 2: 新写 references/subagent-tracing.md（独立 subagent 隔离追踪流程）

**Type:** skill-doc

**Files:**
- Create: `extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/subagent-tracing.md`

**覆盖 AC:** AC-1（subagent 隔离追踪）, AC-2（收敛由独立 subagent 判定）

**前置依赖:** 无

- [ ] **Step 1: 写文档定位和执行规则**

```markdown
# 独立 Subagent 隔离追踪流程

本文件供独立 subagent 读取。你是隔离上下文的追踪者——不知道主 agent 和用户聊了什么，只根据 spec 初稿 + clarification.md + 源码独立追踪。

## 执行规则

1. **从零审视** — 不假设主 agent 已经问过什么。你对每个视角的检查项独立回答。
2. **卡住即 gap** — 追踪到"我不知道""大概是""应该可以"时，这就是 gap。
3. **每个视角必须核对** — 不适用必须写降级理由（为什么 + 依据），不能无声跳过。
4. **不修改文件** — 你只产出 gap 列表，不修改 spec 或 clarification.md。
```

- [ ] **Step 2: 写追踪流程（替代旧 convergence-loop 的 Step 6-10）**

```markdown
## 追踪流程

### 1. 读取材料
- spec 初稿 + clarification.md（主 agent 的已知信息）
- 相关源码（验证 F 类事实）

### 2. 逐视角追踪
read references/scenario-tracing.md，按 5 视角逐一追踪：
- User Journey → Data Lifecycle → API Contract → State Machine → Failure Path
- 每个视角的强制检查项必须逐一回答
- 答不上来的 = gap

### 3. gap 分类
每个 gap 标注类型（详见 references/gap-management.md）：
- F（Fact）：代码里有但初稿没提到的信息
- K（Knowledge）：只有用户知道的业务规则
- D（Decision）：需要做选择的权衡点

### 4. 产出 gap 列表
写入 {topic_dir}/changes/tracing-round-{N}.md，格式：

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G-001 | F | Data Lifecycle | P2/E01 | Order.status 的完整枚举值？ |
| G-002 | K | User Journey | P1/OP-U01 | 提交订单需要二次确认吗？ |
| G-003 | D | API Contract | P3/OP-A01 | 重复提交用 debounce 还是 idempotency key？ |
```

- [ ] **Step 3: 写收敛判定规则（给 Step 5 复核用）**

```markdown
## 收敛判定（Step 5 复核时读取）

当主 agent 处理完上一轮 gap 后，你会被再次派发（Step 5）。你的任务是判断是否收敛：

1. 重新读取更新后的 spec 初稿 + clarification.md
2. 重新跑 5 视角（完整重跑，不是增量——你不知道上轮查过什么）
3. 判定：
   - 无新 gap → 收敛，返回"CONVERGED"
   - 有新 gap → 返回新 gap 列表，主 agent 继续处理

你只负责"有没有新 gap"，不负责判断 gap 重要性或是否该收敛。无新 gap 即返回 CONVERGED。
```

- [ ] **Step 4: Commit**

```bash
git add extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/subagent-tracing.md
git commit -m "feat(spec-clarify): add subagent-tracing reference for isolated-context tracing"
```

**验证:**
```bash
# 文件行数 50-100 行（精简）
wc -l extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/subagent-tracing.md
# 预期: 50-100
```

---

## Task 3: 精简 references/scenario-tracing.md（删除旧机制引用）

**Type:** skill-doc

**Files:**
- Modify: `extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/scenario-tracing.md`

**覆盖 AC:** AC-1（保留 5 视角核心）

**前置依赖:** 无

- [ ] **Step 1: 删除"Deferred 项的处理"章节**

删除整个 `### Deferred 项的处理` 章节（引用了已删除的 Decomposition Map / `[DEFERRED-EXT]`）。

- [ ] **Step 2: 修改"视角适用性与降级"章节**

删除引用 gate 的段落："gate 的 gap-analysis 维度不只'知道'降级，还会校验降级理由是否成立...返回 NEEDS_CLARIFICATION"。

替换为：
```markdown
降级理由写入 tracing-round-{N}.md。主 agent 和后续 subagent 会校验降级理由是否成立——如果理由不充分（例如「重构类需求」却涉及数据模型变更却降级了 Data Lifecycle），会要求追踪该视角。

目的：防止以"不适用"为由跳过追踪。降级是透明的取舍，不是逃避追踪的借口。
```

- [ ] **Step 3: 删除所有 `[DEFERRED-EXT]` / Decomposition Map / P2 defer 引用**

检查全文，删除：
- "Decomposition Map 中标记 `[DEFERRED-EXT]`"
- "P2 gap 可以 defer"
- 任何引用 requirement-decomposition.md 的内容

- [ ] **Step 4: 确认保留的核心内容**

以下内容**必须保留不动**（5 视角追踪模板和强制检查项是核心资产）：
- Perspective 1-5 的追踪模板（User Journey / Data Lifecycle / API Contract / State Machine / Failure Path）
- 每个视角的"强制检查项"
- 每个视角的"典型 gap 模式"
- 通用追踪规则（追踪到能完整描述为止、每个分支单独追踪、卡住即 gap）
- 视角适用性降级表（CRUD/重构/工具/配置类的适用视角）

- [ ] **Step 5: Commit**

```bash
git add extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/scenario-tracing.md
git commit -m "refactor(spec-clarify): strip legacy mechanisms from scenario-tracing, keep 5-perspective core"
```

**验证:**
```bash
# 无旧机制残留
grep -c "DEFERRED-EXT\|Decomposition Map\|gap-analysis 维度\|NEEDS_CLARIFICATION\|requirement-decomposition" extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/scenario-tracing.md
# 预期: 0
# 核心模板保留
grep -c "Perspective [1-5]\|强制检查项" extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/scenario-tracing.md
# 预期: ≥10（5 视角 × 模板 + 检查项）
```

---

## Task 4: 重写 references/gap-management.md（精简 F/K/D + Stagnation）

**Type:** skill-doc

**Files:**
- Rewrite: `extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/gap-management.md`

**覆盖 AC:** AC-3（F/K/D 分类）

**前置依赖:** 无

- [ ] **Step 1: 删除以下章节**

- "Gap Tracker 与 Decomposition Map 的关系"（整个章节，引用已删除机制）
- "Gap 优先级"（P0/P1/P2，spec 明确不做）
- "Gap Tracker"（表格，spec 明确不做）
- "Gap 密度指标"（过度工程）
- "consider decompose 为子系统"（旧机制）

- [ ] **Step 2: 重写 Gap 分类章节**

保留 F/K/D 三类，增加二次确认说明：

```markdown
## Gap 分类

| 类型 | 含义 | 来源 | 解决方式 |
|------|------|------|---------|
| **F** (Fact) | 代码中有但初稿没提到的信息 | 追踪时发现代码有相关信息 | 主 agent 二次确认 |
| **K** (Knowledge) | 只有用户知道的业务规则 | 追踪卡住且代码无答案 | 直接问用户 |
| **D** (Decision) | 需要做选择的权衡点 | 多种方案都可以 | 给方案对比问用户 |

### F 类二次确认（关键）

F 是客观事实，subagent 可能误报（看错代码、旧代码已废弃）。主 agent 拿着对话上下文判断：
- 两边都确认 → 转为具体问题问用户
- 主 agent 否定 → 丢弃，不问用户

K/D 是主观判断，主 agent 否定不了（它确实不知道），直接问用户。
```

- [ ] **Step 3: 保留并适配"卡住信号"和"Stagnation 判定"**

"追踪时的卡住信号"章节保留不动（6 个信号，通用且有效）。

"Stagnation 判定"章节精简为：

```markdown
## Stagnation 判定

连续 3 轮追踪 gap 数量不降（新发现 ≥ 已解决），强制收敛。
未解决的 gap 标记为 [UNRESOLVED]，在 spec 中标注交给后续 review 处理。

Stagnation 同时是"需求可能过大"的早期信号——此时提示用户考虑拆分（但拆分机制不在本 skill 范围）。
```

删除旧版中"可能原因"的 3 条分析（Scope 过大/用户回答引入新问题/AI 聚焦不够）——这些是 NEEDS_USER 升级判定的残留，已砍。

- [ ] **Step 4: Commit**

```bash
git add extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/gap-management.md
git commit -m "refactor(spec-clarify): simplify gap-management to F/K/D + double-confirm + stagnation"
```

**验证:**
```bash
# 无旧机制残留
grep -c "Decomposition Map\|P0\|P1\|P2\|Gap Tracker\|gap 密度\|decompose\|优先级" extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/gap-management.md
# 预期: 0
# F/K/D 保留
grep -c "二次确认\|Fact\|Knowledge\|Decision" extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/gap-management.md
# 预期: ≥4
```

---

## Task 5: 重写 references/clarification.md（轻量模型格式）

**Type:** skill-doc

**Files:**
- Rewrite: `extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/clarification.md`（原 clarification-model.md 重命名+重写）

**覆盖 AC:** AC-4（简单需求适用，不过重）

**前置依赖:** 无

- [ ] **Step 1: 删除旧文件，创建新文件**

```bash
rm extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/clarification-model.md
```

创建 `references/clarification.md`。

- [ ] **Step 2: 写轻量格式说明**

```markdown
# clarification.md 轻量格式

clarification.md 是主 agent 在 Step 2 交互提问后产出的轻量记录。它不是强制五维度表格，只是记录已知信息和需求拆解的载体。

## 格式

clarification.md 没有强制结构。推荐格式：

\`\`\`markdown
# Clarification — {需求标题}

## 已知信息
- {从对话和 Quick Overview 得到的确认信息}
- {从源码验证的事实}

## 需求拆解
- {核心功能点 1}
- {核心功能点 2}

## 待追踪（交给独立 subagent）
- {主 agent 觉得清楚但没系统验证的部分}
\`\`\`

## 为什么不强制五维度

5 视角的追踪产出（tracing-round-{N}.md）本身就是"模型"。clarification.md 只是追踪的输入材料，不需要再抽象一层强制结构。过重的结构会让简单需求变成负担。
```

- [ ] **Step 3: Commit**

```bash
git add extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/clarification.md
git rm extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/clarification-model.md
git commit -m "refactor(spec-clarify): replace clarification-model with lightweight clarification format"
```

**验证:**
```bash
# 旧文件已删除
test ! -f extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/clarification-model.md && echo "OK: deleted"
# 新文件存在
test -f extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/clarification.md && echo "OK: created"
```

---

## Task 6: 删除旧 references（foundation-round + requirement-decomposition + convergence-loop）

**Type:** cleanup

**Files:**
- Delete: `extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/foundation-round.md`
- Delete: `extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/requirement-decomposition.md`
- Delete: `extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/convergence-loop.md`

**覆盖 AC:** AC-5（无 L1/L2、无两层循环、无升级判定）

**前置依赖:** Task 1（SKILL.md 不得残留对这些文件的引用）

- [ ] **Step 1: 删除三个文件**

```bash
git rm extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/foundation-round.md
git rm extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/requirement-decomposition.md
git rm extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/convergence-loop.md
```

- [ ] **Step 2: 全局检查无残留引用**

```bash
# SKILL.md 和所有 references 不得引用已删除的文件
grep -rn "foundation-round\|requirement-decomposition\|convergence-loop" extensions/coding-workflow/skills/xyz-harness-spec-clarify/
# 预期: 无输出
```

如果 Step 2 有输出，回到 Task 1 修复 SKILL.md 中的引用。

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor(spec-clarify): remove legacy references (complexity-assess, decompose, two-layer loop)"
```

**验证:**
```bash
# 文件已删除
for f in foundation-round requirement-decomposition convergence-loop; do
  test ! -f "extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/${f}.md" && echo "OK: ${f}.md deleted"
done
```

---

## Task 7: 改 index.ts 路由（Phase 1: brainstorming → spec-clarify）

**Type:** code-change

**Files:**
- Modify: `extensions/coding-workflow/index.ts:54`

**覆盖 AC:** AC-1（spec-clarify 成为 Phase 1 入口）

**前置依赖:** Task 1（SKILL.md 已重写）

- [ ] **Step 1: 修改 index.ts 第 54 行**

将：
```typescript
		phase: 1, name: "Spec", skillName: "xyz-harness-brainstorming",
```
改为：
```typescript
		phase: 1, name: "Spec", skillName: "xyz-harness-spec-clarify",
```

- [ ] **Step 2: 类型检查**

```bash
pnpm --filter @zhushanwen/pi-coding-workflow typecheck
# 预期: 零类型错误（skillName 是 string，不影响类型）
```

- [ ] **Step 3: Commit**

```bash
git add extensions/coding-workflow/index.ts
git commit -m "refactor(coding-workflow): route Phase 1 to spec-clarify skill"
```

**验证:**
```bash
grep "phase: 1" extensions/coding-workflow/index.ts | grep "spec-clarify"
# 预期: 输出包含 skillName: "xyz-harness-spec-clarify"
```

---

## Task 8: 改 commands/track.md 引用

**Type:** doc-change

**Files:**
- Modify: `extensions/coding-workflow/commands/track.md:21,23,39`

**覆盖 AC:** AC-1（文档一致）

**前置依赖:** Task 7

- [ ] **Step 1: 修改 track.md 三处引用**

第 21 行：`xyz-harness-brainstorming` → `xyz-harness-spec-clarify`
第 23 行：`brainstorming skill 的讨论流程` → `spec-clarify skill 的交互澄清流程`
第 39 行：`xyz-harness-brainstorming（spec completeness check 部分）` → `xyz-harness-spec-clarify（收敛检查部分）`

- [ ] **Step 2: 检查无 brainstorming 残留**

```bash
grep -n "brainstorming" extensions/coding-workflow/commands/track.md
# 预期: 无输出（除非有意保留的对比说明）
```

- [ ] **Step 3: Commit**

```bash
git add extensions/coding-workflow/commands/track.md
git commit -m "docs(coding-workflow): update track.md to reference spec-clarify skill"
```

**验证:**
```bash
grep -c "spec-clarify" extensions/coding-workflow/commands/track.md
# 预期: ≥3
```

---

## Task 9: 全局验证（gate check + 引用完整性 + 加载测试）

**Type:** verification

**Files:** 无（验证性 task）

**覆盖 AC:** 全部 AC 的交叉验证

**前置依赖:** Task 1-8 全部完成

- [ ] **Step 1: references 目录结构验证**

```bash
echo "=== 最终 references 结构 ==="
find extensions/coding-workflow/skills/xyz-harness-spec-clarify -type f | sort
```

预期文件清单：
- SKILL.md
- references/subagent-tracing.md
- references/scenario-tracing.md
- references/gap-management.md
- references/clarification.md

不得存在：foundation-round.md / requirement-decomposition.md / convergence-loop.md / clarification-model.md

- [ ] **Step 2: 旧机制零残留全局检查**

```bash
echo "=== 旧机制残留检查 ==="
grep -rn "complexity-assess\|L0/L1/L2\|requirement-decomposition\|Decomposition Map\|两层循环\|内层循环\|外层循环\|NEEDS_USER\|model_version\|gap-analysis 维度\|DEFERRED-EXT\|P0/P1/P2\|Gap Tracker" extensions/coding-workflow/skills/xyz-harness-spec-clarify/
# 预期: 无输出
```

- [ ] **Step 3: 新设计核心元素存在性检查**

```bash
echo "=== 新设计核心元素检查 ==="
grep -l "独立 subagent\|隔离上下文\|二次确认\|fresh" extensions/coding-workflow/skills/xyz-harness-spec-clarify/SKILL.md
# 预期: SKILL.md 匹配
grep -l "CONVERGED\|从零审视" extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/subagent-tracing.md
# 预期: subagent-tracing.md 匹配
grep -l "Perspective [1-5]" extensions/coding-workflow/skills/xyz-harness-spec-clarify/references/scenario-tracing.md
# 预期: scenario-tracing.md 匹配
```

- [ ] **Step 4: 路由一致性检查**

```bash
echo "=== 路由一致性 ==="
grep "phase: 1" extensions/coding-workflow/index.ts
# 预期: skillName: "xyz-harness-spec-clarify"
grep "spec-clarify" extensions/coding-workflow/commands/track.md | wc -l
# 预期: ≥3
```

- [ ] **Step 5: TypeScript 类型检查**

```bash
pnpm --filter @zhushanwen/pi-coding-workflow typecheck
# 预期: 零类型错误
```

- [ ] **Step 6: brainstorming skill 完整性确认**

```bash
# brainstorming skill 保留不动
test -f extensions/coding-workflow/skills/xyz-harness-brainstorming/SKILL.md && echo "OK: brainstorming preserved"
wc -l extensions/coding-workflow/skills/xyz-harness-brainstorming/SKILL.md
# 预期: 516（不变）
```

- [ ] **Step 7: 最终 Commit（如有未提交的改动）**

```bash
git status --short
# 如有未提交改动
git add -A && git commit -m "chore(spec-clarify): final verification pass"
```
