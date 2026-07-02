---
name: mid-plan
description: >-
  Use when the user says "mid 计划", "中等需求设计", "需求架构一起做",
  "批量设计需求架构", or has a L2-complexity feature (multi-module single system,
  3-5 Waves, 2-3 NFR dimensions) and needs requirements.md + system-architecture.md
  produced efficiently via draft + batch-ask + review-fix-loop. Produces requirements.md
  + system-architecture.md (+ .html). Content aligns with full-clarity + full-architecture;
  orchestration aligns with lite (batch-ask replaces one-by-one Grilling).
  Not for L3 heavy (multi-system/cross-org/complex state machine) — use design-* workflow.
  Not for L1 small feature (no architecture change) — use lite-plan.
  Not for issues/nfr/code-arch/execution — that is mid-detail-plan.
---

# mid-plan（需求 + 架构，L2 标准档）

为 **L2 复杂度**需求同时产出 `requirements.md` + `system-architecture.md`。**内容**对齐 full-clarity +
full-architecture 全量；**编排**改为 draft → batch-ask → review-fix-loop（mid 风格）。

> **[铁律] 本 skill 只做需求 + 架构设计，不进入 issue 拆分 / NFR / 代码架构 / 执行计划（那是 mid-detail-plan）。**
> 也不做代码级 API 签名/时序图/DB schema（属 full-code-arch，mid-detail-plan 复用）。

## 范围守门（L2 判定，开始前必做）

[MANDATORY] 按 `../full-shared/references/loop-skeleton.md`「复杂度自评」（8 信号打分）判定档位：

- **L2（12-18 分，本 skill 目标）** → 继续
- **L1（8-11 分，小功能无架构改动）** → 停止，改用 `/skill:lite-plan`
- **L3（19-24 分，重型）** → 停止，改用 design 工作流（每阶段深度收敛不可省）

> mid 的定位是 **L2 专用**。L1 走 lite 更快，L3 走 design 更稳。范围错了后面全白做。
> 判定结果写入 `{topic_dir}/_progress.md` frontmatter 的 `complexity_tier`，用户可覆盖（判定后 ask_user 确认一次）。

## 前置

- **coding-init 已完成**：项目文档容器就绪（AGENTS.md/CONTEXT.md/ARCHITECTURE.md 骨架）。未完成 → `/skill:coding-init`
- **topic 已选定**：`.xyz-harness/{topic}/` 目录已建（若未建，本 skill Step 0 建）

## 执行流程

按当前进度 read 对应参考，逐步推进：

| 步骤 | 做什么 | read 参考 |
|------|--------|----------|
| 0. 建 topic 基建 | 建 `{topic}/` 目录 + decisions.md + _progress.md | `../full-clarity/references/decisions-template.md` + `_progress-template.md` |
| 1. 统一起草初稿 | 主 agent 读代码+文档，opinionated 起草 requirements.md + system-architecture.md | `../full-clarity/references/deliverable-template.md` + `../full-architecture/references/{deliverable-template\|architecture-perspectives}.md` |
| 2. 批量收集决策点 | draft 过程积累「代码答不了」的决策，分类（D-不可逆/D-可逆/K） | `../mid-shared/references/batch-ask.md`（B1+B2 阶段） |
| 3. 批量提问 | D-不可逆 + K 打包，一次 ask_user（4~8 个，附推荐+理由） | `../mid-shared/references/batch-ask.md`（B3 阶段） |
| 4. 纳入 + 机器检查 | 答案落 decisions.md + 更新初稿 + 跑 check_clarity + check_architecture | `../full-clarity/scripts/check_clarity.py` + `../full-architecture/scripts/check_architecture.py` |
| 5. review-fix-loop | 派 4 路并行 reviewer → 汇总 must_fix → 修复 → 收敛（MAX=2 轮） | `../mid-shared/references/review-fix-loop.md` + 本 SKILL「维度审查分配」节 |
| 6. 二次 ask | loop 残留 D-不可逆打包二次 ask_user | `../mid-shared/references/batch-ask.md`（二次 ask 节） |
| 7. 定稿 + 渲染 | 定稿两份 .md + 派 fresh subagent 加载 coding-visualizer 渲染 2 个 HTML | `coding-visualizer` skill |

> [铁律] 步骤 1 不做 issue 拆分 / NFR / 代码架构。架构决策落到 `system-architecture.md` 为止，向下只给约束（grep 规则、Port 清单、不变式），不给实现。

