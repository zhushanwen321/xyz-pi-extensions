---
name: mid-detail-plan
description: >-
  Use when the user says "mid 详细计划", "中等功能实施设计", "issues+nfr+架构+计划一起做",
  "批量设计实施", or has finished mid-plan (requirements.md + system-architecture.md)
  and needs issues.md + non-functional-design.md + code-architecture.md + execution-plan.md
  produced via ctx-build → drafters (parallel) → review-fix-loop → consistency-check.
  纯设计 skill：产出实施规格 4 件套（含可编译骨架 code-skeleton），不写实现代码。
  Content aligns with full-issues + full-nfr + full-code-arch + full-execution-plan;
  orchestration aligns with lite (parallel drafters + merged review loop).
  Not for L3 heavy — use design-* workflow (each phase deep convergence).
  Not for requirements/architecture — that is mid-plan.
  Produces execution-plan.md as final deliverable; 交接执行阶段时需转为统一 plan.md 格式（见 Step 6 交接说明）。
---

# mid-detail-plan（实施 4 合 1，L2 标准档）

在 mid-plan 之后，一次性产出 `issues.md` + `non-functional-design.md` + `code-architecture.md`（+ code-skeleton）+ `execution-plan.md`。
**内容**对齐 full-issues + full-nfr + full-code-arch + full-execution-plan 全量；**编排**改为
ctx-build → 主 agent 锚 issues → 2 drafter 并行（nfr ‖ code-arch）→ 主 agent 收 execution → review-fix-loop → 一致性终检。

> **[铁律] 本 skill 产出 4 份 deliverable，但不写实现代码。** code-skeleton 是验证设计假设的**可编译骨架**（full-code-arch 的 Step 7），
> 不是实现 body——实现 body 属于后续 Wave 执行（走 `coding-execute` skill）。
>
> **✅ 执行衔接：mid 产出交接给 coding-execute。** coding-execute 的 `check_execute.py` 机器门同时支持两种格式——
> lite 的 plan.md（U*/E* 用例）与 mid/design 的 execution-plan.md（T{UC}.{N} 用例 + 测试验收清单）。mid 执行与 lite 共享
> 同一套 TDD + worktree 隔离 + test-runner 落盘 + 机器门链路。见下方 Step 6 交接说明。

## 依赖链（必须正视，决定并行度）

```
requirements/architecture（mid-plan 已完成）
        │
        ▼
    issues（根，需用户拍板 P0/P1）
        │
        ├──────────┬───────────┐
        ▼          ▼           ▼
       nfr      code-arch    （并行）
        │       (+skeleton)
        └────┬─────┘
             ▼
        execution（读 code-arch 时序图 + nfr 回灌表）
```

- **issues 是根**且最需用户拍板 P0/P1 → 主 agent 锚定（Step 1）
- **nfr ‖ code-arch 是唯一天然并行点** → 2 drafter 真并行（Step 2）
- **execution 必须等 code-arch**（Wave 依赖从时序图读）+ **nfr 回灌表**（测试验收清单来源 B）→ 主 agent 收尾（Step 3）

> 不能无脑「2 subagent 完成全部 4 份文档」——依赖链不允许。接受依赖链，吃满唯一的并行点。

## 前置

- **mid-plan 已完成**：`{topic}/requirements.md` + `system-architecture.md` + `decisions.md`（含 confirmed 决策）。未完成 → `/skill:mid-plan`
- **范围守门已过**：`_progress.md` 的 `complexity_tier: L2`

## 执行流程

