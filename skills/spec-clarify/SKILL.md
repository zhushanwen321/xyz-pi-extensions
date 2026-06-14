---
name: spec-clarify
description: >-
  Standalone requirement-clarification skill. Interactive questioning to
  build a spec draft, then delegates systematic gap-finding to an isolated
  subagent that traces 5 perspectives independently. Solves the core problem
  of clarification omissions. Use when the user says "clarify requirements",
  "澄清需求", "收敛需求", "write spec", "start Phase 1", or when starting
  feature work that needs a clear spec before implementation. Not for:
  implementation itself, debugging, code review, or tasks with an
  already-approved spec.
---

## 核心原则

1. **交互与追踪分离** — 主 agent 做交互（提问、给方案、写初稿），独立 subagent 做追踪（5 视角强制枚举）。主 agent **不做系统追踪**——它带着对话上下文有确认偏误。
2. **5 视角是 forcing function** — User Journey / Data Lifecycle / API Contract / State Machine / Failure Path。每个视角必须核对或写降级理由。详见 `references/scenario-tracing.md`。
3. **F 类二次确认** — Fact gap 先经主 agent 确认（过滤误报），两边都认才问用户。K/D 直接问用户。详见 `references/gap-management.md`。
4. **收敛靠独立复核** — 停止条件是"独立 subagent 跑完 5 视角无新 gap"，不靠主 agent 自我判断。
5. **一次一个问题** — 用 `ask_user` 逐个解决 gap，不一次性抛出所有问题。

## 为什么这样设计

交互式提问澄清看似好用，实际不能覆盖所有需要澄清的环节，遗漏的往往是重要功能。根因有三：

1. **提问靠灵感** — 想到什么问什么，没有外部参照系提醒"你还该看看退款这块"
2. **停止靠自我判断** — AI 觉得"能描述方案了"就停，但它不知道自己不知道什么
3. **后置检查救不了前置遗漏** — Six-Element Check 是形式合规，不查内容完整

解法：把"追踪遗漏"从主 agent 手里拿出来，交给**隔离上下文的独立 subagent** 用 5 视角强制追踪。主 agent 只做交互，不做系统追踪。

<HARD-GATE>

[MANDATORY] Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until the spec has been generated, reviewed, and approved. Applies to EVERY project regardless of perceived simplicity.

</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short, but you MUST present it and get approval. The isolated-subagent tracing is cheap for simple needs (1-2 rounds converge) and catches real gaps (export range, failure handling, etc).

## Dev-flow 上下文

| 项目 | 值 |
|------|---|
| 所在阶段 | Phase 1 (spec) |
| 执行者 | 主 agent（交互 + 编排）+ 独立 subagent（隔离追踪） |
| 上游 | 用户提出需求 |
| 下游（完成后进入） | Phase 2 (plan) — 加载 writing-plans skill |
| 回退目标 | 无前置阶段。如设计需修改，在本阶段内直接迭代 |

## Phase Loop 机制

- **Gate FAIL（spec 不完整）**：回到 Step 2 补充交互提问，根据 gate 反馈更新 spec
- **Review FAIL（must_fix > 0）**：根据 review 反馈修改 spec，重新 dispatch review subagent
- **用户要求修改**：直接修改 spec，不需要回退

**Auto Mode：** coding-workflow 扩展自动管理 loop。skill 中无需处理。

### Agent/Skill 关联

| 步骤 | 执行者 | Agent | Skill | 方式 |
|------|--------|-------|-------|------|
| Step 1: Quick Overview | 主 agent | — | 无 | < 30s 浏览 |
| Step 2: 交互提问 + 写初稿 | 主 agent | — | spec-clarify (本 skill) | `ask_user` 逐个提问 |
| Step 3: 5 视角隔离追踪 | 独立 subagent | general-purpose | spec-clarify (subagent-tracing + scenario-tracing) | task prompt 指定 read |
| Step 4: gap 分流处理 | 主 agent | — | spec-clarify (本 skill + gap-management) | F 二次确认，K/D 问用户 |
| Step 5: 收敛复核 | 独立 subagent | general-purpose | spec-clarify (subagent-tracing) | task prompt 指定 read |
| Step 6: spec 定稿 | 主 agent | — | 无 | 调用 coding-workflow-gate |
| Spec Review | subagent | general-purpose | expert-reviewer | task prompt 指定 read |
| Retrospect | subagent | general-purpose | xyz-harness-retrospect | task prompt 指定 read |

