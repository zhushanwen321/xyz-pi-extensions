# 设计循环操作速查（Design Loop Skeleton）

> **6 个设计阶段 skill 共用的操作骨架。** 每个阶段 read 本文件获取 6 步操作指令和
> subagent 派发模板。方法论详解（Grilling 提问法、Question Hierarchy、gap 信号等）见
> `loop-method.md`——**首次执行本工作流（clarity 阶段）read 一次即可，后续阶段按本骨架执行。**

## 6 步循环

```
Step 1  交互提问 + 写初稿    ← 主 agent，Grilling 遍历本阶段设计树
Step 2  独立 subagent 追踪   ← fresh context，强制视角找 gap（完整性）
Step 3  gap 分流 F/K/D       ← 主 agent 处理，F 类二次确认
Step 4  收敛复核              ← 再派 subagent，无新 gap → CONVERGED
Step 5  定稿 + 渲染 HTML      ← 主 agent 定稿 .md；fresh subagent 渲染 .html
Step 6  独立审查(6维,含红队)  ← fresh subagent 判质量 → APPROVED
Step 6b 上游反哺检查          ← fresh subagent 检测与上游矛盾 → 反哺修订上游 .md
Step 6c 仅⑥: 全文档一致性终检 ← 交接编码前的总闸门（仅执行计划阶段）
```

## 标记约定速查表（机制触发器，一处定义处处引用）

这些标记是机制触发信号，见到时必须执行对应动作：

| 标记 | 含义 | 触发动作 | 定义出处 |
|------|------|----------|--------|
| `[REVISIT of D-NNN]` | 新证据推翻已 confirmed 决策 D-NNN | 走 Step 6b 反哺；D-不可逆须主 agent ask_user；同步 decisions.md（status→revisited） | Step 6b / decisions-template |
| `[BACKFED from {阶段}]` | 本 .md 被下游阶段反哺修订 | 在反哺处行内标注；frontmatter `backfed_from` 追加 | Step 6b |
| `[NEEDS_USER_CONFIRM]` | 涉及 D-不可逆决策，不能 agent 自改 | **必须主 agent ask_user** 确认后才修订 | Step 6b / consistency-check |
| `[CROSS-VALIDATED]` | 多个独立 subagent 报同一问题 | 转主 agent 裁决；强信号（更优先） | architecture-perspectives / review-agent |
| `[UNRESOLVED]` | Stagnation 后仍未解决的 gap | 标注后交下游或用户，不阻断定稿 | Stagnation 保底 |
| `[AMBIGUOUS]` | 模糊语言（快速/合理/大量） | Step 5a 扫描标记，待用户明确 | Step 5a |
| `[DEVIATED]` | 实现期发现与设计偏离 | 标注偏离，回灌设计闭环 | execution / closeout |
| `[UNVERIFIED]` | 设计约束未在代码中验证 | closeout 统计 unverified_count | closeout |

## 核心速记（4 条）

1. **交互与追踪分离** — 主 agent 做交互/写初稿，独立 fresh subagent 做追踪/审查。主 agent 不自己做追踪（带对话上下文有确认偏误）。
2. **收敛靠独立复核** — 停止条件是「独立 subagent 无新 gap」，不靠主 agent 自判。
3. **定稿必过独立审查** — Step 6 审查判质量（不是找 gap），6 维含红队反过度设计，APPROVED 才进 6b。追踪=完整性，审查=质量，两种不同检查。
4. **反哺保文档一致** — Step 6b 审查通过后，fresh subagent 回扫上游，发现矛盾就反哺修订上游 .md。文档一致性靠反哺，不靠最后一次性检查。

## subagent 派发工程规范（多组并行的落地机制）

> 各阶段 SKILL 写「3 组并行」「5 组并行」「2 组并行」是**逻辑并行度**；本节规定它**怎么真并行执行**。读档位（L1/L2/L3）决定派几组后，按本节派发。
> 本规范基于 subagents extension 源码实证（`extensions/subagents/src/`），不依赖未实现的平台能力。

### 核心机制（源码实证）

subagent 工具 `executionMode: "sequential"`——**同消息多个 `subagent` start 是依次启动（不是同消息并行启动）**，但：

- 用 `wait:true`（默认）→ 每个启动即阻塞，**N 个串行 = N 倍 wall-clock**（多组并行设计白费）
- 用 `wait:false` → 每个 start 立即返回 `subagentId`，任务进入**后台并发池**（默认 `maxConcurrent=4`）真并发跑

完成后由 **notifier** 经 `deliverAs: "followUp"` 在当前 streaming turn 结束后唤醒主 agent 处理结果——**不需轮询、不需 sleep**。

### 派发模板（多组并行必用）

```
# 同一消息内发 N 个 start（每个 wait:false），依次启动后全部进入后台并发池：
subagent(action:'start', startParam:{ agent: "general-purpose", wait:false, task: "<组1 task>" })
subagent(action:'start', startParam:{ agent: "general-purpose", wait:false, task: "<组2 task>" })
# ... 组 N
# 各 start 返回 subagentId 后，STOP——不要轮询/sleep。
# notifier 在组完成时自动唤醒主 agent 汇总结果。
```

**必须 `wait:false`**。逐个 `wait:true` 会让「3 组并行」退化成串行 3 倍 wall-clock，多组并行设计失去意义。

### 何时用并行 vs 串行

| 场景 | 派发方式 | 理由 |
|------|---------|------|
| 多组认知帧并行（②3组/④N组/⑤5组/Step6对齐‖红队） | **同消息 N×`wait:false`** | 认知帧正交、读取材料独立，真并发 |
| 单组追踪（L1 降级 / 单 agent 串行档） | 单个 `wait:true` | 无并行对象，sync 简单 |
| 有依赖的串行步骤（Step2→Step4 收敛复核） | `wait:true` 逐个 | Step4 依赖 Step2 结果，无法并行 |

### 已知限制：后台 subagent 静默 hang 无兜底