| 步骤 | 做什么 | read 参考 |
|------|--------|----------|
| 0. context-builder | 派 fresh subagent 压缩 mid-plan 产出 → 阶段工作摘要注入主 agent | `../full-shared/references/context-builder.md` |
| 1. issues + batch-ask | 主 agent 产 issues.md → 批量 ask P0/P1 → 纳入 + 机器检查 | `../full-issues/references/{fog-of-war\|issue-template\|deliverable-template}.md` + `../mid-shared/references/batch-ask.md` |
| 2. 2 drafter 并行 | 派 Drafter-A（nfr）‖ Drafter-B（code-arch+skeleton），wait:false | `../full-nfr/references/{nfr-dimensions\|deliverable-template}.md` + `../full-code-arch/references/{deep-module-vocabulary\|sequence-template\|skeleton-spike\|deliverable-template}.md` |
| 3. execution + 回灌对齐 | 主 agent 产 execution-plan（读 code-arch 时序图）+ 补 code-arch 来源 B + 验证 nfr 指针 + 验收清单 + 机器检查全跑 | `../full-execution-plan/references/{vertical-slice\|wave-template\|deliverable-template}.md` |
| 4. review-fix-loop | 派 5~6 路并行 reviewer（跨 4 份文档）→ 汇总 → 收敛（MAX=2） | `../mid-shared/references/review-fix-loop.md` + 本 SKILL「维度审查分配」节 |
| 5. 一致性终检 | 派 1 fresh subagent 全文档一致性检查（合并 design 6b 反哺 + 6c 终检） | `../full-execution-plan/references/consistency-check.md` |
| 6. 定稿 + 渲染 | 残留 D-不可逆 ask + 定稿 4 份 .md + 派 fresh subagent 渲染 4 HTML | `coding-visualizer` skill |

Announce at start: "我正在使用 mid-detail-plan skill 来高效产出实施设计 4 件套（L2 标准档）。"

## Step 0：context-builder（压缩上游）

mid-detail-plan 上游较多（读 mid-plan 的 2 份 + decisions.md + 长期文档），派 **context-builder subagent**（fresh）：
- 读 `{topic}/decisions.md`（已确认决策）+ `requirements.md` + `system-architecture.md` + 相关长期文档（NFR.md/ADR/ARCHITECTURE.md）
- 输出**阶段工作摘要**注入主 agent context：
  - **不可推翻的决策清单**（decisions.md 里 status=confirmed 的 D-不可逆，带 ID）
  - **本阶段设计树入口**（从上游推导 issues/nfr/code-arch/execution 该遍历的节点）
  - **与上游的接口契约**（必须遵守的 grep 规则/Port/不变式）
  - **相关长期约束**

> **为何压缩传递：** 主 agent 直接裸读全部上游会 context 爆炸→compact→丢「用户在 mid-plan 确认过 X」。压缩成摘要注入，既轻量又让已确认决策从文件重新进入上下文。规范详见 `../full-shared/references/context-builder.md`。

派发模板按 context-builder.md 的 task prompt（fresh，context 注入 decisions.md）。

## Step 1：issues + batch-ask（主 agent 锚定）

### 1a. 主 agent 产 issues.md

读 `../full-issues/references/fog-of-war.md`（决策图构建 + 拆分维度 checklist）+ `issue-template.md`（方案对比格式）+ `deliverable-template.md`（含「上游覆盖核验」表）。

沿 issue 决策树起草：
```
Issue 决策图（根：从 system-architecture 的挑战推导）
├── P0 阻塞项（前沿，必须先做）→ 每 issue 方案 A/B/C → 取舍 → blocked_by
├── P1 核心项（同 P0 结构）
├── P2 重要项（迷雾，标注 ? 先不展开）
└── P3 延后项（后续迭代）
```

**生成候选 issue 先按 4 轴扫**（fog-of-war.md 拆分维度：状态§5/模块§7/边界§8/挑战§10 + 兜底）→ 再标 P 级。**P 级不是拆分维度，先用轴扫再标 P 级**。从 system-architecture.md 的 §5/§7/§8/§10 推导 issue。

### 1b. 批量 ask P0/P1（issues 最需用户拍板）

读 `../mid-shared/references/batch-ask.md`。

**本步骤必问决策点（D-不可逆 + K，agent 最易自作主张，务必逐条问）：**

1. **P0/P1 划线** — 每个候选阻塞项问："不做它，后续真的无法推进 / 目标真的无法达成吗？"【D】
2. **取舍原则的局部例外** — 全局默认"长期架构优先、较少考虑成本"，但每个 P0/P1 issue 要问例外。【D】
3. **DESIGN-IT-TWICE 的最终选定** — 触发并行 subagent 发散的根本性架构选择，最终选定必须 ask_user。【D-不可逆】
4. **迷雾展开判断** — "够不够清晰 / 还有没有没说的需求"必须问用户，不能 agent 自判收敛。【K/D】
5. **P3 延后项逐条确认** — 每个标 P3 的问是否同意延后 + 理由。【D】

