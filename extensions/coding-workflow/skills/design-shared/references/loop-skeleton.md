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

## 核心速记（4 条）

1. **交互与追踪分离** — 主 agent 做交互/写初稿，独立 fresh subagent 做追踪/审查。主 agent 不自己做追踪（带对话上下文有确认偏误）。
2. **收敛靠独立复核** — 停止条件是「独立 subagent 无新 gap」，不靠主 agent 自判。
3. **定稿必过独立审查** — Step 6 审查判质量（不是找 gap），6 维含红队反过度设计，APPROVED 才进 6b。追踪=完整性，审查=质量，两种不同检查。
4. **反哺保文档一致** — Step 6b 审查通过后，fresh subagent 回扫上游，发现矛盾就反哺修订上游 .md。文档一致性靠反哺，不靠最后一次性检查。

## Step 1: 主 agent 交互 + 写初稿

[MANDATORY] 本阶段 Step 1 由两部分组成：① 向用户 grilling **必问决策**；② 对可代码自决的部分直接产出。两者都要做，不能只做②（只扫代码+套启发式写初稿 = 绕开用户）。

**提问纪律（4 条）：**

1. **沿本阶段设计树遍历** — 逐节点推进，解决父节点再问子节点，不跳跃
2. **每问附推荐答案 + 理由** — 给强观点，用户可采纳/修正/推翻，不甩空问题
3. **一次一个问题** — 用 `ask_user`，不一次抛多个
4. **能查代码答的就 dispatch 只读 subagent 查，不问用户** — 问用户的只限于：业务意图、取舍偏好、风险容忍、不可逆的根本选择

**「该问用户」vs「agent 自决」的分界线（关键，防止 agent 读代码自决后绕开用户）：**

- ❓ **必须 ask_user**：决策不可逆（分层/状态机/领域边界/根本架构选择）、取舍涉用户偏好（长期 vs 成本）、风险容忍度、未来计划 —— 这些代码答不了
- ✅ **agent 自决（定稿时暴露给用户）**：有明确启发式、代码可验证、可逆的小决策 —— 直接产出，审查/定稿让用户看到

**何时停止提问：** 每个必问决策点都有用户拍板的答案，无"大概是/应该可以/这取决于"。**本阶段具体必问哪些**见各 SKILL.md 的「Step 1 必问决策点」——这是各阶段 SKILL.md 必须提供的章节。

提问 + 自决完成后写初稿。**初稿不追求完整**——遗漏由 Step 2 发现。

> 完整 Grilling 方法论（设计树展开法、Question Hierarchy Layer 1/2/3、relentless 详解）见 `loop-method.md`，clarity 阶段首次 read。

Announce at start: "我正在使用 {skill-name} skill 来 {本阶段目标}。"

## Step 2: 派 fresh subagent 追踪

[MANDATORY] 主 agent 不自己做追踪。

**派发配置：** Agent=general-purpose，Context=**fresh**（隔离，不继承对话历史），读取=本阶段 perspectives 文件 + 初稿 + 上游交付物 + 相关源码，产出=`changes/tracing-round-{N}.md`。

**Task prompt 模板：**

