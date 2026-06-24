# 共享流程骨架（Shared Design Loop）

> **6 个设计阶段 skill 共用。** 本文件是单一真相源——每个 SKILL.md 引用本文档，
> 不在各自文档里重复流程定义（单一真相源原则）。

## 目录

- [核心原则](#核心原则)
- [6 步循环](#6-步循环)
  - [Step 1: 主 agent 交互 + 写初稿（含 Grilling 提问法）](#step-1-主-agent-交互--写初稿含-grilling-提问法)
  - [Step 2: 派独立 subagent 做强制视角追踪](#step-2-派-independent-subagent-做强制视角追踪)
  - [Step 3: gap 分流处理（F/K/D）](#step-3-gap-分流处理fkd)
  - [Step 4: 收敛复核](#step-4-收敛复核)
  - [Step 5: 定稿 + 渲染可视化 HTML](#step-5-定稿--渲染可视化-html)
  - [Step 6: 独立审查（Review Gate）+ 交接](#step-6-独立审查review-gate--交接)
- [交互原则](#交互原则)
- [gap 卡住信号](#gap-卡住信号)
- [Stagnation 保底](#stagnation-保底)

---

## 核心原则

1. **交互与追踪分离** — 主 agent 做交互（提问、给方案、写初稿），独立 subagent 做追踪（强制枚举视角）。主 agent **不做系统追踪**——它带着对话上下文有确认偏误。
2. **强制视角是 forcing function** — 每个阶段定义自己的 N 视角。每个视角必须核对或写降级理由。视角清单在各 skill 的 references 文件中。
3. **F 类二次确认** — Fact gap 先经主 agent 确认（过滤误报），两边都认才问用户。K/D 直接问用户。
4. **收敛靠独立复核** — 停止条件是「独立 subagent 跑完视角追踪无新 gap」，不靠主 agent 自我判断。
5. **定稿后必须过独立审查** — Step 6 的审查 subagent 从**质量/一致性/可执行性**维度判断定稿是否合格，而非找 gap。审查通过才能交接下游。审查与追踪是两种不同的检查（追踪=完整性，审查=质量）。
6. **一次一个问题** — 用 `ask_user` 逐个解决 gap，不一次性抛出所有问题。

## 6 步循环

```
Step 1  交互提问 + 写初稿    ← Grilling 提问法，逐节点遍历设计树
Step 2  独立 subagent 追踪   ← 强制视角，找 gap（完整性）
Step 3  gap 分流 F/K/D       ← 主 agent 处理，二次确认 F
Step 4  收敛复核              ← 再派 subagent，无新 gap → CONVERGED
Step 5  定稿 + 渲染 HTML      ← 整理最终 .md + 生成可视化 .html
Step 6  独立审查 + 交接       ← 审查 subagent 判质量 → APPROVED → 提示下一步
```

### Step 1: 主 agent 交互 + 写初稿（含 Grilling 提问法）

这是核心交互步骤。**逐个提问**，建立理解后写初稿。

#### Grilling 提问法

移植自 grilling / grill-me skill——**对设计树的每个节点 relentless 追问，直到达成共识**。不是「问几个问题就停」，而是「沿着设计树走，一个分支一个分支地解决决策依赖」。

**四条铁律：**

1. **设计树遍历，不跳跃** — 把要澄清的主题展开成一棵设计树（根=核心目标，分支=子决策）。沿树枝从根到叶逐节点推进，**解决父节点再问子节点**。不在不同树枝间来回跳——跳跃会让用户困惑、遗漏依赖。

   > 例（澄清需求阶段）：根「业务目标」→ 分支「谁是 Actor」→ 叶「Actor A 有哪些用例」。先把 Actor 问清楚，再问 Actor A 的用例；不要 Actor 还没定就跳去问数据流。

2. **每个问题附推荐答案** — 不甩空问题菜单。每个问题给出**你的推荐答案 + 理由**（基于已建立的上下文和代码扫描）。用户要的是强观点，不是「你觉得呢？」。用户可以采纳、修正或推翻——但推荐答案让对话有锚点。

   > ❌「数据归档策略是什么？」
   > ✅「推荐按月分区 + 90 天后转冷存储（你现在的 orders 表已经按月分区了，沿用同一策略最省力）。除非有合规要求保留更久？」

3. **一次一个问题，等回答再继续** — 一次只问一个。抛多个问题 = 让用户认知过载 = 回答质量下降。一个主题需要深挖时，拆成连续的单问题序列。

4. **能查代码就查代码，不问用户** — 如果问题能通过探索代码库回答（「现在有没有 refund 表？」「状态枚举有哪些？」），**dispatch 只读 subagent 去查，不问用户**。问用户的问题应该是代码回答不了的（业务意图、取舍偏好、未来计划）。

**何时停止提问：** 当你能不猜测地向用户完整复述方案、且每个设计树叶子节点都有明确答案时。如果还有「大概是」「应该可以」「这取决于」，继续问。

#### Question Hierarchy（按顺序提问）

**Layer 1: 目标与用户（2-3 问题）**
- 解决什么问题？谁受影响？
- 成功长什么样？怎么知道完成了？

**Layer 2: 核心行为（3-5 问题）**
- 走一遍主要流程。先发生什么，然后呢？
- [具体场景] 时应该发生什么？（基于回答提出具体场景）
- 和哪些现有功能/系统交互？
- 有硬约束吗？

**Layer 3: 边界与非显而易见（2-3 问题）**
- 明确不做什么？什么是 out of scope？
- 有已经做出的决策我不该重新讨论吗？

**各阶段特有的提问焦点** 见各自 SKILL.md 的「Step 1」章节——每个阶段有不同的设计树（业务目标树 / 架构决策树 / issue 决策树 / 副作用树 / 代码契约树 / Wave 依赖树）。

#### 写初稿

提问结束后，写初稿到阶段对应的产出文件（见各 skill 的「交付物」章节）。

**初稿不追求完整** — 它是对话能聊清楚的部分的记录。遗漏的部分由 Step 2 的 subagent 发现。

Announce at start: "我正在使用 {skill-name} skill 来 {本阶段目标}。"

### Step 2: 派独立 subagent 做强制视角追踪

[MANDATORY] **主 agent 不自己做追踪。** 必须派一个隔离上下文的 subagent。

主 agent 带着对话上下文做追踪会有确认偏误——对「已经讨论过」的部分快速跳过，这正是盲区产生的地方。追踪必须由不知道对话内容的独立 subagent 做。

#### Subagent 派发配置

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Context | **fresh**（隔离上下文，不继承主 agent 对话历史）|
| 读取文件 | 本阶段的 perspectives 文件 + 初稿 + 上游交付物 + 相关源码 |
| 产出 | `changes/tracing-round-{N}.md`（gap 列表）|

#### Task prompt 模板

**Dispatch 时显式传 fresh context**（不要依赖默认值——若 agent 配置了 fork，默认会继承历史，破坏隔离）。

```
你是独立追踪 subagent。你的上下文与主 agent 隔离——你不知道主 agent 和用户聊了什么，
只根据以下材料独立追踪：

1. read {perspectives_file}（本阶段追踪视角模板）
2. read {deliverable_path}（初稿）
3. read {upstream_deliverables}（上游交付物）
4. 按需 read 相关源码验证事实

按视角逐一追踪，卡住的地方就是 gap。每个 gap 标注类型（F/K/D）和具体问题。
将结果写入 {topic_dir}/changes/tracing-round-{N}.md。
```

**关键：必须用 fresh context。** 继承对话历史会带着同样的预设和盲区。

### Step 3: gap 分流处理（F/K/D）

收到 subagent 返回的 gap 列表后，主 agent 回到交互上下文，按类型处理。

#### F 类（Fact）— 二次确认（关键）

F 是客观事实（代码里有但初稿没提到的信息），subagent 可能误报（看错代码、旧代码已废弃）。主 agent 拿着对话上下文判断事实是否成立：

- **两边都确认** → 转为具体问题问用户
- **主 agent 否定**（代码已废弃 / 理解有偏差 / 不相关）→ 丢弃，不问用户

二次确认的价值：过滤误报，避免基于废弃代码的错误提问打扰用户。

#### K 类（Knowledge）— 直接问用户

生成具体的、有上下文的问题。不要问「退款怎么处理」，要问「代码里有 refund 表但状态只有 pending/completed——退款是部分还是全额？退款后订单状态变什么？」

#### D 类（Decision）— 给方案对比

提供 2-3 选项 + trade-off，让用户选择。记录决策 + 推理过程。

#### 处理完所有 gap 后

更新初稿，进入 Step 4 收敛复核。

### Step 4: 收敛复核

gap 处理完后，**再派一次独立 subagent** 重新追踪（同 Step 2 配置，fresh context）。

#### Task prompt 差异

Step 4 必须在 Step 2 task prompt 末尾追加：

```
本轮是收敛复核（Round {N}）。除了按视角追踪外，还要执行收敛判定：
如果追踪无新 gap，在 tracing-round-{N}.md 顶部标注 `CONVERGED` 并列出已追踪的视角。
```

**为什么必须区分：** 如果不区分，subagent 收敛复核时可能只返回 gap 列表而不做 CONVERGED 判定，主 agent 无法区分「这是收敛复核结果（无新 gap = 收敛）」还是「又一轮追踪结果（仍需继续）」。

#### 收敛判定

- **无新 gap → CONVERGED**，进入 Step 5
- **有新 gap → 回 Step 3** 继续处理

**停止条件由独立 subagent 的复核判定**，不依赖主 agent 的自我判断。

### Step 5: 定稿 + 渲染可视化 HTML

收敛后内容已稳定。本步做两件事：**定稿 .md** 和 **渲染 .html**。

#### 5a. 定稿 .md

1. 从初稿 + 已解决 gap 整理出最终文件
2. 已解决的 D 类 gap → 决策记录章节
3. `[UNRESOLVED]` gap → 标注 `[AMBIGUOUS]`，在产出文件中显式列出
4. 整理 frontmatter（含 `verdict: pass`）
5. 执行 Ambiguity Marking：扫描模糊语言（「快速」「合理」「大量」）标记 `[AMBIGUOUS]`，解决后才算完成

#### 5b. 渲染可视化 HTML

定稿 .md 完成后，生成一个**自包含的 .html 可视化页面**，方便人类查看和评审。

read `references/visual-deliverable.md`（位于 design-clarity skill 的 references 目录）了解完整规范。核心要求：

- **自包含** — 单个 .html 文件，内联 CSS/JS，Mermaid 图表直接渲染（不依赖外部文件）
- **从定稿 .md 渲染** — HTML 是 .md 的可视化呈现，不是新内容。.md 是真相源，.html 是视图
- **每阶段不同的可视化重点** — clarity 渲染用例图/DFD；architecture 渲染分层/状态机/泳道；issues 渲染决策 DAG；nfr 渲染风险矩阵；code-arch 渲染时序图/依赖图；execution 渲染 Wave DAG
- **打开即看** — 用户浏览器双击即可打开，无需构建

输出路径：`.xyz-harness/${主题}/{deliverable-name}.html`（与 .md 同目录）。

#### 5c. 主动打开 HTML 供用户审查

[MANDATORY] **HTML 渲染完成后，立即用 bash `open` 命令打开它**，让用户在浏览器里审查，不要只生成不打开。

```bash
open .xyz-harness/${主题}/{deliverable-name}.html
```

- macOS 用 `open`，Linux 用 `xdg-open`，Windows 用 `start`
- 打开后向用户说明：「已生成 `{deliverable-name}.html` 并在浏览器打开。请在审查时关注 {本阶段主角图表}。如需调整告诉我，否则进入 Step 6 独立审查。」
- **用户审查 HTML 的反馈** 与 Step 6 审查 subagent 的反馈同等对待——如有修改意见，作为 gap 回 Step 3 处理后重新渲染

### Step 6: 独立审查（Review Gate）+ 交接

[MANDATORY] **定稿后必须过独立审查。** 这是质量门，不是可选步骤。

#### 审查 vs 追踪的区别

| | Step 2/4 追踪 | Step 6 审查 |
|---|---|---|
| **问什么** | 信息完不完整？有没有 gap？ | 质量行不行？能不能用？ |
| **输入** | 初稿（可能不完整） | 定稿 .md + .html（已完成） |
| **视角** | 强制枚举 N 视角（找遗漏） | 全局质量（判好坏） |
| **输出** | gap 列表（F/K/D） | verdict: APPROVED / CHANGES_REQUESTED |
| **失败动作** | 回 Step 3 补 gap | 回 Step 3（审查发现当 gap 处理）|

追踪找的是「缺了什么」，审查判的是「做出来的东西够不够好」。

#### 审查 subagent 派发配置

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Context | **fresh**（隔离上下文，同 Step 2 理由）|
| 读取文件 | 定稿 .md + 定稿 .html + 所有上游交付物 + CONTEXT.md |
| 产出 | `changes/review-{phase-slug}.md`（审查报告 + verdict）|

#### 审查维度（5 维）

审查 subagent 从以下 5 个维度评审定稿：

1. **内部一致性（Internal Consistency）** — 文档自相矛盾吗？目标树→用例→数据流→功能清单能对得上吗？状态机转换图与状态枚举一致吗？
2. **上游对齐（Upstream Alignment）** — 定稿忠实延伸了上游交付物吗？有没有偷偷改了上游已定的结论？有没有遗漏上游的关键约束？
3. **可执行性（Actionability）** — 下游阶段（或编码）能拿着这个文档直接干活、不用猜吗？方法签名表够具体吗？Wave 依赖够明确吗？
4. **完整性（Completeness）** — 所有章节都 present 且 substantive 吗（不是占位符/TODO）？该有的图都有吗？模糊语言都标记了吗？
5. **可视化质量（Visual Quality）** — HTML 页面打开能正确渲染吗？Mermaid 图表语法正确吗？排版可读吗？

#### Task prompt 模板

```
你是独立审查 subagent。你的上下文与主 agent 隔离。审查以下定稿是否达到可交接下游的质量：

1. read {final_deliverable_md}（定稿）
2. read {final_deliverable_html}（可视化页面）
3. read {upstream_deliverables}（所有上游交付物，用于对齐检查）
4. read 项目根 CONTEXT.md（统一语言对齐）

从 5 个维度审查：内部一致性 / 上游对齐 / 可执行性 / 完整性 / 可视化质量。

判定标准：
- APPROVED：5 维均通过，或仅有 cosmetic 小问题（不影响下游执行）
- CHANGES_REQUESTED：任一维度有实质问题（下游会卡住/猜错/遗漏关键信息）

将审查报告写入 {topic_dir}/changes/review-{phase-slug}.md，frontmatter 含 verdict。
报告格式：
  ## Verdict: APPROVED | CHANGES_REQUESTED
  ## 维度评估
  ### 1. 内部一致性 ✅/⚠️/❌  {说明}
  ...
  ## 必须修改（如 CHANGES_REQUESTED）
  - [维度] {具体问题} → 建议修改
  ## 可选改进（如 APPROVED）
  - {nice-to-have}
```

#### 审查结果处理

- **APPROVED** → 进入交接（见下方）
- **CHANGES_REQUESTED** → 将「必须修改」项作为新 gap（映射到 F/K/D），回 Step 3 处理，更新初稿后重新走 Step 4 收敛 → Step 5 定稿 → Step 6 再审。**审查不通过不交接。**

#### 交接（Handoff）

审查 APPROVED 后，主 agent 向用户提示进入下一阶段：

```
✅ {当前阶段名} 已完成并通过独立审查。
   产出：{deliverable}.md + {deliverable}.html
   审查报告：changes/review-{phase-slug}.md（verdict: APPROVED）

下一步：{第 N+1 步名称} — {一句话目标}
调用：/{next-skill-command}

是否现在进入下一步？
```

**用户确认后才加载下一个 skill。** 不自动跳转——设计阶段是用户主导的，用户可能想先 review HTML、或手动调整、或暂停。

> 最后一个阶段（⑥执行计划）审查通过后，交接目标变为「编码实现」（见该 skill 的下游衔接章节），不再有第 7 个设计 skill。

---

## 交互原则

Grilling 提问法的快速参考（详见 Step 1）：

- **一次一个问题** — 一个主题需要更多探索时，拆成多个问题
- **设计树遍历** — 沿树枝从根到叶推进，解决父节点再问子节点，不跳跃
- **每个问题给推荐答案** — 附推荐 + 理由，用户要强观点不是选项列表
- **优先多选** — 选项可发现时（来自 quick overview 或 scan）用 `ask_user` 多选
- **避免抽象问题** — 别问「需求是什么？」，问「用户点击 X 时，Y 应该立即发生还是确认后？」
- **能查代码就查代码** — 如果问题能通过探索代码回答，探索代码而不是问用户
- **快速浏览先于提问** — 提问前快速浏览项目（ls + 依赖文件 + README + CONTEXT.md），建立基本上下文，避免问已有答案的问题（< 30 秒）
- **relentless** — 还有「大概是」「应该可以」就继续问，直到每个设计树叶子节点都有明确答案

### On-demand Deep Scan（按需触发，贯穿 Step 1）

当用户回答涉及具体模块、技术细节或需要验证代码行为时，dispatch 只读 subagent 做针对性扫描。

**触发条件（任一）：**
- 用户提到「和 XX 模块交互」→ 扫描该模块
- 用户提到「复用现有的 YY 机制」→ 扫描相关代码
- 需要验证代码中是否存在某个功能/约束 → 精准 grep + read

**Subagent config:**

| Item | Value |
|------|-------|
| Agent | general-purpose (read-only mode) |
| Tools | read, bash (no write) |

Scan 结果直接用于后续提问，不产出独立文档。

---

## gap 卡住信号

追踪 subagent 遇到以下情况说明遇到了 gap：

1. **「我不知道」** → 需要信息才能继续追踪
2. **「大概是...」** → 在猜测，不是在追踪
3. **「应该可以...」** → 在假设，不是在确认
4. **「这不重要」** → 可能重要，记录为 gap 让主 agent 判断
5. **「这取决于...」** → 有未做的决策（D 类）
6. **「让我看看代码」** → F 类 gap，需要扫描源码

---

## Stagnation 保底

连续 3 轮追踪 gap 数量不降（新发现 ≥ 已解决），强制收敛。未解决 gap 标记 `[UNRESOLVED]`，在产出文件中标注交由下游阶段或用户决策处理。

Stagnation 同时是「需求/设计可能过大」的早期信号——此时提示用户考虑拆分。