按 batch-ask B3 批量提问（一次 4~8 个，每问附推荐+方案对比）。**P0/P1 划线是最高频被 agent 吞的决策**，重点标红。

### 1c. 纳入 + 机器检查

1. 即时 append decisions.md（stage:mid-detail-plan）
2. 更新 issues.md
3. 机器检查：`python3 ../full-issues/scripts/check_issues.py {topic_dir}`，exit 1 当场修（幽灵 #N、空 N/A、❌/待补残留、P0/P1 缺 ≥2 方案、P 级与 blocked_by 不一致）

## Step 2：2 drafter 并行（nfr ‖ code-arch，wait:false）

读 `../mid-shared/references/review-fix-loop.md` 的派发工程（wait:false 同消息多 start）。

**派发配置：** 2 个 drafter 同消息 `wait:false` 派发，各自独立产出主体 + 各自跑机器检查。完成后 notifier 唤醒主 agent。

> **并行前提：** nfr 和 code-arch 都读 issues.md（已定稿）+ architecture（已完成），无写冲突（产出不同文件）。唯一依赖：code-arch 的 test-matrix §6 来源 B（NFR 用例）依赖 nfr 回灌表——**Drafter-B 先写来源 A（功能用例），来源 B 留占位**，Step 3 主 agent 补。

### Drafter-A：non-functional-design.md（nfr）

```
subagent(action:'start', startParam:{
  agent: "general-purpose",
  wait: false,
  context: "<decisions.md 内容>",
  cwd: "<topic 对应项目目录，可写 .xyz-harness>",
  task: """
  你是独立 drafter（nfr），上下文与主 agent 隔离。产出 non-functional-design.md。

  read：
  - {topic}/issues.md（已定稿，每个 issue 的已决策方案）
  - {topic}/requirements.md + system-architecture.md（上游）
  - ../full-nfr/references/nfr-dimensions.md（7 维度模板）
  - ../full-nfr/references/deliverable-template.md（骨架）
  - 项目根 NFR.md（长期约束，若有）

  沿副作用分析树产出：每个 issue 的已决策方案 → 7 维度（安全/数据/性能/并发/稳定性/兼容性/可观测性）副作用分析 + 缓解。
  不适用维度写理由（防偷懒跳过）。不确定性高的副作用（并发死锁/缓存命中率）标记为需 code-arch 骨架验证。
  **「缓解项回灌登记表」**：每条缓解标「验收方式」（代码测试/性能混沌/人工/不可验），其中「验收方式=代码测试」的会被 code-arch test-matrix 来源 B 引用。

  产出后自跑：python3 ../full-nfr/scripts/check_nfr.py {topic_dir}，exit 1 当场修。
  写到 {topic}/non-functional-design.md。不写其他文件。
  """
})
```

### Drafter-B：code-architecture.md + code-skeleton

```
subagent(action:'start', startParam:{
  agent: "general-purpose",
  wait: false,
  context: "<decisions.md 内容>",
  cwd: "<topic 对应项目目录>",
  task: """
  你是独立 drafter（code-arch），上下文与主 agent 隔离。产出 code-architecture.md + code-skeleton/（可编译骨架）。

  read：
  - {topic}/issues.md + system-architecture.md（上游）
  - {topic}/requirements.md（用例，推导 API 入口）
  - ../full-code-arch/references/{deep-module-vocabulary|sequence-template|skeleton-spike|deliverable-template}.md
  - 项目根 ARCHITECTURE.md + TEST-STRATEGY.md（若有，测试手册复用）

  沿代码契约树产出：工程目录 + API 契约（签名表，标注接线层级）+ 功能时序图（类方法级，含异常路径）+ 包依赖图。
  **test-matrix §6**：来源 0（项目已有测试，先读复用）+ 来源 A（功能用例，从时序图 alt/else 枚举异常用例，**每条标测试层 mock/real**；并发强制 real，e2e 拆 mock+real）。
  **来源 B（NFR 用例）留占位** {PLACEHOLDER_NFR_SOURCE_B}——nfr 还在并行产出，主 agent Step 3 会从 nfr 回灌表补。
  **Step 7 骨架验证**：按 skeleton-spike.md 产 code-skeleton/（可编译骨架，验证签名/调用链/依赖方向，非实现 body）。
  签名设计标注接线层级（模块内直调/跨模块 port/adapter 真引 SDK）。

  产出后自跑：python3 ../full-code-arch/scripts/check_code_arch.py {topic_dir}（骨架已生成；未生成用 --no-skeleton），exit 1 当场修。
  写到 {topic}/code-architecture.md + {topic}/code-skeleton/。不写其他文件。
  """
})
```