notifier 只在 subagent **完成/失败**时唤醒。但 subagent 可能**静默 hang**（推理卡住/连接中断）——既不完成也不失败，notifier 永不触发，主 agent 在 STOP 醒不过来。

**当前无平台级兜底**——Pi 核心工具仅 `read/bash/edit/write/grep/find/ls`，无定时唤醒机制。主 agent 只能在**用户推进下一个 turn 时**调 `subagent(action:list)` 排查（非规范保证，是偶发救场）。根治需 subagents extension 加 heartbeat（未落地）。

**实践取舍**：并行追踪/审查场景仍用 `wait:false`（并发收益大于 hang 风险，hang 是低概率）；但任务预估很短（如纯只读 review ≤60s）或无并行需求时，优先 `wait:true`（hang 时主 agent 同步阻塞、至少在 turn 边界可见）。

## 复杂度自评与降级档位（设计开始时判定一次，驱动全程）

设计工作流默认按「标准档」执行全流程。但简单需求走全流程是浪费（标准档 20-40 个 subagent 派发）。本节定义统一复杂度判定 + 三档降级，**收敛各阶段散点的降级判据**——主 agent 在 init/首次进入时判定一次档位，后续各阶段读档位自动降级，不必逐阶段自行判断。

### 复杂度自评（6 信号 → 三档）

init 阶段或首次进入设计工作流时，主 agent 按下表打分（每信号低/中/高=1/2/3 分），总分映射档位：

| 信号 | 低（1） | 中（2） | 高（3） |
|------|---------|---------|---------|
| 系统数 | 单系统 | 多模块单系统 | 多系统/跨组织 |
| 用例数 | ≤5 | 6-15 | >15 |
| NFR 高风险维度 | 0-1 | 2-3 | ≥4（高并发/安全/合规） |
| 技术选型开放度 | 栈已定 | 部分开放 | 全开放 greenfield |
| Wave 数（预估） | ≤2 | 3-5 | >5 |
| 领域成熟度 | 团队熟悉 | 部分新领域 | 全新领域 |

- **总分 6-8 → 轻量档（L1）** | **9-14 → 标准档（L2，默认）** | **15-18 → 重型档（L3）**

判定结果写入 `_progress.md` frontmatter：`complexity_tier: L1|L2|L3`。各阶段 Step 1.0 读此字段驱动降级。用户可覆盖主 agent 判定（判定后 ask_user 确认一次）。

### 三档执行矩阵（驱动各阶段降级）

| 动作 | 轻量 L1 | 标准 L2（默认） | 重型 L3 |
|------|---------|----------------|---------|
| context-builder（Step 1.0） | 跳过，主 agent 直读 decisions.md + 本阶段「Step 1 必问决策点」引用的上游章节 | 派（重型模式） | 派 |
| 追踪 subagent（Step 2） | 单 agent 串行（不拆认知帧） | 按各阶段认知帧并行 | 并行 + 多轮收敛 |
| 禁读重建帧 | 跳过（**⑤test-matrix 重建除外——不降级**） | 各阶段已定义重建帧执行 | 全执行 |
| review（Step 6） | 单组（review_mode: single） | parallel（对齐组 + 红队组） | parallel |
| max-rounds | 1 | 3（Stagnation 保底） | 5 |

> **round 颗粒度定义（消除歧义）：** 1 round = 一次「Step 2 追踪 + Step 3 分流 + Step 4 收敛复核」的 fresh subagent 派发。max-rounds 指「追踪循环」的迭代上限（Step3 有新 gap → 回 Step2 重跑）。
> - **L1（max-rounds=1）：** Step 2 单 agent 串行追踪一轮后**直接进 Step 5 定稿**，跳过 Step 4 收敛复核（L1 单 agent 已自带收敛，无需二次 fresh 复核）；有新 gap 则 Step3 分流后直接进 Step5（不回 Step2）。
> - **L2（max-rounds=3）/ L3（5）：** 完整 Step2→3→4 循环，Step4 收敛复核后无新 gap 才进 Step5；有新 gap 回 Step2，直到收敛或触发 Stagnation。

### 不降级的硬约束（即使 L1 也必做）

1. **decisions.md 机制**——决策持久化不降级（L1 也要创建/读/append，否则 compact 丢决策）
2. **⑤code-arch 的 test-matrix 禁读重建帧**——测试遗漏是事故重灾区，重建是对抗它的唯一手段
3. **Step 6 独立审查**——质量门不降级（L1 也派 fresh subagent，至少 single 组）
4. **gate 校验**——交付物 + verdict:pass + review APPROVED 不降级

### 各阶段如何接入

各阶段原有的散点降级判据（architecture 的「CRUD 降到 2 组」、code-arch 的「4 帧降单 agent」等）**统一由档位驱动**：L1 直接走矩阵的「单 agent 串行」，L2/L3 按各阶段认知帧设计。各阶段 SKILL 的 Step 1.0 读 `complexity_tier` 后，按本矩阵执行——不再逐阶段自判。

## Step 1: 主 agent 交互 + 写初稿

[MANDATORY] 本阶段 Step 1 由三部分组成：① **读决策账本建立工作上下文**；② 向用户 grilling **必问决策**；③ 对可代码自决的部分直接产出。三者都要做，不能只做②③（只扫代码+套启发式写初稿 = 绕开用户）。

### Step 1.0（开篇第一动作）：读决策账本，建立工作上下文

[MANDATORY] 进入 grilling 前，主 agent 必须先获取「已确认决策」——这是对抗主 agent context 被 compact 的第一道防线。决策从文件读，不依赖对话痕迹。

**两种获取方式（按上游体量二选一）：**

