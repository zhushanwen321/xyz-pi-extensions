# Pi Plan Mode 设计文档

> Status: draft
> 日期: 2026-06-11
> 最后审查：对比 Claude Code / Codex CLI / OpenCode 的可借鉴点（见第 9 节）

## 1. 定位

Plan mode 是一个轻量级规划工具，融合 brainstorming（需求探索）+ writing-plans（实现计划）两个 skill 的核心能力，借鉴 Claude Code plan mode 的交互模式，但比 coding-workflow 的完整 5-phase 流程更轻量。

**核心差异（vs coding-workflow）**：
- 无 gate/review/retrospect 流程
- 无 spec.md → plan.md 的两阶段产出，直接产出一份 plan 文件
- 无术语表/ADR 强制步骤
- 产出物持久化到 `.xyz-harness/` 目录，和 brainstorming 规则一致
- 退出后可衔接 goal 工具执行，也可独立使用

## 2. Use Cases

### UC-1: 新功能实现规划（核心场景）

- **Actor**: 开发者
- **触发**: `/plan 实现 plan mode 扩展` 或 `/plan 添加用户认证`
- **主流程**:
  1. `/plan` 命令触发，进入 plan mode
  2. AI 快速浏览项目结构和相关代码
  3. AI 逐轮提出 2-3 个澄清问题
  4. AI 提出 2-3 个方案，给出推荐
  5. 用户选定方案后，AI 做代码假设验证
  6. AI 选择模板，逐章节填写 plan 文件（顺序写，不跳过）
  7. 用户整体 review plan 文件，可要求修改任意章节
  8. 满意后退出 plan mode，进入实现
- **频率**: 高

### UC-2: 复杂 Bug 修复规划

- **Actor**: 开发者
- **触发**: `/plan 修复并发场景下状态丢失的 bug`
- **特点**: 提问较少，探索较多。重点在根因分析和影响评估
- **频率**: 中

### UC-3: 重构规划

- **Actor**: 开发者
- **触发**: `/plan 重构 permission 系统，拆分为独立模块`
- **特点**: 依赖分析是关键，plan 需要严格的步骤顺序
- **频率**: 低-中

### UC-4: 快速方案探索（不写代码）

- **Actor**: 开发者
- **触发**: `/plan 调研 WebSocket vs SSE 对实时更新的影响`
- **特点**: plan 产出方案对比 + 推荐，可能不进入实现
- **变体**: 用户可能 `/plan abort` 退出
- **频率**: 中

### UC-5: 已有设计文档的实现计划

- **Actor**: 开发者
- **触发**: `/plan 根据 .xyz-harness/xxx/spec.md 制定实现计划`
- **特点**: 跳过 brainstorming，直接探索代码后写 plan
- **频率**: 中

### UC-6: Plan 迭代修改

- **Actor**: 开发者
- **触发**: 用户在 plan mode 中直接提出修改（如"第二个任务拆分更细"）
- **特点**: 不退出重进，对话式迭代
- **频率**: 高

### UC-7: 中途切换到 Plan Mode

- **Actor**: 开发者
- **触发**: 对话中途输入 `/plan`
- **特点**: 保留当前上下文，在当前会话中切换
- **频率**: 中

### UC-8: 取消 Plan Mode

- **Actor**: 开发者
- **触发**: `/plan abort`（任何阶段均可）
- **行为**: 退出 plan mode，plan 文件保留在 `.xyz-harness/` 目录不管
- **频率**: 低

### UC-9: 查看已有 Plan

- **Actor**: 开发者
- **触发**: `/plan`（不带参数，当前不在 plan mode）
- **行为**: 检测已有 plan 文件，提示用户选择：
  - 继续上次 plan
  - 基于已有 plan 开始实现
  - 创建新 plan（覆盖）
  - 取消
- **频率**: 中

### UC-10: Plan 完成后进入实现

- **Actor**: 开发者
- **触发**: 用户确认 plan 完成
- **行为**:
  1. 退出 plan mode
  2. 提示用户选择上下文隔离方式（compact/tree/不隔离）
  3. 执行隔离后，AI 读取 plan 文件
  4. 检测 subagent 能力
  5. 建议执行方式（goal + wave / 分阶段），提示用户启动
- **频率**: 高