## 流程地图

```
[主 agent: 交互上下文]
  Step 1: Quick Overview          → 浏览项目，< 30s
  Step 2: 交互提问 + 写初稿         → ask_user 逐个提问，写 spec 初稿 + 轻量 clarification.md
                                    （刻意不做 5 视角追踪 — 追踪交给隔离 subagent）
  ↓ 产出：spec 初稿 + clarification.md

[独立 subagent: 隔离上下文，只读需求+初稿+代码]
  Step 3: 5 视角强制追踪           → 独立重跑，卡住点 = gap，分类返回（F/K/D）
  ↓ 产出：tracing-round-{N}.md（gap 列表）

[主 agent: 回到交互上下文]
  Step 4: gap 分流处理
    F 类 → 二次确认：两边都认→问用户；主 agent 否定→丢弃
    K 类 → 直接问用户
    D 类 → 给方案对比
    处理完 → 更新 spec / clarification.md

  Step 5: 收敛判定 → 再派独立 subagent 追踪
    无新 gap → 收敛，进入 Step 6
    有新 gap → 回 Step 4（Stagnation 保底：连续 3 轮强制收）

  Step 6: spec 定稿 → 整理 frontmatter，调用 coding-workflow-gate(phase=1)
```

## 路由表

按当前所处步骤 read 对应文件。不要一次全部加载——按需加载节省 context。

| 步骤 | 需要读的文件 |
|------|------------|
| Step 1-2（主 agent 交互） | 本 SKILL.md |
| Step 3（派 subagent 追踪） | subagent-tracing.md + scenario-tracing.md（注入 subagent task prompt） |
| Step 4（gap 分流） | gap-management.md |
| Step 5（派 subagent 复核） | subagent-tracing.md + scenario-tracing.md（注入 subagent task prompt） |
| clarification.md 格式 | clarification.md |

## Step 1: Quick Overview

**在提问前，主 agent 快速浏览项目基本信息。** 不 dispatch subagent，不产出文档。目的是建立最基本的上下文，避免问出已经能直接看到答案的问题。

**主 agent 直接执行（< 30 秒）：**
1. `ls` 项目根目录，了解目录结构
2. 读 `package.json`（或等效的依赖文件），了解技术栈和关键依赖
3. 读 `README.md`（如果存在），了解项目定位
4. 如果有 `CONTEXT.md`，快速浏览术语表

目的：知道"这是什么项目、用什么技术栈"，不是全面扫描。

## Step 2: 交互提问 + 写初稿

这是核心交互步骤。**逐个提问**，建立理解后写 spec 初稿 + 轻量 clarification.md。

**关键约束：此步骤刻意不做 5 视角追踪。** 追踪交给独立 subagent（Step 3）。主 agent 带着对话上下文做追踪会有确认偏误。

### Question Hierarchy（按顺序提问）

**Layer 1: Purpose & Users（2-3 问题）**
- 解决什么问题？谁受影响？
- 成功长什么样？怎么知道完成了？
- 是新功能、修复，还是改进现有行为？

**Layer 2: Core Behavior（3-5 问题）**
- 走一遍主要用户流程。先发生什么，然后呢？
- [具体场景] 时应该发生什么？（基于用户回答提出具体场景）
- 和哪些现有功能交互？（不清楚时 dispatch on-demand scan）
- 有硬约束吗？（时间、性能、兼容性）

**Layer 3: Boundaries & Non-obvious（2-3 问题）**
- 明确不做什么？什么是 out of scope？
- 有已经做出的技术决策我不该重新讨论吗？

