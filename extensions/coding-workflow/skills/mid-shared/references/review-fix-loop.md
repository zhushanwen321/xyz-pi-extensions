# review-fix-loop 协议（mid 工作流核心抽象）

> **mid-plan / mid-detail-plan 共用的收敛循环。** 把 full 的「追踪(找 gap) + 审查(判质量) + 反哺(检测上游矛盾)」三道独立检查
> **折叠成一路 reviewer 循环**，跨 deliverable 合并维度，MAX=2 轮收敛 + 残留打包二次 ask。
>
> 本文件是 loop 的**通用协议**（步骤/派发/汇总/收敛/降级）。**各路 reviewer 读什么、查什么维度**见
> `mid-plan/SKILL.md` 和 `mid-detail-plan/SKILL.md` 的「维度审查分配」节——那是阶段特有的，不在此重复。

## 为什么是它（vs full 6 步循环）

full 每阶段独立跑 6 步循环（tracing→gap 分流→收敛复核→定稿→审查→反哺），**6 阶段 = 6 遍循环**。
mid 把同一目的的检查**跨 deliverable 合并**：

| full 的检查（每阶段各一遍） | mid 的对应（合并后） |
|---|---|
| Step 2/4 追踪（找 gap）+ Step 6 审查（判质量） | **一路 reviewer 既找 gap 又判质量** |
| Step 4 独立复核 subagent 判 CONVERGED | loop 无 must_fix 即收敛（隐式） |
| Step 6b 每阶段独立 backfeed | 折叠进 Skill B 一致性终检 + 跨 deliverable reviewer |
| 每阶段 N 视角 | **跨 deliverable 合并**（Skill B 5 路覆盖 4 份文档） |
| max-rounds L2=3 | **MAX=2**（更激进，靠 batch-ask 兜底残留） |

**代价（明知）：** 合并追踪+审查损失了「找 gap」与「判质量」的视角隔离（full 有意分两道防 confirmation bias）。
**缓解：** 禁读重建路 + 红队路天然反向（一个删/质疑，一个补/对齐），提供 bias 对冲。这是 mid 用「正交认知帧 + 跨阶段合并」换 wall-clock 的核心取舍。

## loop 6 步协议

```
round = 0
loop:
  L1  主 agent 调 cw(action=clarify|detail) 触发机器检查  ← 零成本前置门，FAIL 当场修，不进 subagent
  L2  派 N 路 fresh reviewer 并行 wait:false   ← 各跑正交认知帧（维度见各 SKILL 的「维度审查分配」）
  L3  每路读 changes/machine-check-{phase}.md（L1 已产出）+ 跑认知帧  ← 禁读重建路：重建阶段禁读对应 deliverable
  L4  notifier 唤醒 → 主 agent 汇总 must_fix   ← 并集去重 + 交叉验证标注（见下）
  L5  无 must_fix？→ CONVERGED，跳出 loop
  L6  否则 round++ ；round ≥ MAX → 停止，残留 D-不可逆打包二次 ask_user
      否则主 agent 按 must_fix 修复初稿 → 回 L1
```

### L1 · 机器检查（前置门，零 subagent）

主 agent 调 CW gate 触发对应阶段的机器检查（mid 阶段不手写 check 脚本，复用 CW 的 check 函数）。mid-plan 阶段调 `cw(action=clarify)`，mid-detail-plan 阶段调 `cw(action=detail)`：

```
cw(action=clarify, topicId, clarifyJson)   # mid-plan 阶段，触发 check_clarity + check_architecture
cw(action=detail, topicId, detailJson)     # mid-detail-plan 阶段，触发 check_issues + check_nfr + check_code_arch + check_execution
```

- **gate pass** → 进 L2 派 reviewer
- **gate fail** → CW 在 `changes/machine-check-{phase}.md` 落盘报告，顶层返回 `mustFix`。**当场修**低级硬伤（占位符/缺章节/幽灵引用/集合差集），修完重调 CW 直到 gate pass。**不进 subagent**（机器可证的结构硬伤不值得占 subagent 预算）。

