---
verdict: pass
---

# Pi Plan Mode Extension

## Background

Pi coding agent 当前缺少轻量级规划工具。用户需要对功能实现、bug 修复、重构、调研等任务做快速规划，但不需要 coding-workflow 的完整 5-phase 流程（gate/review/retrospect）。

Plan mode 填补这个空白：融合 brainstorming（需求探索）+ writing-plans（实现计划）的核心能力，借鉴 Claude Code plan mode 的交互模式，产出一份临时 plan 文件，退出后可衔接 goal 工具执行。

## Functional Requirements

### FR-1: Plan Mode 进入

| ID | 要求 |
|----|------|
| FR-1.1 | 用户通过 `/plan [描述]` 命令进入 plan mode |
| FR-1.2 | `/plan 添加用户认证` 带描述时，描述作为初始需求，先进入 brainstorming 再选模板 |
| FR-1.3 | `/plan` 不带描述时，若当前不在 plan mode，检测已有 plan 文件并提示用户选择（继续/实现/新建/取消） |
| FR-1.4 | `/plan` 不带描述时，若当前在 plan mode，显示状态（阶段、plan 文件路径） |
| FR-1.5 | 进入时创建 plan session 状态，存储在 `ctx.sessionManager`（per-session 隔离） |
| FR-1.6 | 进入时生成 plan 文件路径 `/tmp/plan-{slug}.md` |
| FR-1.7 | 进入时通过 skill 加载 plan mode 系统提示词（只读约束 + 流程指引） |
| FR-1.8 | 重入时先读已有 plan 文件，判断是新任务覆盖还是同一任务迭代 |

### FR-2: Brainstorming 流程

| ID | 要求 |
|----|------|
| FR-2.1 | B1: Quick Overview — AI 自动 ls + README + package.json 建立上下文（<30s） |
| FR-2.2 | B2: 渐进式提问 — 一次 2-3 个问题，按层级递进（目的→核心行为→边界） |
| FR-2.3 | 提问时优先使用 `ask_user` 工具（如已安装 pi-ask-user） |
| FR-2.4 | 先探索再提问：至少做一次代码探索（grep/read）再向用户提问，不问代码能回答的问题 |
| FR-2.5 | 区分两类未知数：探索能回答的（grep/read 解决）vs 需要用户偏好的（用 ask_user 问） |
| FR-2.6 | B3: 提出 2-3 个方案 + 权衡 + 推荐 |
| FR-2.7 | B4: 假设审计 — 提取设计中对代码的假设，grep 验证接口/类型是否存在 |
| FR-2.8 | 假设验证失败 → 修正设计；无法验证 → 标记 `[UNVERIFIED]` 告知用户 |
| FR-2.9 | B2-B4 可循环：用户提出新想法 → 重新提问 → 修改方案 → 重新审计 |
| FR-2.10 | 进入 Phase C 的条件：用户说"开始写 plan"或 AI 判断信息充分主动提议 |

### FR-3: Plan 文件编写

| ID | 要求 |
|----|------|
| FR-3.1 | AI 使用原生 write/edit 工具编辑 plan 文件 |
| FR-3.2 | 模板选择：AI 调用 `plan` tool (list-template) 展示可用模板，用户选择后调用 (select-template) |
| FR-3.3 | 必须按模板中章节的顺序逐个填写，不能跳过未写的章节 |
| FR-3.4 | 已写完的章节可以回头修改 |
| FR-3.5 | AI 一次 turn 写完所有章节，全部章节写完后才让用户确认 |
| FR-3.6 | Plan 文件使用 YAML frontmatter（template, created, status 字段） |

### FR-4: 模板系统

| ID | 要求 |
|----|------|
| FR-4.1 | 内置 5 个模板：feature-plan, bugfix-plan, refactor-plan, research-plan, implementation-plan |
| FR-4.2 | 用户自定义模板存放位置：全局 `~/.pi/agent/plan-templates/*.md`，项目级 `<project>/.pi/plan-templates/*.md` |
| FR-4.3 | 项目级同名模板覆盖全局 |
| FR-4.4 | AI 可帮用户创建自定义模板（`plan` tool create-template action） |
| FR-4.5 | 模板文件格式：YAML frontmatter + `## 章节名` 分隔的章节结构 |

### FR-5: Plan Mode 退出与上下文隔离

| ID | 要求 |
|----|------|
| FR-5.1 | 用户确认 plan 满意后，AI 调用 `plan` tool (complete) 触发退出流程 |
| FR-5.2 | 退出时通过 `ask_user` 让用户选择上下文隔离方式 |
| FR-5.3 | 选项 a：自动 compact — extension 调用 `ctx.compact()`，`onComplete` 回调中注入 steer message 指示 AI 读取 plan 文件执行 |
| FR-5.4 | 选项 b：tree 回退 — 提示用户手动 `/tree` |
| FR-5.5 | 选项 c：直接继续（不隔离上下文）— 直接注入 steer |
| FR-5.6 | `session_before_compact` handler 检测 plan mode 完成状态，自定义压缩摘要为 plan 文件路径 + 执行指令 |
| FR-5.7 | `session_before_tree` handler 类似，在回退摘要中注入 plan 文件路径 |
| FR-5.8 | compact 失败时降级为直接继续（不隔离上下文），通过 `ctx.ui.notify` 提示用户 |