**何时停止提问：** 覆盖了目的、核心行为、边界、约束。如果你能不猜测地向用户完整描述方案，就准备好提方案了。

### Question Quality Guidelines

- **用 `ask_user` 工具** — 如果 `ask_user` 工具可用（pi-ask-user 等扩展注册），优先用它而非纯文本。它提供多选、自由输入、TUI 交互体验。只在工具不可用或问题是真正开放性探索时回退纯文本。
- **优先多选** — 选项可发现时（来自 quick overview 或 scan）："我看到项目用 Pinia 做状态管理。这个功能用同样模式，还是需要不同方式？"
- **用 quick overview 跳过基础** — 别问"用什么框架"如果你已经读了 package.json
- **用 scan 结果问更深入的问题** — "我扫了 API 层，看到 `useApi()` 处理所有 API 调用带自动重试。这个功能用它，还是需要不同的错误处理？"
- **一次一个问题** — 一个主题需要更多探索时，拆成多个问题
- **避免抽象问题** — 别问"需求是什么？"，问"用户点击 X 时，Y 应该立即发生还是确认后？"

### On-demand Deep Scan（按需触发，贯穿 Step 2）

**当用户回答涉及具体模块、技术细节或需要验证代码行为时**，dispatch 只读 subagent 做针对性扫描。这不是独立 Step，而是贯穿提问过程的工具。

**触发条件（任一）：**
- 用户提到"和 XX 模块交互"→ 扫描该模块
- 用户提到"复用现有的 YY 机制"→ 扫描相关代码
- 需要验证代码中是否存在某个功能/约束 → 精准 grep + read
- 需要了解某个 API 的实际签名和行为 → 读对应文件

**Subagent config:**

| Item | Value |
|------|-------|
| Agent | general-purpose (read-only mode) |
| Tools | read, bash (no write) |

**Task prompt 模板:**
```
扫描 {具体模块/目录/文件}，聚焦于：
1. 导出的函数/接口/类型
2. 与 {用户提到的功能} 相关的数据流和调用链
3. 使用的模式和约定

不要扫描无关代码。范围限定在：{具体路径}
```

Scan 结果直接用于后续提问，不产出独立文档。

### Terminology Step（MUST + Nullable，嵌入 Step 2）

在讨论过程中，主动识别 spec 中的模糊术语并提议精确定义：
- 挑战已有术语表（读 `CONTEXT.md`，检查冲突）
- 发明边界场景测试概念边界
- 交叉引用代码验证一致性
- 术语解决时立即写入 `CONTEXT.md`（不等最后批量处理）

**产出可为空：** 简单需求未出现模糊术语且代码无矛盾时，跳过写入。但必须过一遍检查。

### Propose Approaches（Step 2 尾部）

提问结束后：
1. **提 2-3 个方案**，带 trade-off 和你的推荐。优先讲推荐方案并解释为什么
2. **展示设计**，每个 section 按复杂度缩放（简单的几句话，复杂的最多 200-300 字）。每个 section 后问用户"这部分看起来对吗"
3. **Assumption Audit**（嵌入，不独立成 Step）：用户确认设计后、写 spec 前，提取所有对现有代码的假设并逐一验证

**Assumption Audit 铁律：** 禁止在 spec 中写入未经代码验证的接口签名、枚举值或 RPC 方法名。无法验证的标记 `[UNVERIFIED]`。验证命令模板：

```bash
# 接口签名验证
grep -rn "export.*interface\|export.*type\|export.*function" {file_or_dir}
# 枚举/常量值验证
grep -rn "enum\s*\w*\s*{" {file_or_dir} --include="*.ts"
```

### 写初稿

验证后，写 spec 初稿到 `.xyz-harness/${主题}/spec.md` + 轻量 `clarification.md`（格式见 `references/clarification.md`）。

**spec 初稿不追求完整** — 它是对话能聊清楚的部分的记录。遗漏的部分由 Step 3 的 subagent 发现。

