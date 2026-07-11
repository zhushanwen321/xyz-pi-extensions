---
verdict: pass-with-simplifications
reviewer: redteam (anti-over-design)
date: 2026-07-10
---

# 红队审查：T1 过度设计清单

> 认知帧：删/质疑。对每项设计做 deletion test（去掉会不会塌）+ 比例性检查（代价配得上问题吗）。
> 已确认决策 D-000~D-004 不重报。本文件只输出「过度设计/可简化」项。

## TL;DR

8 项设计里：**1 项过度（建议删/降级）**、**3 项比例性偏弱（建议简化）**、**4 项合理（保留）**。
T1 范围整体不过大，但有一个「搭便车」改造（format 统一）建议移出本 topic。

---

## 过度设计 / 可简化清单

### 1. format utils 统一（搭便车）— ❌ 建议移出 T1

**设计项**：架构文档 §1「搭便车改造目标」+ §7 目录 `shared/format.ts`，把两包重复的
`formatElapsedSeconds` / `formatEventLine` 统一到 `shared/format.ts`。

**deletion test（去掉会怎样）**：两包各自保留自己的 format 函数。结果：**不塌**。
两包的 TUI 渲染各自独立工作，互不依赖。

**比例性评估**：**负收益**。证据——两份实现**已经行为分叉**，不是真重复：

- `formatElapsedSeconds`：
  - subagents 版（`tui/format.ts:78`）：3 分支，<60s / <3600s / ≥3600s（处理小时）
  - workflow 版（`interface/views/format.ts:135`）：2 分支，<1s→"0s" / <60s / <3600s（**无小时分支**）
- `formatEventLine`：两边 ThemeLike 类型不同、逻辑不同，workflow 版注释明确写
  「对齐 subagents formatEventLine 的视觉风格，**但用 workflow 的 ThemeLike（无 spinner）**」

强行统一会出现两种结局：(a) 选一边行为，另一边回归；(b) 加参数分支兼容两种，得到一个
比两个 8 行函数更难读的参数化怪物。这是经典 false DRY：名字相同 → 以为重复 → 合并 →
引入回归或复杂度。

**建议**：**移出 T1**。`extractYamlField` 统一保留（那是真重复，两份 `function extractYamlField`
逻辑等价）。format 函数各管各的，留到 T3 或独立清理 PR 再评估是否真有必要统一。

---

### 2. executeAndAwait 独立方法（D-A1）— ✅ 保留，但 80 行偏高

**设计项**：SubagentService 新增 `executeAndAwait` 方法（而非复用 `execute(sync)`），预估 +80 行。

**deletion test（去掉会怎样）**：若不新增方法，让 SubprocessAgentRunner 直接 inline 调
`SubagentService.execute({wait:true})` 再转 AgentResult——**会塌，三处**：

1. **返回类型不兼容**：`execute` 返回 `ExecutionHandle`（discriminated union：
   `{mode:"sync", record, details} | {mode:"background", subagentId, ...}`），
   workflow 需要 `AgentResult`。inline 后 SubprocessAgentRunner 还是要写 handle→AgentResult
   的转换逻辑，只是换了个位置写。
2. **副作用污染**：`execute(sync)` 路径有 tool 层关切——嵌套 sync onUpdate 抑制
   （`subagent-service.ts:343-349`）、onUpdate 节流（200ms）、SubagentResultComponent spinner
   驱动。workflow 编排层在 Worker 线程外，不需要这些 TUI 副作用，复用会引入 spinner 泄漏风险
   （代码注释明确警告「转发 onUpdate 还会被 liftSync 误标 syncResponse → spinner setInterval 泄漏」）。
3. **T2 耦合**：T2 要删 sync 模式。若 executeAndAwait 复用 sync 路径，删 sync 时牵连
   executeAndAwait。独立方法让 T2 的删 sync 干净。

**比例性评估**：**合理但行数虚标**。独立方法本身的理由成立（三个独立塌点）。
但「+80 行」偏高——核心逻辑是「background 管道 + await runAndFinalize + AgentResult 映射」。
`runAndFinalize` 已存在（`subagent-service.ts:483`，已返回 subagents 的 AgentResult），
executeAndAwait 主要是包一层 + 做 `success→error?`/`text→content` 的映射（~15 行）。
预估 40-50 行更准确。**这不是过度设计，是估点偏高**。

**建议**：**保留独立方法**。但 issue 拆分时把估点修正到 40-50 行，避免 Wave 排期虚胖。