```
你是独立追踪 subagent。上下文与主 agent 隔离——只根据以下材料独立追踪：
1. read {perspectives_file}（本阶段追踪视角模板）
2. read {deliverable_path}（初稿）
3. read {upstream_deliverables}（上游交付物）
4. 按需 read 相关源码验证事实

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
2. 已解决 D 类 gap → 决策记录章节
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

## Step 6: 独立审查 + 交接

[MANDATORY] 定稿后必须过独立审查（质量门）。审查判质量（不是找 gap）；追踪 vs 审查区别详见 `loop-method.md`。
**审查分两层：先跑机器检查脚本（硬阻断），后做 6 维 LLM 审查。** 审查 subagent 规范见 `review-agent.md`。

**派发配置：** Agent=general-purpose，Context=**fresh**，读取=design-shared 的 `references/review-agent.md`（审查规范）+ 定稿 .md + 定稿 .html + 所有上游交付物 + CONTEXT.md，产出=`changes/review-{phase-slug}.md`。

**Step 0（机器检查，审查 subagent 最先做）：** 审查 subagent 先跑对应阶段的机器检查脚本：

```bash
python3 ${SKILL_DIR}/scripts/check_{phase}.py {topic_dir}
```

脚本输出 `changes/machine-check-{phase}.md` + 退出码。**exit 1（机器检查 FAIL）= 直接判 CHANGES_REQUESTED，不许 APPROVED（硬阻断）**——机器可证伪的硬伤（缺章节/占位符/引用断裂/骨架反模式）不存在"审查认为可以过"。exit 0 才进 6 维 LLM 审查。各阶段脚本路径见 `review-agent.md`。

**审查 6 维：** 内部一致性 / 上游对齐 / 可执行性 / 完整性 / 可视化质量 / **必要性与比例性（红队维度）**。

**Task prompt 模板：**

```
你是独立审查 subagent。上下文与主 agent 隔离。审查定稿是否达可交接质量：

**Step 0（机器检查，硬阻断，最先做）：**
0a. read design-shared skill 的 references/review-agent.md（审查规范）
0b. 跑 `python3 {skill_dir}/scripts/check_{phase}.py {topic_dir}`
0c. exit 1 = 机器检查 FAIL → 直接判 CHANGES_REQUESTED，把 machine-check-{phase}.md 的 ❌ 当"必须修改"，不许 APPROVED（硬阻断）
0d. exit 0 才进下面的 6 维 LLM 审查

**Step 1（6 维 LLM 审查，机器全过后才做）：**
1. read {final_deliverable_md}（定稿）
2. read {final_deliverable_html}（可视化页面）
3. read {upstream_deliverables}（所有上游交付物，对齐检查）
4. read 项目根 CONTEXT.md（统一语言对齐）

从 6 维审查：
- 内部一致性 / 上游对齐 / 可执行性 / 完整性 / 可视化质量（5 个客观维度）
- **必要性与比例性（红队维度）**——站在「这个设计过度/不合理」的反方立场质询：
  · 对每个 port/adapter/interface：「删掉它会怎样？最小可行版本是什么？」(deletion test)
  · 对每个 D-不可逆决策：「这是真不可逆，还是 agent 没找到可逆方案？」
  · 对分层深度：「核心计算真的复杂到需要这层吗？三层够不够？」
  判定：若认为某决策过度设计，即使其他 5 维全过也标 CHANGES_REQUESTED + 注「建议降级为 X」

判定：APPROVED（机器检查 PASS + 6 维均过或仅 cosmetic）/ CHANGES_REQUESTED（机器检查 FAIL，或任一维实质问题，含过度设计）。
报告写入 {topic_dir}/changes/review-{phase-slug}.md（frontmatter 含 verdict + machine_check）。
格式：## Verdict / ## 机器检查结果 / ## 维度评估（6 维 ✅⚠️❌）/ ## 必须修改 / ## 可选改进
```

**结果处理：** APPROVED → 进 Step 6b 反哺检查；CHANGES_REQUESTED → 「必须修改」当 gap 回 Step 3，更新后重走 Step 4→5→6。审查不通过不交接。

## Step 6b: 上游反哺检查（审查 APPROVED 后、交接前）

[MANDATORY] 审查 APPROVED 后，交接前必须做上游反哺——检测本阶段是否引入了与上游矛盾的结论，若有则反哺修订上游 .md，保证文档一致性。

**派发配置：** Agent=general-purpose，Context=**fresh**，读取=本阶段定稿 .md + 所有上游交付物 + CONTEXT.md，产出=`changes/backfeed-round-{N}.md`。

**Task prompt 模板：**

```
你是独立反哺检查 subagent。上下文与主 agent 隔离。检测本阶段定稿是否引入与上游矛盾的结论：
1. read {final_deliverable_md}（本阶段定稿）
2. read {upstream_deliverables}（所有上游交付物）
3. read 项目根 CONTEXT.md

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
4. **反哺后回流** —— 上游 .md 更新后，本阶段可能需重新对齐 → 回 Step 2 重追踪（Phase Loop 已含此条）。

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
## 不可推翻的约束（从各阶段 .md 自动提取，非主 agent 主观总结）
- {从已完成阶段的 .md frontmatter `verdict: pass` + 决策记录章节提取，重点：}
  - {标记为 D-不可逆 的决策（分层/状态机/领域边界/根本架构选择）}
  - {②搭便车清单的最终范围}
  - {④残余风险的接受理由}
  - {⑤骨架验证结论（哪些调用链已物理验证）}