Announce at start: "我正在使用 mid-plan skill 来高效产出需求 + 架构设计（L2 标准档）。"

## Step 0：建 topic 基建

mid-plan 是 mid 工作流首阶段，负责建 topic 级基建：

1. **建 topic 目录**：`.xyz-harness/{yyyy-MM-dd}-{topic-slug}/`
2. **建 decisions.md**（空骨架，直接 copy）：
   ```bash
   cp ../full-clarity/references/decisions-template.md {topic_dir}/decisions.md
   ```
   decisions.md 是本 topic 的 append-only 决策账本，mid 全程沿用 design 的机制（见 `../full-shared/references/loop-skeleton.md` Step 1.2）。
3. **建 _progress.md**（含 complexity_tier）：
   ```bash
   cp ../full-clarity/references/_progress-template.md {topic_dir}/_progress.md
   ```
   写入 `complexity_tier: L2`（范围守门判定结果）。

> **状态追踪说明：** mid 不接 design_status 的 7 阶段状态机（阶段语义对不上——mid 合并成 2 阶段）。用 `_progress.md` + todo 追踪。`_progress.md` 记跨会话交接（已完成阶段表 + 不可推翻决策引用 decisions.md）。

## Step 1：主 agent 统一起草初稿

**先读已确认决策（建工作上下文）：** mid-plan 是首阶段（decisions.md 刚建为空），直接进起草。读 `CONTEXT.md`（统一语言）+ 项目根 `ARCHITECTURE.md`（当前架构态，coding-init 建的骨架或已有文档）+ 项目源码。

**起草顺序（先需求后架构，但同一 Step）：**

### 1a. requirements.md（业务目标，不碰实现）

读 `../full-clarity/references/deliverable-template.md` 用其骨架。沿业务目标树起草：
```
业务目标（根）
├── G1: {目标} — 成功标准（可衡量）
│   ├── Actor: 谁来达成？ → 用例 → 主流程/替代/异常 + 前置/后置
│   ├── 数据: 产生/消费什么？
│   └── 界面: 在哪完成？
└── 约束 & 不做
```

**起草纪律（agent opinionated，不等问题）：**
- 基于**代码扫描 + 业务输入**直接产出初稿，遇到「代码答不了」的决策点记到 batch 队列（Step 2），不立即问
- 能 grep 代码答的（现有 Actor、现有用例、现有数据表），dispatch 只读 subagent 查，不问用户
- 业务用例非技术用例；区分「目标」和「方案」
- 同步写入项目根 `CONTEXT.md`（统一语言/领域术语）

> **[铁律] requirements.md 不考虑系统实现。** 不做技术栈选型/架构设计/API 定义/数据库建模。技术约束（「必须用 Postgres」）只记录到 Constraints 不展开。与 full-clarity 同源铁律。

### 1b. system-architecture.md（系统设计）

读 `../full-architecture/references/deliverable-template.md` + `architecture-perspectives.md`（边界划分原则、复杂度归位、证伪三连）用其骨架。沿架构决策树起草：
```
系统设计立场（根：核心计算是什么？）
├── 分层决策 → DDD 4 层 or 三层？（看核心计算是业务规则还是技术编排）
├── 领域建模 → 有状态机？aggregate/实体 or DTO？
│   └── Status 枚举 + Reason 字段（正交）+ 不变式守卫
├── 模块拆分 → 按变化轴（问「会因为什么改」，答 2+ 原因=该拆）
└── 外部依赖 → 4 类分类决定 port（In-process/Local-sub/Remote-owned/True-external）
```

**统摄 metric：复杂度归位** — 所有决策回问「复杂度是否归位到正确的地方？」。边界划分原则（三层代价台阶）、Seam 纪律（一个 adapter=假设 seam，两个=真 seam）、Port≠interface（结构边界 vs 控制边界反向）——详见 `architecture-perspectives.md`。

**[铁律] system-architecture.md 不进入代码级细节。** 不做代码级 API 签名/时序图/DB schema（属 full-code-arch，mid-detail-plan 复用），不做 issue 拆分（mid-detail-plan），不做性能/成本量化（mid-detail-plan 的 nfr）。

## Step 2：批量收集决策点

读 `../mid-shared/references/batch-ask.md`（B1 收集 + B2 分类阶段）。

