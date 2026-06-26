---
name: design-init
description: >-
  Use when the user says "初始化项目", "init project", "准备项目文档",
  "新建 AGENTS.md", "项目基建", "project bootstrap", "start design workflow",
  or when the project lacks AGENTS.md/CONTEXT.md/ARCHITECTURE.md
  and needs documentation bootstrapped before design work.
  Not for business requirements (Step 1), architecture modeling (Step 2), or
  coding. Not for overwriting existing docs — only scans, reports, and fills
  gaps with minimal skeletons on user confirmation.
---

# 项目文档初始化

## 核心目标

为 design 工作流（Steps 1-6）建立**正确的文档载体**：让后续阶段的产出归位到项目根的长期文档，而非只堆在 `.xyz-harness/` 一次性目录里。

> **[MANDATORY] 只扫描、报告、按确认填充缺失。绝不覆盖或改写已有文档内容。**（已有文档是用户资产，覆盖不可逆。）

## 文档清单与分级

| 文档 | 级别 | 工作流关系 | 处理 |
|------|------|-----------|------|
| **AGENTS.md** | 必备 | AI 协作规范的单一真相源；所有阶段遵守 | 见下方「AGENTS.md 归一化」 |
| **README.md** | 必备 | 项目说明 | 标配，通常已存在，缺失才提示 |
| **CONTEXT.md** | 必备 | design-clarity 写入统一语言/领域术语，后续全读 | 缺失则用模板创建骨架 |
| **ARCHITECTURE.md** | 推荐 | design-architecture 阶段**更新此文件**（长期沉淀） | 缺失则提示，按需创建骨架 |
| **PRODUCT.md** | 可选 | design-clarity 的参考输入（产品愿景/功能边界） | 缺失不阻断，仅提示 |

## AGENTS.md 归一化（CLAUDE.md = AGENTS.md）

`AGENTS.md` 是跨工具开放标准（Codex CLI / Copilot CLI / Gemini CLI / Cursor / Claude Code 均支持）；`CLAUDE.md` 是 Claude Code 专用。**二者是同一件事的不同叫法，只维护一份。**

> ETH Zurich 研究结论：**臃肿的 context 文件反而降低 agent 成功率、增 20% 成本**。AGENTS.md 要最小化（under 100 行），只含项目概述/技术栈/常用命令/核心约定，不含冗余解释。

检测逻辑：

| 现状 | 处理 |
|------|------|
| 只有 `AGENTS.md` | ✅ 完美。若用 Claude Code，可选创建 symlink：`ln -s AGENTS.md CLAUDE.md` |
| 只有 `CLAUDE.md` | 建议迁移为标准：`git mv CLAUDE.md AGENTS.md && ln -s AGENTS.md CLAUDE.md`（保留 CLAUDE.md 兼容入口） |
| 两者都有且内容重复 | 建议合并为 `AGENTS.md`，`CLAUDE.md` 改 symlink。**让用户确认后操作，不自动合并** |
| 两者都没有 | 创建 `AGENTS.md`（最小骨架）+ `ln -s AGENTS.md CLAUDE.md` |
| `CLAUDE.md` 已是 `AGENTS.md` 的 symlink | ✅ 已归一化，跳过 |

[MANDATORY] **涉及文件重命名/删除/symlink 的操作必须逐项向用户确认，不可自动执行。** 只报告建议，用户拍板。

## 执行流程（轻量，不走 loop-skeleton 6 步）

本 skill 是基建准备，**不接入** loop-skeleton 的追踪/审查机制——它只做扫描 + 报告 + 按确认创建。

> **[状态追踪]** 开始时调 `design_status start_phase init` 标记阶段开始。
> **有 `design_status` tool 优先用 tool**：`design_status(action: start_phase, phase: init)`；**无 tool（Claude Code/Cursor/shell）用 CLI**：`design-status start-phase init`。CLI 完整用法见 loop-skeleton.md「CLI 完整用法」。

### 1. 扫描

扫描项目根 + `docs/`，检测上述 5 个文档是否存在（含 symlink 解引用判断真实内容）。

### 2. 报告基建状态

向用户展示扫描结果，按级别排序：

```
📋 项目文档基建扫描

✅ 必备
   - AGENTS.md ✅ (内容 47 行，健康)
   - README.md ✅
   - CONTEXT.md ❌ 缺失 — design-clarity 会写入它，建议先建骨架

⚠️ 推荐
   - ARCHITECTURE.md ❌ 缺失 — design-architecture 会更新它

— 可选
   - PRODUCT.md ❌ (缺失不阻断)
```

### 3. 按确认填充缺失

逐个询问缺失的必备项是否创建。创建时用 `references/templates/` 的最小骨架（**只放章节标题 + 一句话提示，不 LLM 生成臃肿内容**）。用户逐项确认后才 write。

- `AGENTS.md` 骨架 → `references/templates/AGENTS.md`
- `CONTEXT.md` 骨架 → `references/templates/CONTEXT.md`
- `ARCHITECTURE.md` 骨架 → `references/templates/ARCHITECTURE.md`

### 4. 生成基建报告

将扫描结果 + 已执行操作写入 `.xyz-harness/_bootstrap-report.md`，供后续会话和阶段参考。

## 下游衔接

基建就绪后向用户提示：

> **[状态追踪]** 交接前调 `design_status complete_phase init` 收尾——校验 AGENTS.md/CONTEXT.md 就位后才标 completed。
> **有 tool 优先用 tool**：`design_status(action: complete_phase, phase: init)`；**无 tool 用 CLI**：`design-status complete-phase init`。

```
✅ 项目文档基建就绪。
   单一真相源：AGENTS.md（CLAUDE.md → symlink）
   缺失必备文档已补齐骨架，请在后续阶段填充实际内容。
下一步：①需求澄清 — 明确业务目标→路线→用例/数据流/UI-UX
调用：/design-clarity
是否现在进入？
```

## 何时跳过本步

- 项目已有 `AGENTS.md`（或 `CLAUDE.md`）+ `CONTEXT.md` → 基建健全，直接进 Step 1
- 纯原型/实验项目，不需要长期文档沉淀 → 跳过，后续阶段直接用 `.xyz-harness/` 一次性目录

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
| [OPTIONAL] | 可选步骤 | 可根据实际情况决定是否执行 |
