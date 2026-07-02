# 设计工作流

> 从业务需求到执行计划的完整设计流程。可选初始化（Step 0）+ 6 个设计 skill（Steps 1-6）按顺序串联，每个独立可调用。
> 编码实施后由 **coding-closeout** 收尾——把稳定结论沉淀进长期文档（ARCHITECTURE/PRODUCT/NFR/ADR/TEST-STRATEGY），闭合设计→实施→沉淀管道。
> **不修改现有 coding-workflow 的 5-phase gate 流程**——这是独立的「设计前序」工作流，
> 在编码实现之前完成设计决策。

## 流程总览

```
【设计阶段 · Steps 0-6】
⓪初始化 → ①澄清需求 → ②系统设计 → ③Issue拆分 → ④非功能设计 → ⑤代码架构 → ⑥执行计划
 扫描+补齐  业务目标    系统目标    细节问题     副作用分析    代码链路     Wave编排
            不碰实现    架构建模    P0-P3+方案   7维度兜底    类方法时序   串并行DAG
                                                                    │
                                                            ⑤Step7 骨架验证（可编译骨架）
                                                            ⑥Step6c 一致性终检（CONSISTENT）
                                                                    ↓ 交接编码
【实施阶段】编码实现 — 测试验收清单全绿 = 完成
                                                                    ↓ 全绿后
【收尾阶段】⓼ coding-closeout — 沉淀进长期文档（ARCHITECTURE/PRODUCT/NFR/ADR/TEST-STRATEGY）
                                                                    ↓
                                                          下次 /coding-init 回读（闭环）
```

每一步内部走 **6+步循环**（交互→追踪→gap分流→收敛→定稿+HTML→独立审查6维→反哺检查），**审查 APPROVED 且反哺通过后**才提示进入下一步。⑥额外有 **Step 6c 全文档一致性终检**（编码前总闸门）。用户确认才跳转。用户可随时手动跳过或回退。

```
每一步内部：
  Step1 Grilling 提问+初稿 → Step2 独立追踪(gap) → Step3 F/K/D 分流
  → Step4 收敛复核 → Step5 定稿.md + 渲染.html → Step6 独立审查6维(含红队)(APPROVED?)
                                                        │
                                            ┌──── CHANGES_REQUESTED → 回 Step3
                                            ↓
                                       ✅ 审查通过 → Step6b 反哺检查(回扫上游矛盾→修订上游.md)
                                                        │
                                            ┌──── 有矛盾(D-不可逆)→ ask_user 确认
                                            ↓
                                       ✅ 反哺通过 → 提示「进入下一步？」

  仅⑥额外：Step6c 全文档一致性终检(①-⑥总闸门, CONSISTENT 才交接编码)
```

## skill 速查（8 个）

| 步骤 | Skill | 触发命令 | 产出文件（.md + .html） | 一句话目标 | 可跳过当 |
|------|-------|---------|------------------------|-----------|---------|
| ⓪ | coding-init | `/coding-init` | —（产出 AGENTS/CONTEXT/ARCHITECTURE） | 扫描项目文档基建，补齐缺失骨架，AGENTS.md 归一化 | 项目已有健全文档 |
| ① | full-clarity | `/full-clarity` | `requirements` | 明确业务目标→路线→用例/数据流/UI-UX，**不考虑系统实现** | 纯技术重构无业务变更 |
| ② | full-architecture | `/full-architecture` | `system-architecture` | 业务目标→系统目标，统一语言/架构/模块/边界/领域模型/状态机 | 已有成熟的 system-design.md |
| ③ | full-issues | `/full-issues` | `issues` | 系统设计→具体问题，P0-P3 优先级 + 方案对比取舍 | 系统设计已足够细化到代码层 |
| ④ | full-nfr | `/full-nfr` | `non-functional-design` | issue 解决方案的副作用分析 + 缓解（安全/性能/并发/稳定性/兼容性/可观测性） | 纯功能性小改动无 NFR 风险 |
| ⑤ | full-code-arch | `/full-code-arch` | `code-architecture` + `code-skeleton/` | 工程目录/契约/包管理/API入口→最底层 类方法时序图 + **Step7 可编译骨架验证** | 已有详细的 interface 契约 + 时序 + 骨架验证 |
| ⑥ | full-execution-plan | `/full-execution-plan` | `execution-plan` | Wave 拆分（从骨架叶子作用域推导），依赖 DAG，串并行标注 + **Step6c 编码前一致性终检** | 单人直接实现无需编排 |
| ⓼ | coding-closeout | `/coding-closeout` | `ARCHIVED.md` + `closeout-report.md`（+ 沉淀进长期文档） | **编码全绿后**沉淀稳定结论进长期文档，归档 topic，闭合设计→实施→沉淀管道 | 原型/实验项目用完即弃 |