### 2c. drafter 返回处理

- **两路都 DONE**：进 Step 3
- **某路 NEEDS_CONTEXT**：补 context 重派该路
- **某路 BLOCKED**：评估（上下文问题补 / 能力不足换强模型 / 任务太大拆 / 上游有误上报用户）。**不原样重试**

## Step 3：execution + 回灌对齐（主 agent 收尾）

### 3a. 回灌对齐（并行产物对齐）

Drafter-A（nfr）和 Drafter-B（code-arch）并行产出后，主 agent 做一次**回灌对齐**（处理并行遗留的依赖）：

1. **补 code-arch test-matrix 来源 B**——从 nfr 回灌表筛 `验收方式=代码测试` 的缓解项，为每条生成 ≥1 测试用例，补入 code-architecture.md §6（替换 `{PLACEHOLDER_NFR_SOURCE_B}` 占位）
2. **验证 nfr 的 ⑤指针**——nfr 回灌表里「去 ⑤某用例」的指针，核对 code-arch §6 真有对应用例（PHANTOM/MISMATCH 标 gap）
3. **nfr 的 ④性能混沌类缓解项**——筛 `验收方式=性能混沌` 的，标记给 execution Step 3b 编排为独立 perf/chaos Wave

### 3b. 主 agent 产 execution-plan.md

读 `../full-execution-plan/references/{vertical-slice|wave-template|deliverable-template}.md` + code-architecture.md §4 时序图。

沿 Wave 编排树产出：
```
Wave 编排（根：从时序图推导）
├── Wave 0: Prefactor → 是否有让后续更易的前置重构？
├── Wave 1-N: 垂直切片（P0/P1）→ blocked_by 从时序图读
├── Wave N+1: 验收 Wave → blocked_by 所有功能 Wave（闭环闸门）
└── P3 延后项 → 标注「后续迭代」+ 理由
```

- 从 code-architecture.md §4 时序图推导 Wave 依赖（功能 B 调用 A → Wave(B) blocked_by Wave(A)）
- **编排末端强制加验收 Wave**（blocked_by 所有功能 Wave），读测试验收清单全量→跑测试→全 PASS 才算实现完成
- **[MANDATORY] 定稿含「测试验收清单」**——code-arch §6 test-matrix 全量用例（来源 A + B）按归属 Wave + **测试层（mock/real）**列全，供下游 coding-execute 分层验收（mock 组 / real 组；coding-execute 的 check_execute.py 自动识别 mid 的 T{UC}.{N} 用例 + 测试执行层）
- **性能混沌类缓解项**编排为独立 perf/chaos Wave 或 pre-prod gate（不混入功能 Wave）
- **测试验收清单可脚本生成草稿**：`python3 ../full-execution-plan/scripts/check_execution.py {topic_dir} --generate-manifest`

### 3c. 机器检查全跑

```bash
python3 ../full-nfr/scripts/check_nfr.py {topic_dir}            # 复跑确认 drafter 已修
python3 ../full-code-arch/scripts/check_code_arch.py {topic_dir}
python3 ../full-execution-plan/scripts/check_execution.py {topic_dir} --no-consistency-final
```
（`--no-consistency-final` 跳过 6c 终检——该文件 Step 5 才产出）。exit 1 当场修。

## Step 4：review-fix-loop（5~6 路跨文档维度审查）

读 `../mid-shared/references/review-fix-loop.md`（完整 loop 协议）+ 本节维度分配。