Announce at start: "I'm using the spec-clarify skill to clarify requirements and find gaps."

## Step 3: 派独立 subagent 做 5 视角追踪

[MANDATORY] **主 agent 不自己做追踪。** 必须派一个隔离上下文的 subagent。

这是整个设计的核心：主 agent 带着对话上下文做追踪会有确认偏误——对"已经讨论过"的部分快速跳过，这正是盲区产生的地方。追踪必须由不知道对话内容的独立 subagent 做。

### Subagent 派发配置

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Context | **fresh**（隔离上下文，不继承主 agent 对话历史）|
| 读取文件 | `references/subagent-tracing.md` + `references/scenario-tracing.md` + spec 初稿 + clarification.md + 相关源码 |
| 产出 | `tracing-round-{N}.md`（gap 列表）|

### Task prompt 模板

**Dispatch 参数：** 调用 subagent 工具时显式传 `context: "fresh"`（不要依赖默认值——若 general-purpose agent 配置了 `defaultContext: "fork"`，默认会继承对话历史，破坏隔离）。

```
你是独立需求追踪 subagent。你的上下文与主 agent 隔离——你不知道主 agent 和用户聊了什么，只根据以下材料独立追踪：

1. read references/subagent-tracing.md（你的执行流程）
2. read references/scenario-tracing.md（5 视角追踪模板）
3. read {topic_dir}/spec.md（spec 初稿）
4. read {topic_dir}/clarification.md（已知信息）
5. 按需 read 相关源码验证事实

按 5 视角逐一追踪，卡住的地方就是 gap。每个 gap 标注类型（F/K/D）和具体问题。
将结果写入 {topic_dir}/changes/tracing-round-{N}.md。
```

**关键：必须用 fresh context（或等效的独立进程模式）。** 如果 subagent 继承了主 agent 的对话历史，追踪就失去了隔离价值——它会带着同样的预设和盲区。

## Step 4: gap 分流处理

收到 subagent 返回的 gap 列表后，主 agent 回到交互上下文，按类型处理。

### F 类（Fact）— 二次确认（关键）

F 是客观事实（代码里有但初稿没提到的信息），subagent 可能误报（看错代码、旧代码已废弃）。主 agent 拿着对话上下文判断事实是否成立：

- **两边都确认** → 转为具体问题问用户
- **主 agent 否定**（代码已废弃 / 理解有偏差 / 不相关）→ 丢弃，不问用户

二次确认的价值：过滤误报，避免基于废弃代码的错误提问打扰用户。

### K 类（Knowledge）— 直接问用户

生成具体的、有上下文的问题。不要问"退款怎么处理"，要问"代码里有 refund 表但状态只有 pending/completed——退款是部分还是全额？退款后订单状态变什么？"

### D 类（Decision）— 给方案对比

提供 2-3 选项 + trade-off，让用户选择。记录决策 + 推理过程。

### 处理完所有 gap 后

更新 spec 初稿和 clarification.md（记录已解决的 gap），进入 Step 5 收敛复核。

### Gap 处理的交互原则

- **用 `ask_user` 逐个问**，一次一个问题
- **F 类要先二次确认再问用户**（可能整个丢弃，不问）
- **K/D 类直接问**（二次确认无意义——主 agent 否定不了它不知道的事）
- 详见 `references/gap-management.md`

## Step 5: 收敛复核

gap 处理完后，**再派一次独立 subagent** 重新追踪（同 Step 3 配置，fresh context）。同样显式传 `context: "fresh"`。

主 agent 对自己构建的理解有确认偏误。独立 subagent 不知道上轮查过什么，从零审视，反而能发现主 agent 的盲区。

### Task prompt 差异（区分初始追踪 vs 收敛复核）

隔离上下文的 subagent 无法从 task prompt 判断自己是第 1 次 dispatch（初始追踪）还是第 N 次（收敛复核）。Step 5 必须在 Step 3 task prompt 末尾追加以下指令：

