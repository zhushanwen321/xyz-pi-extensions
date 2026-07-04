---
name: full-code-arch
description: >-
  Use when the user says "代码架构", "code architecture", "详细设计",
  "接口契约", "时序图", "工程目录", "API 设计", or has finished
  non-functional-design.md and needs concrete code-level architecture.
  Produces code-architecture.md + code-skeleton/ (可编译骨架代码). Step 5 of 6.
  Not for system-level architecture (Step 2) or issue decomposition (Step 3).
  This designs the code structure and contracts AND validates them via a
  compilable skeleton (Step 7) — it does not write the implementation bodies,
  which belong to the execution/coding phase.
---

## 核心目标

将设计结论转换为**具体代码架构**：工程目录规划、API 契约（签名表）、包模块管理、从 API 入口到最底层的**类方法时序图**。**并通过 Step 7 代码骨架验证，物理验证设计假设可编译、调用链可达。**

> **时序图是本阶段核心产出。** 因为代码已细化到类方法时序，Step 6 的 Wave 依赖关系能直接从时序图推导。
>
> **骨架验证（Step 7）是设计与编码之间唯一的物理验证点。** 签名/调用链/依赖方向在纸面看着对，
> 落成可编译代码才知道真不真——代价前置到这里，比到 ⑥第一个 Wave 才发现时序图作废便宜得多。

## 执行流程

按 `../full-shared/references/loop-skeleton.md`（共享参考目录）的 6 步循环执行。**（loop-method.md 的方法论仅 clarity 首次 read，本阶段无需 read。）**

**Step 1（交互+初稿）— Grilling 遍历代码契约树：**

> **[状态追踪]** 开始时调 `design_status start_phase code-arch` 标记阶段开始（会校验 nfr 已 completed）。
> **有 `design_status` tool 优先用 tool**：`design_status(action: start_phase, phase: code-arch)`；**无 tool（Claude Code/Cursor/shell）用 CLI**：`design-status start-phase code-arch`。CLI 完整用法见 loop-skeleton.md「CLI 完整用法」。
>
> **[按 loop-skeleton Step 1.0]** grilling 前先获取已确认决策：
>
> **[复杂度档位]** 先读 `_progress.md` 的 `complexity_tier`：**L1 档跳过 context-builder**（主 agent 直读 decisions.md + 必问决策点引用的上游章节）；L2/L3 派 context-builder。追踪/审查/重建帧的降级见 loop-skeleton「复杂度自评与降级档位·三档执行矩阵」。⑤是上游最多的阶段（读①②③④），必派 **context-builder subagent**（fresh）读 `{topic_dir}/decisions.md`（本 topic 已确认决策）+ 相关长期文档（NFR.md/ADR/ARCHITECTURE.md）+ 上游 .md，输出「阶段工作摘要」（不可推翻决策清单 + 设计树入口 + 接口契约）注入主 agent context。**grilling 不得重新确认已 confirmed 决策**；每个 D 类决策拍板后按 Step 1.2 即时 append decisions.md。

```
代码架构（根：工程目录 + 契约 + 时序）
├── 工程目录 → 从 system-architecture §7 模块划分推导（每目录=一变化轴）
├── API 契约 → 从 requirements 用例推导入口
│   └── 类.方法 → 签名(参数/返回/边界) → Deep Module 检验(deletion test)
├── 功能时序图 → 从 requirements 用例走端到端路径
│   └── 入口→底层调用链 + 异常路径(每边界条件一个 alt/else)
└── 包依赖图 → 循环依赖检测
```

遍历纪律：先定工程目录（根）——目录决定模块边界，方法签名和时序图在骨架内展开。
**签名设计时标注每个方法的接线层级**（模块内直调 / 跨模块 port / adapter 真引 SDK），供 Step 7 分层接线——
哪些方法该真接线下游、哪些是叶子（throw）、哪些 adapter 该真引 SDK，在签名表就标清。
用 `references/deep-module-vocabulary.md` 的 Module/Interface/Depth/Seam/Adapter 统一语言设计接口。
依赖按 4 类分类决定 port；接口满足可测性三原则（accept deps / return results / small surface）。
时序图按 `references/sequence-template.md`。初稿用 `references/deliverable-template.md`。

**[MANDATORY] test-matrix 是 ⑤的核心产出之一**（与工程目录/契约/时序图并列）。**三个来源，前 1 复用 + 后 2 推导，缺一不可：**