### UC-11: 非代码任务规划

- **Actor**: 开发者
- **触发**: `/plan 编写 API 文档`
- **特点**: plan 粒度偏粗，重点是步骤和产出物
- **频率**: 低

### Edge Cases

| 场景 | 期望行为 |
|------|----------|
| 用户在 plan mode 中要求直接改代码 | AI 提醒当前在 plan mode，建议先完成 plan。用户坚持则 abort 后执行 |
| AI 发现任务很简单 | AI 提示不需要完整 plan，建议直接做 |
| Plan mode 中触发 compact | extension 的 `session_before_compact` handler 保留 plan 文件路径 |
| 用户给 `/plan` 传了非常详细的指令 | 跳过 brainstorming，直接探索后写 plan |

### Out of Scope

| 场景 | 原因 | 替代方案 |
|------|------|----------|
| Spec 级别的术语表/ADR | coding-workflow 的职责 | 完整 harness 流程 |
| TDD 粒度的测试计划 | writing-plans skill 的职责 | 完整 harness 流程 |
| Plan 执行进度跟踪 | 通过 goal 编程接口自动管理 | `startGoalFromPlan()` 创建 goal + task |
| Gate/review/retrospect | coding-workflow 的职责 | 完整 harness 流程 |

## 3. 完整流程

```
/plan [描述]
  │
  ▼
┌─────────────────────────────────────────────────┐
│ Phase A: Setup                                  │
│                                                 │
│ 1. 创建 plan session 状态（闭包变量）           │
│ 2. 生成 plan 文件路径：.xyz-harness/{slug}/plan.md│
│ 3. 调用 pi.setActiveTools() 限制为只读工具集    │
│ 4. 注入 plan mode 系统提示词（只读约束）        │
│                                                 │
│ 如果用户带了描述（如 /plan 添加认证）：          │
│   → 先进入 Phase B，brainstorming 完成后再选模板 │
│ 如果用户没带描述（如 /plan）：                   │
│   → 先选模板，再进入 Phase B                    │
│                                                 │
│ 模板选择流程：                                   │
│   AI 调用 plan tool (list-template)              │
│   → 展示内置模板 + 用户自定义模板               │
│   用户选择 → AI 调用 plan tool (select-template) │
│   → 复制模板到 plan 文件路径                     │
└─────────────┬───────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────┐
│ Phase B: Explore + Brainstorm                   │
│                                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ B1: Quick Overview                          │ │
│ │ • ls + README + package.json + CONTEXT.md   │ │
│ │ • 快速建立上下文（<30s）                    │ │
│ └─────────────┬───────────────────────────────┘ │
│               ▼                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ B2: 渐进式提问                              │ │
│ │ • 一次 2-3 个问题                           │ │
│ │ • 层级：目的 → 核心行为 → 边界              │ │
│ │ • 按需 grep/read 验证假设                   │ │
│ │ • 用户可随时打断修改方向                     │ │
│ └─────────────┬───────────────────────────────┘ │
│               ▼                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ B3: 提出方案                                │ │
│ │ • 2-3 个方案 + 权衡 + 推荐                 │ │
│ │ • 用户选定一个方向                           │ │
│ └─────────────┬───────────────────────────────┘ │
│               ▼                                 │
│ ┌─────────────────────────────────────────────┐ │
│ │ B4: 假设审计                                │ │
│ │ • 提取设计中对代码的所有假设                 │ │
│ │ • grep 验证接口/类型/枚举是否存在            │ │
│ │ • 验证失败 → 修正设计                       │ │
│ │ • 无法验证 → 标记 [UNVERIFIED] 告知用户     │ │
│ └─────────────┬───────────────────────────────┘ │
│                                                 │
│ B2-B4 可循环：用户提出新想法 → 重新提问         │
│ → 修改方案 → 重新审计。直到双方对方向达成共识。 │
│                                                 │
│ 进入条件（满足任一）：                           │
│ • 用户说"开始写 plan"、"可以，写吧"             │
│ • AI 判断信息充分，主动提议进入写 plan 阶段     │
└─────────────┬───────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────┐
│ Phase C: Write Plan                             │
│                                                 │
│ 如果 Phase A 没选模板（因为先 brainstorming）， │
│ 现在选：list-template → select-template         │
│                                                 │
│ AI 使用原生 write/edit 工具，逐章节填写 plan    │
│ 文件。约束：                                     │
│ • 必须按模板中章节的顺序逐个填写                │
│ • 不能跳过未写的章节直接写后面的                │
│ • 已写完的章节可以回头修改                       │
│ • 全部章节写完后才让用户确认（中间不暂停）       │
│                                                 │
│ AI 一次 turn 写完所有章节。                      │
│ 写完后告知用户"plan 已完成，请审阅"。            │
└─────────────┬───────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────┐
│ Phase D: 用户确认 + 退出                      │
│                                                 │
│   AI 调用 plan tool (complete) 时：              │
│   → tool 弹出 ctx.ui.select() 用户确认门控      │
│   → 用户选择「执行」→ 继续 D2-D3                │
│   → 用户选择「修改」→ 回到 Phase C 继续编辑     │
│   → 用户选择「稍后再说」→ 保存 plan，不退出     │
│                                                 │
│   注意：complete 必须经过用户确认，AI 不能直接   │
│   触发执行。这是防止 AI 跳过用户 review 的关键   │
│   门控（参考 Claude Code ExitPlanMode 和 Codex   │
│   三选一弹窗的设计）。                           │
│                                                 │
│ D2: 上下文隔离                                   │
│   extension 通过 ask_user 让用户选择：           │
│     a) 自动 compact（默认推荐）                  │
│       → ctx.compact() 编程式触发                 │
│       → session_before_compact handler 自定义摘要│
│       → 只保留 "plan 文件路径 + 执行指令"        │
│       → onComplete 回调中注入 steer message      │
│     b) /tree 回退到 plan 开始前                  │
│       → 用户手动执行 /tree                       │
│       → session_before_tree handler 自定义摘要   │
│     c) 直接继续（不隔离上下文）                  │
│                                                 │
│   compact 实现参考 coding-workflow 的             │
│   ctx.compact({ customInstructions,              │
│     onComplete, onError }) 模式。                │
│                                                 │
│ D3: 进入实现                                    │
│   • Extension 调用 goal 编程接口                │
│     startGoalFromPlan(pi, objective, planFilePath)│
│   • Goal 自动从 plan 的「实现步骤」提取 task    │
│   • 进度通过 goal task 状态追踪                 │
│   • 如 goal 不可用 → steer 引导单 agent 执行    │
│   • 退出时恢复完整工具集                        │
│     pi.setActiveTools(['read','bash','edit','write'])│
└─────────────────────────────────────────────────┘
```

