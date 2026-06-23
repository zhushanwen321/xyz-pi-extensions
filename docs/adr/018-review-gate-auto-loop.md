# ADR 018: Review-Gate 自动循环审查机制

> **⚠️ SUPERSEDED — 本 ADR 已被以下文档取代：**
> 最终实现见 coding-workflow extension 的 xyz-harness-* skills。
>
> 本 ADR 中的以下决策已变更：
> - Phase 1/2/4 Review-Gate：从"单次无循环"改为"Workflow 循环（agent 审查+修复）"
> - Phase 4：去掉 Review-Gate，改为 Test-Fix Loop Workflow（测试-修复循环）
> - Phase-Gate：从"统一 workflow 循环 doc-fix"改为"2 步（脚本检查 + AI Agent 防伪造）"
> - Phase 3 Review-Gate：前置节点从"单 reviewer"改为"spec-plan-conformance-reviewer（独立循环）"
> - Phase 3 Review-Gate：新增 Fallow 静态分析审查维度
>
> 注：原引用的 phase-specs / playbook 为 harness 产出物，已移除。

Status: ~~accepted~~ superseded

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

| Phase | Review-Gate Agent | Phase-Gate Agent |
|-------|-------------------|-----------------|
| 1 Spec | `spec-requirements-reviewer.md` | `deliverables-reviewer.md` |
| 2 Plan L1 | `plan-requirements-reviewer.md` | `deliverables-reviewer.md` |
| 2 Plan L2 | `plan-requirements-reviewer.md` + `plan-bl-requirements-reviewer.md` | `deliverables-reviewer.md` |
| 3 Dev | 5 个现有 SKILL.md + `sync-agent.md` | `deliverables-reviewer.md` |
| 4 Test | `test-requirements-reviewer.md` | `deliverables-reviewer.md` |

### 两层 Gate 设计

每个 phase 有两层 gate，职责不同：

| Gate | 审查内容 | 模式 |
|------|---------|------|
| **Review-Gate** | 需求/内容质量 | Phase 1/2/4: 单次检查，失败回退上游；Phase 3: 循环 workflow |
| **Phase-Gate** | 文档格式 + 防造假 | 所有 Phase: 统一 workflow（循环 doc-fix → script → 防造假） |

Review-Gate 通过后自动触发 Phase-Gate。主 agent 只调一次 `coding-workflow-gate`。

### Retrospect 执行方式

Retrospect subagent **fork 主 session 的对话历史**后执行复盘。需要之前所有阶段的对话记忆来评估：

- Phase 执行质量（是否偏离 spec/plan）
- Harness 体验（工具是否好用、流程是否顺畅）
- 教训提炼（什么该做没做、什么做了不该做）

### 各 Phase 的 Gate 配置

| Phase | Review-Gate | Phase-Gate |
|-------|------------|------------|
| 1 Spec | 单次 subagent（spec-requirements-reviewer.md），失败回退 brainstorming | workflow |
| 2 Plan L1 | 单次 subagent（plan-requirements-reviewer.md），失败回退 plan 编写 | workflow |
| 2 Plan L2 | 并行 subagent，失败回退 plan 编写 | workflow |
| 3 Dev | 循环 workflow: parallel 5 reviewer → sync → fix | workflow |
| 4 Test | 单次 subagent（test-requirements-reviewer.md），失败回退 test 编写 | workflow |

### 各 Phase 流程变更

#### Phase 1 Spec

```
1. [Skill] xyz-harness-brainstorming
2. [固定] Brainstorming + 用户讨论（多轮）
3. [固定] 编写 spec 交付物
4. [Subagent] Review-Gate: spec-requirements-reviewer.md
   → FAIL: 列出待澄清问题，回退到步骤 2
   → PASS: 自动触发 Phase-Gate
5. [Workflow] Phase-Gate: 循环 deliverables-reviewer.md → script → 防造假
6. [Subagent] Retrospect (fork session)
```

SKILL.md 改动：删除 "Spec Review" + "Gate Handoff" 章节。

#### Phase 2 Plan

同理，删除 "Plan Review" + "Gate Handoff" 章节。

#### Phase 3 Dev

删除 "Five-Step Specialized Review" + "Gate Handoff" 章节。5 维度 reviewer 由 review-gate workflow script 内部并行 dispatch。

#### Phase 4 Test

删除 review 相关步骤 + "Gate Handoff" 章节。

#### Phase 5 PR

不变，不引入 review-gate。

### 项目规范文件传递方式（方案 B：subagent 自行查找）

reviewer subagent 需要读取项目自己的规范文件（CLAUDE.md、~/.codetaste/essence.md 等）进行审查。采用 **subagent 自行查找并读取** 方案，不通过主 agent 预处理或注入。

**实现方式**：
1. subagent 的 SKILL.md 中定义规范文件查找步骤（如 standards-reviewer 的 Phase B Step 1）
2. subagent 有 `read` 和 `bash` 工具，按 SKILL.md 指引自行查找和读取
3. dispatch subagent 时 `cwd` 设为项目根目录，确保相对路径正确

**理由**：
- 现有 standards-reviewer SKILL.md 已实现此模式（Phase A 检测 lint 配置 + Phase B 读 CLAUDE.md）
- subagent 是独立进程，读文件不占用主 agent 上下文
- 项目规范路径不固定（CLAUDE.md / .editorconfig / pyproject.toml / ~/.codetaste/essence.md），subagent 按 SKILL.md 指引查找比主 agent 预判更灵活

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