- **轻量模式（L1，上游极少如 ①clarity 无上游 / ②单上游且短）：** 主 agent 直接 `read {topic_dir}/decisions.md`（全读）+ 本阶段 SKILL「Step 1 必问决策点」直接引用的上游章节（grep 章节号定位，非全读上游）。不开 context-builder。**「少量上游」= decisions.md 全读 + 必问决策点引用的章节**，不是随意挑几个。
- **重型模式（上游多，architecture 及之后各阶段）：** 主 agent 派 **context-builder subagent**（fresh），规范详见 `references/context-builder.md`（输入/输出 4 段摘要 schema/task prompt 模板/失败兜底）。输入=`decisions.md` + 相关长期文档 + 上游 .md，输出=**阶段工作摘要**（注入主 agent context）：
  - **不可推翻的决策清单**（从 decisions.md 提取 status=confirmed 的 D-不可逆决策，带 ID）
  - **本阶段设计树入口**（从上游 .md 推导本阶段该遍历的节点）
  - **与上游的接口契约**（本阶段必须遵守的 grep 规则/Port/不变式）
  - **相关长期约束**（跨 topic 硬约束）

> **为何要压缩传递：** 主 agent 直接裸读全部上游 .md 会 context 爆炸→compact→丢「用户在②确认过 X」的对话痕迹。把原料压缩成摘要注入主 agent，既轻量，又让已确认决策从文件重新进入上下文。摘要可从 decisions.md+长期文档随时重新生成，所以主 agent 即使 compact，重派 context-builder 即可恢复——状态从「对话痕迹（易丢）」转为「文件派生（可再生）」。

**grilling 时禁止重新确认已 confirmed 决策：** Step 1.0 拿到的不可推翻决策清单，grilling 不得重新当问题抛给用户。有新证据需推翻，走 Step 6b 反哺流程（D-不可逆须 ask_user），不在 Step 1 重开。

### Step 1.1 向用户 grilling 必问决策


**提问纪律（4 条）：**

1. **沿本阶段设计树遍历** — 逐节点推进，解决父节点再问子节点，不跳跃
2. **每问附推荐答案 + 理由** — 给强观点，用户可采纳/修正/推翻，不甩空问题
3. **一次一个问题** — 用 `ask_user`，不一次抛多个
4. **能查代码答的就 dispatch 只读 subagent 查，不问用户** — 问用户的只限于：业务意图、取舍偏好、风险容忍、不可逆的根本选择

**「该问用户」vs「agent 自决」的分界线（关键，防止 agent 读代码自决后绕开用户）：**

- ❓ **必须 ask_user**：决策不可逆（分层/状态机/领域边界/根本架构选择）、取舍涉用户偏好（长期 vs 成本）、风险容忍度、未来计划 —— 这些代码答不了
- ✅ **agent 自决（定稿时暴露给用户）**：有明确启发式、代码可验证、可逆的小决策 —— 直接产出，审查/定稿让用户看到

**何时停止提问：** 每个必问决策点都有用户拍板的答案，无"大概是/应该可以/这取决于"。**本阶段具体必问哪些**见各 SKILL.md 的「Step 1 必问决策点」——这是各阶段 SKILL.md 必须提供的章节。

### Step 1.2 即时落盘决策到 decisions.md

[MANDATORY] 每个 D 类决策在 grilling 中经 ask_user 拍板（或 agent opinionated 定稿）后，**主 agent 立即 append 一条到 `{topic_dir}/decisions.md`**，不等阶段结束。即时持久化让后续 fresh subagent 读到的 decisions.md 永远是最新的。

**decisions.md 是本 topic 的一等持久化载体**（append-only 决策账本）。每条决策字段：

| 字段 | 必填 | 说明 |
|------|------|------|
| `id` | 是 | 稳定标识符 D-001 递增 |
| `decision` | 是 | 用户/agent 拍板的结论（一句话） |
| `rationale` | 是 | 为什么这么定，附被采纳/被否方案的关键取舍 |
| `classification` | 是 | `D-不可逆` / `D-可逆`（决定能否被 agent 自行 revisit） |
| `confirmed_by` | 是 | `ask_user` / `agent-opinionated`（定稿暴露给用户） |
| `stage` | 是 | 在哪个阶段拍板（clarity/architecture/.../execution） |
| `source` | 是 | 溯源 `[from: {topic} §{章节}]`，回查 .md 原文。**grilling 即时 append 时初稿未写、章节未定稿，先填 `§TBD`；Step 5a 定稿时补实际章节号**（source 是双向引用键，必须最终指向真实章节） |
| `status` | 是 | `confirmed` / `revisited`（被新证据推翻并重新确认） |
| `superseded_by` | 否 | 若被 revisit，指向新决策 id |

**append-only 纪律：** 新决策追加新行；已 confirmed 决策**禁止原地覆盖**（保审计链）。推翻走 revisit：原行 `status→revisited` + `superseded_by` 指向新行，新行追加带 `[REVISIT of D-NNN]` 溯源。

**首个阶段（①clarity）负责创建空 decisions.md**（直接用 `design-clarity/references/decisions-template.md` 骨架），后续阶段 append。

### Step 1.3 写初稿

提问 + 自决 + 落盘完成后写初稿。**初稿不追求完整**——遗漏由 Step 2 发现。

> 完整 Grilling 方法论（设计树展开法、Question Hierarchy Layer 1/2/3、relentless 详解）见 `loop-method.md`，clarity 阶段首次 read。

Announce at start: "我正在使用 {skill-name} skill 来 {本阶段目标}。"

## Step 2: 派 fresh subagent 追踪

[MANDATORY] 主 agent 不自己做追踪。

> **[MANDATORY 派发前替换占位符]** task prompt 模板里的 `{...}` 是占位符，派发前主 agent 必须全部替换为实际值，不能把字面 `{xxx}` 注入 subagent（fresh subagent 无对话上下文，收到字面占位符会报路径不存在且无法自修）：
> - `{skill_dir}` / `${SKILL_DIR}` = 本 SKILL 目录绝对路径（SKILL.md 的 dirname）
> - `{topic_dir}` = `.xyz-harness/{topic}/` 绝对路径
> - `{N}` = 当前 loopRound（从 design_status get-phase 读）
> - `{upstream_deliverables}` = 本阶段上游 .md 路径列表（如 architecture 阶段 = requirements.md）
> - `{final_deliverable_md}` = 本阶段定稿 .md 路径