## 4. Plan 模板

### 4.1 内置模板

#### feature-plan（新功能实现）

```markdown
---
template: feature-plan
created: {timestamp}
---

## 背景

<!-- 为什么做这个功能？解决什么问题？ -->

## 方案

<!-- 选定的方案描述，包括架构、组件、数据流 -->
<!-- 包含从 brainstorming 中确认的设计决策 -->

## 关键文件

<!-- 需要创建或修改的文件，每个文件一句话说明改什么 -->
<!-- 引用的已有函数/接口，附文件路径 -->

## 实现步骤

<!-- 按文件或模块组织的步骤列表 -->
<!-- 每步说明做什么、依赖哪一步 -->

## 验证

<!-- 如何测试这些变更：运行什么命令、检查什么结果 -->
```

#### bugfix-plan（Bug 修复）

```markdown
---
template: bugfix-plan
created: {timestamp}
---

## 现象

<!-- Bug 的表现、触发条件、影响范围 -->

## 根因分析

<!-- 代码级别的根因，附调用链路和关键代码位置 -->

## 修复策略

<!-- 怎么修，为什么这样修，有无更优方案 -->

## 受影响文件

<!-- 需要修改的文件 + 每个文件的改动说明 -->

## 回归测试

<!-- 验证修复的测试方案 + 防止复发的测试 -->
```

#### refactor-plan（重构）

```markdown
---
template: refactor-plan
created: {timestamp}
---

## 现状

<!-- 当前结构的问题、为什么要重构 -->

## 目标结构

<!-- 重构后的目标架构，与现状的对比 -->

## 分步骤计划

<!-- 渐进式重构步骤，每步可独立验证 -->
<!-- 步骤间的依赖关系 -->

## 风险与缓解

<!-- 重构可能引入的风险 + 缓解措施 -->

## 验证

<!-- 每步完成后的验证方式 -->
```