### FR-6: 实现阶段衔接

| ID | 要求 |
|----|------|
| FR-6.1 | AI 读取 plan 文件后，检测 subagent 能力：检查 pi-subagents 包是否已安装 + Pi tool 注册表是否有 subagent tool |
| FR-6.2 | 有 subagent → 建议启动 goal + wave 并行开发 |
| FR-6.3 | 无 subagent → 建议单 agent 分阶段执行 |
| FR-6.4 | 通过 goal extension 的 `__goalInit` API 启动 goal（与 coding-workflow 一致的调用模式） |

### FR-7: Plan Mode 取消

| ID | 要求 |
|----|------|
| FR-7.1 | `/plan abort` 可在任何阶段取消 plan mode |
| FR-7.2 | AI 也可调用 `plan` tool (abort) 取消 |
| FR-7.3 | 取消后 plan 文件保留在 /tmp 不管，状态清除 |

### FR-8: 只读约束

| ID | 要求 |
|----|------|
| FR-8.1 | Plan mode 期间，提示词告知 AI 禁止编辑非 plan 文件、禁止运行写入类命令 |
| FR-8.2 | 约束仅通过提示词实现，不使用 `tool_call` 事件拦截 |
| FR-8.3 | 违反约束时用户可在 review 中发现并 abort |

### FR-9: 状态管理

| ID | 要求 |
|----|------|
| FR-9.1 | Plan session 状态存储在 `ctx.sessionManager`（per-session 隔离，不用闭包变量） |
| FR-9.2 | 通过 `appendEntry("plan-state", data)` 持久化 |
| FR-9.3 | `session_start` 事件中从 entries 重建状态 |

### FR-10: TUI 状态显示

| ID | 要求 |
|----|------|
| FR-10.1 | Plan mode 活跃时，状态栏显示 `[Plan Mode]` 标签 |
| FR-10.2 | 不显示阶段、文件路径等额外信息 |

## Acceptance Criteria

| ID | 验收标准 |
|----|---------|
| AC-1 | `/plan 添加认证` 进入 plan mode，AI 开始 brainstorming（提问→方案→审计） |
| AC-2 | AI 在 brainstorming 中先做代码探索再提问，不问代码能回答的问题 |
| AC-3 | AI 提出至少 2 个方案并给出推荐 |
| AC-4 | AI 按模板章节顺序逐个填写 plan 文件，不跳过 |
| AC-5 | Plan 文件存在且格式正确（YAML frontmatter + 章节结构） |
| AC-6 | `/plan abort` 在任何阶段均可取消 |
| AC-7 | `complete` 后 compact 成功时，新上下文中 AI 自动读取 plan 文件并提议执行策略 |
| AC-8 | `complete` 后 compact 失败时，降级为直接继续并通知用户 |
| AC-9 | Goal 通过 `__goalInit` API 成功启动 |
| AC-10 | 用户自定义模板被 list-template 正确发现 |
| AC-11 | 同一 Pi 进程多 session 时 plan 状态互不干扰 |

## Constraints

- **运行环境**：Pi extension，进程内执行，非独立进程
- **TypeScript**，Pi Extension API，typebox schema 定义
- **只读约束**：纯提示词驱动，不做 `tool_call` 事件拦截
- **状态存储**：`ctx.sessionManager`（per-session），不用闭包变量
- **Plan 文件**：存储在 `/tmp`，不主动清理
- **上下文隔离**：`ctx.compact()` + `session_before_compact` handler，与 coding-workflow 一致的实现模式
- **Goal API**：通过 `(pi as Record<string, unknown>).__goalInit` 调用，与 coding-workflow 一致的调用模式
- **无 gate/review/retrospect**：plan mode 不做质量门控

## 业务用例

### UC-1: 新功能规划

- **Actor**: 开发者
- **场景**: 需要实现一个新功能，但不确定方案
- **预期结果**: 产出 plan 文件，可选衔接 goal 执行

### UC-2: 复杂 Bug 修复

- **Actor**: 开发者
- **场景**: bug 根因不明，需要分析后再修复
- **预期结果**: 产出 bugfix-plan 文件，含根因分析和修复策略

### UC-3: 快速调研

- **Actor**: 开发者
- **场景**: 需要对比多个技术方案的优劣
- **预期结果**: 产出 research-plan 文件，含方案对比和推荐

### UC-4: 已有 Spec 的实现计划

- **Actor**: 开发者
- **场景**: 已有 spec.md，需要制定实现步骤
- **预期结果**: 跳过 brainstorming，直接产出 implementation-plan

## Complexity Assessment

**中等复杂度**。核心机制（状态管理、compact、goal API）在 coding-workflow 中已有成熟实现可参考。主要新增工作：
1. Plan tool 的 5 个 action handler
2. 模板系统（5 内置 + 自定义发现）
3. SKILL.md 提示词（brainstorming + writing 流程融合）
4. session_before_compact / session_before_tree handler

无数据库、无网络、无复杂算法。风险集中在提示词质量和跨 extension API 调用的稳定性。