- **来源 0（项目已有测试，先读复用）** — Step 1 开头先扫项目是否已有测试手册/策略文档（根 `TEST-STRATEGY.md`、`docs/testing/`、`CLAUDE.md`/`AGENTS.md` 测试规范章节）。有则 read **本次改动涉及功能**的对应文档，抽取：已有用例 ID（避免重复设计同覆盖）、data-testid 清单（复用 selector 不重新发明）、调用链/fixture 位置、已知坑（mock 回显双匹配、收起态 v-if 时序、预填默认值等仅靠读组件源码无法发现的运行时行为）。来源 0 **不替代** A/B 推导（A/B 仍独立枚举防漏），但 A/B 产出后与来源 0 做去重 + 补充——已有用例直接引用标来源，新用例归 A/B。成熟项目的测试手册记录了历次事故教训，复用是设计期规避历史坑的最高 ROI 动作。
- **来源 A（功能用例）** — 沿 §4 时序图每个 alt/else 逐个枚举异常用例——AI 最易漏、bug 最多发处。**每条标测试层 mock/real**（mock=隔离外部依赖验逻辑，real=真实后端/数据验集成；并发强制 real，e2e 常拆 mock+real 两条），供 ⑥验收清单按层分组。
- **来源 B（NFR 用例）** — 从④NFR「缓解项回灌登记表」中 `验收方式=代码测试` 的每条风险生成 ≥1 用例。安全/性能/可观测/兼容风险常不是时序图异常分支，若不单列会在⑤被遗漏、最终无人测试——正是线上事故重灾区。
产出按 `references/deliverable-template.md` §6。

> **来源 0 vs Step 6 禁读重建帧不冲突**：来源 0 是 Step 1 主 agent **主动 read 项目测试手册**（外部已有资产，复用）；Step 6 重建帧禁读的是**自己写的 §6 test-matrix 初稿**（防同源锈定）。两者对象不同——一个是项目历史经验（该读），一个是本次初稿（重建时禁读）。重建帧从①④⑤源头独立推导时，同样应先 read 来源 0（项目测试手册），否则重建也会重复发明已有用例。

**Step 1 必问决策点（代码答不了，逐个 ask_user；其余 = agent 自决）：**

1. **工程目录粒度/边界（歧义时）** — 按变化轴拆有多种合理方案时，问用户倾向哪种 + 为什么。模块边界不可逆，影响后续所有开发。【D-不可逆】
2. **API 契约抽象深度** — Deep Module（窄深，可测）vs 易用性（宽浅）。"为可测性收窄，还是为易用性放宽？"是用户偏好。【D-不可逆】
3. **包依赖严格度** — 是否允许反向依赖特例 / 循环检测严格度。问用户"严格边界 vs 务实例外"的偏好。【D】
4. **异常路径覆盖深度** — 时序图异常路径覆盖到什么程度（每边界条件 vs 只关键路径）。取决于用户对"鲁棒性 vs 交付速度"的权衡。【D】

> 时序图调用链推导、签名表语法、Deep Module 词汇应用 = agent 自决。

**Step 1 末尾 — 机器结构检查前置（零成本提速）：** 初稿（含 §6 test-matrix）写完后，主 agent 调 `cw(action=clarify)` / `cw(action=detail)` 触发 CW gate 的机器检查（若骨架未生成则骨架检查自动跳过），FAIL 当场修低级硬伤（缺章节/占位符/§9 未定义签名/类型逃逸），不必等 Step 6。
> **与 Step 6 审查的分工**：此处只杀机器可证的结构硬伤；Step 6 才是质量门（含骨架 P1 反模式 + 红队）。两者不替代——Step 6 审查前 CW gate 的机器检查 FAIL 仍硬阻断。

**§6 test-matrix 来源 A/B 拆 2 并行 subagent（减写+提速）：** 来源 A（功能用例，从 §4 时序图 alt/else 正向推导）与来源 B（NFR 用例，从④回灌表 `验收方式=代码测试` 反向映射）**认知帧不同**（功能边界 vs 风险登记），读文件基本不重叠（A 读 §4+①UC；B 读④回灌表），拆 2 并行 fresh subagent 无写冲突（写入 template §6 的分表，ID 段 T{UC}.6+ 区分）。来源 A 内部可选"按 UC 并行"（每 UC 1 subagent），但需上限保护：UC≤3 全并行；>3 按模块归组或分批（撞≤5 并发约束）。