#### research-plan（调研/方案对比）

```markdown
---
template: research-plan
created: {timestamp}
---

## 问题

<!-- 要调研的问题/决策点 -->

## 候选方案

<!-- 每个方案的描述 -->

## 对比分析

<!-- 按维度对比：性能、复杂度、可维护性、兼容性等 -->

## 推荐

<!-- 推荐方案 + 理由 -->

## 后续步骤

<!-- 如果采纳推荐方案，下一步做什么 -->
```

#### implementation-plan（从已有 spec 出发）

```markdown
---
template: implementation-plan
created: {timestamp}
---

## Spec 摘要

<!-- 从 spec 文件中提取的关键需求，附 spec 文件路径 -->

## 任务分解

<!-- 按 spec 的功能点分解为可独立实现的单元 -->
<!-- 每个任务：做什么、改哪些文件、依赖哪个任务 -->

## 实现顺序

<!-- 任务执行的先后顺序和理由 -->

## 验证

<!-- 端到端验证方案 -->
```

### 4.2 用户自定义模板

**存放位置**：
- 全局：`~/.pi/agent/plan-templates/*.md`
- 项目级：`<project>/.pi/plan-templates/*.md`

**发现机制**：`plan tool (list-template)` 扫描这两个目录，合并结果。项目级同名模板覆盖全局。

**创建方式**：
- 用户手动在上述目录放置 .md 文件
- AI 帮用户创建：用户描述模板需求 → AI 生成模板内容 → AI 调用 `plan tool (create-template)` 保存到目录

**模板文件格式**：与内置模板相同，YAML frontmatter 中 `template` 字段为模板名称，文件体为章节结构（用 `## 章节名` 分隔）。

## 5. Extension 架构

### 5.1 包结构

```
extensions/plan/
├── index.ts              # re-export src/index.ts
├── package.json          # @zhushanwen/pi-plan
├── src/
│   ├── index.ts          # 工厂函数，注册 tool + command + events
│   ├── state.ts          # Plan session 状态定义
│   ├── templates.ts      # 内置模板 + 模板发现/加载
│   ├── tool-handler.ts   # plan tool 的 execute 逻辑
│   ├── command-handler.ts# /plan 命令处理
│   ├── compaction.ts     # session_before_compact handler
│   ├── tree-handler.ts   # session_before_tree handler
│   ├── prompts.ts        # plan mode 系统提示词
│   └── widget.ts         # TUI 状态栏（显示 [Plan Mode] 标签）
└── skills/
    └── plan-mode/
        └── SKILL.md      # plan mode skill（brainstorming + writing 流程指引）
```

### 5.2 状态模型

```typescript
interface PlanSession {
  /** 是否在 plan mode 中 */
  active: boolean;
  /** plan 文件路径（.xyz-harness/{slug}/plan.md） */
  planFilePath: string;
  /** 选定的模板名称 */
  templateName?: string;
  /** plan mode 开始时的 entry ID（用于 tree 回退） */
  startEntryId?: string;
  /** 当前阶段 */
  phase: "setup" | "brainstorm" | "writing" | "review" | "done";
}
```

状态存储在 `ctx.sessionManager` 中（per-session 隔离），通过 `appendEntry("plan-state", data)` 持久化，`session_start` 时从 entries 重建。

**不用闭包变量**：同一 Pi 进程可能运行多个 session，闭包变量会被共享导致冲突。`sessionManager` 天然 per-session。

### 5.3 注册项

| 类型 | 名称 | 说明 |
|------|------|------|
| Tool | `plan` | plan mode 操作：list-template, select-template, create-template, complete（含用户确认门控）, abort |
| Command | `/plan` | 触发 plan mode：`/plan [描述]`、`/plan abort`、`/plan status` |
| Event | `session_start` | 重建 plan session 状态 |
| Event | `session_before_compact` | plan mode 活跃时自定义压缩摘要 |
| Event | `session_before_tree` | plan mode 活跃时自定义回退摘要 |
| Skill | `plan-mode` | brainstorming + writing 流程指引 |

### 5.4 Tool: plan

**参数 schema**:

```typescript
const PlanToolParams = Type.Object({
  action: StringEnum([
    "list-template",      // 列出可用模板
    "select-template",    // 选择模板，复制到 plan 文件
    "create-template",    // 创建用户自定义模板
    "complete",           // 完成 plan，弹出用户确认 → 通过后触发退出流程
    "abort",              // 取消 plan mode
  ]),
  // select-template / create-template 时必填
  templateName: Type.Optional(Type.String()),
  // create-template 时必填，模板内容
  templateContent: Type.Optional(Type.String()),
  // create-template 时可选，存到全局还是项目级
  scope: Type.Optional(StringEnum(["global", "project"])),
});
```

**行为**:

| action | 行为 |
|--------|------|
| `list-template` | 扫描内置 + 全局 + 项目模板目录，返回模板列表 |
| `select-template` | 将指定模板内容写入 planFilePath |
| `create-template` | 将 templateContent 写入模板目录 |
| `complete` | 1. 弹出 `ctx.ui.select()` 用户确认：执行 / 修改 / 稍后再说。用户选「执行」才继续。2. 用户确认后，让用户选择上下文隔离方式（compact/tree/继续）。3. 若选 compact：调用 `ctx.compact()`，`onComplete` 回调注入 steer + 调用 `startGoalFromPlan()`。4. 恢复完整工具集 `pi.setActiveTools()`。用户选「修改」→ 返回修改指令，不退出。用户选「稍后再说」→ 保存当前 plan，不退出。 |
| `abort` | 设置 active=false，清除 plan session 状态 |

### 5.5 Command: /plan

| 调用方式 | 行为 |
|---------|------|
| `/plan <描述>` | 进入 plan mode，描述作为初始需求 |
| `/plan` | 不在 plan mode：显示已有 plan 或提示创建。在 plan mode：显示当前状态（阶段、plan 文件路径） |
| `/plan abort` | 取消 plan mode |
| `/plan status` | 显示当前 plan mode 状态（阶段、plan 文件路径） |

### 5.6 系统提示词

plan mode 的核心提示词通过 skill (SKILL.md) 注入，包含：

1. **只读约束**：禁止编辑文件（plan 文件除外）、禁止运行写入类命令
2. **流程指引**：Phase B（brainstorming）→ Phase C（writing）→ Phase D（review）的完整步骤
3. **提问策略**：
   - 一次 2-3 个问题、按层级递进、用 ask_user 工具
   - **先探索再提问**：至少做一次代码探索再向用户提问，不要问代码能回答的问题
   - **两类未知数**：探索能回答的（grep/read 解决）vs 需要用户偏好的（用 ask_user 问）
4. **方案探索**：必须提出 2-3 个方案
5. **假设审计**：验证代码引用的正确性
6. **章节顺序**：严格按模板章节顺序填写
7. **退出方式**：complete 后引导用户选择上下文隔离方式
8. **重入处理**：重入 plan mode 时先读已有 plan 文件，判断是新任务覆盖还是同一任务迭代

### 5.7 Compaction / Tree Handler

`session_before_compact` 和 `session_before_tree` handler 逻辑：

```typescript
// ── 编程式触发 compact（参考 coding-workflow 的 phase-start 实现）──

// complete action 中，用户选择 compact 后：
ctx.compact({
  customInstructions:
    `Plan mode completed. Plan file at: ${state.planFilePath}. ` +
    `Summarize: only preserve the plan file path and execution instruction.`,
  onComplete: () => {
    // compact 成功，注入 steer message 让 AI 开始执行
    pi.sendUserMessage(
      `Read the plan file at ${state.planFilePath} and execute it. ` +
      `Detect subagent capability, then propose execution strategy.`,
      { deliverAs: "steer" },
    );
  },
  onError: (error: Error) => {
    // compact 失败（如 stale context），降级为直接继续
    ctx.ui.notify(
      `Compact failed: ${error.message}. Continuing without context isolation.`,
      "warning",
    );
    pi.sendUserMessage(
      `Read the plan file at ${state.planFilePath} and execute it.`,
      { deliverAs: "steer" },
    );
  },
});
```

