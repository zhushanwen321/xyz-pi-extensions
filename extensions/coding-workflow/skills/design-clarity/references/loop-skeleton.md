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
Step 6  独立审查 + 交接       ← fresh subagent 判质量 → APPROVED → 提示下一步
```

## 核心速记（3 条）

1. **交互与追踪分离** — 主 agent 做交互/写初稿，独立 fresh subagent 做追踪/审查。主 agent 不自己做追踪（带对话上下文有确认偏误）。
2. **收敛靠独立复核** — 停止条件是「独立 subagent 无新 gap」，不靠主 agent 自判。
3. **定稿必过独立审查** — Step 6 审查判质量（不是找 gap），APPROVED 才交接。追踪=完整性，审查=质量，两种不同检查。

## Step 1: 主 agent 交互 + 写初稿

逐个提问（Grilling 提问法——设计树遍历、每问附推荐答案、一次一问、能查代码不问用户；详见 `loop-method.md`），建立理解后写初稿到本阶段产出文件。**初稿不追求完整**——遗漏由 Step 2 发现。

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
- **D 类（Decision）— 给方案对比**：2-3 选项 + trade-off，记录决策+推理。

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

[MANDATORY] **HTML 渲染下沉 fresh subagent，主 agent 不 read visual-deliverable.md、不 write HTML 全文**（~25KB 留在 subagent 隔离上下文）。

**派发配置：** Agent=general-purpose，Context=**fresh**，读取=刚定稿 `{deliverable}.md` + visual-deliverable.md（design-clarity skill 的 references 目录），产出=`.xyz-harness/${主题}/{deliverable-name}.html`（write）+ `open` 打开。

**Task prompt 模板：**

```
你是独立渲染 subagent。上下文与主 agent 隔离。把定稿渲染成自包含可视化 HTML：
1. read {final_deliverable_md}（定稿，真相源）
2. read design-clarity skill 的 references/visual-deliverable.md（渲染规范+骨架模板）
3. 按 visual-deliverable.md 的「最小骨架模板」生成 {deliverable-name}.html（内联 CSS/JS，主角图={本阶段主角图表}）
4. 执行 Anti-Slop 清单自检（Mermaid 语法/占位符/空章节/死链/编码）
5. 用 `open`（macOS）/`xdg-open`（Linux）/`start`（Windows）打开
6. 向主 agent 只返回：html 路径 + Anti-Slop 自检结果（✅全过/❌哪几项）+ 一行 TL;DR
不要返回 HTML 全文，不要返回渲染推理过程。
```

### 5c. 主 agent 处理返回

向用户说明：「已生成 `{deliverable-name}.html` 并在浏览器打开。请关注 {本阶段主角图表}。如需调整告诉我，否则进入 Step 6。」用户反馈当 gap 处理，更新定稿后重新派 subagent 渲染。

## Step 6: 独立审查 + 交接

[MANDATORY] 定稿后必须过独立审查（质量门）。审查判质量（不是找 gap）；追踪 vs 审查区别详见 `loop-method.md`。

**派发配置：** Agent=general-purpose，Context=**fresh**，读取=定稿 .md + 定稿 .html + 所有上游交付物 + CONTEXT.md，产出=`changes/review-{phase-slug}.md`。

**审查 5 维：** 内部一致性 / 上游对齐 / 可执行性 / 完整性 / 可视化质量。

**Task prompt 模板：**

```
你是独立审查 subagent。上下文与主 agent 隔离。审查定稿是否达可交接质量：
1. read {final_deliverable_md}（定稿）
2. read {final_deliverable_html}（可视化页面）
3. read {upstream_deliverables}（所有上游交付物，对齐检查）
4. read 项目根 CONTEXT.md（统一语言对齐）

从 5 维审查：内部一致性 / 上游对齐 / 可执行性 / 完整性 / 可视化质量。
判定：APPROVED（5 维均过或仅 cosmetic）/ CHANGES_REQUESTED（任一维实质问题）。
报告写入 {topic_dir}/changes/review-{phase-slug}.md（frontmatter 含 verdict）。
格式：## Verdict / ## 维度评估（5 维 ✅⚠️❌）/ ## 必须修改 / ## 可选改进
```

**结果处理：** APPROVED → 交接；CHANGES_REQUESTED → 「必须修改」当 gap 回 Step 3，更新后重走 Step 4→5→6。审查不通过不交接。

**交接（审查 APPROVED 后）：**

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
## 不可推翻的约束（提醒清单，完整约束以上游 .md 全文为准）
- {逐条列出上游拍板的关键决策/硬约束}
```

新会话主 agent 只 read `_progress.md` 即可接上。

## Stagnation 保底

连续 3 轮追踪 gap 数量不降（新发现 ≥ 已解决），强制收敛。未解决 gap 标 `[UNRESOLVED]` 交由下游或用户。Stagnation 也是「设计可能过大」的早期信号，提示用户考虑拆分。