**派发配置：** Agent=general-purpose，Context=**fresh**（隔离，不继承对话历史），读取=本阶段 perspectives 文件 + 初稿 + 上游交付物 + **`decisions.md`（必读，作为 context 参数注入）** + 相关源码，产出=`changes/tracing-round-{N}.md`。

> **[多组并行派发]** 本阶段若按复杂度档位拆多组认知帧并行（②3组/④N组/⑤5组），**必须用 `wait:false` 同消息多 start**——见上方「subagent 派发工程规范」。逐个 `wait:true` 会让并行退化成串行 N 倍 wall-clock。

> **[MANDATORY] decisions.md 必须作为 subagent 的 `context` 参数注入，不能仅在 task prompt 里文字提及。** context 参数是 subagent 启动即载入的强制材料，优先级高于 task prompt 的文字指令——这是「已确认决策能被 fresh subagent 看见」的机制保证。

**Task prompt 模板：**

```
你是独立追踪 subagent。上下文与主 agent 隔离——只根据以下材料独立追踪：
1. read {perspectives_file}（本阶段追踪视角模板）
2. read {deliverable_path}（初稿）
3. read {upstream_deliverables}（上游交付物）
4. 按需 read 相关源码验证事实

**决策账本纪律（关键，防重复确认）：**
- context 参数中注入的 decisions.md 里 status=confirmed 的决策，是用户已拍板的结论。
- **已 confirmed 决策不得当 gap 重报。** 若你的追踪发现某处与已 confirmed 决策冲突，
  那是初稿偏离了决策（记 gap 指向初稿），不是决策本身有问题——不要建议重开决策。
- 只有当你有**下游新证据**能证明某 confirmed 决策已不成立时，才标 `[REVISIT of D-NNN]`
  + 附上新证据，走 Step 6b 反哺流程（D-不可逆的 revisit 须主 agent ask_user，你不能自改）。
  这不是 gap，是反哺信号。

按视角逐一追踪，卡住的地方就是 gap。每个 gap 标注类型（F/K/D）和具体问题。
将结果写入 {topic_dir}/changes/tracing-round-{N}.md。
```

**关键：必须显式传 fresh context。** 继承对话历史会带着同样的预设和盲区。

## Step 3: gap 分流（F/K/D）

主 agent 收到 gap 列表后回到交互上下文，按类型处理：

- **F 类（Fact）— 二次确认（关键）**：F 是客观事实，subagent 可能误报（看错代码/旧代码废弃）。主 agent 拿对话上下文判断：两边都确认→转问用户；主 agent 否定→丢弃。过滤误报，避免基于废弃代码的错误提问打扰用户。
- **K 类（Knowledge）— 直接问用户**：生成具体、有上下文的问题。
- **D 类（Decision）— 细分两种**：
  - **D-不可逆**（分层、状态机、领域边界、根本架构选择、触发 DESIGN-IT-TWICE 的根本选择）→ 生成方案对比后 **必须 ask_user**，不能 agent 给完 opinionated 推荐就记录
  - **D-可逆**（命名、小重构、可逆实现细节）→ agent 可 opinionated 决策 + 理由，定稿时暴露给用户

处理完所有 gap 更新初稿，进入 Step 4。

## Step 4: 收敛复核

再派一次独立 subagent（同 Step 2 配置，fresh context）重新追踪。**Task prompt 在 Step 2 模板末尾追加：**

```
本轮是收敛复核（Round {N}）。除了按视角追踪外，还要执行收敛判定：
如果追踪无新 gap，在 tracing-round-{N}.md 顶部标注 `CONVERGED` 并列出已追踪的视角。
```

**收敛判定：** 无新 gap → CONVERGED，进 Step 5；有新 gap → 回 Step 3。停止条件由独立 subagent 判定。

## Step 5: 定稿 + 渲染 HTML

### 5a. 主 agent 定稿 .md

1. 从初稿 + 已解决 gap 整理最终文件
2. 已解决 D 类 gap → **两处同步写**（分层分工，方案 2）：
   - **各 .md 的决策记录章节**：写**完整推理**（背景 / 备选方案 / 取舍理由 / 后果）——这是决策的上下文载体，给人读
   - **decisions.md**：写**权威索引**（ID + 一句话决策 + classification + confirmed_by + 溯源 `[from: {topic} §{章节}]`）——给机器查、给跨阶段引用。Step 1.2 已在 grilling 时即时 append；定稿时核对 decisions.md 的每条溯源确实指向本 .md 的实际章节（防止即时 append 时的章节号漂移）
   - **两者关系 = 索引 vs 展开**，语义不重复：decisions.md 是可 grep 的扁平账本，.md 决策章节是带论证的叙述。decisions.md 的 `source` 字段是两者的连接键——机器校验以此验双向引用不断
3. `[UNRESOLVED]` gap → 标注 `[AMBIGUOUS]` 显式列出
4. frontmatter 含 `verdict: pass`
5. Ambiguity Marking：扫描模糊语言（「快速」「合理」「大量」）标记 `[AMBIGUOUS]`

### 5b. 派 fresh subagent 渲染 HTML

[MANDATORY] **HTML 渲染下沉 fresh subagent，主 agent 不 write HTML 全文。** 渲染由本包内置的 **design-visual-explainer** 技能承担——它内置自包含 HTML 生成、Mermaid 渲染（带 zoom/pan）、drawio 集成（复杂架构）、CSS 配色与模板，比手写更可控。无需额外安装。

**派发配置：** Agent=general-purpose，Context=**fresh**，加载=design-visual-explainer skill，读取=刚定稿 `{deliverable}.md`，产出=`.xyz-harness/${主题}/{deliverable-name}.html`（write）+ `open` 打开。

**Task prompt 模板：**

