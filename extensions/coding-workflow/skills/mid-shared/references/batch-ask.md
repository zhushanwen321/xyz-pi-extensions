# batch-ask 协议（mid 工作流的批量提问法）

> **mid-design / mid-build 共用的交互协议。** 替代 design 的「Grilling 一问一答」（沿设计树逐节点、一次一个问题）。
> mid 先由主 agent 统一起草初稿，draft 过程中**积累**需要用户拍板的决策点，分类打包后**一次性批量提问**。
>
> 这是 mid 把 wall-clock 从「40~80 次 ask_user 串行」压到「3~5 次批量」的核心机制。

## 为什么是它（vs design Grilling）

design 的 Grilling（见 `../design-shared/references/loop-method.md`）四条铁律之一是「**一次一个问题，等回答再继续**」——
沿设计树从根到叶逐节点推进，解决父节点再问子节点。这保证决策深度（每个决策基于前一个的答案），但代价是
**每阶段 5~15 次 ask_user 串行往返，6 阶段累计 40~80 次**——这是 design wall-clock 的最大杀手。

mid 的取舍：**用「agent 先整体 draft + 批量收集决策」换「逐节点串行确认」**。

| | design Grilling | mid batch-ask |
|---|---|---|
| 时机 | 写初稿前（边问边写） | 写初稿中/后（draft 积累 → 批量问） |
| 颗粒 | 一次一个，沿设计树 | 一次批量 4~8 个，分类打包 |
| 决策深度 | 高（父答案约束子问题） | 中（agent 先给推荐，用户批量拍板） |
| wall-clock | 慢（N 次串行等待） | 快（1~2 次批量） |
| 用户认知负荷 | 低（一次一个） | 高（一次多个）→ **靠强推荐 + 分类缓解** |

**代价（明知）：** 批量提问让用户认知负荷升高，决策深度可能下降（无法沿设计树逐步收敛）。
**缓解：** ① 每问附**强推荐答案 + 理由**（用户可采纳/修正/推翻，不是甩空问题）；② **分类打包**（D-不可逆突出标红，D-可逆 agent 已自决只告知）；③ **二次 ask**（loop 兜底后残留的 D-不可逆再确认一轮）。

## 协议 4 阶段

```
B1  收集  ← 主 agent draft 初稿时，把「代码答不了的决策点」记到 batch 队列
B2  分类  ← 按 D-不可逆 / D-可逆 / K / 可代码自决 四类分流
B3  批量提问 ← D-不可逆 + K 打包，一次 ask_user（4~8 个，每问附推荐+理由）
B4  纳入  ← 用户答案即时 append decisions.md + 更新初稿
```

### B1 · 收集（draft 过程中积累）

主 agent 基于代码扫描 + 业务输入，**opinionated 起草初稿**（不是等用户回答才写）。draft 过程中遇到「代码答不了、必须用户拍板」的点，不立即问，而是记到 batch 队列：

```
batch_queue = []
# draft requirements.md 时：
#   "归档策略选月分区还是按事件？" → 记：{决策点, 推荐, 理由, 分类}
#   "Actor 包不含审核人？" → 记
# draft system-architecture.md 时：
#   "分层用 DDD4 还是三层？" → 记（D-不可逆）
#   "这个 port 真做还是假设 seam？" → 记（D-不可逆）
```

> **能查代码答的，dispatch 只读 subagent 查，不进 batch 队列。** 进队列的只限：业务意图、取舍偏好、风险容忍、不可逆的根本选择——这些代码答不了。与 design Grilling 第 4 铁律同源。

### B2 · 分类（四类分流）

收集到的决策点按类型分流，**决定哪些进批量问、哪些 agent 自决**：

| 类型 | 含义 | 处理 | 进 batch 提问？ |
|---|---|---|---|
| **D-不可逆** | 分层/状态机/领域边界/根本架构选择 | 生成方案对比 + 推荐 → **必须 ask_user** | ✅ 进（标红突出） |
| **D-可逆** | 命名、小重构、可逆实现细节 | agent opinionated 自决 + 理由 | ❌ 不进（定稿时暴露） |
| **K** | 知识缺口（业务规则、外部约束） | 生成具体问题 | ✅ 进 |
| **可代码自决** | 有明确启发式、代码可验证 | agent 直接产出 | ❌ 不进 |

> **D-可逆 vs D-不可逆的判定**（关键，防 agent 吞决策）：分层深度、状态机结构、领域聚合边界、依赖方向、根本技术选型 = D-不可逆（改了牵一发动全身）；命名、局部重构、可逆实现细节 = D-可逆。与 design 的 Step 1 必问决策点判定同源。

### B3 · 批量提问（一次 ask_user，4~8 个）

