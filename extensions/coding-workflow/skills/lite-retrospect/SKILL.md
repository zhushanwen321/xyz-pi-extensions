---
name: lite-retrospect
description: >-
  Use when the user says "轻量复盘", "lite retrospect", "做个复盘", "复盘一下",
  or after a lite-execute run has completed (goal completed) and wants a quick
  self-check retrospect on the dev/test process, docs, skill/subagent quality,
  prompt tuning, and architecture signals. Produces a lightweight checklist
  report (not a deep evidence extraction). Not for design closeout (that is
  design-closeout). Not for planning or execution.
---

# 轻量复盘（Lite Retrospect）

## 核心目标

在一次 lite 工作流（lite-plan → lite-execute）跑完后，用**轻量自检清单**快速复盘：哪里顺、哪里卡、有什么可改进。不追求结构化证据提取，追求**快速发现问题 + 一句话改进建议**。

> **定位：轻量。** 不是 design-closeout（沉淀长期文档），不是 harness-retrospect（重流程质量复盘）。是一张 5 分钟过完的清单，帮下次跑得更好。

## 前置

- lite-execute 已完成（goal 已 complete，验收全绿）
- 可选：plan.md + 测试报告仍在（便于回顾）

## 流程

单一意图（复盘）：过自检清单 → **根因追溯** → 写报告 → 交付。**四步线性推进**。

> **[铁律] 根因追溯是独立步骤，不是清单的一个勾。** 清单阶段只产出「哪些 ❌/⚠️ 需深挖」，根因分析在独立 Step 2 用专用判据表做。先打勾后根因、根因与清单条目脱钩的旧做法（只写「问题→改进」不写 why）是已知失败模式——根因与改进建议会脱节，修复停在症状层。

### Step 1. 过自检清单

逐项自检，标记 ✅（好）/ ⚠️（需注意）/ ❌（有问题）。**清单阶段的产出是「问题清单」——收集所有 ❌/⚠️ 条目（带一句症状描述），根因在 Step 2 分析，本步不强求。** ❌/⚠️ 条目**必须保留到 Step 2**，不在此处附一句改进建议就标结——没有根因的改进建议是猜。

#### 流程自检

- [ ] plan 的 Wave 拆分是否准确？有无返工源于拆分不当（如漏了文件依赖、并行组划错）
- [ ] TDD 是否真执行（每个 implementer 先写测试再实现）？还是出现"先写代码后补测试"
- [ ] 失败循环触发了几轮？哪轮最耗时？是测试设计问题还是实现问题
- [ ] 测试 ‖ review 并行是否真并行了？有无不必要的串行（如 worktree 没建好导致串行跑）

#### 测试质量自检

- [ ] 覆盖率是否达标（≥60%）？哪部分增量未覆盖（关键逻辑还是边缘分支）
- [ ] E2E 边界用例是否漏了关键场景？有无 bug 是测试没覆盖、验收时才暴露
- [ ] plan 的测试清单与实际跑的测试是否一致？有无用例被静默跳过

#### 文档自检

- [ ] plan.md 是否与最终实现一致？有无偏差（实现改了 plan 没更新）
- [ ] 是否需要更新 CLAUDE.md / ARCHITECTURE.md / 相关 ADR（本次改动有无影响约定/架构）
- [ ] 测试清单是否值得沉淀进 TEST-STRATEGY.md（如有破坏即事故的基线用例）

#### skill / subagent 优化自检

- [ ] lite-plan / lite-execute 的指令是否有歧义导致 AI 跑偏？哪步最模糊
- [ ] implementer / test-runner / code-review subagent 的 prompt 和 context 是否足够？有无 NEEDS_CONTEXT / BLOCKED
- [ ] subagent 工具白名单是否过严（该有的工具没有）或过松（不该有的给了）

#### ensemble 趋同数据复盘（消费上次跑的 *_ensemble_overlap）

> lite-plan（scope/reuse/test）和 lite-execute（review）在 ensemble 点会产出趋同字段，记在 plan.md / review 清单 frontmatter。本项是这些数据的**唯一消费者**——读取它们判断哪些 ensemble 点恒定高重合（= 单路已够，未来应降级），让趋同检测真正闭环。否则这些字段是死数据。

- [ ] grep 上次的 `*_ensemble_overlap` 字段（在 plan.md frontmatter、review 清单、或本 topic 的 `_progress.md`/retrospect 输入）：
  - **连续 high**（≥2 次同类功能都 high overlap）→ 该 ensemble 点单路已够，记改进项「降级 X 为单路」（归属：对应 lite-* skill，方向：删条件触发的 ensemble 分支或默认关）
  - **恒定 low**（每次都各找各的）→ 该 ensemble 点同源盲区大，ensemble 价值高，保持
  - **无数据**（首次跑 ensemble 或字段缺失）→ 标「数据不足，至少跑 2 次同类功能再判」
- [ ] 降级建议若有，进 Step 2 根因追溯（为什么该 ensemble 点恒定高重合——是问题本身简单，还是差异化不够导致 N 路盲区仍相关？）

#### 系统提示词 / 业务 / 架构自检

- [ ] 是否有反复出现的错误，提示了 CLAUDE.md 或系统提示词需要补充某条规则
- [ ] 业务流程是否合理？有无可简化的环节（如某个 Wave 其实可合并、某步验证多余）
- [ ] 是否暴露了架构层面的问题（如某模块耦合太紧导致 Wave 无法并行 → 需 design 重构）

### Step 2. 根因追溯（独立步骤，对应 Step 1 每条 ❌/⚠️）

对 Step 1 收集的**每条 ❌/⚠️**，按下表分层判据做根因追溯。这不是可选的深度分析——是复盘的核心价值所在，缺失则复盘仅是症状清单。