```
本轮是收敛复核（Round {N}）。除了按 5 视角追踪外，还要执行收敛判定：
如果追踪无新 gap，在 tracing-round-{N}.md 顶部标注 `CONVERGED` 并列出已追踪的视角。
详见 subagent-tracing.md 的"收敛判定"章节。
```

**为什么必须区分：** 如果不区分，subagent 收敛复核时可能只返回 gap 列表而不做 CONVERGED 判定，主 agent 无法区分"这是收敛复核结果（无新 gap = 收敛）"还是"又一轮追踪结果（仍需继续）"。

### 收敛判定

subagent 复核后返回结果：
- **无新 gap → CONVERGED**，进入 Step 6
- **有新 gap → 回 Step 4** 继续处理（同样 F/K/D 分流）

**停止条件由独立 subagent 的复核判定**，不依赖主 agent 的自我判断。这是解决"AI 不知道自己不知道"的关键。

### Stagnation 保底

连续 3 轮 gap 数量不降（新发现 ≥ 已解决），强制收敛。未解决 gap 标记 `[UNRESOLVED]`，在 spec 中标注交给后续 review 处理。

Stagnation 同时是"需求可能过大"的早期信号——此时提示用户考虑拆分（但拆分机制不在本 skill 范围）。

### 循环粒度

每次"再追踪"是完整重跑 5 视角，不是增量。因为独立 subagent 不知道上轮结果，无法做增量——它从零审视正是其价值所在。简单需求通常 1-2 轮收敛，成本可控。

## Step 6: spec 定稿

收敛后 spec 内容已稳定。

### 生成规则

1. 从 spec 初稿 + clarification.md + 已解决 gap 整理出最终 spec.md
2. 已解决的 D 类 gap → spec 的决策记录章节
3. `[UNRESOLVED]` gap → spec 中标记 `[AMBIGUOUS]`
4. 整理 frontmatter

### Six-Element Completeness Check

定稿前验证 spec 回答了六个问题（每个缺失元素加 `[MISSING]` 并解决）：

| Element | What to check |
|---------|--------------|
| **Outcomes** | 有具体的终态描述（不只是"构建 X"）？ |
| **Scope boundaries** | in-scope 和 out-of-scope 都列了？ |
| **Constraints** | 技术栈、API 限制、性能要求说明了？ |
| **Decisions made** | 已做的技术选择记录了？ |
| **Verification** | 有具体的验收标准，不只是"能用"？ |
| **Business use cases** | 有"业务用例"章节，至少一个 UC？（纯技术需求可标"无业务用例"）|

### Ambiguity Marking

扫描 spec 中的模糊语言并标记 `[AMBIGUOUS]`：
- 模糊形容词："快速"、"合理"、"友好"
- 未量化阈值："大量"、"很快"、"响应式"
- 斜杠组合词："交付/履行"（AND 还是 OR？）
- 缺失的错误/失败行为：只描述 happy path

所有 `[AMBIGUOUS]` 解决后才进入用户审核。

### Terminology & ADR（Step 6 尾部，MUST + Nullable）

spec.md 写完后、用户审核前：
1. **CONTEXT.md 最终检查** — 扫描 spec.md 是否有 Step 2 遗漏的术语
2. **ADR 评估** — 扫描 spec 决策，满足"难以逆转 + 无上下文会惊讶 + 真实权衡"三条件的创建 ADR

**产出可为空。** 但必须执行评估。

## 交付物：spec.md

spec.md 必须包含 YAML frontmatter：

| 字段 | 类型 | 必填 | 允许值 | 说明 |
|------|------|------|--------|------|
| `verdict` | string | 是 | `"pass"` | 门禁通过标志 |

**模板：**
```markdown
---
verdict: pass
---

# {Feature Title}

## Background
## Functional Requirements
## Acceptance Criteria
## Constraints
## 业务用例

> 初版简述（Phase 2 会在此基础上细化）。纯技术性需求可标注"无业务用例"。

### UC-1: {用例名称}
- **Actor**: {谁执行}
- **场景**: {什么情况下}
- **预期结果**: {成功后的状态}
```