把 D-不可逆 + K 类决策点打包，**一次性批量提问**（用 `ask_user` 的多问题能力）。

**提问纪律（5 条）：**

1. **一次批量 4~8 个**——少于 4 个不值得批量（走单问），多于 8 个用户认知过载（拆成两批，D-不可逆优先）。
2. **每问附推荐答案 + 理由**——给强观点，用户可采纳/修正/推翻。不甩空问题菜单。
   > ❌「数据归档策略是什么？」
   > ✅「推荐按月分区 + 90 天转冷存储（你现在的 orders 表已按月分区，沿用最省力）。除非有合规要求保留更久？」
3. **D-不可逆标红突出**——这类决策牵一发动全身，提示用户重点确认。
4. **附方案对比**——D-不可逆类附「方案 A vs B vs C + 取舍」（agent 给推荐，用户拍板）。
5. **分类排序**——先 D-不可逆（最重要），后 K（补充信息）。

**ask_user 模板（批量，用 add action）：**

```
ask_user(action:'add', questions:[
  {
    question: "[D-不可逆] 分层架构：DDD 4 层还是三层？",
    detail: "核心是业务规则编排还是技术流程编排？未来会不会长出复杂规则引擎？\n推荐：DDD 4 层（理由：现有 orders 已有 aggregate 雏形，核心计算是业务规则）\n方案 A: DDD 4 层（domain/app/infra/gateway）\n方案 B: 三层（controller/service/repository）",
    default: "A（推荐）"
  },
  {
    question: "[D-不可逆] 支付 port：真做还是假设 seam？",
    detail: "支付渠道未来会替换吗？\n推荐：真 port（理由：多渠道是已规划路线）",
    default: "真 port"
  },
  {
    question: "[K] 归档保留期有合规要求吗？",
    detail: "影响 nfr 的数据安全维度\n推荐：90 天（无合规要求的话）",
    default: "90 天"
  }
  # ... 4~8 个
])
```

### B4 · 纳入（即时落盘 decisions.md）

用户批量拍板后，主 agent：

1. **即时 append decisions.md**——每个 D 类决策按 `../design-shared/references/loop-skeleton.md` Step 1.2 的 schema append（id/decision/rationale/classification/confirmed_by/stage/source/status）。不等阶段结束。**这是对抗主 agent context 被 compact 的第一道防线**（状态从「对话痕迹易丢」转为「文件派生可再生」）。
2. **更新初稿**——把用户答案纳入初稿对应章节。
3. **D-可逆类在定稿时暴露**——agent 自决的 D-可逆决策，定稿时在「决策记录」章节列出（标 `confirmed_by: agent-opinionated`），让用户看到。

## 二次 ask（loop 兜底后）

`review-fix-loop` 收敛后（round ≥ MAX 或 CONVERGED），若残留未解决的 **D-不可逆** must_fix，走**二次批量 ask**：

- 收集 loop 残留的 D-不可逆类 must_fix（ reviewer 发现的、主 agent 无法自判的）
- 同 B3 协议打包提问（通常 1~3 个，比首次少）
- 用户拍板后 append decisions.md（标 `[REVISIT of D-NNN]` 若推翻了首次确认的决策）

> 二次 ask 是 batch-ask 的兜底——首次批量问不可能覆盖所有决策（draft 不完整时有些决策点还没浮现），loop 的 reviewer 会发现新的 D-不可逆 gap，二次 ask 收尾。

## 何时仍走单问（batch 的例外）

batch-ask 是默认，但以下情况**仍走 design 式单问**（退回 `loop-method.md` 的 Grilling）：

1. **决策有强依赖链**——决策 B 的答案完全取决于决策 A（A 选 X 则 B 只能选 Y，A 选 Z 则 B 是另一组选项）。批量问会让用户在没有 A 的约束下答 B，答案可能无效。这类沿依赖链单问。
2. **D-不可逆且影响范围大**——如根本架构选型（微服务 vs 单体），其答案会重塑后续所有决策。这类先单问拍板，再基于它 batch 收集其余。
3. **用户主动深挖**——用户对某个决策点追问，转入单问模式深聊。

> **判据：** 批量问的前提是「各决策点相对独立」。发现强依赖链就拆出来单问，其余批量。不是非此即彼——一次交互里可以「1 个单问拍板根决策 + 1 批 batch 问其余」。

## 与 design 决策持久化的关系

batch-ask **完全复用** design 的 decisions.md 机制（append-only 账本、D-不可逆/D-可逆分类、confirmed_by、溯源、revisit 流程）——
见 `../design-shared/references/loop-skeleton.md` Step 1.2。mid 只是把「提问方式」从逐个串行改成批量，**决策的持久化和反哺纪律不变**。