```typescript
// ── session_before_compact handler（自定义压缩内容）──

pi.on("session_before_compact", async (event, ctx) => {
  // 检查 plan session 状态（从 branchEntries 读取）
  const planState = getPlanStateFromEntries(event.branchEntries);
  if (!planState?.active || planState.phase !== "done") {
    return; // 非 plan 完成状态，不干预，走默认压缩
  }

  // 自定义压缩：只保留 plan 文件路径
  return {
    compaction: {
      summary:
        `Plan mode completed. Plan file at: ${planState.planFilePath}\n` +
        `Instruction: Read the plan file and execute it.`,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  };
});
```

Tree handler 类似，在回退摘要中只注入 plan 文件路径。

**检测机制**：plan session 状态通过 `appendEntry("plan-state", data)` 持久化。handler 从 `branchEntries` 中读取最近的 plan-state entry 判断是否处于 plan 完成状态。

**与 coding-workflow 的一致性**：coding-workflow 在 `coding-workflow-phase-start` tool 的 execute 中调用 `ctx.compact()`，在 `session_before_compact` 中自定义压缩内容。plan mode 采用完全相同的模式。

### 5.8 Goal API 集成

Goal extension 导出函数：

```typescript
// extensions/goal/src/index.ts
export function startGoalFromPlan(
  pi: ExtensionAPI,
  objective: string,
  planFilePath: string,
): void { ... }
```

Plan extension 调用：

```typescript
import { startGoalFromPlan } from "@zhushanwen/pi-goal";

// 在 complete action 的实现阶段
startGoalFromPlan(pi, objective, planFilePath);
```

**约束**：`startGoalFromPlan` 接受 `source: "plan-mode"` 参数，不做额外验证（信任调用方）。其他模式的调用方不会传这个参数，实际上不会被误调用。

### 5.9 Subagent 能力检测

Phase D3 中 AI 执行检测：

```typescript
// 检测方式：检查 goal extension 是否已安装
const goalInit = (pi as unknown as Record<string, unknown>).__goalInit;
if (goalInit) {
  goalInit(objective, tasksFromPlan);
} else {
  // 降级：steer message 引导单 agent 执行
  pi.sendUserMessage(`Read plan and execute: ${planFilePath}`, { deliverAs: "steer" });
}
```

检测逻辑在提示词中引导 AI 自行完成（read package.json / 调用 bash 检查），不需要 extension 注册额外 tool。

## 6. Plan 文件管理

### 6.1 存储位置

- 路径：`.xyz-harness/{slug}/plan.md`（项目目录内，与 brainstorming 规则一致）
- 命名：slug 从用户描述生成，小写 + 横线分隔
- 生命周期：持久化，纳入版本控制，可被 coding-workflow 的后续 phase 引用
- 目录结构：`.xyz-harness/{slug}/plan.md`，与 coding-workflow 的 `.xyz-harness/{date}-{slug}/` 规则一致

### 6.2 Compact 恢复

`session_before_compact` handler 不仅保存 plan 文件路径，还保存 **plan 完整内容**，确保即使文件被意外删除也能恢复：

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const planState = getPlanStateFromEntries(event.branchEntries);
  if (!planState?.active || planState.phase !== "done") return;

  const planContent = fs.readFileSync(planState.planFilePath, "utf-8");
  return {
    compaction: {
      summary:
        `Plan mode completed. Plan file: ${planState.planFilePath}\n\n` +
        `## Plan Content\n${planContent}\n\n` +
        `Awaiting user decision on execution.`,
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  };
});
```

### 6.2 文件格式

```markdown
---
template: feature-plan
created: 2026-06-11T10:30:00Z
status: draft | complete
---

## 背景
...

## 方案
...

## 关键文件
...

## 实现步骤
...