> ⚠️ **顺带发现一个 under-specification（非过度设计，但影响 D-A1 实现）**：
> 当前 `SubprocessAgentRunner.run(opts, signal, onEvent)` 的 `onEvent` 回调驱动 workflow 的
> live record（TUI 实时进度，`error-recovery.ts:276-280`）。架构文档 §9 泳道图只画了
> executeAndAwait 返回 AgentResult，**没说明 onEvent 流式回调如何穿透 executeAndAwait**。
> BC-4 声称「run 签名不变（含 onEvent）」，所以 executeAndAwait 必须支持 onEvent 透传。
> 这不是过度设计问题，是实现契约缺口，建议 issues.md 补一条 AC。

---

### 3. AgentRunner port 保留 — ✅ 保留，但「port」措辞过度

**设计项**：合并后 AgentRunner 仍保留为 port，仅一个实现 SubprocessAgentRunner。

**deletion test（去掉会怎样）**：让 `executeAgentCall` 直接依赖 `SubagentService`——**会塌**：
`executeAgentCall`（`execute-agent-call.ts:40`）签名是
`(call, runner, budget, signal, trace, onEvent)`，`runner: AgentRunner` 只有 1 个方法 `run`。
若换成 `service: SubagentService`，测试需 mock SubagentService 全部 ~15 个方法
（execute/cancel/findRecord/onChange/listRunning/collectRecords/...），且 `execute` 返回
`ExecutionHandle` 还要再转 AgentResult。窄接口（只依赖 `run`）mock 成本远低于宽接口。

**比例性评估**：**合理**。这是 Interface Segregation——依赖你需要的窄接口，不是伪 port。
单人开发也值得，因为 `execute-agent-call.ts` 有独立单测（重试/budget/stale-context），
mock 窄接口是测试可写性的硬需求。

**但措辞过度**：架构文档称其为「port」并做「证伪三连验证」，对一个「单方法函数参数类型」
来说仪式感过重。它实质是「executeAgentCall 的依赖参数类型」，不是 DDD sense 的 port。

**建议**：**保留 AgentRunner 类型**（实质正确）。但文档降调：别叫「port 证伪三连」，
叫「窄依赖类型（ISP）」。不影响实现。

---

### 4. resolveAgentOpts 独立模块（D-A3）— ✅ 保留（已存在，无需新建）

**设计项**：D-A3 讨论 resolveAgentOpts 合并后放哪层，是否 inline 进 runner。

**deletion test（去掉会怎样）**：**这个问题部分是伪命题**。证据——
`agent-opts-resolver.ts` **已经存在**（128 行 + 295 行测试），且**已经从
`error-recovery.ts:245`（dispatchAgentCall，Orchestration 层）调用**，不是从 runner 调用。
合并不改变这个调用位置。

「能否 inline 进 SubprocessAgentRunner.run」——**不能，且现状就不是那样**：
dispatchAgentCall 先 resolveAgentOpts 把 `{agent,skill,schema}` 解析成
`{systemPromptFiles, skillPath, schemaEnv}`，**然后才**调 `runner.run(resolvedOpts)`。
runner 收到的是已解析的 opts。inline 进 runner 会把「opts 解析（含临时文件生命周期）」
和「执行」耦合，且 runner 拿不到 `activeTempFiles`/`sessionDir`/`agentRegistry`
（这些是 Interface 层 session_start 注入的 per-session 依赖，归 Orchestration 层持有）。

**比例性评估**：**合理，且无需新增工作量**。独立模块已存在、有测试、职责清晰
（agent/skill/schema → 临时文件 + env）。D-A3 在文档里花篇幅讨论「放哪层」是过度讨论
一个已解决的问题。

**建议**：**保留现状**（文件不动，调用点不动）。文档 D-A3 可压缩为一句「resolveAgentOpts
保持现位置（infra），合并后不改调用链」。

---

### 5. BC-1~BC-8 数量 — ⚠️ 有冗余，8 → 5-6

**设计项**：8 条行为契约（refactor 模式回归清单）。

**deletion test（逐条）**：

| BC | 内容 | deletion test | 结论 |
|----|------|--------------|------|
| BC-1 | AgentResult 形状不变 | 删→无法验证输出契约 | **保留**（核心） |
| BC-2 | AgentCallOpts 形状不变 | 删→无法验证输入契约 | **保留**（核心） |
| BC-3 | pi.__workflowRun 签名不变 | 删→下游 coding-workflow 断裂 | **保留**（外部契约） |
| BC-4 | runner.run 签名不变 | 删→？run 签名由 BC-1+BC-2 决定（opts/signal/onEvent/result 全是前两者形状），**可派生** | **合并进 BC-1/BC-2** |
| BC-5 | workflow pending emit 不变 | 删→pending-notifications 集成回归 | **保留** |
| BC-6 | subagent tool 行为不变 | 删→tool 层回归 | **保留** |
| BC-7 | error-recovery 重试不变 | 删→重试/budget 回归 | **保留** |
| BC-8 | schema 契约保持（D-A6 bridge） | 删→structured-output 静默失效 | **保留**（D-A6 是新风险点，值得单独盯） |