**Step 2（追踪）— 5 组并行 fresh-context subagent（4 认知帧 + 1 禁读重建帧）：**

> **为何拆**：⑤ 是 6 阶段信息密度最高、追踪最弱的（现状单 agent 串行 5 视角）。拆 4 组各跑正交认知帧，盲区更少。**诚实标注**：⑤的5视角异质性<②的3组（②是不同工程思维，⑤更像同一批代码审查检查项），收益主要在**上下文隔离+读取并行提速**，盲区对抗次要。
>
> **为何加第 5 组（test-matrix 禁读重建）：** 前 4 组都读同一份 §6 test-matrix 初稿——**同源盲区**：初稿漏的用例类别，覆盖帧查的是"已列是否全"，查不出"该列未列"。这正是测试遗漏（事故重灾区）的机制根源——防线只能保证"已列的全覆盖"，保证不了"该列的都列了"。禁读重建 subagent 从①④⑤源头独立推导"该有哪些用例类别"，与初稿 diff，MISSING 即同源盲区。范式抄①clarity / ③issues 已验证有效的「禁读重建」。

| 组（认知帧） | 吞入的视角 | 主读文件 | 写入文件 |
|---|---|---|---|
| **契约帧** | 契约完整性 + 调用链闭合 | §3 签名表 + §4 时序图 | `tracing-round-{N}-contract.md` |
| **结构帧** | 依赖健康（无环 / god object LOC） | §2 包依赖图 + 骨架 LOC | `tracing-round-{N}-structure.md` |
| **覆盖帧** | 测试覆盖完整性（来源 A alt/else + 来源 B NFR映射） | §6 + §4 + ④NFR 表 | `tracing-round-{N}-coverage.md` |
| **闭环帧** | 搭便车闭环（②清单→⑤落点） | ②搭便车清单 + ⑤各章节落点 | `tracing-round-{N}-closure.md` |
| **重建帧（禁读）** | 同源盲区对抗（该列未列） | **禁读 §6 test-matrix**，只读①UC+AC / ④风险表 / ⑤§4 时序图 | `tracing-round-{N}-reconstruct.md` |

**契约帧详细检查**：每用例/功能有对应 API 契约？**NFR④ 回灌到契约的字段（如 idempotency-key）是否在签名表体现？** / 每时序图入口到底层完整、异常路径覆盖？
**结构帧详细检查**：包依赖无环、无上帝对象 LOC<400？
**覆盖帧详细检查**：每 UC 正常+边界+异常+状态+e2e 类齐全？时序图每个 alt/else 有对应异常用例（来源 A）？**来源 A 每条标了测试层 mock/real？e2e 类用例 mock+real 各至少 1 条？**NFR④ `验收方式=代码测试` 的每条缓解项在 §6 来源 B 有 ≥1 对应用例（非仅并发）？来源 B 安全/并发用例是否标了"强制层级"？
**闭环帧详细检查**：②搭便车清单每项是否有⑤代码架构落点？无落点的是否已回流②打回？
**重建帧（禁读，关键防遗漏）**：**禁止 read §6 test-matrix**（避免被主 agent 初稿锈定）。从三类源头独立推导「该有哪些测试用例类别」：① 每 UC 的正常/边界/异常 + ④ 每条 `验收方式=代码测试` 的风险 ≥1 用例 + ⑤§4 时序图每个 alt/else ≥1 异常用例。**重建完成才读 §6 test-matrix**，与初稿做集合 diff，产出三态 gap：MISSING（该有而初稿漏列，最致命）/ PHANTOM（初稿列但①④无根）/ MISMATCH（标覆盖但断言点不符）。

**重建帧 Task prompt：**