## 验证
...
```

## 7. 只读约束

Plan mode 的只读约束通过**工具级限制 + 提示词辅助**双保险实现。

### 第一层：pi.setActiveTools()（硬限制）

进入 plan mode 时：
```typescript
pi.setActiveTools(["read", "bash", "grep", "find", "ls", "plan"]);
```

退出 plan mode 时恢复：
```typescript
pi.setActiveTools(["read", "bash", "edit", "write"]);
```

这确保 AI 物理上无法调用 edit/write 工具。Plan 文件的写入通过 plan tool 内部的 write 逻辑完成（不在 AI 的工具列表中直接暴露）。

### 第二层：提示词引导（软约束）

SKILL.md 中的提示词告知 AI：
- 当前在 plan mode，只分析不修改
- 禁止运行写入类 bash 命令
- 退出方式只有 `plan tool (complete)` 或 `plan tool (abort)`

### 设计理由

- `pi.setActiveTools()` 提供硬性保证，AI 无法绕过
- 提示词作为行为引导，让 AI 理解 plan mode 的意图
- 参考了 Claude Code 的三层防护（prompt + disallowedTools + permission）和 Pi 官方 plan-mode 示例的 `setActiveTools` 模式

## 8. 与 coding-workflow 的关系

| 维度 | Plan Mode | Coding Workflow |
|------|-----------|-----------------|
| 定位 | 轻量规划工具 | 完整工程流程 |
| 产出 | 1 个 plan 文件（.xyz-harness/） | spec.md + plan.md + code + tests |
| Gate/Review | 无 | 5-phase gate |
| Brainstorming 深度 | 精简（5 步） | 完整（10 步 + 术语/ADR） |
| 持久化 | .xyz-harness/ 持久 | .xyz-harness/ 持久 |
| 适用场景 | 快速规划、非正式需求 | 正式项目、需要审计追踪 |

**衔接方式**：plan mode 的产出（plan 文件）可以被 coding-workflow 的 Phase 2 (writing-plans) 作为输入参考，但两者独立运行。

## 9. 跨工具对比与借鉴记录

审查三个工具后的决策记录：

| 来源 | 特性 | 是否采纳 | 理由 |
|------|------|----------|------|
| Claude Code | 稀疏提示词刷新（attachment 周期注入） | 否 | Pi 无等价 attachment 系统；compact 已保证上下文新鲜度 |
| Claude Code | 退出后 plan 文件完整内容注入 | **采纳** | compact 摘要含 plan 完整内容（非只传路径） |
| Claude Code | Plan mode 重入处理（读已有 plan → 判断新任务 vs 迭代） | **采纳** | SKILL.md 中补充重入判断逻辑 |
| Claude Code | EnterPlanMode 触发条件（AI 自动判断何时进 plan mode） | 否 | 用户手动 `/plan` 触发已足够 |
| Claude Code | disallowedTools 硬性只读 | **采纳** | `pi.setActiveTools()` 限制只读工具集 |
| Claude Code | ExitPlanMode 用户审批门控 | **采纳** | complete action 加 `ctx.ui.select()` 用户确认 |
| Codex | `<proposed_plan>` 结构化输出 + 专用渲染 | 否 | 纯 TUI，无专用渲染层 |
| Codex | "先探索再提问"原则 | **采纳** | SKILL.md 中加强：至少做一次代码探索再向用户提问 |
| Codex | 两类未知数区分（可探索 vs 需用户偏好） | **采纳** | SKILL.md 中明确：探索能回答的不问用户 |
| Codex | 实现确认弹窗（三选项） | **采纳** | complete 弹出三选一（执行/修改/稍后再说） |
| Codex | Plan mode nudge（关键词提示切换） | 否 | `/plan` 命令已足够直接 |
| OpenCode | 权限系统硬性只读 | **采纳** | `pi.setActiveTools()` 提供工具级硬限制 |
| OpenCode | Agent 切换模型（plan/build 双 agent） | 否 | Pi 用单一 agent + 状态切换 |
| OpenCode | Subagent 协作（explore/plan subagent） | 否 | plan mode 轻量化设计，不依赖 subagent |

## 10. 依赖关系

```
extensions/plan/
├── 依赖 @zhushanwen/pi-goal (optional runtime dependency)
│   └── 运行时检测 goal 编程接口（__goalInit）
├── 依赖 pi-ask-user (optional runtime dependency)
│   └── AI 使用 ask_user 工具做结构化提问
└── 依赖 pi-subagents (optional runtime dependency)
    └── 检测是否可用，决定执行策略
```

在 `extension-dependencies.json` 中声明：

```json
{
  "@zhushanwen/pi-plan": {
    "dependsOn": [
      { "name": "@zhushanwen/pi-goal", "type": "optional" },
      { "name": "pi-ask-user", "type": "optional" },
      { "name": "pi-subagents", "type": "optional" }
    ]
  }
}
```