#### 根因分层判据表（借鉴 design 的 F/K/D 分层思路）

按「问题归属哪一层」选判据。分层决定修复方向与归属，混层会导向治标不治本：

| 根因层级 | 识别信号 | 修复归属 | 修复方向 |
|---------|---------|---------|----------|
| **工具/系统层** | 问题是工具机制限制硬塞给执行者（cwd 不跨调用持久 / subagent 无心跳 / happy-dom 不支持真实 DOM）| pi 调度层 / 业务项目只能绕不能根治 | 先在 skill 加过渡方案，根治跨 repo |
| **认知/流程层** | 是 skill 或 agent 的疏漏（handoff 事实盲信 / fixture 不在场 / TDD 步骤跳过） | lite skill / CLAUDE.md | 改 skill 指令或加规则 |
| **架构/契约层** | 问题源于模块耦合 / 契约不一致 / 测试金字塔断层 | 业务项目架构 / 需 design 级决策 | 升级 design 工作流或更新 ADR |

**每条 ❌/⚠️ 必须产出**：症状 → why1 → why2（至少 2 层）→ 分层归类 → 可证伪实验。可证伪 = 能用实验验证（如「若 bash cwd sticky，首条 cd 后 0 次重复」）；不可证伪的根因（如「脚本太脆弱」「AI 太懒」）是错误归因。

> **常见脱错**：①只写「问题→改进」不写 why（根因停在症状）②把认知层问题归给工具（如「漏写 cd」真因是工具 cwd 不 sticky，但「AI 忘了」是误归因——除非 cwd sticky 后仍漏）③把工具层问题归给认知（subagent hang 不是「skill 没写检查」，是系统无 heartbeat——见 `subagent-dispatch.md`「已知限制」）。分层表防这类误归。

### Step 3. 写复盘报告

把清单结果 + 根因分析写入 `.xyz-harness/{yyyy-MM-dd}-lite-{topic}/retrospect.md`：

```markdown
# Lite 复盘：{topic}（{date}）

## 概况
- Wave 数：{N} | 失败循环轮数：{R} | 覆盖率：{X}%
- 总体：✅ 顺利 / ⚠️ 有改进点 / ❌ 有问题

## 清单结果

### 流程
- ✅ Wave 拆分准确
- ❌ TDD 第 2 个 Wave 跳过先写测试 | 根因：症状(skip 跑确认失败)→why1(implementer prompt 未强调该步)→why2(认知层) | 层级：认知层
...

### 测试质量
...

### 文档
...

### skill/subagent
...

### 提示词/业务/架构
...

## 根因深度分析

### 问题 1：{标题}
**症状**：...
**why1**：...
**why2（根因）**：...
**层级**：工具/系统层 | 认知/流程层 | 架构/契约层
**可证伪实验**：若 X 则 Y（如何验证根因真伪）

### 问题 2：...

## 改进项（按优先级）
每条格式：`[P级] 问题 | 根因链(症状→why1→why2) | 层级 | 归属(repo/文件/skill) | 追踪(issue/分支/已修/待办) | 修复方向`

1. [P0] <问题> | 根因：症状→why1→why2 | 层级：认知层 | 归属：lite-plan | 追踪：待办 | 方向：步骤4 加 fixture 对齐自检
2. [P1] ...
3. [P2] ...
```

> 轻量：不进长期文档（那是 design-closeout 的活）。但**每条 ❌/⚠️ 必须有根因链 + 层级 + 归属**——否则复盘的价值（发现问题）无法转化为改进（修复问题），复盘就成了空转。
>
> **[铁律] 报告里每个 ❌/⚠️ 条目后必须附 `| 根因：症状→why1→why2 | 层级：xxx`**。只写「问题→改进」、根因留空 = 未完成复盘，不能进 Step 4 交付。
>
> **[铁律] 改进项必须回流，禁止「追踪：待办」死信。** 归属为 lite-* / design-* / CLAUDE.md 的每条改进项，二选一：
> - 当场改对应 skill / 文档，改进项的「追踪」标「已修（文件:行 或 commit）」
> - 当场在 `docs/todos/` 建 followup 文件（如 `docs/todos/lite-skills-followups.md`），改进项的「追踪」标 followup 文件路径
>
> 只写「追踪：待办」= 未完成复盘。实测：上一轮 retrospect 标了「归属：lite-execute / 追踪：待办」，lite-execute 从未被改，5 条改进全部死信——没有回流机制，retrospect 是自嗨文档。
>
> **[提示] retrospect.md 产出在 `.xyz-harness/`，不进代码 commit。** 提交代码时用显式路径 `git add <改动文件>`，禁 `git add -A`（实测：retrospect.md 被 add -A 误加混进代码 commit）。`.xyz-harness/` 是工作流产出，独立于代码变更。

### Step 4. 交付

```
✅ 复盘完成：.xyz-harness/{date}-lite-{topic}/retrospect.md
   概况：{N} Wave，{R} 轮失败循环，覆盖率 {X}%
   改进项：{P0 数} 个 P0 / {P1 数} 个 P1
   最值得改：<P0 第一条>
```

## 何时升级

复盘若发现**架构层面的反复问题**（如模块耦合导致并行受限、测试总在某层断裂），建议：
- 走 design 工作流做一次架构设计（design-init → design-architecture）
- 或更新对应 ADR 记录架构决策

> lite 复盘的价值之一：发现"小功能也卡"的根因往往是架构债，这时该升级到 design。

## 标记说明

| 标记 | 含义 |
|------|------|
| ✅ | 做得好，保持 |
| ⚠️ | 需注意，有改进空间 |
| ❌ | 有问题，应改进 |