```
你是独立 test-matrix 重建 subagent。上下文与主 agent 隔离。**重建阶段禁止 read code-architecture.md 的 §6 test-matrix**（避免被初稿锈定）。
**决策账本纪律：** decisions.md（作为 context 参数注入）里 status=confirmed 的决策是用户已拍板结论，已 confirmed 决策不得当 gap 重报；有下游新证据推翻须标 `[REVISIT of D-NNN]` + 附新证据走 Step 6b 反哺（D-不可逆须主 agent ask_user）。
1. read requirements.md（①UC + AC，功能用例源头）
2. read non-functional-design.md（④风险表，筛 `验收方式=代码测试` 的缓解项，NFR 用例源头）
3. read code-architecture.md 的 §4 时序图（每个 alt/else 异常分支，来源 A 异常用例源头）
4. 从三类源头独立推导「该有哪些测试用例类别」：① 每 UC 正常/边界/异常 + ④ 每条代码测试风险 ≥1 用例 + ⑤§4 每个 alt/else ≥1 异常用例
5. **重建完成后**才 read §6 test-matrix，与你的重建做集合 diff：
   MISSING（重建有、初稿漏列）/ PHANTOM（初稿有、①④无根）/ MISMATCH（标覆盖但断言不符）
6. 每条 gap 标类型（F/K/D）。写入 {topic_dir}/changes/tracing-round-{N}-reconstruct.md
```

**交叉验证点（组间重叠区）**：契约帧「调用链闭合」隐含"签名都在"与结构帧可能重叠→两组都报=强信号 `[CROSS-VALIDATED]`。重建帧 MISSING 与覆盖帧「时序图每个 alt/else 有异常用例」可能交叉命中→同一漏列被独立证实。

**轻量项目降级**：L1 档（系统数=低 且 Wave 数≤2）4 认知帧合回单 agent 串行；但**重建帧不降级**（test-matrix 遗漏是事故重灾区，禁读重建是对抗它的唯一有效手段）。降级由 `complexity_tier` 驱动（见 loop-skeleton「三档执行矩阵」），不本地自判。

**收敛判定**：5 组都 CONVERGED 才算整轮收敛；任一组有新 gap → 回 Step 3 处理后重跑该组（不必 5 组全重跑）。

> **机器化降级空间**：CW gate 的机器检查已覆盖「test-matrix 来源B」「骨架源文件」「骨架无占位符/类型逃逸」「god object 行数」「tsc 编译」——即 5 组认知帧里「结构帧+闭环帧」的机器可判子集，这些由 CW gate 在 `cw(action=clarify)` / `cw(action=detail)` 调用时自动完成，不占 subagent 预算。当机器检查覆盖这两帧时，Step 2 可从 5 组降为 3 组。subagent 只做机器做不了的：时序图语义贯通、API 契约一致性、禁读重建的盲区发现。

**Step 3-4 — gap 分流(F/K/D) → 收敛复核。** 按 loop-skeleton.md。

**特有信号：** 时序图走不通（数据流需跨层穿透/调用链断裂）→ system-architecture.md 模型边界有问题 → 回 Step 2 调整。

**Step 5（定稿+HTML）— 按 `references/deliverable-template.md` 定稿 code-architecture.md；派 fresh subagent 渲染 code-architecture.html（机制见 loop-skeleton.md Step 5b）（主角图：包依赖图+核心时序图）。**

**Step 6（审查）— 派 fresh-context 审查 subagent（按 ../full-shared/references/review-agent.md 规范，CW gate 的机器检查——含 P1 骨架反模式，FAIL 硬阻断），6 维评审（含红队维度），报告写 `changes/review-code-arch.md`（frontmatter 含 verdict + machine_check）。APPROVED 才进 Step 7。**

**Step 7（骨架验证）— 派 fresh-context subagent 生成可编译骨架代码，物理验证 Step 1-5 的设计假设。**

> **[MANDATORY] 骨架验证是本阶段的强制 gate。** 通过才能进 Step 6b。详见 `references/skeleton-spike.md`。

**Step 6b（上游反哺检查）— 骨架验证后、交接前。** 按 loop-skeleton.md Step 6b（[MANDATORY]）。派 fresh-context subagent 回扫①-④上游：本阶段定稿 + **骨架物理验证**是否引入与上游矛盾的结论（骨架常证伪②的分层/领域边界/模块划分假设——这是⑤反哺的高发场景，比其他阶段的文档级反哺更硬）。产出 `changes/backfeed-round-{N}.md`。反哺纪律（只改事实性矛盾/D-不可逆须 ask_user/同步 decisions.md/只改内容不改 phase 状态/反哺后回流）见 loop-skeleton Step 6b。