> 每步产出**两份**：`.md`（真相源）+ `.html`（可视化视图，浏览器双击即可打开）。

## 共享机制

所有 6 个 skill 共用一套验证有效的流程骨架：

- **Grilling 提问法** — 逐节点遍历设计树，每个问题附推荐答案；一次一个问题；能查代码就不问用户（移植自 grill-me/grilling）
- **交互与追踪分离** — 主 agent 做交互，独立 fresh-context subagent 做强制视角追踪
- **F/K/D gap 分类** — 事实(二次确认)/知识(直接问)/决策(方案对比)
- **独立收敛** — 连续追踪到无新 gap 才收敛，不靠主 agent 自判
- **定稿 + HTML 渲染** — 收敛后定稿 .md，并渲染自包含 .html（用本包内置的 **coding-visualizer** 技能，整合 Mermaid + drawio + 手画 HTML/CSS 三种引擎，Mermaid 图表直接渲染）
- **独立审查门（Review Gate，6 维含红队）** — 定稿后派 fresh-context 审查 subagent 从 6 维评审：内部一致性 / 上游对齐 / 可执行性 / 完整性 / 可视化质量 / **必要性与比例性（红队维度，反过度设计）**，APPROVED 才进反哺
- **上游反哺（Step 6b）** — 审查通过后，fresh subagent 回扫上游检测矛盾，反哺修订上游 .md（标注来源+原因），保证每阶段交接时文档一致。D-不可逆矛盾必须 ask_user
- **decisions.md 决策账本** — 跨阶段 append-only 决策索引（每条含 ID/决策/理由/classification/confirmed_by/溯源）。每阶段 Step 1.0 读已确认决策（不得重问），D 类决策拍板后即时 append；追踪/审查 subagent 注入为 context，对抗 compact 丢决策。详细 schema + 模板见 `loop-skeleton.md` Step 1.2 + `full-clarity/references/decisions-template.md`
- **context-builder subagent** — 重型阶段（L2/L3）Step 1.0 必派，读 decisions.md + 长期文档 + 上游 .md 产出「阶段工作摘要」注入主 agent（压缩传递，每阶段必派一次消除 compact 检测依赖）。规范见 `full-shared/references/context-builder.md`
- **复杂度三档降级（L1/L2/L3）** — ①clarity 按 6 信号判定 `complexity_tier` 写入 `_progress.md`，驱动全程降级（context-builder/追踪/重建帧/review/max-rounds）。简单需求 L1 走轻量路径（单 agent 串行），复杂走完整循环。4 个硬约束不降级（decisions.md/⑤test-matrix重建/审查/gate）。见 `loop-skeleton.md`「复杂度自评与降级档位」
- **_progress.md 跨会话交接** — design_status tool/CLI 是权威状态机，_progress.md 是其可读快照（含 complexity_tier + 阶段进度表 + 下阶段必读），换会话前写一次
- **代码骨架验证（⑤Step 7）** — ⑤设计落成可编译骨架代码，物理验证签名/调用链/依赖方向。移植 recursive-skeleton 的顶层骨架机制
- **全文档一致性终检（⑥Step 6c）** — 仅⑥，编码前对①-⑥全部 .md + 骨架代码做总闸门审计，CONSISTENT 才交接编码

