---
name: coding-init
description: >-
  Use when the user says "初始化项目", "init project", "准备项目文档",
  "新建 AGENTS.md", "项目基建", "project bootstrap", "start full workflow",
  or when the project lacks AGENTS.md/CONTEXT.md/ARCHITECTURE.md
  and needs documentation bootstrapped before full-* design work.
  Not for business requirements (Step 1), architecture modeling (Step 2), or
  coding. Not for overwriting existing docs — only scans, reports, and fills
  gaps with minimal skeletons on user confirmation.
---

# 项目文档初始化

## 核心目标

为 full 工作流（Steps 1-6）建立**正确的文档载体**：建好长期文档容器，供 **coding-closeout**（收尾步骤）把稳定结论沉淀进项目根，而非只堆在 `.xyz-harness/` 一次性目录里流失。

> **职责边界：** 本 skill 只建容器（骨架 + 回读验证），**不负责沉淀**（沉淀是 coding-closeout 的职责）。①-⑥ 各阶段的产出仍写 `.xyz-harness/{topic}/`，收尾时才由 closeout 提炼进这里的长期文档。

> **[MANDATORY] 只扫描、报告、按确认填充缺失。绝不覆盖或改写已有文档内容。**（已有文档是用户资产，覆盖不可逆。）

## 文档清单与分级

