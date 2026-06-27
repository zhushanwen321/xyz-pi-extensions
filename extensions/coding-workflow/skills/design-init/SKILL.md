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

为 design 工作流（Steps 1-6）建立**正确的文档载体**：建好长期文档容器，供 **design-closeout**（收尾步骤）把稳定结论沉淀进项目根，而非只堆在 `.xyz-harness/` 一次性目录里流失。

> **职责边界：** 本 skill 只建容器（骨架 + 回读验证），**不负责沉淀**（沉淀是 design-closeout 的职责）。①-⑥ 各阶段的产出仍写 `.xyz-harness/{topic}/`，收尾时才由 closeout 提炼进这里的长期文档。

> **[MANDATORY] 只扫描、报告、按确认填充缺失。绝不覆盖或改写已有文档内容。**（已有文档是用户资产，覆盖不可逆。）

## 文档清单与分级

| 文档 | 级别 | 工作流关系 | 处理 |
|------|------|-----------|------|
| **CLAUDE.md / AGENTS.md** | 必备（二者其一） | AI 协作规范的单一真相源；所有阶段遵守 | 见下方「主配置定位」 |
| **README.md** | 必备 | 项目说明 | 标配，通常已存在，缺失才提示 |
| **CONTEXT.md** | 必备 | design-clarity 写入统一语言/领域术语，后续全读 | 缺失则用模板创建骨架 |
| **ARCHITECTURE.md** | 推荐 | 架构当前态（分层/模块/状态机/领域模型）；design-closeout 从②沉淀 | 缺失则提示，按需创建骨架 |
| **PRODUCT.md** | 推荐 | 产品愿景/核心用户/功能边界/**非目标**；design-closeout 从①沉淀，design-clarity 读 | 缺失则提示，按需创建骨架 |
| **NFR.md** | 推荐 | 工程约束/不变式（安全/数据/性能/并发/稳定性/兼容性/可观测性 7 维度）；design-closeout 从④沉淀 | 缺失则提示，按需创建骨架 |
| **TEST-STRATEGY.md** | 可选 | 测试策略 + 不可回退基线；design-closeout 从⑥提炼 | 缺失不阻断，按需创建骨架 |
| **DESIGN-LOG.md** | 可选 | 设计历史索引（跨主题导航）；design-closeout 维护 | 缺失不阻断，按需创建骨架 |

## 主配置定位（CLAUDE.md / AGENTS.md）

`CLAUDE.md`（Claude Code 专用）和 `AGENTS.md`（跨工具开放标准，Codex CLI / Copilot CLI / Gemini CLI / Cursor / Claude Code 均支持）**都是 AI 协作规范载体，二者等价，有一个即可，不强制同时存在或 symlink**。

> ETH Zurich 研究结论：**臃肿的 context 文件反而降低 agent 成功率、增 20% 成本**。主配置要最小化（under 100 行），只含项目概述 / 技术栈 / 常用命令 / 核心约定，不含冗余解释。

**主配置检测**（决定后续文档建在哪）：

| 现状 | 处理 |
|------|------|
| 只有 `CLAUDE.md` | ✅ 直接用，以其所在目录为文档根 |
| 只有 `AGENTS.md` | ✅ 直接用，以其所在目录为文档根 |
| 两者都有且内容重复 | ⚠️ 维护两份会漂移，建议合并保留一个（多工具生态推荐 `AGENTS.md`）。**让用户确认，不自动合并** |
| 两者都有且内容不同 | ⚠️ 语义冲突，须用户厘清哪个是真相源 |
| 两者都没有 | 进入「文档位置推断 — 无主配置降级查找」 |

[MANDATORY] **涉及文件重命名 / 删除 / 合并的操作必须逐项向用户确认，不可自动执行。** 只报告建议，用户拍板。

## 文档位置推断（跟随主配置）

长期文档（ARCHITECTURE / PRODUCT / NFR / TEST-STRATEGY / DESIGN-LOG / CONTEXT）**建在主配置所在目录**，而非硬编码项目根：

- 主配置在项目根 → 长期文档建项目根
- 主配置在子目录（如 `web/CLAUDE.md`）→ 长期文档建该子目录

### 无主配置时的降级查找

主配置缺失时，**先扫描项目找类似文档**作为基线参考，避免在已有设计沉淀的项目里重复造容器：

1. 扫描常见主配置文件名：`AGENTS.md`、`CLAUDE.md`、`.cursorrules`、`.github/copilot-instructions.md`
2. 扫描已有架构 / 设计文档：`ARCHITECTURE.md`、`DESIGN.md`、`docs/architecture/`、`docs/design/`
3. 找到任一 → 报告其位置，建议以其所在目录为文档根，**询问用户**确认
4. 都没有 → 按默认规则在项目根建 `AGENTS.md`（最小骨架）+ 其他缺失文档

> 默认建 `AGENTS.md`（通用标准，多工具支持）；用户明确只用 Claude Code 生态时建 `CLAUDE.md`。

## 执行流程（轻量，不走 loop-skeleton 6 步）

本 skill 是基建准备，**不接入** loop-skeleton 的追踪/审查机制——它只做扫描 + 报告 + 按确认创建。

> **[状态追踪]** 开始时调 `design_status start_phase init` 标记阶段开始。
> **有 `design_status` tool 优先用 tool**：`design_status(action: start_phase, phase: init)`；**无 tool（Claude Code/Cursor/shell）用 CLI**：`design-status start-phase init`。CLI 完整用法见 loop-skeleton.md「CLI 完整用法」。
>
> **[init 特例：项目级状态]** init 在 ①clarity 选 topic 之前运行，无 topic 子目录。design_status 对 init 用**项目级状态存储**（`.xyz-harness/.design-status.json`，非 topic 子目录）——这是 design_status 内置的特例，正常调用即可，agent 无需特殊处理。

### 1. 扫描 + 回读一致性验证

扫描**主配置所在目录** + `docs/`，检测上述文档是否存在（含 symlink 解引用判断真实内容）。长期文档（ARCHITECTURE/PRODUCT/NFR/TEST-STRATEGY/DESIGN-LOG/CONTEXT）建在主配置所在目录；若主配置缺失，按「文档位置推断」的降级查找确定目录。

**[防腐烂闸门] 回读一致性验证**（文档已存在时额外做）——堵住「文档说一套、代码一套」的累积偏差：
对已存在的 always-current 文档（ARCHITECTURE.md / NFR.md），与当前代码快速核对，不一致标 `[STALE]`：
- **ARCHITECTURE.md**：grep「模块划分」表的核心模块名 → 代码里是否都存在；grep 状态机枚举 → 与代码枚举是否一致
- **NFR.md**：grep 各约束「验证」字段指向的 grep AC → 是否仍命中代码（命不中 = 约束未落地或已漂移）

`[STALE]` **不阻断**（用户可选择带着偏差设计），但必须显式告知，建议「先更新过时文档，再开新设计」——否则新设计基于过时前提，偏差一路放大到①-⑥。

### 2. 报告基建状态

向用户展示扫描结果，按级别排序：

```
📋 项目文档基建扫描

✅ 必备
   - AGENTS.md ✅ (内容 47 行，健康)
   - README.md ✅
   - CONTEXT.md ❌ 缺失 — design-clarity 会写入它，建议先建骨架

⚠️ 推荐（design-closeout 沉淀容器）
   - ARCHITECTURE.md ⚠️ [STALE] — 文档模块「X」代码已重构为「Y」，建议先更新
   - PRODUCT.md ❌ 缺失 — design-closeout 从①沉淀
   - NFR.md ❌ 缺失 — design-closeout 从④沉淀

— 可选（design-closeout 沉淀容器）
   - TEST-STRATEGY.md ❌ (缺失不阻断)
   - DESIGN-LOG.md ❌ (缺失不阻断)
```

### 3. 按确认填充缺失

逐个询问缺失的必备项是否创建。创建时用 `references/templates/` 的最小骨架（**只放章节标题 + 一句话提示，不 LLM 生成臃肿内容**）。用户逐项确认后才 write。

- `AGENTS.md` 骨架 → `references/templates/AGENTS.md`
- `CONTEXT.md` 骨架 → `references/templates/CONTEXT.md`
- `ARCHITECTURE.md` 骨架 → `references/templates/ARCHITECTURE.md`
- `PRODUCT.md` 骨架 → `references/templates/PRODUCT.md`
- `NFR.md` 骨架 → `references/templates/NFR.md`
- `TEST-STRATEGY.md` 骨架 → `references/templates/TEST-STRATEGY.md`
- `DESIGN-LOG.md` 骨架 → `references/templates/DESIGN-LOG.md`

### 4. 生成基建报告

将扫描结果 + 已执行操作写入 `.xyz-harness/_bootstrap-report.md`，供后续会话和阶段参考。

## 下游衔接

基建就绪后向用户提示：

> **[状态追踪]** 交接前调 `design_status complete_phase init` 收尾——校验 AGENTS.md/CONTEXT.md 就位后才标 completed。
> **有 tool 优先用 tool**：`design_status(action: complete_phase, phase: init)`；**无 tool 用 CLI**：`design-status complete-phase init`。

```
✅ 项目文档基建就绪。
   单一真相源：CLAUDE.md（或 AGENTS.md，二者其一即可）
   缺失必备文档已补齐骨架，请在后续阶段填充实际内容。
下一步：①需求澄清 — 明确业务目标→路线→用例/数据流/UI-UX
调用：`/design-clarity`

> **①clarity 会创建两个 topic 级文件**（init 不预建）：
> - `decisions.md` — 决策账本（跨阶段 append-only），用 `design-clarity/references/decisions-template.md` 骨架创建
> - `_progress.md` — 含 `complexity_tier`（L1/L2/L3）+ 阶段进度表，驱动全程降级
>
> 两者由首阶段按 `loop-skeleton.md` 创建，init 只负责项目级文档（AGENTS/CONTEXT/ARCHITECTURE 等）。
是否现在进入？
```

## 何时跳过本步

- 项目已有 `AGENTS.md`（或 `CLAUDE.md`）+ `CONTEXT.md` → 基建健全，直接进 Step 1
  （但若 ARCHITECTURE/NFR 已存在且 `[STALE]`，仍须先处理过时文档——跳过基建不等于跳过防腐烂）
- 纯原型/实验项目，不需要长期文档沉淀 → 跳过，后续阶段直接用 `.xyz-harness/` 一次性目录

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
| [OPTIONAL] | 可选步骤 | 可根据实际情况决定是否执行 |
