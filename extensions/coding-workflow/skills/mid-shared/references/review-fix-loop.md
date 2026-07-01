# review-fix-loop 协议（mid 工作流核心抽象）

> **mid-plan / mid-detail-plan 共用的收敛循环。** 把 design 的「追踪(找 gap) + 审查(判质量) + 反哺(检测上游矛盾)」三道独立检查
> **折叠成一路 reviewer 循环**，跨 deliverable 合并维度，MAX=2 轮收敛 + 残留打包二次 ask。
>
> 本文件是 loop 的**通用协议**（步骤/派发/汇总/收敛/降级）。**各路 reviewer 读什么、查什么维度**见
> `mid-plan/SKILL.md` 和 `mid-detail-plan/SKILL.md` 的「维度审查分配」节——那是阶段特有的，不在此重复。

## 为什么是它（vs design 6 步循环）

design 每阶段独立跑 6 步循环（tracing→gap 分流→收敛复核→定稿→审查→反哺），**6 阶段 = 6 遍循环**。
mid 把同一目的的检查**跨 deliverable 合并**：

| design 的检查（每阶段各一遍） | mid 的对应（合并后） |
|---|---|
| Step 2/4 追踪（找 gap）+ Step 6 审查（判质量） | **一路 reviewer 既找 gap 又判质量** |
| Step 4 独立复核 subagent 判 CONVERGED | loop 无 must_fix 即收敛（隐式） |
| Step 6b 每阶段独立 backfeed | 折叠进 Skill B 一致性终检 + 跨 deliverable reviewer |
| 每阶段 N 视角 | **跨 deliverable 合并**（Skill B 5 路覆盖 4 份文档） |
| max-rounds L2=3 | **MAX=2**（更激进，靠 batch-ask 兜底残留） |

**代价（明知）：** 合并追踪+审查损失了「找 gap」与「判质量」的视角隔离（design 有意分两道防 confirmation bias）。
**缓解：** 禁读重建路 + 红队路天然反向（一个删/质疑，一个补/对齐），提供 bias 对冲。这是 mid 用「正交认知帧 + 跨阶段合并」换 wall-clock 的核心取舍。

## loop 6 步协议

```
round = 0
loop:
  L1  主 agent 跑机器检查 check_*.py          ← 零成本前置门，FAIL 当场修，不进 subagent
  L2  派 N 路 fresh reviewer 并行 wait:false   ← 各跑正交认知帧（维度见各 SKILL 的「维度审查分配」）
  L3  每路先复跑机器检查（幂等）+ 跑认知帧      ← 禁读重建路：重建阶段禁读对应 deliverable
  L4  notifier 唤醒 → 主 agent 汇总 must_fix   ← 并集去重 + 交叉验证标注（见下）
  L5  无 must_fix？→ CONVERGED，跳出 loop
  L6  否则 round++ ；round ≥ MAX → 停止，残留 D-不可逆打包二次 ask_user
      否则主 agent 按 must_fix 修复初稿 → 回 L1
```

### L1 · 机器检查（前置门，零 subagent）

主 agent 自跑对应阶段的机器检查脚本（复用 design 的脚本，不重写）：

```bash
python3 ${对应阶段 skill dir}/scripts/check_{phase}.py {topic_dir}
```

- **exit 0** → 进 L2 派 reviewer
- **exit 1** → 看 `changes/machine-check-{phase}.md` 报告，**当场修**低级硬伤（占位符/缺章节/幽灵引用/集合差集），修完重跑直到 exit 0。**不进 subagent**（机器可证的结构硬伤不值得占 subagent 预算）。

> 这层与 design 的 Step 5d 同源——「把 Step 6 审查的反馈环从定稿后缩到初稿后当场修」。mid 把它作为 loop 的固定第一道门。

### L2 · 派 N 路 reviewer（并行，wait:false）

按当前 skill 的「维度审查分配」表派 N 路（mid-plan=4 路，mid-detail-plan=5~6 路）。**必须 `wait:false` 同消息多 start**——见 `../design-shared/references/loop-skeleton.md`「subagent 派发工程规范」。逐个 `wait:true` 会让 N 路并行退化成串行 N 倍 wall-clock。

**派发模板（每路一个 start，同消息发起）：**

```
subagent(action:'start', startParam:{
  agent: "general-purpose",
  wait: false,
  context: "<decisions.md 内容>",   # 强制注入已确认决策，对抗主 agent compact 丢决策
  task: """
  你是独立 reviewer（{路名}），上下文与主 agent 隔离。
  {若是禁读重建路：本路重建阶段禁止读 {deliverable}，从 {源} 独立重建后 diff——读了就被锚定，退回读后审查}

  **Step 0（机器检查，硬阻断，最先做）：**
  跑 python3 {skill_dir}/scripts/check_{phase}.py {topic_dir}。
  exit 1 → 直接判 CHANGES_REQUESTED，把 machine-check-{phase}.md 的 ❌ 当必须修改。
  exit 0 才进下面的认知帧审查。

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

### L4 · 汇总去重（主 agent，notifier 唤醒后）

收齐 N 路报告后，主 agent 汇总：

1. **must_fix 并集去重**——按「文件:章节 + 问题」去重，合并为统一清单。写入 `{topic_dir}/changes/review-{skill-slug}-merged.md`（frontmatter 含 `review_round` + `route_count`）。
2. **交叉验证标注**（复用 design 的标记约定）：
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

> MAX=2 是 mid 的默认（比 design L2 的 3 更激进）。理由：batch-ask 已在循环前把大部分决策拍板，loop 主要兜底 reviewer 发现的新 gap，2 轮通常够收敛；超 2 轮说明问题在决策层而非实现层，应该 ask_user 而非继续 loop。

## 收敛后的动作（loop 外）

跳出 loop 后，按当前 skill 的流程进定稿 + 渲染 HTML（派 1 个 fresh subagent 加载 design-visual-explainer）。
**Skill B 额外有「全文档一致性终检」**（合并 design 的 Step 6b 反哺 + 6c 终检），在 loop 之后、定稿之前——见 `mid-detail-plan/SKILL.md`。

## 复杂度降级（loop 路数随档位缩）

mid 默认服务 L2（标准档）。档位驱动 loop 的路数和轮次：

| 动作 | L1（降级到 lite-plan 退出 mid） | L2（默认） | L3（升级 design 退出 mid） |
|---|---|---|---|
| reviewer 路数 | — | 4 路（design）/ 5~6 路（build） | — |
| MAX 轮次 | — | 2 | — |
| 禁读重建路 | — | 含（每 skill ≥1 路） | — |

> mid 的定位是 **L2 标准档的专用工作流**。L1 走 lite-plan（更轻），L3 走 design（每阶段深度收敛不可省）。mid 不实现 L1/L3 降级——遇到直接路由出去（范围守门，见各 SKILL 开头）。

## 已知限制

1. **后台 reviewer 静默 hang 无兜底**——notifier 只在完成/失败时唤醒，subagent 可能静默 hang（推理卡住/连接中断），主 agent 在 STOP 醒不过来。当前无平台级兜底。主 agent 在用户推进下一 turn 时调 `subagent(action:list)` 排查。与 design 同源限制。
2. **合并追踪+审查的 bias 风险**——一路 reviewer 既找 gap 又判质量，认知惯性比 design 两道隔离强。靠禁读重建 + 红队反向帧对冲，但不完全等价 design 的隔离强度。这是 mid 用 wall-clock 换的质量代价。