### 维度审查分配（5~6 路并行，wait:false，跨 4 份文档）

| 路 | 认知帧 | 读什么 | 复用 reference |
|---|---|---|---|
| **issues 覆盖重建** | 反向（他证） | **禁读 issues.md**，从 system-architecture 独立重建可拆元素（4 轴）→ diff（MISSING/PHANTOM/MISMATCH） | `../full-issues/references/fog-of-war.md` 角色 A（覆盖重建者） |
| **nfr 副作用 + 回灌指针** | 对齐（正向） | non-functional-design.md + issues.md + architecture | `../full-nfr/references/nfr-dimensions.md`（7 维覆盖 + 回灌指针核对） |
| **code 契约 + test-matrix 禁读重建** | 反向（他证） | code-architecture.md + skeleton + 上游；**禁读 §6 test-matrix**，从时序图 alt/else + nfr 回灌表独立重建测试用例 → diff | `../full-code-arch/SKILL.md` 5 视角 + 重建帧 |
| **Wave 依赖 + 测试闭环** | 对齐（正向） | execution-plan.md + code-architecture §4 时序图 + test-matrix | `../full-execution-plan/SKILL.md` 组 A（编排结构）+ 组 B（测试闭环） |
| **红队 · 反过度编排** | 反向（删/质疑） | 全部 4 份 + 骨架 | `../full-shared/references/review-agent.md` 红队节（port/seam/分层/Wave 是否过度，deletion test） |

> **第 6 路（可选，状态复杂时）：异常猎手**——触发条件：状态复杂度信号≥中（4+ 状态/单状态机）或跨边界数≥中（2+ 外部系统）。
> 从 ② §5 状态转换路径 / §8 跨进程边界扫异常路径（失败帧）。范式抄 `../full-issues/references/fog-of-war.md` 角色 B。

**派发：** 5~6 路 `wait:false` 同消息派发，context 注入 decisions.md。
**汇总：** 按 review-fix-loop L4 汇总去重。
**收敛：** 按 L5/L6（无 must_fix → CONVERGED；有 → 修复回 L1，round ≥ MAX=2 → 进 Step 5）。

> **跨文档 reviewer 的反哺**：reviewer 发现「code-arch 某决策与 architecture 矛盾」「nfr 某缓解项在 code-arch 走不通」等跨文档矛盾，标 `[BACKFED from mid-detail-plan]` 进 must_fix。Step 5 终检会复扫。

## Step 5：全文档一致性终检（1 fresh subagent）

loop 收敛后，派 **1 个 fresh subagent** 做全文档一致性检查——合并 design 的 Step 6b（反哺）+ Step 6c（全文档一致性终检）。

读 `../full-execution-plan/references/consistency-check.md`（终检 spec）。

**派发配置：** Agent=general-purpose，Context=fresh，读取=全部 6 份 deliverable + decisions.md + CONTEXT.md，产出=`{topic}/changes/consistency-final.md`。

**检查项：**
1. **跨文档矛盾**——逐对核对（requirements↔architecture、architecture↔issues、issues↔nfr、issues↔code-arch、nfr↔code-arch、code-arch↔execution）：
   - aggregate 边界 / 状态机 / 模块划分是否跨文档一致
   - nfr 缓解项落地方式与 code-arch 签名表是否相符
   - execution Wave 依赖与 code-arch 时序图是否一致
2. **decisions.md 一致性**——每条 confirmed 决策在对应 .md 有真实章节（source 溯源不断），无 §TBD 残留
3. **测试闭环**——execution 验收清单用例 ID 集合 = code-arch §6 test-matrix 全量（来源 A + B）
4. **反哺处理**——loop 中标的 `[BACKFED]` 是否已修订上游 .md

**结果：** CONSISTENT → 进 Step 6；INCONSISTENT → 矛盾当 must_fix 回 Step 3 修复（涉及 D-不可逆须 ask_user）。

> **为何合并 6b+6c：** design 每阶段各做一次 6b（反哺）+ execution 做一次 6c（终检）= 7 次。mid 把 4 份文档的反哺 + 终检合并成 1 次全文档扫描——因为 4 份文档是同一 step 产出的（时序紧凑），跨文档矛盾集中暴露，一次终检兜底比逐文档反哺高效。