详见 `skills/full-shared/references/loop-skeleton.md`（6+步操作速查，每阶段 read）、`loop-method.md`（Grilling 提问法等方法论，clarity 首次 read）。HTML 渲染用本包内置的 **coding-visualizer** 技能（无需安装，整合 Mermaid + drawio + 手画 HTML/CSS）。

## 审查门（Review Gate）的作用

每一步定稿后，**必须**经过独立审查 subagent 的 APPROVED 才能进入下一步。审查与追踪是两种不同的检查：

| | Step 2/4 追踪 | Step 6 审查(6维) |
|---|---|---|
| 问什么 | 信息完不完整？有没有 gap？ | 质量行不行？能不能用？是否过度设计？ |
| 视角 | 强制枚举 N 视角（找遗漏） | 全局质量 6 维（判好坏，含红队反过度） |
| 输出 | gap 列表（F/K/D） | verdict: APPROVED / CHANGES_REQUESTED |

**审查不通过 → 审查意见当 gap 回 Step 3 处理 → 重新定稿 → 再审。** 不通过不交接。

**审查通过后还有 Step 6b 反哺检查**——回扫上游检测矛盾并修订上游 .md。反哺通过才交接。
**⑥额外有 Step 6c 全文档一致性终检**——编码前总闸门，CONSISTENT 才交接编码。

这三层（追踪→审查→反哺→终检）形成完整防线：追踪防遗漏，审查防低质/过度，反哺防跨阶段矛盾积累，终检防编码前最后一公里的全链断裂。

## 与 coding-workflow 5-phase 的关系

```
[设计工作流]              [编码实施]                [收尾]
①~⑥ 设计  ──→  ⑥执行计划  ──→  Phase 1-5      ──→  ⓼ coding-closeout 沉淀
                              (spec→plan→dev→test→pr)     │
(本指南)   (gate 编排可选串联)  (测试全绿=完成)            ↓ 长期文档更新 + topic 归档 → 下次 /coding-init 回读
```

- 设计工作流的 6 个 skill **不接入**现有 gate 编排，是用户主动发起的设计工具
- 设计工作流的产出（requirements/system-architecture/issues/nfr/code-architecture/execution-plan）**可以作为现有 Phase 1-2 的输入**——执行计划⑥完成后，如需自动 TDD 编码，可启动现有 coding-workflow 的 Phase 流程
- 两条工作流可以独立使用，也可以串联

## 设计→编码交接契约（Hard Handoff）

**设计阶段完成的定义（Definition of Done: Design）= ⑥execution completed（design_status 状态机）+ `changes/consistency-final.md` verdict:CONSISTENT（⑥Step 6c 总闸门）。** 两者满足才允许交接编码；编码完成的定义见下表（测试验收清单全绿）。

设计阶段建得再严密，**实现端无人核对 = 设计闭环，但设计→实现开环**。这是“设计很全、实现还是漏”的典型断点。
⑥产出含**「测试验收清单」（Test Acceptance Manifest）**，把"设计闭环"延伸为"实现闭环"：

| 层 | 机制 | 强制力来源 |
|----|------|-----------|
| **交接物** | 测试验收清单 = ⑤test-matrix 全量（来源 A 功能 + 来源 B NFR）按归属 Wave 列全 | ⑥交付物（方式 A/B 都带） |
| **Wave 完成判定** | 每功能 Wave 的「覆盖的 test-matrix 用例 ID」全 PASS 才算完成 | ⑥Wave 配置（方式 B 内嵌） |
| **末尾验收 Wave** | blocked_by 所有功能 Wave，读清单全量→跑测试→全 PASS 才算实现完成 | ⑥DAG 末端（方式 A/B 都跑） |

**编码完成的定义（Definition of Done）= 测试验收清单全绿。** 末尾验收 Wave 未绿 = 实现未完成。