| 文档 | 级别 | 工作流关系 | 处理 |
|------|------|-----------|------|
| **CLAUDE.md / AGENTS.md** | 必备（二者其一） | AI 协作规范的单一真相源；所有阶段遵守 | 见下方「主配置定位」 |
| **README.md** | 必备 | 项目说明 | 标配，通常已存在，缺失才提示 |
| **CONTEXT.md** | 必备 | full-clarity 写入统一语言/领域术语，后续全读 | 缺失则用模板创建骨架 |
| **ARCHITECTURE.md** | 推荐 | 架构当前态（分层/模块/状态机/领域模型）；coding-closeout 从②沉淀 | 缺失则提示，按需创建骨架 |
| **PRODUCT.md** | 推荐 | 产品愿景/核心用户/功能边界/**非目标**；coding-closeout 从①沉淀，full-clarity 读 | 缺失则提示，按需创建骨架 |
| **NFR.md** | 推荐 | 工程约束/不变式（安全/数据/性能/并发/稳定性/兼容性/可观测性 7 维度）；coding-closeout 从④沉淀 | 缺失则提示，按需创建骨架 |
| **TEST-STRATEGY.md** | 可选 | 测试策略 + 不可回退基线；coding-closeout 从⑥提炼 | 缺失不阻断，按需创建骨架 |
| **DESIGN-LOG.md** | 可选 | 设计历史索引（跨主题导航）；coding-closeout 维护 | 缺失不阻断，按需创建骨架 |

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

**[RECOMMENDED] 项目结构速览（理解布局，扫描第一步）：** 细粒度 Glob 之前，先跑 `python3 ${SKILL_DIR}/scripts/dump_tree.py <项目根>`（可选 `--depth N`，默认 3），一次性获取结构化项目树：

- 跳过依赖/构建产物（node_modules/dist/build/.git/target/.venv 等），不读文件内容，纯元数据遍历
- 限深度 + 单目录合并 + 节点上限，输出可控（默认不跟随 symlink，避免 `.pi/agent/extensions/` 等软链形成循环）
- 标注关键文件：`[主配置]`/`[monorepo]`/`[pkg]`/`[design容器]`/`[entry]`（各语言入口）
- 鲁棒性：symlink 环检测、权限目录降级显示、中文/emoji 文件名 UTF-8 输出、`.bare`+worktree 结构识别

输出直接用于：① 判断项目类型（monorepo/单包/多语言）；② 定位关键目录（src/docs/scripts）供后续细读；③ 填入 Step 4 bootstrap-report 的「项目结构」节（`--out .xyz-harness/_tree.txt` 可持久化）。树给全局视图，Glob 精确定位，两者互补——先树后 Glob。

**[RECOMMENDED] 扫描并行化（提速，只读无依赖动作并发）：** 拿到结构树后，细粒度扫描动作是**只读、相互无依赖**的，主 agent 应在同一回合发起多个 Glob/Grep/Read，而非串行逐个查找：

- **可同消息并行的动作**（结果互不依赖）：
  - `Glob **/{AGENTS,CLAUDE}.md` 找主配置
  - `Glob **/{ARCHITECTURE,PRODUCT,NFR,TEST-STRATEGY,DESIGN-LOG,CONTEXT}.md` 找长期文档
  - `Glob **/{.cursorrules,.github/copilot-instructions.md}` 找其他主配置（降级查找）
  - `Glob docs/{architecture,design}/` 找已有架构/设计沉淀（降级查找）
- **不可并行、须串行的动作**（后步依赖前步结果）：
  - 「确认主配置存在」→「以它的目录为文档根」→「在该目录内找长期文档」——定位目录与在其内扫描是依赖链，先定位再扫
  - 「扫描结果」→「[STALE] 标注」——先有存在性结论才能决定是否回读核对

> 思想来自 lite 工作流的「同消息并行只读探索」——把无依赖的只读 IO 打包到同一回合，减少串行往返。本 skill 不派 subagent，并行发生在主 agent 工具层。

**[防腐烂闸门] 回读一致性验证**（文档已存在时额外做）——堵住「文档说一套、代码一套」的累积偏差：
对已存在的 always-current 文档（ARCHITECTURE.md / NFR.md），与当前代码快速核对，不一致标 `[STALE]`：
- **ARCHITECTURE.md**：grep「模块划分」表的核心模块名 → 代码里是否都存在；grep 状态机枚举 → 与代码枚举是否一致
- **NFR.md**：grep 各约束「验证」字段指向的 grep AC → 是否仍命中代码（命不中 = 约束未落地或已漂移）

`[STALE]` **不阻断**（用户可选择带着偏差设计），但必须显式告知，建议「先更新过时文档，再开新设计」——否则新设计基于过时前提，偏差一路放大到①-⑥。

**[RECOMMENDED] 机器回读诊断（零成本兜底）：** 扫描完成后，主 agent 自跑 `python3 ${SKILL_DIR}/scripts/check_init.py <项目根>`（默认当前目录）。脚本把上述「防腐烂闸门」+ 存在性/骨架态识别固化为机器诊断：

- **A 类（总是跑）**：对照文档分级表检测必备/推荐/可选文档的存在性 + 骨架态（含 `{占位符}`/TODO = 未沉淀骨架，标 SKELETON）。必备缺失标 MISSING。
- **B 类（仅非骨架态 always-current 文档跑）**：ARCHITECTURE.md / NFR.md 已被 closeout 沉淀过（非骨架态）时，做回读一致性——模块名 grep 源码、状态机枚举 grep 源码、NFR「验证」字段反引号标识符 grep 源码，漂移标 `[STALE]`。仍是骨架的文档跳过回读（无内容可核对）。
- **语义**：**exit 0 非阻断**（与 design_status gate.ts 的存在性门正交——gate 是完成态门，check_init 是设计期诊断）。产出 `.xyz-harness/_bootstrap-check.md`，Step 2 报告直接复用，不必主 agent 手动 grep。

> 中文/含空格的模块名、纯描述性 NFR 验证文本，脚本保守跳过（机器不可靠验证）——这类项需主 agent 人工核对补充。

### 2. 报告基建状态

向用户展示扫描结果，按级别排序：

```
📋 项目文档基建扫描

✅ 必备
   - AGENTS.md ✅ (内容 47 行，健康)
   - README.md ✅
   - CONTEXT.md ❌ 缺失 — full-clarity 会写入它，建议先建骨架

⚠️ 推荐（coding-closeout 沉淀容器）
   - ARCHITECTURE.md ⚠️ [STALE] — 文档模块「X」代码已重构为「Y」，建议先更新
   - PRODUCT.md ❌ 缺失 — coding-closeout 从①沉淀
   - NFR.md ❌ 缺失 — coding-closeout 从④沉淀

— 可选（coding-closeout 沉淀容器）
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
调用：`/full-clarity`

> **①clarity 会创建两个 topic 级文件**（init 不预建）：
> - `decisions.md` — 决策账本（跨阶段 append-only），用 `full-clarity/references/decisions-template.md` 骨架创建
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