```

新会话主 agent 只 read `_progress.md` 即可接上。

> **约束提取方式（改动8）：** 「不可推翻的约束」一节**从各阶段 .md 的 frontmatter + 决策记录章节 grep 提取**——
> 扫描 `verdict: pass` 的 .md，提取其决策记录章节中标记为 D-不可逆 的决策、搭便车清单、残余风险接受理由。
> 主 agent 只负责汇总格式化，不主观筛选（避免主 agent 的确认偏误漏掉硬约束）。

### 阶段状态追踪（design_status tool / CLI）

> **[RECOMMENDED]** 用 `design_status` 追踪 7 阶段状态，替代手写 `_progress.md` 的进度部分。
> 它是**权威状态机**：阶段线性依赖（防跳阶）+ complete_phase 自动校验交付物 gate（防伪造完成）。
> `_progress.md` 降级为其状态的可读快照（跨会话交接用，每次 complete_phase 可选同步生成）。
>
> **两种调用方式**（语义完全一致，调同一批约束/gate 逻辑）：
> - **Pi tool**（Pi 环境）：`design_status(action: start_phase, phase: {本阶段})`
> - **CLI**（Claude Code / Cursor / 纯 shell）：`design-status start-phase {本阶段}`
>   非 Pi 环境用 `npx @zhushanwen/pi-design-status <command>` 或装 bin 后直接 `design-status <command>`。

各阶段 SKILL.md 在两处调：
- **Step 1 开头**：`start_phase {本阶段}` 标记开始（会校验前置阶段是否 completed）
- **Step 6 审查 APPROVED 后**：`complete_phase {本阶段}` 收尾——自动验交付物存在 + verdict:pass + review APPROVED，过了才标 completed，否则拒绝并告缺什么

> **为什么用它而非手写 _progress.md**：「完成状态」从交付物派生（不是 agent 主观写），无法伪造「做完了」；
> 阶段状态机约束（completed 不可回退、不可跳阶）被强制，agent 无法绕过 gate。
> 提示词不暴露存储实现（json），tool action / CLI command 即全部接口。

## Stagnation 保底

连续 3 轮追踪 gap 数量不降（新发现 ≥ 已解决），强制收敛。未解决 gap 标 `[UNRESOLVED]` 交由下游或用户。Stagnation 也是「设计可能过大」的早期信号，提示用户考虑拆分。

## changes/ 目录文件的 frontmatter schema

机器检查脚本依赖各文件的 frontmatter 字段。统一 schema：

| 文件 | frontmatter 字段 | 取值 |
|------|----------------|------|
| `review-{phase}.md` | `verdict` + `machine_check` | verdict: `APPROVED`/`CHANGES_REQUESTED`；machine_check: `PASS`/`FAIL` |
| `tracing-round-{N}.md` | `converged` | `true`/`false`（是否收敛复核轮） |
| `backfeed-round-{N}.md` | `entries` | 整数（检出矛盾条数，0 = 无矛盾直接 pass） |
| `consistency-final.md`（仅⑥） | `verdict` | `CONSISTENT`/`INCONSISTENT` |
| `machine-check-{phase}.md` | `phase` + `machine_check` | 脚本自动产出，machine_check: `PASS`/`FAIL` |

各阶段交付物（requirements.md / system-architecture.md / ...）的 frontmatter 见各 `deliverable-template.md`，核心字段 `verdict: pass`。