```
你是独立渲染 subagent。上下文与主 agent 隔离。用 design-visual-explainer 技能把定稿渲染成自包含可视化 HTML：

**前置：** 加载 design-visual-explainer skill（本包内置，无需安装）。
1. read {final_deliverable_md}（定稿，真相源）——HTML 只做可视化呈现，不产生新内容
2. 按 design-visual-explainer 的 workflow 生成 {deliverable-name}.html：
   - 主角图（hero，紧随 header 最显眼位置）= {本阶段主角图表}——见各 SKILL.md Step 5 标注 + design-visual-explainer SKILL.md 的「各阶段主角图规范」表
   - 配一段 TL;DR（3-5 行核心结论），让人不滚动就能 grasp 要点
   - .md 的 Mermaid 代码块必须渲染成实际图表（不是 <pre> 源码）
3. 自检：Mermaid 语法正确渲染 / 无 {占位符} / 无空章节 / TOC 锚点无死链 / UTF-8 中文正常
4. 写到 .xyz-harness/${主题}/{deliverable-name}.html，用 `open`（macOS）/`xdg-open`（Linux）/`start`（Windows）打开
5. 向主 agent 只返回：html 路径 + 自检结果（✅全过/❌哪几项）+ 一行 TL;DR
不要返回 HTML 全文，不要返回渲染推理过程。
```

**各阶段主角图表（subagent 生成时对齐）：**

| 阶段 | 主角图（hero） |
|------|---------------|
| ① 澄清需求 | 用例图（Actor × 用例 × 系统边界） |
| ② 系统设计 | 分层架构图 + 状态机图 |
| ③ Issue 拆分 | 决策 DAG 图（节点=issue，边=blocked_by，状态色标） |
| ④ 非功能设计 | 风险矩阵热力图（issue × 7 维度，✅⚠️❌ 着色） |
| ⑤ 代码架构 | 包依赖图 + 核心时序图 |
| ⑥ 执行计划 | Wave 依赖 DAG 图（节点=Wave，标注并行组） |

### 5c. 主 agent 处理返回

向用户说明：「已生成 `{deliverable-name}.html` 并在浏览器打开。请关注 {本阶段主角图表}。如需调整告诉我，否则进入 Step 6。」用户反馈当 gap 处理，更新定稿后重新派 subagent 渲染。

### 5d. 机器检查前置自检（初稿后立即跑，提前消灭低级硬伤）

[RECOMMENDED] **初稿写完后（各阶段 Step 1 末），主 agent 立即自跑本阶段的机器检查脚本。** 时机统一为「初稿后」（非定稿后）——初稿后跑反馈更早；定稿后的硬伤由 Step 6 审查 subagent 复跑兜底（不取消最终门）。 把占位符/缺章节/幽灵引用/集合差集等低级硬伤的反馈环从「Step6 审查 → 回 Step3 → Step4 → Step5 → Step6」缩到「Step5 当场修」。审查 subagent 仍复跑一次做最终门（**不取消**，硬阻断铁律不变）。

```bash
python3 ${SKILL_DIR}/scripts/check_{phase}.py {topic_dir}
```

- exit 0 → 进 Step 6（审查 subagent 仍会复跑确认为最终门）
- exit 1 → 看脚本报告 `changes/machine-check-{phase}.md`，当场修低级硬伤（不进 Step 6），修完重跑直到 exit 0

**与 Step 6 审查的分工：** Step 5d 只杀机器可证的**结构**硬伤（快、主 agent 自跑、不阻塞交接）；Step 6 才是**质量门**（红队反过度设计等语义判断，fresh subagent 跑）。两者不替代。

## Step 6: 独立审查 + 交接

[MANDATORY] 定稿后必须过独立审查（质量门）。审查判质量（不是找 gap）；追踪 vs 审查区别详见 `loop-method.md`。
**审查分两层：先跑机器检查脚本（硬阻断），后做 6 维 LLM 审查。** 审查 subagent 规范见 `review-agent.md`。

**【并行提速】6 维拆 2 组并行认知帧（红队独立 fresh context）。** 6 维不是天然一个任务——**红队维度（必要性与比例性，反过度设计）与其余 5 维认知方向相反**（一个删/质疑，一个补/对齐），塞进同一 context 串行会 confirmation bias 沿维度链累积（前半程补完 gap，后半程要删时心态已偏向「刚补的是必要的」）。拆成 2 组并行 fresh subagent，各跑正交认知帧，盲区更少、wall-clock 更短。审查 subagent 规范见 `review-agent.md`。

**派发配置（2 组并行）：** Agent=general-purpose，Context=**fresh**，两组读取材料不同（见下表），产出各写一份。两组都先跑 Step 0 机器检查（同一脚本，谁先跑都行）。

> **[并行派发]** 2 组用 `wait:false` 同消息派发（见上方「subagent 派发工程规范」）。两组完成由 notifier 唤醒主 agent 汇总，不需轮询。

| 组 | 认知帧 | 跑的维度 | 读取材料 | 产出文件 |
|----|--------|---------|---------|---------|
| **对齐组** | 对齐/补齐（与设计同向） | 内部一致性 / 上游对齐 / 可执行性 / 完整性 / 可视化质量（5 维） | `review-agent.md` + 定稿 .md + .html + 上游交付物 + CONTEXT.md | `changes/review-{phase-slug}.md`（主报告）|
| **红队组** | 反过度设计（与设计反向） | 必要性与比例性（1 维，独立 fresh context） | `review-agent.md` + 定稿 .md + 上游交付物（可执行性判断需要）+ {⑤: 骨架代码} | `changes/review-{phase-slug}-redteam.md`（红队报告）|

> **交叉验证机制（红队 × 对齐冲突）：** 红队组说「某 port/层该删」、对齐组说「该 port 是上游对齐必需」——两组独立命中同一对象但结论相反，标 `[CROSS-VALIDATED]` 转主 agent。主 agent 判断：若涉及 D-不可逆决策（分层/状态机/领域边界）→ **必须 ask_user**，不能 agent 自判；其余主 agent 按「事实性矛盾」原则裁决。范式同 Step2 追踪的 `[CROSS-VALIDATED]`。