## Inline Checks（定稿前）

1. **Placeholder scan:** 有 "TBD"、"TODO"、不完整章节吗？修复
2. **Internal consistency:** 各章节相互矛盾吗？
3. **Scope check:** 足够聚焦于单一实施计划吗？

Fix any issues inline. No need to re-review — just fix and move on.

## Gate 调用

完成 spec.md 编写后，**不要**手动运行任何审查流程。直接调用：

```
coding-workflow-gate(phase=1)
```

Review-Gate 会自动启动 workflow 循环审查 + 修复。如果 gate 返回 FAIL，按修复指引修改 spec.md 后重新调用。

## Retrospect (复盘)

**触发时机：** coding-workflow 扩展在 gate PASS 后自动 dispatch retrospect steer。

Retrospect steer 会包含当前 phase 关键交付物的摘要。按 steer 指令执行复盘即可。

## Self-Check

**铁律：禁止在未实际运行验证命令的情况下声称完成。**

- [ ] spec.md 存在，YAML frontmatter 含 `verdict: pass`
- [ ] 独立 subagent 的 tracing-round-{N}.md 存在（证明追踪真的执行了，不是主 agent 自圆其说）
- [ ] 所有 `[AMBIGUOUS]` 标记已解决
- [ ] Requirements 与 implementation details 清晰分离
- [ ] Acceptance criteria 可测试
- [ ] 所有 Constraints 已记录

### 追踪执行真实性检查

- [ ] tracing-round 文件的 perspective 字段覆盖了适用的视角（不适用视角有降级理由）
- [ ] gap 分类（F/K/D）与 gap-management.md 的定义一致
- [ ] F 类 gap 有二次确认记录（确认/丢弃/转问用户）
- [ ] 收敛判定基于独立 subagent 的 CONVERGED 返回，非主 agent 自我判断

## 阶段完成提交

**阶段完成时，必须提交并推送所有代码和文档到远程仓库。** 确保 `.xyz-harness/` 和 `docs/` 目录下的所有产出文件都被 git 跟踪。

## Phase Transition

Phase 1 gate 通过后，retrospect 会自动触发。完成 retrospect 后调用 `coding-workflow-phase-start()` 进入 Phase 2。

## Key Principles

- **交互与追踪分离** — 主 agent 交互，独立 subagent 追踪，职责不混淆
- **隔离上下文是追踪的价值所在** — fresh context，不继承对话历史
- **F 类二次确认** — 过滤误报，K/D 直接问
- **收敛靠独立复核** — 不靠主 agent 自我判断
- **One question at a time** — `ask_user` 逐个问
- **YAGNI ruthlessly** — 从所有设计中移除不必要的功能
- **Explore alternatives** — 定方案前总是提 2-3 个方案
- **Be flexible** — 某些地方说不通时，回去澄清

<!-- LOCAL-OVERRIDE:START -->
## 本地目录覆盖规则

**以下规则覆盖本文档中所有关于输出目录的路径指定**（如 `.xyz-harness/${主题}/` 子目录）：

- **主目录：** `.xyz-harness/`（项目根目录下）
- **子目录命名：** `${yyyy-MM-dd}-${主题简短标题}`（例：`2026-04-14-core-proxy`）
- **路径映射：**
  - `.xyz-harness/${主题}/spec.md` → `.xyz-harness/${主题}/spec.md`
  - `.xyz-harness/${主题}/clarification.md` → `.xyz-harness/${主题}/clarification.md`
  - 追踪产出：`.xyz-harness/${主题}/changes/tracing-round-{N}.md`
- **不同主题使用不同子目录，禁止混放**

**文档精简：** 单次写入超过 1000 字时优先拆分子文档，主文档保留概述和索引。使用 agent 并行编写各模块文档（并发度 ≤ 2），最后合成精简主文档。
<!-- LOCAL-OVERRIDE:END -->