- **方式 A**（接入 coding-workflow）：Phase-test gate 以测试验收清单为验收基线（清单用例全 PASS 才过），而非仅"测试套件通过"。
- **方式 B**（手动）：每个功能 Wave 派 fresh subagent；末尾验收 Wave 最后跑，闭环。
- **偏离通道**：编码中发现某用例设计错误/不可行，走 `[DEVIATED]` 登记（原因 + 用户确认 + 判断是否回流⑤），不可静默跳过——单源真相，所有偏离可追溯。

> 这条契约与 P0-1（NFR 风险进 test-matrix）是同一条链的两端：
> `④NFR风险 →(P0-1)→ ⑤test-matrix 含NFR用例 →(P0-2)→ 测试验收清单全绿才完成`。
> 单修任一个都堵不住漏洞——必须两端协同。

## 产出目录约定

所有产出写入 `.xyz-harness/${yyyy-MM-dd}-${主题简短标题}/`（各 skill 的 LOCAL-OVERRIDE 块有详细说明）。不同主题使用不同子目录，禁止混放。

目录结构示例：

```
.xyz-harness/2026-06-24-order-system/
├── requirements.md          ← ① 真相源
├── requirements.html        ← ① 可视化
├── system-architecture.md   ← ②
├── system-architecture.html ← ②
├── issues.md / issues.html  ← ③
├── non-functional-design.md / .html  ← ④
├── code-architecture.md / .html      ← ⑤
├── code-skeleton/                     ← ⑤Step7 可编译骨架代码（⑥Wave 起点）
│   └── src/...
├── execution-plan.md / .html         ← ⑥
├── ARCHIVED.md                       ← ⓼ closeout 归档标记（沉淀去向清单）
├── closeout-report.md                ← ⓼ closeout 报告（unverified_count）
└── changes/
    ├── tracing-round-1.md   ← 各阶段追踪记录
    ├── tracing-round-2.md
    ├── review-clarity.md    ← 各阶段审查报告
    ├── review-architecture.md
    ├── backfeed-round-1.md  ← 各阶段反哺记录（Step 6b）
    ├── backfeed-round-2.md
    └── consistency-final.md ← ⑥一致性终检报告（Step 6c）
```

## 何时只用其中几步

- **纯业务需求**：①→②→③→⑥（跳过④⑤，系统设计直接到执行）
- **技术重构**：②→③→④→⑤→⑥（跳过①，无业务目标变更）
- **紧急修复**：③→⑥（跳过①②④⑤，直接问题到执行）
- **简单功能**：①→②→⑥（跳过③④⑤，系统设计足够指导执行）

每一步都独立可用，不必强制走完全部 6 步。

## mid-* 工作流（design 与 lite 之间的档位）

如果 full 的 6 阶段深度收敛**太慢**（ask_user 40~80 次串行 + subagent 30~48 次派发），可选用 **mid-* 工作流**——内容对齐 full 全量（6 份 deliverable + 机器检查 + 红队门），编排改为 lite 风格（draft → batch-ask → review-fix-loop）。

| 档位 | 适用 | ask_user | subagent | 阶段 |
|------|------|----------|----------|------|
| **full-***（本指南） | L3 重型（多系统/跨组织/状态机复杂） | 40~80 | 30~48 | 6+1 |
| **mid-***（更快） | L2 标准（多模块单系统/3~5 Wave） | 3~5 | ~20 | 2 |
| lite-*（最轻） | L1 小功能（无架构改动） | 1~3 | 5~10 | 1 |

mid-* 的核心取舍：用「正交认知帧 + 跨阶段合并」换 wall-clock。合并追踪+审查损失了 full 两道隔离的 bias 防护，靠禁读重建路 + 红队路反向帧对冲。**L3 场景仍应走 full（每阶段深度收敛不可省）**。

- `mid-plan`：需求 + 架构（draft → batch-ask → 4 路 review-fix-loop）
- `mid-detail-plan`：issues + nfr + code-arch + execution（ctx-build → 2 drafter 并行 → 5~6 路 loop → 一致性终检）
- `mid-shared`：review-fix-loop + batch-ask 协议（共享参考）

详见 `skills/mid-{plan,mid-detail-plan,shared}/SKILL.md`。