**Step 0（机器检查，两组最先做，硬阻断）：** 任一组先跑对应阶段的机器检查脚本：

```bash
python3 ${SKILL_DIR}/scripts/check_{phase}.py {topic_dir}
```

脚本输出 `changes/machine-check-{phase}.md` + 退出码。**exit 1（机器检查 FAIL）= 两组都直接判 CHANGES_REQUESTED，不许 APPROVED（硬阻断）**——机器可证伪的硬伤（缺章节/占位符/引用断裂/骨架反模式）不存在"审查认为可以过"。exit 0 才进各自的维度审查。

**Task prompt 模板（对齐组）：**

```
你是独立审查 subagent（对齐组）。上下文与主 agent 隔离。审查定稿的 5 个客观维度：

**Step 0（机器检查，硬阻断，最先做）：**
0a. read `review-agent.md`（审查规范，与本文件同目录 `design-shared/references/`）
0b. 跑 `python3 {skill_dir}/scripts/check_{phase}.py {topic_dir}`
0c. exit 1 = 机器检查 FAIL → 直接判 CHANGES_REQUESTED，把 machine-check-{phase}.md 的 ❌ 当"必须修改"，不许 APPROVED（硬阻断）
0d. exit 0 才进下面的 5 维审查

**Step 1（5 维客观审查，机器全过后才做）：**
1. read {final_deliverable_md}（定稿）
2. read {final_deliverable_html}（可视化页面）
3. read {upstream_deliverables}（所有上游交付物，对齐检查）
4. read 项目根 CONTEXT.md（统一语言对齐）

从 5 维审查（**不跑红队维度，那是红队组的活**）：
- 内部一致性 / 上游对齐 / 可执行性 / 完整性 / 可视化质量

判定：APPROVED（机器检查 PASS + 5 维均过或仅 cosmetic）/ CHANGES_REQUESTED（机器检查 FAIL，或任一维实质问题）。
报告写入 {topic_dir}/changes/review-{phase-slug}.md（frontmatter 含 verdict + machine_check）。
格式：## Verdict / ## 机器检查结果 / ## 维度评估（5 维 ✅⚠️❌）/ ## 必须修改 / ## 可选改进
```

**Task prompt 模板（红队组）：**

```
你是独立审查 subagent（红队组）。上下文与主 agent 隔离，**与对齐组也隔离**。你只跑 1 个维度——**必要性与比例性（红队维度，反过度设计）**。

**Step 0（机器检查，硬阻断，最先做）：** 跑 `python3 {skill_dir}/scripts/check_{phase}.py {topic_dir}`。**两组各跑一次**（机器检查幂等，重复跑无害，不依赖复用对齐组结果——并行模式下对齐组未必跑完）。exit 1 → 直接判 CHANGES_REQUESTED。

**Step 1（红队维度审查）：**
1. read `review-agent.md` 的「必要性与比例性」节
2. read {final_deliverable_md}（定稿）
3. read {upstream_deliverables}（判断某决策是否真必需）
4. {⑤: read 骨架代码}（验证 port/adapter 是否真接 SDK）

站在「这个设计过度/不合理」的反方立场质询：
- 对每个 port/adapter/interface：「删掉它会怎样？最小可行版本是什么？」(deletion test)
- 对每个 D-不可逆决策：「这是真不可逆，还是 agent 没找到可逆方案？」
- 对分层深度：「核心计算真的复杂到需要这层吗？三层够不够？」

判定：若认为某决策过度设计，即使其他 5 维全过也标 CHANGES_REQUESTED + 注「建议降级为 X」。
报告写入 {topic_dir}/changes/review-{phase-slug}-redteam.md（frontmatter: verdict: APPROVED|CHANGES_REQUESTED, machine_check: PASS|FAIL, dimension: redteam）。
格式：## Verdict / ## 过度设计发现（每条：对象 + deletion test 结论 + 建议降级方案）/ ## 必须修改
```

**结果处理：**
- 两组都 APPROVED → 进 Step 6b 反哺检查
- 任一组 CHANGES_REQUESTED → 该组「必须修改」当 gap 回 Step 3，更新后重走该组审查（另一组若已 APPROVED 不必重跑）
- [CROSS-VALIDATED] 冲突 → 主 agent 判断，D-不可逆必须 ask_user

**轻量项目降级：** 本阶段交付物体量小（如 ③issues.md 仅决策图），红队维度常无可质询对象，可降级为单组审查（红队维度合进对齐组 context，强制「先 5 维补 → redact → 再红队删」内部顺序）。是否降级由主 agent 按交付物复杂度判断，并在 review 报告 frontmatter 标 `review_mode: single|parallel`。

## Step 6b: 上游反哺检查（审查 APPROVED 后、交接前）

[MANDATORY] 审查 APPROVED 后，交接前必须做上游反哺——检测本阶段是否引入了与上游矛盾的结论，若有则反哺修订上游 .md，保证文档一致性。

**派发配置：** Agent=general-purpose，Context=**fresh**，读取=本阶段定稿 .md + 所有上游交付物 + CONTEXT.md，产出=`changes/backfeed-round-{N}.md`。

**Task prompt 模板：**

```
你是独立反哺检查 subagent。上下文与主 agent 隔离。检测本阶段定稿是否引入与上游矛盾的结论：
1. read {final_deliverable_md}（本阶段定稿）
2. read {upstream_deliverables}（所有上游交付物）
3. read 项目根 CONTEXT.md
4. read {topic_dir}/decisions.md（决策账本——上游已拍板决策的权威索引）

逐上游 .md 核对：本阶段是否有结论与上游已拍板的事实/决策矛盾？
常见矛盾类型：
- ②aggregate 边界划错了 → ⑤代码架构发现需调整
- ③某 issue 方案在 ④副作用分析后发现不可行
- ④某缓解项的落地方式与 ⑤签名表不符
- ⑤骨架验证发现 ②某决策（如分层）在代码层走不通

将矛盾写入 {topic_dir}/changes/backfeed-round-{N}.md，每条标注：
- 涉及的上游 .md + 章节位置
- 矛盾描述（上游说什么 vs 本阶段发现什么）
- 建议修订（修订成什么）
- 是否涉及 D-不可逆决策（涉及则标 NEEDS_USER_CONFIRM，不能 agent 自改）
```