> 机器检查由 CW gate 在 `cw(action=clarify/detail)` 调用时自动执行（TS check 函数，不再是 python 脚本——上一轮已迁移）。agent 不手动跑 check 脚本。

### L2 · 派 N 路 reviewer（并行，wait:false）

按当前 skill 的「维度审查分配」表派 N 路（mid-plan=4 路，mid-detail-plan=5~6 路）。**必须 `wait:false` 同消息多 start**——见 `../full-shared/references/loop-skeleton.md`「subagent 派发工程规范」。逐个 `wait:true` 会让 N 路并行退化成串行 N 倍 wall-clock。

**派发模板（每路一个 start，同消息发起）：**

```
subagent(action:'start', startParam:{
  agent: "general-purpose",
  wait: false,
  context: "<decisions.md 内容>",   # 强制注入已确认决策，对抗主 agent compact 丢决策
  task: """
  你是独立 reviewer（{路名}），上下文与主 agent 隔离。
  {若是禁读重建路：本路重建阶段禁止读 {deliverable}，从 {源} 独立重建后 diff——读了就被锚定，退回读后审查}

  **Step 0（机器检查结果，硬阻断，最先看）：**
  read {topic_dir}/changes/machine-check-{phase}.md（主 agent L1 已调 CW gate 产出）。
  frontmatter machine_check: FAIL → 直接判 CHANGES_REQUESTED，把 ❌ 项当必须修改。
  PASS 才进下面的认知帧审查。

  **Step 1（认知帧审查）：**
  read {本路读取材料清单}
  按本路认知帧（{帧描述}）审查：
  - 既找 gap（缺什么/错什么）也判质量（够不够好）—— 两者合并，不区分
  - 每条发现标类型：F(事实，需二次确认) / K(知识，问用户) / D-不可逆(需 ask_user) / D-可逆(agent 可改) / 过度设计(红队路专属)

  **决策账本纪律：** decisions.md 里 status=confirmed 的决策是用户已拍板结论，已 confirmed 决策不得当 gap 重报。
  有下游新证据推翻须标 [REVISIT of D-NNN] + 附新证据（D-不可逆须主 agent ask_user）。

  判定：APPROVED（无必须修改）/ CHANGES_REQUESTED（有 must_fix）。
  报告写入 {topic_dir}/changes/review-{skill-slug}-{route-slug}.md
  格式：## Verdict / ## 机器检查结果 / ## must_fix（必须修改）/ ## should_fix（建议）/ ## nit（可选）
  """
})
```

### L3 · 每路认知帧（差异化是关键）

**同 prompt 重复 N 次 = 盲区高度相关，loop 无增益。** 每路必须跑**正交认知帧**：

| 帧类型 | 方向 | 找什么 |
|---|---|---|
| 对齐/补齐 | 与设计同向（补） | 内部一致性 / 上游对齐 / 可执行性 / 完整性 |
| 禁读重建 | 反向（他证） | **禁读初稿**，从源独立重建 → diff（MISSING/PHANTOM/MISMATCH） |
| 红队 | 反向（删/质疑） | 必要性与比例性（deletion test：删掉会怎样？） |

> 三帧方向不同，盲区正交，并集才有效。具体每 skill 派几路各帧、读什么，见 `mid-plan/SKILL.md` 和 `mid-detail-plan/SKILL.md` 的「维度审查分配」表。

### L3a · 异常猎手（失败帧，条件触发的附加路）

> **不是独立认知帧**，是失败帧（bottom-up）的应用——假设设计是错的，找最可能出 bug 的地方。
> 与对齐帧（确认性视角）正交，是对抗性审查的唯一兜底。如果它也漏了就没人兜底。

**触发条件**：状态复杂度信号≥中（4+ 状态/单状态机）或跨边界数≥中（2+ 外部系统）。

**Task prompt 模板**（各 SKILL 按交付物调整 read 列表）：