## Step 6：定稿 + 渲染 HTML

1. **二次 ask**（残留 D-不可逆）：loop + 终检后残留的 D-不可逆 must_fix，按 batch-ask 二次 ask 协议打包提问。
2. **主 agent 定稿** 4 份 .md（frontmatter `verdict: pass`，decisions.md 溯源核对）。
3. **派 fresh subagent 渲染 HTML**（4 个，wait:false 并行，加载 coding-visualizer）：
   - issues.md → hero=决策 DAG 图（节点按 P 级着色）
   - non-functional-design.md → hero=风险矩阵热力图（issue×7 维度）
   - code-architecture.md → hero=包依赖图 + 核心时序图
   - execution-plan.md → hero=Wave 依赖 DAG 图（并行组标注）

**交接（定稿后）：**

```
✅ mid-detail-plan 已完成。实施设计 4 件套就绪。
   产出：issues.md + non-functional-design.md + code-architecture.md (+skeleton) + execution-plan.md（各 +.html）
   一致性终检：changes/consistency-final.md（verdict: CONSISTENT）
   决策账本：decisions.md（累计 {N} 条 confirmed）
下一步：执行阶段
   当前产出 execution-plan.md（design 格式，含 Wave DAG + 时序图 + 测试验收清单）
   mid 执行走 coding-execute skill（其 check_execute.py 机器门支持 mid 的测试验收清单格式，T{UC}.{N} 用例 + unit/integration/e2e 测试执行层）
   下一步：goal_control(action='create', objective='Execute: {topic}/execution-plan.md') → /skill:coding-execute
   执行后去向：/skill:coding-retrospect（复盘执行过程）→ /skill:coding-closeout（沉淀设计结论进长期文档 ARCHITECTURE/NFR/ADR）
是否现在开始执行？
```

## Self-Check

**[MANDATORY] 全部满足才算 mid-detail-plan 完成。**

上游 + 基建：
- [ ] context-builder 已派发，阶段工作摘要已注入主 agent（不可推翻决策清单可见）
- [ ] mid-plan 产出的 confirmed 决策未被当 gap 重报（decisions.md 纪律）

issues：
- [ ] issues.md 按 4 轴扫再标 P 级（非先标 P 再凑）
- [ ] P0/P1 划线 / DESIGN-IT-TWICE 选定 / P3 延后 已批量 ask_user（非 agent 自决）
- [ ] check_issues.py exit 0

drafter 并行：
- [ ] 2 drafter wait:false 同消息并行派发（未串行）
- [ ] nfr 7 维度全覆盖（不适用有理由）+ 回灌登记表完整
- [ ] code-arch 含 test-matrix（来源 0+A，**来源 A 每条标测试层 mock/real**，来源 B 占位）+ code-skeleton（可编译骨架）
- [ ] check_nfr.py + check_code_arch.py exit 0

execution + 对齐：
- [ ] 回灌对齐已做（来源 B 已补 + nfr ⑤指针已验证 + 性能混沌类已标记）
- [ ] execution-plan 从 code-arch 时序图推导 Wave 依赖
- [ ] 末尾验收 Wave 存在（blocked_by 所有功能 Wave）+ 测试验收清单全量（来源 A+B，**按测试层 mock/real 可分组**）
- [ ] check_execution.py exit 0

loop + 终检：
- [ ] review-fix-loop 5~6 路并行，禁读重建路禁读了对应 deliverable
- [ ] 汇总 must_fix 去重 + 交叉验证标注，跨文档矛盾已标 [BACKFED]
- [ ] loop 收敛（CONVERGED 或 round=MAX 残留已二次 ask）
- [ ] consistency-final.md verdict: CONSISTENT

定稿：
- [ ] 4 份 .md frontmatter 含 `verdict: pass`
- [ ] decisions.md 每条溯源指向真实章节
- [ ] 4 个 HTML 已渲染并 open，hero 图就位

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [铁律] | 阶段核心不可逾越的边界 | 不允许削弱或移除 |
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
