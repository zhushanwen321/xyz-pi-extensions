# L1/L2 工作流整合设计

> **状态**：设计中，待用户确认
> **日期**：2026-07-01
> **背景**：长期废弃 design 工作流（太重），将 mid + lite 整合为 L1/L2 两档标准工作流

## 一、问题诊断

### 1.1 命名对不上

| | 设计阶段 | 实施阶段 | 执行阶段 | 复盘阶段 |
|---|---|---|---|---|
| **L1 lite** | lite-plan | — | lite-execute | lite-retrospect |
| **L2 mid** | mid-design | mid-build | ❌ 无（交接说明写"可继续用 lite-execute"但格式不兼容）| ❌ 无 |

mid 的 `design` / `build` 和 lite 的 `plan` / `execute` 动词体系完全不对应。`build` 还误导（暗示构建代码，实际产出设计文档）。

### 1.2 执行入口格式割裂

- `lite-execute` 读 `plan.md`（lite 格式：6 章节，`## 实现步骤` 标题被 plan extension 的 `extractPlanSteps` 识别）
- `mid-build` 产 `execution-plan.md`（design 格式：Wave DAG / 时序图推导 / 测试验收清单）
- 两者格式不兼容，mid-build 交接说明"可继续用 lite-execute"是错的

### 1.3 复盘不通用

- `lite-retrospect` 绑定 lite-plan/lite-execute 的 frontmatter 趋同数据（`*_ensemble_overlap`），非真正通用
- design 废弃后 `design-closeout`（归档长期文档）也需要替代

### 1.4 design 资产依赖

mid-shared 目前引用了大量 design-* 资产（16+ 路径：decisions.md 模板、review-agent spec、context-builder、deliverable 模板、机器检查脚本、HTML 渲染）。废弃 design 前需要把这些资产迁移到 mid/lite 能独立持有的位置。

## 二、目标态设计

### 2.1 命名方案

| | 计划阶段 | 详细计划 | 执行 | 复盘 |
|---|---|---|---|---|
| **L1 lite** | lite-plan | — | lite-execute | retrospect（通用） |
| **L2 mid** | mid-plan | mid-detail-plan | lite-execute（共用） | retrospect（通用） |

**命名决策**：
- `mid-design` → **`mid-plan`**（需求 + 架构，属于"计划"范畴）
- `mid-build` → **`mid-detail-plan`**（实施规格 4 件套：issues + nfr + code-arch + execution-plan，是详细计划不是构建代码）
- execute 和 retrospect 提取为**通用 skill**，lite/mid 共用

### 2.2 统一 plan 格式

**核心改动**：定义统一的 `plan.md` 格式，lite 和 mid 最终都输出它。

```
统一 plan.md 格式：
---
tier: lite | mid          # 标注来源档位
topic: {slug}             # mid 时关联 .xyz-harness/{topic}/
source_skills:            # 产出此 plan 的 skill 链
  - lite-plan             #   lite: [lite-plan]
  - mid-plan              #   mid: [mid-plan, mid-detail-plan]
design_assets:             # mid 专属：关联的设计资产目录
  requirements: .xyz-harness/{topic}/requirements.md
  architecture: .xyz-harness/{topic}/system-architecture.md
  issues: .xyz-harness/{topic}/issues.md
  nfr: .xyz-harness/{topic}/non-functional-design.md
  code_arch: .xyz-harness/{topic}/code-architecture.md
---

# {功能名} 实现计划
## 业务目标
## 技术改动点
## Wave 拆分与依赖
## 单测用例清单（AC 级）
## E2E 用例清单
## 覆盖率 gate
## 实现步骤    <!-- [MANDATORY] 此标题被 extractPlanSteps 识别 -->
```

**关键**：
- 6 章节结构不变（lite-execute 的 `extractPlanSteps` 兼容）
- frontmatter 的 `tier` 字段让 execute/retrospect 知道来源
- mid 时 `design_assets` 指针让 execute 能回溯设计依据（如遇到问题时查 code-arch 的 API 契约）
- lite-plan 写的 plan.md：`tier: lite`，无 `design_assets`
- mid-detail-plan 写的 plan.md：`tier: mid`，含 `design_assets`

### 2.3 通用 execute（改造 lite-execute）

lite-execute 改造为通用 execute：
- 读取 plan.md 的 `tier` frontmatter
- `tier: lite` → 现有行为（读 6 章节，按 Wave 执行）
- `tier: mid` → 同样读 6 章节执行，但 implementer 遇到契约问题时可按 `design_assets` 回溯 code-architecture.md

### 2.4 通用 retrospect（从 lite-retrospect 提取）

提取 `retrospect` skill：
- 核心自检清单（通用：哪里顺/卡/改进）
- 根因链 + 层级 + 归属（通用）
- **可选增强**：读 plan.md 的 `tier`，若 `lite` 则消费 `*_ensemble_overlap` 趋同数据；若 `mid` 则消费 review-fix-loop 的收敛轮次数据
- 删除 lite-retrospect（或保留为 thin wrapper）

### 2.5 通用 closeout（替代 design-closeout）