```
你是独立异常猎手 subagent。上下文与主 agent 隔离。假设设计文档是错且不全的。
决策账本纪律：decisions.md 里 status=confirmed 的决策不得当 gap 重报；有下游新证据推翻
须标 [REVISIT of D-NNN] + 附新证据。

1. read 设计文档（各 SKILL 声明 read 列表）
2. 戴失败帧，按 hunting 清单逐项找未覆盖面：
   - 异常路径：error / fallback / 超时 / 重试 / 降级
   - 边界值：空 / 单元素 / 极大极小
   - 并发时序：race / 幂等 / 乱序
   - 状态机死角：不可达状态 / 缺转移 / 卡死终态
   - **状态机终态矛盾**：多入口/多 session 收口时终态是否一致；诚实态声明与实际行为是否矛盾
   - **数据流跨层丢失**：错误信息/上下文在层间传递时是否被吞、被覆盖、被降级
   - 删除测试：对每个元素问「不做它会怎样」——抓伪需求/伪 issue
3. 产出「未处理清单」，每条标 F(必须修)/K(应修)/D(决策项)。写入 review-round-{N}.md。
```

> **hunting 清单中「状态机终态矛盾」和「数据流跨层丢失」两项来自 fix-state-tearing 复盘教训**
> （F1: 多 session 收口终态不一致 / F2: errorText 跨层传递丢失 / F3: toolCall 诚实态矛盾）。
> 这两类问题是主 agent + 架构 reviewer 的共同盲区——它们的视角是「验证设计是否正确」，
> 而异常猎手的视角是「假设设计是错的」。

### L4 · 汇总去重（主 agent，notifier 唤醒后）

收齐 N 路报告后，主 agent 汇总：

1. **must_fix 并集去重**——按「文件:章节 + 问题」去重，合并为统一清单。写入 `{topic_dir}/changes/review-{skill-slug}-merged.md`（frontmatter 含 `review_round` + `route_count`）。
2. **交叉验证标注**（复用 full 的标记约定）：
   - **多路同报同一问题** → `[HIGH-CONFIDENCE]`（强信号，必修）
   - **仅一路报** → `[NEEDS-VERIFY]`（边缘，主 agent 复核确认后转必修或丢弃）
   - **结论相反**（如红队说删、对齐说必需）→ `[CROSS-VALIDATED]`，转主 agent 裁决；**涉及 D-不可逆决策（分层/状态机/领域边界）→ 必须 ask_user**，不能 agent 自判
3. **趋同检测**（落盘供后续优化）：N 路重合度 > 80% → frontmatter 记 `review_ensemble_overlap: high`（未来同类可降级路数）；重合度低 → `low`。

### L5 · 收敛判定

- **无 must_fix**（should_fix/nit 不阻断）→ CONVERGED，跳出 loop，进定稿。
- **有 must_fix** → 进 L6。

### L6 · 修复 / 超限

- **round < MAX**：主 agent 按 must_fix 清单修复初稿（F 类先二次确认过滤误报，D-不可逆积累到二次 ask，其余当场改）→ round++ → 回 **L1** 重跑机器检查 + 重派 reviewer。
- **round ≥ MAX（停止）**：残留未解决的 must_fix 中，**D-不可逆类打包走二次 `ask_user`**（见 `batch-ask.md`「二次 ask」节）；其余标 `[UNRESOLVED]` 交下游或显式列为设计风险，进定稿。

> MAX=2 是 mid 的默认（比 full L2 的 3 更激进）。理由：batch-ask 已在循环前把大部分决策拍板，loop 主要兜底 reviewer 发现的新 gap，2 轮通常够收敛；超 2 轮说明问题在决策层而非实现层，应该 ask_user 而非继续 loop。

## 收敛后的动作（loop 外）

跳出 loop 后，按当前 skill 的流程进定稿 + 渲染 HTML（派 1 个 fresh subagent 加载 coding-visualizer）。
**Skill B 额外有「全文档一致性终检」**（合并 full 的 Step 6b 反哺 + 6c 终检），在 loop 之后、定稿之前——见 `mid-detail-plan/SKILL.md`。