**反哺纪律（关键，防滥用）：**

1. **只修订「事实性矛盾」或「设计假设被下游证伪」** —— 不因「下游有更好的想法」就改上游。上游是用户拍板的真相源，下游发现「更优方案」不构成反哺理由，只有「上游结论在下游被证明不成立」才反哺。
2. **每处反哺必须可追溯** —— 上游 .md 修订处在行内标注 `[BACKFED from {阶段} on {yyyy-MM-dd}] {修订原因}`，并在上游 frontmatter 的 `backfed_from:` 追加本阶段标识。
3. **D-不可逆决策 → 必须 ask_user** —— 反哺若涉及上游的 D-不可逆决策（分层/状态机/领域边界/根本架构选择），**不能 agent 自改**，标 `NEEDS_USER_CONFIRM`，由主 agent ask_user 重新确认后才修订。
4. **[MANDATORY] decisions.md 与上游 .md 同步更新** —— 反哺修订上游决策时，必须同步更新 `decisions.md`：原决策 `status→revisited` + `superseded_by` 指向新决策，新决策 append 带 `[REVISIT of D-NNN]` 溯源 + `confirmed_by: ask_user`（D-不可逆）。这防止上游 .md 与 decisions.md 漂移——两者是同一决策的不同抽象层（.md 保完整推理，decisions.md 保权威索引），必须一起动。
5. **反哺后回流** —— 上游 .md 更新后，本阶段可能需重新对齐 → 回 Step 2 重追踪（Phase Loop 已含此条）。
6. **反哺只改内容，不改 phase 状态** —— design_status 的 phase 状态是「流程进度」语义（已走到哪一步），completed 不可回退。反哺修订的是上游 .md 的**内容**和 decisions.md，不回退上游 phase 的 completed 状态——内容修订不等于「流程没走完」。反哺后内容与状态的最终一致性由下游 ⑥execution 的 consistency-check 终检对账兜底（维4 决策一致性以 decisions.md 为准）。这避免「反哺触发 phase 回退→重新过 gate→级联」的复杂度。

**结果处理：** 无矛盾 → 交接；有矛盾（非 D-不可逆）→ 主 agent 按建议修订上游 .md + 本阶段重对齐；有 D-不可逆矛盾 → 主 agent ask_user 确认后再修订。

**交接（反哺检查通过后）：**

```
✅ {当前阶段名} 已完成并通过独立审查。
   产出：{deliverable}.md + {deliverable}.html
   审查报告：changes/review-{phase-slug}.md（verdict: APPROVED）
下一步：{第 N+1 步名称} — {一句话目标}
调用：/{next-skill-command}
是否现在进入下一步？
```

用户确认后才加载下一 skill。最后一个阶段（⑥执行计划）交接目标变为「编码实现」。

### 跨会话续作（推荐）

[OPTIONAL] 每个阶段结束是天然换会话点——把累积上下文重置回基线，让下阶段从干净状态开始（「单阶段 150K」变成「整个工作流也只占 150K」，零代码改动）。换会话前主 agent 向 `.xyz-harness/${主题}/_progress.md` 写进度交接（每阶段覆盖更新）：

```markdown
# 设计进度 — {主题}
**当前阶段：** {第 N+1 步名称}（下一步执行）
**主题目录：** `.xyz-harness/${yyyy-MM-dd}-${主题}/`
## 已完成阶段
| 阶段 | 交付物 | 审查 |
|------|--------|------|
| ①澄清需求 | requirements.md (+.html) | ✅ APPROVED |
## 下阶段必读
- 下阶段 SKILL.md（load 对应 skill）
- 本主题全部上游交付物（见上表，均在本目录）
## 不可推翻的决策（从 decisions.md 读取，不再 grep 提取）
- **直接 read `{topic}/decisions.md` 取 status=confirmed 且 classification=D-不可逆 的决策**（权威源，即时维护）
- decisions.md 是一等持久化载体，每条决策含 ID/rationale/confirmed_by/溯源；不再从各阶段 .md frontmatter + 决策记录章节事后 grep（grep 是事后提取、易漏，decisions.md 是即时 append、不漏）
```

新会话主 agent 只 read `_progress.md`（进度）+ `decisions.md`（决策）即可接上。

> **决策来源改为 decisions.md（改动8修订）：** 原方案从各阶段 .md frontmatter + 决策记录章节 grep 提取「不可推翻的决策」，但 grep 是事后提取、依赖 .md 决策章节格式、易漏。现已改为 decisions.md 即时 append 的权威载体（见 Step 1.2）。`_progress.md` 的决策一节直接引用 decisions.md，不再自己 grep 存一份——消除双份维护的漂移风险。进度部分（已完成阶段表）仍由 _progress.md 维护。

### 阶段状态追踪（design_status tool / CLI）

> **[RECOMMENDED]** 用 `design_status` 追踪 7 阶段状态，替代手写 `_progress.md` 的进度部分。
> 它是**权威状态机**：阶段线性依赖（防跳阶）+ complete_phase 自动校验交付物 gate（防伪造完成）。
> `_progress.md` 降级为其状态的可读快照（跨会话交接用，每次 complete_phase 可选同步生成）。

**优先用 tool，无 tool 用 CLI。** 两者调同一批约束/gate 逻辑（单一真相源），语义完全一致：
- **Pi 环境**（有 `design_status` tool）：调 tool —— `design_status(action: start_phase, phase: {本阶段})`
- **无 tool 环境**（Claude Code / Cursor / 纯 shell）：调 CLI —— `design-status start-phase {本阶段}`
  - 已装 bin（`npm link` / `npm i -g`）：直接 `design-status <command>`
  - 未装 bin：`npx @zhushanwen/pi-design-status <command>`