**机制：**
1. **按模块 DAG 划分生成**（模块数 > 1 时；≤1 或 §2 有 `modules/* 互相 import` 循环嫌疑时不并行，单 agent 够）——详见 `references/skeleton-spike.md`「按模块 DAG 划分并行生成」：
   - **Tier 0 基础层先串行**（1 subagent）：`shared/`（types.ts/errors.ts，从 §3 跨层共享类型 + §4 数据流链一次固化）+ `infra/`（含各模块 adapter stub）
   - **Tier 1 模块层并行**（每 `modules/{module}/` 一个 fresh subagent）：§2 强制 `modules/* 不能互相 import` → 无写冲突。**Tier 1 只读不改 `shared/`**，发现缺类型标 gap 回主 agent 补 Tier 0
   - 读取 = §3 签名表 + §4 时序图 + §1 工程目录 + §2 包依赖图，生成到 `code-skeleton/`
2. 骨架 = 所有类/方法签名/参数/返回类型 + **分层接线**（Level 1：模块内真接线 `this.x()`/`self.x()`/`receiver.x()`（按语言）+ adapter 真引 SDK，方法体不再全 throw，见 `references/skeleton-spike.md`「分层接线规则」）+ import 关系 + 类型契约 + 状态机枚举 + port/adapter 占位
3. **高密度骨架原则**——骨架注释暴露数据流/失败路径/SDK 契约/竞态/不变式（agent 不读代码推不出的信息），不只堆签名
4. **停止点**——签名+调用链+依赖方向可验证即停，不写实现逻辑。Level 1 下「调用链」= 代码里真实接线，**接线边界画线**见 `references/skeleton-spike.md`「接线边界画线（防 Level 1 滑向实现）」——硬纪律：只接调用+透传参数，不写业务逻辑/数据组装

**强制验证（移植 recursive-skeleton [MANDATORY]）：**
- [ ] 类型/编译检查通过（按项目语言：tsc/mypy/cargo/go build/javac；签名自洽 + Level 1 接线调用链签名匹配）
- [ ] lint 通过（无类型逃逸/占位符：跨语言 any/@ts-ignore/eslint-disable/`# type: ignore`//nolint/`#[allow]`/TODO）
- [ ] 包依赖无环（import 与 §2 包依赖图一致）
- [ ] **调用链代码接线可达**（Level 1：每张 §4 时序图入口→底层在骨架代码里真实接线——`this.x()`/`self.x()`/`receiver.x()`，非仅 import 图）
- [ ] **adapter 真引 SDK** — 每个 `infra/*` adapter 方法真引用其 SDK（类型检查器/编译器对依赖声明验签），不 throw 占位
- [ ] **§3 签名表每个方法在骨架有定义**（orphan 检查，CW gate 代码架构检查 ③f）
- [ ] NFR④ 标并发的 UC，骨架已有幂等键/idempotency/锁字段

**失败处理：** 验证失败 → 回 Step 1 修签名/目录/依赖/时序图，不带着错误交接 ⑥。

**搭便车核对（改动7）：** 骨架验证时强制核对 ②搭便车清单每项的真实工作量。若 ⑤发现某项远超 ②预期（搭便车变主工程），必须回流 ②重新确认范围（带⑤骨架的真实代码证据），不能默默扩大范围。

**吸纳 ④prototype：** ④NFR 标记的高不确定性副作用（并发/缓存），其 stub 方法直接进骨架验证，不再「用完即删」。

## Phase Loop 机制

- 收敛失败 → 回 Step 1 调整架构/时序
- 时序图走不通 → 回 Step 2 系统设计调整模型边界
- 审查 CHANGES_REQUESTED → 审查意见当 gap 回 Step 3
- **骨架验证失败（签名/调用链/依赖不可编译）→ 回 Step 1 修纸面设计**，不带着错误交接
- **反哺触发上游修订**（详见 loop-skeleton.md Step 6b）→ 上游 .md 更新后，本阶段可能需重新对齐 → 回 Step 2 重追踪
- Stagnation（连续 3 轮 gap 不降）→ 强制收敛

## Self-Check

**[MANDATORY] 禁止在未完成 loop-skeleton 全流程（含 Step 6 审查 APPROVED + Step 7 骨架验证通过）时声称完成。**