**比例性评估**：BC-4 是唯一明确冗余——`run(opts: AgentCallOpts, signal, onEvent): Promise<AgentResult>`
的签名完全由 BC-1（AgentResult）+ BC-2（AgentCallOpts）决定。opts 形状不变 + result 形状不变
→ run 签名不可能变。BC-4 是 BC-1/BC-2 的推论。

其余 7 条各有独立验证目标（输入/输出/外部 RPC/内部事件/tool 层/重试/schema bridge），
不冗余。8 条不算过多，但 1 条可省。

**建议**：**删除 BC-4**（合并进 BC-1+BC-2 的注释），或保留但在文档标注「BC-4 是 BC-1/BC-2
的推论，无需独立测试」。净 8 → 7。

---

### 6. T1 整体范围 — ✅ 不过大，不建议拆分

**设计项**：T1 = 包结构合并 + 执行链统一。是否应拆成「先合并结构，执行链单独做」？

**deletion test（拆分会怎样）**：

拆成 T1a（纯结构合并，保留两条 spawn 路径）+ T1b（执行链统一）：

- **T1a 后的中间态很尴尬**：新包内 `SubprocessAgentRunner`（自己 spawn pi）和
  `session-runner`（也 spawn pi）**共存于同一包**，两份 spawn 代码面对面却互不调用。
  编译能过、测试能过，但包内有明知的死代码/重复代码——这是个「明知有问题但故意留着」的状态，
  违反「冲突要表面化」原则。
- **T1a 几乎没有独立价值**：合并后不删重复 infra，省不下维护成本（重复代码还在，只是换了目录）。
  G2（执行链单一实现）才是合并的主要收益，拆掉后 T1a 只剩 G1（单包交付）的壳。
- **耦合方向**：执行链统一**依赖**包合并（SubprocessAgentRunner 要 import SubagentService，
  同包才能干净 import；跨包 import 正是合并要消除的）。所以「先合并结构」无法独立验证
  「执行链统一」——它只是把风险延后，不减少风险。

**比例性评估**：**拆分增加中间态成本，不减少风险**。当前 T1 的 Wave 拆分（Execution 层
先做 executeAndAwait，Orchestration 层后做委托）已经把风险隔离在 Wave 级别，不需要
topic 级拆分。

**建议**：**不拆分**。T1 范围合理。若想降风险，可在 issues.md 里把 Wave 1（Execution 层
executeAndAwait + session-runner schemaEnv 扩展）做成「可独立验证」的 Wave——
executeAndAwait 写完后用临时测试验证，再做 Wave 2（Orchestration 委托）。Wave 内隔离，
而非 topic 拆分。

---

## 汇总

| # | 设计项 | 结论 | 动作 |
|---|--------|------|------|
| 1 | format utils 统一 | ❌ 过度（false DRY） | **移出 T1**，extractYamlField 统一保留 |
| 2 | executeAndAwait 独立方法 | ✅ 合理 | 保留，估点从 80 修正到 40-50 行 |
| 3 | AgentRunner port 保留 | ✅ 合理（措辞过度） | 保留类型，文档降调「port」→「窄依赖类型」 |
| 4 | resolveAgentOpts 独立模块 | ✅ 合理（已存在） | 保留现状，文档 D-A3 压缩 |
| 5 | BC-1~BC-8 | ⚠️ BC-4 冗余 | 删 BC-4（BC-1/BC-2 推论），8 → 7 |
| 6 | T1 范围 | ✅ 不过大 | 不拆分，Wave 内隔离风险 |

**移出/简化后净效果**：T1 减少 1 个搭便车改造（format 统一）+ 1 条冗余 BC + 文档瘦身。
核心架构（包合并 + 执行链统一 + executeAndAwait + AgentRunner 窄类型）全部保留。

---

## 附：审查中发现的非过度设计问题（供 issues.md 参考）

1. **executeAndAwait 的 onEvent 透传未在文档明确**（见 #2 附注）：当前 runner.run 的
   onEvent 驱动 workflow live record（TUI 进度），executeAndAwait 必须支持 onEvent 透传，
   否则合并后 workflow agent 调用期间 TUI 无实时进度。建议 issues.md 补 AC。

2. **D-A6 schema bridge 的 session-runner 扩展**：文档说「session-runner.runSpawn 需扩展：
   接收 schemaEnv 参数，注入 childEnv」。这是 session-runner.ts 的签名变更，影响 subagents
   包现有调用方（tool 层 execute 不传 schemaEnv）。确认 tool 层不传 schemaEnv 时行为不变
   （childEnv 不含 PI_WORKFLOW_SCHEMA），否则 BC-6（subagent tool 不变）会被打破。