各阶段 SKILL.md 在两处调：
- **Step 1 开头**：`start_phase {本阶段}` 标记开始（会校验前置阶段是否 completed）
- **Step 6 审查 APPROVED 后**：`complete_phase {本阶段}` 收尾——自动验交付物存在 + verdict:pass + review APPROVED，过了才标 completed，否则拒绝并告缺什么

> **为什么用它而非手写 _progress.md**：「完成状态」从交付物派生（不是 agent 主观写），无法伪造「做完了」；
> 阶段状态机约束（completed 不可回退、不可跳阶）被强制，agent 无法绕过 gate。
> 提示词不暴露存储实现（json），tool action / CLI command 即全部接口。

#### CLI 完整用法（无 tool 环境参考）

```bash
# 概览 / 单阶段详情（只读）
design-status get-status                            # 7 阶段状态 + 进度 + open gaps
design-status get-phase <phase>                     # 单阶段：step/round/gaps/gate 校验结果

# 阶段流转（会改状态，受状态机约束）
design-status start-phase <phase>                   # 开始阶段（校验前置 completed，防跳阶）
design-status advance <phase> <step> [--note ...]   # 推进 loop step（step 单调前进，不能倒退）
design-status review-phase <phase>                  # 标记进入 Step 6 审查（in_progress → under_review）
design-status complete-phase <phase>                # 收尾（强制校验交付物 gate，过了才标 completed）

# 追踪发现（会改状态）
design-status log-gap <phase> <gap_id> -c F|K|D -s open|resolved [-d "描述"]
```

**参数：**
- `<phase>` = `init | clarity | architecture | issues | nfr | code-arch | execution`
- `<step>` = `1 交互初稿 / 2 追踪 / 3 gap分流 / 4 收敛 / 5 定稿 / 6 审查 / 6b 反哺`
- `-c` gap 分类：`F`(二次确认) / `K`(直接问用户) / `D`(agent 自决)
- `-s` gap 状态：`open` / `resolved`

**输出惯例：** 成功 → stdout（exit 0）；约束拒绝/错误 → stderr（exit 1，shell 脚本可判断）。

**运行前提：** 在含 `.xyz-harness/{topic}/` 的项目根运行（自动检测最近修改的 topic）。无则报错提示先 `/design-init`。

**示例（一次完整阶段流转）：**
```bash
design-status start-phase clarity        # Step 1 开始
design-status advance clarity 2          # 进 Step 2 追踪
design-status log-gap clarity G1 -c K -s open -d "需确认支付渠道"
design-status advance clarity 6          # 进 Step 6 审查
design-status review-phase clarity       # → under_review
design-status complete-phase clarity     # 校验 requirements.md + review APPROVED → completed
design-status get-status                 # 看全貌
```

## Stagnation 保底

连续 3 轮追踪 gap 数量不降（新发现 ≥ 已解决），强制收敛。**触发后的下一步（消除歧义）：**
1. **主 agent ask_user 确认是否拆分 topic** —— Stagnation 是「设计可能过大」的强信号（当前设计树超出单 topic 承载）；若用户同意拆分，当前未解决部分标记延后，另开 topic
2. **不拆分则强制收敛** —— 未解决 gap 标 `[UNRESOLVED]`，**直接进 Step 5 定稿**（不回 Step 2 重跑）；`[UNRESOLVED]` gap 交由下游阶段处理或显式列为设计风险
3. **轮次计数源** —— 用 `design_status` 的 loopRound（每轮 Step 2 追踪 round 递增），主 agent 无需自己累计

## changes/ 目录文件的 frontmatter schema

机器检查脚本依赖各文件的 frontmatter 字段。统一 schema：

| 文件 | frontmatter 字段 | 取值 |
|------|----------------|------|
| `review-{phase}.md` | `verdict` + `machine_check` | verdict: `APPROVED`/`CHANGES_REQUESTED`；machine_check: `PASS`/`FAIL` |
| `tracing-round-{N}.md` | `converged` | `true`/`false`（是否收敛复核轮） |
| `tracing-round-{N}-{frame}.md`（变体：-reconstruct/-modeling/-structure/-evolution/-contract/-coverage/-closure/-testclosure/-backfeed） | `converged` | 同上；各阶段认知帧的拆分追踪文件用同一 schema（-backfeed 为 nfr 回灌重建帧产出） |
| `backfeed-round-{N}.md` | `entries` | 整数（检出矛盾条数，0 = 无矛盾直接 pass） |
| `consistency-final.md`（仅⑥） | `verdict` | `CONSISTENT`/`INCONSISTENT` |
| `machine-check-{phase}.md` | `phase` + `machine_check` | 脚本自动产出，machine_check: `PASS`/`FAIL` |
| `context-summary-{phase}-round-{N}.md` | （无强制 frontmatter） | context-builder subagent 产出的阶段工作摘要（仅 L2/L3），非 gate 强制，供主 agent 读不入校验链 |

> **closeout-report.md（topic 根，非 changes/）：** 由 design-closeout 产出，frontmatter 含 `archived: true` + `unverified_count: N`（未代码验证的约束数）。check_closeout.py 依赖这两个字段（不写 changes/，避免污染「changes/ 已清理」检查项）。

各阶段交付物（requirements.md / system-architecture.md / ...）的 frontmatter 见各 `deliverable-template.md`，核心字段 `verdict: pass`。

> **过程产物（tracing-round / backfeed-round / context-summary）无独立模板文件**——格式以各 Step 的 task prompt 为准（subagent 按注入的 task prompt 产出）。deliverable 有模板是因为它是人写的最终交付物，需要结构保证；过程产物是 subagent 机械产出的中间态，task prompt 的格式指令已足够，加模板是过度工程。