## 复杂度降级（loop 路数随档位缩）

mid 默认服务 L2（标准档）。档位驱动 loop 的路数和轮次：

| 动作 | L1（降级到 lite-plan 退出 mid） | L2（默认） | L3（升级 full 退出 mid） |
|---|---|---|---|
| reviewer 路数 | — | 4 路（full）/ 5~6 路（build） | — |
| MAX 轮次 | — | 2 | — |
| 禁读重建路 | — | 含（每 skill ≥1 路） | — |

> mid 的定位是 **L2 标准档的专用工作流**。L1 走 lite-plan（更轻），L3 走 full（每阶段深度收敛不可省）。mid 不实现 L1/L3 降级——遇到直接路由出去（范围守门，见各 SKILL 开头）。

## 已知限制

1. **后台 reviewer 静默 hang 无兜底**——notifier 只在完成/失败时唤醒，subagent 可能静默 hang（推理卡住/连接中断），主 agent 在 STOP 醒不过来。当前无平台级兜底。主 agent 在用户推进下一 turn 时调 `subagent(action:list)` 排查。与 full 同源限制。
2. **合并追踪+审查的 bias 风险**——一路 reviewer 既找 gap 又判质量，认知惯性比 full 两道隔离强。靠禁读重建 + 红队反向帧对冲，但不完全等价 full 的隔离强度。这是 mid 用 wall-clock 换的质量代价。

## CW gate 落盘契约

> **[MANDATORY] loop CONVERGED 后，必须额外落盘 CW 面向的 `review-{slug}.md`（slug = clarity/architecture/issues/nfr/code-arch/execution），含 frontmatter `verdict: APPROVED`。这是 CW gate 预检（`findMissingReviewStubs`）的硬依赖——CW 不造假桩（D-007 方案 A），靠 skill 落盘。**

### 两层 review 文件的区别（易混淆，必读）

| 文件 | 性质 | 谁产 | 格式 | CW 是否直接读 |
|------|------|------|------|--------------|
| `changes/review-{skill-slug}-{route-slug}.md` | **loop 中间产物**（per-route reviewer 报告） | 各路 reviewer subagent | `## Verdict` heading（APPROVED/CHANGES_REQUESTED） | ❌ 不直接读（仅供主 agent L4 汇总） |
| `changes/review-{slug}.md` | **CW gate 面向文件**（维度合并后的最终结论） | skill（主 agent / merge subagent） | **frontmatter `verdict: APPROVED`**（不是 heading） | ✅ CW `findMissingReviewStubs` 预检 |

### slug 映射

- **mid-plan（CW clarify 阶段）** → 产 2 份：`review-clarity.md` + `review-architecture.md`
- **mid-detail-plan（CW detail 阶段）** → 产 4 份：`review-issues.md` + `review-nfr.md` + `review-code-arch.md` + `review-execution.md`

### 落盘规则

1. **loop 未 CONVERGED** → 不落盘 `review-{slug}.md`（重跑 loop）
2. **loop CONVERGED** → 主 agent（或 1 个 merge subagent）收集 N 路 per-route 报告，**按维度合并**成 CW 面向文件：
   - verdict 合并规则：所有纳入该 slug 的 per-route 报告均 APPROVED（无 must_fix）→ `verdict: APPROVED`；任一 CHANGES_REQUESTED → 不落盘（回 loop 修）
   - 正文：合并 must_fix（已清空）/ should_fix / nit，保留 per-route 溯源标注（`[from review-{skill}-{route}]`）
3. **frontmatter 必须**：`verdict: APPROVED`（字段值，非 heading）。CW 读 frontmatter 不读 `## Verdict` heading——只写 heading 不写 frontmatter = CW 预检失败

> **这一步是 skill 职责，不是 CW 的。** CW 只预检文件存在 + 跑机器检查，不生成 review 桩（D-007）。per-route 报告（`## Verdict` heading）是 loop 内部工程产物，CW 永远不读；CW 只认 `review-{slug}.md` 的 frontmatter `verdict`。两套命名/格式不可混用。