- [ ] code-architecture.md 存在，frontmatter 含 `verdict: pass`
- [ ] **`decisions.md` 已读**（Step 1.0）+ 本阶段 D 类决策（目录边界/契约抽象深度/依赖严格度）已即时 append
- [ ] **`changes/backfeed-round-{{N}}.md` 存在**（Step 6b 反哺检查真执行了；entries=0 也算，只要文件产出）
- [ ] code-architecture.html 存在，包依赖图+时序图正确渲染
- [ ] `changes/tracing-round-{N}-{contract|structure|coverage|closure}.md` 存在（4 帧组追踪真执行了；轻量降级为单 `tracing-round-{N}.md`）
- [ ] **`changes/tracing-round-{N}-reconstruct.md` 存在（test-matrix 禁读重建真执行了——⑤的测试遗漏防线，不降级）**
- [ ] `changes/review-code-arch.md` 存在且 verdict: APPROVED
- [ ] 工程目录树存在，每目录标注职责+变化轴
- [ ] 包依赖图（Mermaid）无循环依赖
- [ ] 每关键功能有时序图（Mermaid sequenceDiagram，入口→底层），异常路径覆盖
- [ ] **test-matrix 章节存在**（deliverable-template §6），来源 A 每 UC 覆盖正常/边界/异常/状态 4 类
- [ ] **来源 A 每条标测试层（mock/real），e2e 类用例 mock+real 各≥1**（real 无环境标 `[需集成环境]`）
- [ ] **时序图每个 alt/else 异常分支映射到 ≥1 条异常用例**（§4↔§6 双向可查）
- [ ] **§6 来源 B（NFR 风险→用例映射表）存在**，④每条 `验收方式=代码测试` 的缓解项有 ≥1 对应用例（双向可查）
- [ ] 方法签名表与时序图一致；Deep Module 词汇统一使用；接口满足可测性三原则
- [ ] **`code-skeleton/` 骨架代码存在，类型检查/lint（按项目语言）全过**（Step 7 gate）
- [ ] **每张时序图入口→底层调用链在骨架代码接线可达（Level 1：`this.x()`/`self.x()`/`receiver.x()` 真实接线，非仅 import）**
- [ ] **adapter 真引 SDK** — `infra/*` adapter 不全 throw，真引用第三方 SDK（类型检查器/编译器验依赖声明）
- [ ] **§9 骨架覆盖核验表存在且无 `❌ 未定义` / 无空行**（§3 签名 ↔ 骨架定义双向可查）
- [ ] **无类型逃逸/占位符**（跨语言：any/@ts-ignore/eslint-disable/`# type: ignore`//nolint/`#[allow]`/TODO；非叶子方法体用接线，叶子逻辑用 not-implemented 异常）
- [ ] **NFR④ 标并发的 UC，骨架已有幂等/锁字段**
- [ ] **②搭便车清单每项有⑤落点或已回流②打回**（追踪视角「搭便车闭环」）

## 本地目录覆盖规则

- **主目录：** `.xyz-harness/`（项目根）
- **子目录：** `${yyyy-MM-dd}-${主题简短标题}`
- **路径：** `.xyz-harness/${主题}/code-architecture.md` + `.html`
- **骨架代码：** `.xyz-harness/${主题}/code-skeleton/`（Step 7 产出，可编译骨架，⑥Wave 的起点）
- **不同主题不同子目录，禁止混放。** 单次写入超 1000 字优先拆分子文档。

## 下游衔接

**Step 7 骨架验证 + Step 6b 反哺检查通过后**向用户交接（按 loop-skeleton.md Step 6 格式）：

> **[状态追踪]** 交接前调 `design_status complete_phase code-arch` 收尾——自动校验 code-architecture.md + verdict:pass + review APPROVED + 骨架 gate，过了才标 completed。
> **有 tool 优先用 tool**：`design_status(action: complete_phase, phase: code-arch)`；**无 tool 用 CLI**：`design-status complete-phase code-arch`。

```
✅ ⑤代码架构设计 已完成并通过独立审查 + 骨架验证。
   产出：code-architecture.md + code-architecture.html + code-skeleton/（可编译骨架）
   审查报告：changes/review-code-arch.md（verdict: APPROVED）
   骨架验证：类型检查/lint 通过，调用链全可达
下一步：⑥执行计划 — Wave 拆分（从骨架叶子作用域推导），依赖 DAG，串并行标注
调用：/full-execution-plan
是否现在进入下一步？
```

用户确认后才加载下一 skill。

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| [MANDATORY] | 流程强制要求 | 必须严格遵守 |