提取 `closeout` skill（从 design-closeout 提取核心）：
- 设计→实施→沉淀闭环最后一步
- 把 .xyz-harness/{topic}/ 的稳定结论沉淀进长期文档（ARCHITECTURE/PRODUCT/NFR/ADR/TEST-STRATEGY）
- 归档 topic 目录
- lite 通常不需要（无 topic 目录）；mid 需要

### 2.6 资产迁移（design 废弃的前提）

mid-shared 当前引用的 design 资产需要迁移到独立位置（如 `workflow-shared/` 或 mid-shared/lite-shared 合并）：

| design 资产 | 迁移目标 | 被 mid 引用处 |
|---|---|---|
| `design-shared/references/loop-skeleton.md` | `workflow-shared/references/` | mid-design, mid-build 复杂度自评 |
| `design-shared/references/decisions-template.md` | `workflow-shared/references/` | mid-design Step 0 |
| `design-shared/references/review-agent.md` | `workflow-shared/references/` | mid-design/mid-build 红队 |
| `design-shared/references/context-builder.md` | `workflow-shared/references/` | mid-build Step 0 |
| `design-clarity/scripts/check_clarity.py` | `workflow-shared/scripts/` | mid-design Step 4 |
| `design-architecture/scripts/check_architecture.py` | `workflow-shared/scripts/` | mid-design Step 4 |
| `design-issues/scripts/check_issues.py` | `workflow-shared/scripts/` | mid-build Step 1c |
| `design-nfr/scripts/check_nfr.py` | `workflow-shared/scripts/` | mid-build Step 2/3c |
| `design-code-arch/scripts/check_code_arch.py` | `workflow-shared/scripts/` | mid-build Step 2/3c |
| `design-execution/scripts/check_execution.py` | `workflow-shared/scripts/` | mid-build Step 3c |
| `design-execution/references/consistency-check.md` | `workflow-shared/references/` | mid-build Step 5 |
| 各 deliverable-template.md | `workflow-shared/references/` | mid-design/mid-build 起草 |
| design-visual-explainer | 保留为独立 skill | mid-design/mid-build 渲染 |

> **本次范围**：资产迁移不在本次（用户说"mid 内容不做大变更"）。本次只改命名 + 统一 plan 格式 + 提取通用 execute/retrospect。资产迁移留待 design 正式废弃时做。

## 三、本次执行范围

用户明确："整体 mid 的内容本次不做大的变更"。所以本次只做**命名 + 边界对齐**，不改 mid 的内部流程：

### 3.1 重命名（机械操作）
- `mid-design/` → `mid-plan/`（改目录名 + SKILL.md frontmatter name + 内部自引用）
- `mid-build/` → `mid-detail-plan/`（同上）

### 3.2 description 和交接文本修正
- mid-plan description：明确产出 requirements.md + system-architecture.md
- mid-detail-plan description：明确产出 issues+nfr+code-arch+execution-plan，且**最终转译为统一 plan.md 格式**
- 修正 mid-detail-plan 的交接说明：不再是"可继续用 lite-execute（错）"，改为"产出统一格式 plan.md，用 execute skill 执行"

### 3.3 mid-detail-plan 增加转译步骤
mid-detail-plan 在 Step 6 定稿后，增加 Step 7：把 execution-plan.md 的 Wave/测试清单转译为统一 plan.md 格式（6 章节 + frontmatter `tier: mid` + `design_assets` 指针）。

### 3.4 提取通用 retrospect
- `lite-retrospect/` → `retrospect/`（提取通用核心 + tier 自适应增强）
- 修正引用

### 3.5 不做的
- ❌ 不改 mid-plan / mid-detail-plan 的内部执行流程（Step 1-6 不变）
- ❌ 不迁移 design 资产（留待 design 正式废弃）
- ❌ 不改 lite-plan 内部流程
- ❌ 不提取通用 closeout（留待 design 废弃时一起做）

## 四、文件变更清单（本次）

| 操作 | 路径 | 说明 |
|---|---|---|
| 重命名 | `mid-design/` → `mid-plan/` | 目录 + frontmatter name + 内部自引用 |
| 重命名 | `mid-build/` → `mid-detail-plan/` | 同上 |
| 新增 | `mid-detail-plan/SKILL.md` Step 7 | execution-plan.md → 统一 plan.md 转译 |
| 重命名+改造 | `lite-retrospect/` → `retrospect/` | 提取通用核心 |
| 更新 | `lite-execute/SKILL.md` 前置检查 | 接受 tier: lite|mid 的 plan.md |
| 更新 | `AGENTS.md`（根目录） | 目录结构 + 包清单同步 |
| 更新 | `coding-workflow/docs/design-workflow-guide.md` | mid 交叉引用节同步 |

## 五、待确认

1. **`mid-detail-plan` 这个名字**——会不会太长？备选：`mid-spec`（spec 比 detail plan 简洁，语义=规格）
2. **通用 retrospect 是否保留 lite-retrospect 作为别名**——避免破坏现有引用
3. **统一 plan.md 的 frontmatter `design_assets` 字段**——mid-detail-plan 转译时是否需要，还是 execute 遇到问题自己去找 .xyz-harness/{topic}/