draft 过程中积累的决策点，按四类分流：

| 类型 | 本阶段典型 | 处理 |
|---|---|---|
| **D-不可逆** | 分层（DDD4 vs 三层）、核心计算复杂度预期、Seam/port 真伪、领域模型边界（aggregate vs DTO）、状态机结构 | 进 batch 提问（标红） |
| **D-可逆** | 命名、模块拆分细节、Context Map 画法、不变式推导 | agent 自决，定稿暴露 |
| **K** | 归档保留期合规、外部契约稳定性、业务规则细节 | 进 batch 提问 |
| **可代码自决** | 现有依赖 4 类分类、现有状态枚举、现有模块边界 | agent 直接产出 |

## Step 3：批量提问（一次 ask_user）

读 `../mid-shared/references/batch-ask.md`（B3 批量提问阶段）。

**本阶段必问决策点清单（D-不可逆 + K，合并 clarity + architecture）：**

1. **核心计算的复杂度预期** — "核心是业务规则编排（→DDD4层）还是技术流程编排（→三层）？未来会长出复杂规则引擎吗？"【D-不可逆】
2. **业务目标 + 成功标准** — 可衡量（「X 达到 Y 指标」非「做好 X」）。目标 vs 方案要分清。【D-不可逆】
3. **Actor 清单（含隐含）** — 审核人/管理员等隐含 Actor 是否纳入。【K】
4. **状态机结构 + 严格度** — 有哪些状态转换？显式转换表（紧）还是只守终态（松）？【D-不可逆 + D】
5. **Seam/port 真伪边界** — 哪些依赖值得做 port（可替换性 vs 复杂度成本）？假设 seam 还是真 seam？【D-不可逆】
6. **领域模型边界争议** — aggregate vs DTO、有状态机 vs 无状态。【D-不可逆】
7. **跨系统依赖契约** — 外部系统功能依赖 + 同步/异步 + 自有可控 vs 第三方不可控。【K】
8. **搭便车改造清单（候选）** — business-goal→system-goal 转换时发现的「趁机可做的重构」，逐个问本轮是否做（候选意向，mid-detail-plan code-arch 骨架验证后最终确认）。【D】

> **决策点细节**（提问话术、方案对比、推荐理由的展开）参考 `../full-clarity/SKILL.md` 和 `../full-architecture/SKILL.md` 的「Step 1 必问决策点」节——mid 不重复内容，只做编排整合。

按 batch-ask B3 的 5 条纪律批量提问（一次 4~8 个，每问附推荐+理由，D-不可逆标红，附方案对比，分类排序）。**强依赖链的决策拆出来单问**（见 batch-ask「何时仍走单问」）。

## Step 4：纳入 + 机器检查

1. **即时 append decisions.md**——每个 D 类决策按 `../full-shared/references/loop-skeleton.md` Step 1.2 schema append（id/decision/rationale/classification/confirmed_by:ask_user/stage:mid-plan/source/status:confirmed）。
2. **更新初稿**——把用户答案纳入 requirements.md + system-architecture.md 对应章节。
3. **机器检查自跑**（零成本前置门）：
   ```bash
   python3 ../full-clarity/scripts/check_clarity.py {topic_dir}
   python3 ../full-architecture/scripts/check_architecture.py {topic_dir}
   ```
   exit 1 → 当场修低级硬伤（占位符/缺章节/每 UC 缺 AC/系统实现越界/frontmatter verdict 缺/分层缺失），重跑直到 exit 0。

## Step 5：review-fix-loop（4 路并行 reviewer）

读 `../mid-shared/references/review-fix-loop.md`（完整 loop 协议）+ 本节维度分配。

### 维度审查分配（4 路并行，wait:false）

| 路 | 认知帧 | 读什么 | 复用 reference |
|---|---|---|---|
| **需求完整性** | 对齐/补齐（同向） | requirements.md + 项目源码 | `../full-clarity/SKILL.md` 的 5 视角（目标可追溯/角色用例完整/数据流/界面场景/跨系统） |
| **架构合理性 + 边界** | 对齐/补齐（同向） | system-architecture.md + requirements.md + 源码 | `../full-architecture/references/architecture-perspectives.md`（边界划分/复杂度归位/证伪三连） |
| **禁读重建** | 反向（他证） | **禁读两份初稿**，只读 CONTEXT.md + 项目源码，独立重建 Actor/用例/数据流 + 模型/边界/状态机 → diff | 范式抄 `../full-clarity/SKILL.md` 重建器 + `../full-issues/references/fog-of-war.md` 角色 A |
| **红队 · 反过度设计** | 反向（删/质疑） | 两份初稿 + 上游 | `../full-shared/references/review-agent.md` 红队节（必要性与比例性，deletion test） |

**派发：** 按 review-fix-loop L2 的派发模板，4 路 `wait:false` 同消息派发，context 注入 decisions.md。
**汇总：** 按 L4 汇总去重（HIGH-CONFIDENCE / CROSS-VALIDATED / NEEDS-VERIFY）。
**收敛：** 按 L5/L6（无 must_fix → CONVERGED；有 → 修复回 L1，round ≥ MAX=2 → 进 Step 6）。

> **[CROSS-VALIDATED 冲突处理]** 红队说「某 port 该删」、对齐说「该 port 是上游对齐必需」——涉及 D-不可逆（分层/边界）→ 必须 ask_user，不能 agent 自判。与 design Step 6 同源。

## Step 6：二次 ask（loop 残留 D-不可逆）

读 `../mid-shared/references/batch-ask.md`（二次 ask 节）。

loop 收敛后（CONVERGED 或 round ≥ MAX），残留未解决的 **D-不可逆** must_fix 打包二次 ask_user（通常 1~3 个）。用户拍板后 append decisions.md（推翻首次确认的标 `[REVISIT of D-NNN]`）。

## Step 7：定稿 + 渲染 HTML

1. **主 agent 定稿** requirements.md + system-architecture.md：
   - 已解决 D 类 gap 两处同步写（各 .md 决策记录章节写完整推理 + decisions.md 写权威索引，见 `../full-shared/references/loop-skeleton.md` Step 5a）
   - `[UNRESOLVED]` gap 标 `[AMBIGUOUS]` 显式列出
   - frontmatter 含 `verdict: pass`
2. **派 fresh subagent 渲染 HTML**（2 个，可并行）：
   - 加载 `coding-visualizer` skill（本包内置，无需安装）
   - requirements.md → hero=用例图（Actor×用例×边界）
   - system-architecture.md → hero=分层架构图 + 状态机图
   - 按 `../full-shared/references/loop-skeleton.md` Step 5b 的渲染 task prompt 模板派发

**交接（定稿后）：**

```
✅ mid-plan 已完成。
   产出：requirements.md (+.html) + system-architecture.md (+.html)
   决策账本：decisions.md（{N} 条 confirmed）
   复杂度档位：L2
下一步：mid-detail-plan — issues + nfr + code-arch + execution（实施 4 合 1）
调用：/skill:mid-detail-plan
是否现在进入？
```

## Self-Check

**[MANDATORY] 全部满足才算 mid-plan 完成。**

范围与基建：
- [ ] 范围守门已判定 L2（非 L1/L3），complexity_tier 写入 _progress.md
- [ ] `{topic}/decisions.md` + `_progress.md` 已建
- [ ] requirements.md 不含系统实现（无 API/DB schema/技术栈选型展开）
- [ ] system-architecture.md 不含代码级细节（无 API 签名/时序图/DB schema）

batch-ask：
- [ ] 决策点已分类（D-不可逆/D-可逆/K/可代码自决），D-可逆未进提问（agent 自决定稿暴露）
- [ ] 批量提问附推荐+理由，D-不可逆标红+方案对比
- [ ] 强依赖链决策已拆出单问
- [ ] 用户答案即时 append decisions.md（confirmed_by:ask_user）

机器检查 + loop：
- [ ] check_clarity.py + check_architecture.py 均 exit 0
- [ ] review-fix-loop 4 路并行派发（wait:false），禁读重建路禁读了初稿
- [ ] 汇总 must_fix 已去重 + 交叉验证标注，CROSS-VALIDATED 的 D-不可逆已 ask_user
- [ ] loop 收敛（CONVERGED 或 round=MAX 残留已二次 ask）

定稿：
- [ ] 两份 .md frontmatter 含 `verdict: pass`
- [ ] decisions.md 每条溯源指向真实章节（无 §TBD 残留）
- [ ] 2 个 HTML 已渲染并 open，hero 图就位（用例图 / 分层架构图+状态机图）

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
