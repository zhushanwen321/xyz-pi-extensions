# 独立重建审查 — swf-merge-exec-chain

> **审查方法**：禁读初稿，先从源码 + CONTEXT.md + AGENTS.md 独立重建「合并后该有哪些
> 用例/架构决策/行为契约」，再 diff 主 agent 初稿（requirements.md + system-architecture.md），
> 输出三态 gap。
>
> **重建依据**（已全部实读）：
> - `extensions/subagents/src/index.ts`、`extensions/workflow/src/index.ts`
> - `extensions/workflow/src/engine/models/ports.ts`、`types.ts`
> - `extensions/workflow/src/infra/subprocess-agent-runner.ts`、`pi-runner.ts`、`agent-discovery.ts`
> - `extensions/subagents/src/runtime/subagent-service.ts`（execute 入口 L260-380）、
>   `core/session-runner.ts`（buildSpawnArgs/runSpawn + 顶部）、`core/agent-registry.ts`、
>   `core/pi-invocation.ts`
> - `extensions/coding-workflow/lib/gates/gate.ts`
> - `extension-dependencies.json`、项目根 `CONTEXT.md`、`AGENTS.md`

---

## 0. 重建结论（先于 diff）

### 两包当前真相（与 CONTEXT.md/AGENTS.md 的关键出入）

CONTEXT.md / AGENTS.md 均断言「`@zhushanwen/pi-subagents` **已改为进程内
`createAgentSession()`，不 spawn**」。**这与源码不符**：

- `extensions/subagents/src/core/session-runner.ts` 顶部注释（L1-5）明确：
  > spawn pi --mode json 子进程执行 session 的编排器…**runSpawn 是唯一执行入口**
  > （sync/background 共用）…spawn 改造后：session 在独立子进程跑
- `buildSpawnArgs`/`runSpawn`/`getPiInvocation`（pi-invocation.ts）组成完整的
  spawn 链，`spawnedChildren` Set + `killAllSpawnedChildren` 兜底 kill 孤儿子进程。

**即两包现在都是 spawn `pi --mode json`**。合并的前提「两条并行 spawn 路径」成立，
但项目文档的「subagents 进程内」描述已过期。本审查最重要的发现：**初稿从未点出
这个 doc/code 漂移**。

### 重建出的「合并后必须满足」清单（独立推导）

**用例（初稿 UC-1..UC-5 之外应显式覆盖的）**：
- fork 子代理（继承父 session 上下文，`--fork` sessionFile）
- worktree 隔离子代理（`worktree:true`，MF#7 要求 fork:true）
- 并行扇出（background 池 + maxConcurrent）
- 嵌套深度护栏（MAX_FORK_DEPTH=10，11 层上限）
- session 生命周期/清理（killAllSpawnedChildren、worktree reaper、session file GC、kill-9 恢复）
- 模型解析（ModelConfigService 三层回退）

初稿把这些压缩进 UC-4「subagent tool 行为不变 + 现有测试全绿」。对 subagent tool
本身（走 `execute()`，代码不动）这是可接受的重构策略；**但对 `executeAndAwait`
这条新代码路径，上述契约是否被新路径尊重，初稿未规定**——这是真正的 gap。

**架构决策点（初稿 D-A1..D-A7 之外应明确表态的）**：
- executeAndAwait 是否经过 execute() 入口的嵌套护栏
- executeAndAwait 是否复用 kickOffBackground（含 followUp 注入）
- 合并后孤儿子进程的 kill 归属（subagents 的 spawnedChildren vs workflow 的 D-4 恢复）
- WorkflowRun + ExecutionRecord 双重记账的重叠
- 模型解析归属（workflow 从「无」变为共享 ModelConfigService，是行为变更还是保持）
- CONTEXT.md/AGENTS.md 过期描述的订正

**行为契约（初稿 BC-1..BC-8 之外应新增的）**：
- 嵌套护栏对新入口生效
- 编程式消费者（workflow）不得被注入 followUp 消息
- workflow agent 子进程的崩溃恢复链不因 spawn 归属迁移而断
- 模型解析等价性（零回归的具体含义）

---

## 1. 三态 Gap 清单

> 标注：`[H]`高 `[M]`中 `[L]`低。每条含：发现 / 类型 / 源码证据 / 为什么主 agent 漏了。

### MISSING（重建有、初稿无）

---

**[M-1] [H] CONTEXT.md/AGENTS.md「subagents 进程内」描述与源码冲突，初稿未点出**
- **类型**：MISSING（架构决策 + spec 准确性）
- **发现**：合并的全部理由是「两条 spawn 路径」。但 CONTEXT.md（Subagent 词条）与
  AGENTS.md（运行环境小节）都白纸黑字写「subagents 已改为进程内 createAgentSession()，
  不 spawn」。一个信任文档的 spec 读者会得出「只有 workflow 一条 spawn 路径，合并多余」
  的结论。初稿 §3 统一语言「引用项目根 CONTEXT.md」却没核对所引文档与源码是否一致。
- **证据**：`session-runner.ts` L1-5（runSpawn 唯一入口）；`pi-invocation.ts` 全文
  （spawn pi 基座模块，注释「spawn 改造 in-process → spawn pi --mode json」）；
  AGENTS.md「运行环境」小节「@zhushanwen/pi-subagents 已改为进程内…不 spawn」。
- **为什么漏了**：主 agent 从源码写了 spec，但把 CONTEXT.md 当既定事实引用而未做
  doc↔code 交叉校验。§8 把「AGENTS.md/CLAUDE.md 更新」整体推给 T3，却没意识到
  「in-process vs spawn」是一个**已存在的错误描述**，而非待更新的目录条目——它
  直接动摇合并前提的可信度。**应在 requirements §1 业务目标里显式记录这个漂移，
  作为合并动机的佐证之一，而非埋进 T3 的泛化「文档更新」。**

---

**[M-2] [H] executeAndAwait 与 followUp 注入的关系未规定（正确性风险）**
- **类型**：MISSING（行为契约）
- **发现**：初稿 D-A1/D-A4 反复说「executeAndAwait 内部走 background 管道」，但
  background 管道的关键副作用是 `kickOffBackground` → `notifier.ts` L158-163
  `sendMessage({ customType:"subagent-bg-notify", … }, { triggerTurn:true,
  deliverAs:"followUp" })`——**向主对话注入一条 followUp 消息唤醒父 agent**。
  workflow 是**编程式消费者**（await Promise 拿 AgentResult），它不需要、也不应该
  被注入 followUp。初稿全程没说 executeAndAwait 是复用 kickOffBackground（会误注入）
  还是剥离 notify 路径（只保留 spawn + 槽位 + record）。
- **证据**：`subagent-service.ts` L360（`kickOffBackground(...)`）、L563（定义）；
  `notifier.ts` L158-163（followUp 注入）；初稿 §9 泳道图「SS->>SS: 内部 background
  管道（acquire 槽 + create record）」只画了槽和 record，**漏画 notify/followUp**。
- **为什么漏了**：D-A4 把「pending emit」（EventBus，id 区分）和「followUp 消息注入」
  （sendMessage，改主对话）混为一谈，只处理了前者。主 agent 跟踪了 pending 通道
  却没跟踪 notifier 通道。这是新路径最可能的实际 bug 源——workflow agent 调用完成后
  会往主对话塞一条 bg-notify 消息。

---

**[M-3] [M-H] executeAndAwait 是否经过 execute() 入口的嵌套护栏未规定**
- **类型**：MISSING（行为契约）
- **发现**：`execute()` 顶部（subagent-service.ts L286-300）有 `parentNesting`/
  `nestingDepth`/`MAX_FORK_DEPTH` 护栏，拦截 `nestingDepth > MAX_FORK_DEPTH`。
  初稿把 executeAndAwait 定为「新增独立方法」（D-A1），独立方法若不复制该护栏，
  workflow agent 调用（经 dispatchAgentCall → executeAndAwait）将绕过递归限制。
  workflow 脚本可以递归调 agent，无护栏会资源耗尽。
- **证据**：`subagent-service.ts` execute 入口 execCtxAls 护栏；初稿 D-A1「新增方法，
  不复用 execute」+ §9「SS->>SS 内部 background 管道」未提护栏。
- **为什么漏了**：主 agent 聚焦 happy-path 参数映射（AgentCallOpts→ExecuteOptions），
  没追溯 execute() 入口的安全护栏在新路径是否仍然生效。executeAndAwait 的契约清单
  （应类似 BC-6）缺失。

---

**[M-4] [M] 合并后孤儿子进程的 kill 归属迁移未追溯**
- **类型**：MISSING（架构决策）
- **发现**：合并前：subagent tool 子进程由 subagents 的 `spawnedChildren` Set +
  `killAllSpawnedChildren`（dispose 兜底）管；workflow agent 子进程由 workflow 自己
  spawn（pi-runner），崩溃走 D-4（session_start 把 running→failed）。
  合并后：workflow agent 调用也经 session-runner.runSpawn，**这些子进程现在进了
  subagents 的 spawnedChildren Set**。那么：(a) dispose 时 subagents 会 kill 它们——
  行为是否等价于旧 workflow 的处理？(b) D-4 恢复的是 WorkflowRun 状态，但对应的
  ExecutionRecord（subagents 侧）谁来清？双重记账产生残留 record 的风险。
- **证据**：`session-runner.ts` spawnedChildren Set + killAllSpawnedChildren 注释
  （C1）；workflow `index.ts` session_start 的 D-4 块（running→failed +
  pending:unregister）；初稿 BC-5 只说「workflow pending emit 不变」，未提子进程
  与 record 的归属迁移。
- **为什么漏了**：主 agent 把合并建模为「SubprocessAgentRunner 委托 executeAndAwait」
  的接口层改造，没追踪「子进程所有权」这个运行时副作用随 spawn 路径迁移后的清理责任。

---

**[M-5] [M] 模型解析归属未表态（零回归边界模糊）**
- **类型**：MISSING（架构决策 + 行为契约）
- **发现**：subagents 有完整 `ModelConfigService`（override→agentConfig→主 agent model
  三层回退 + TaskComplexity→model 映射）；workflow 当前**没有**模型解析（AgentCallOpts
  传 `model`/`scene`，SubprocessAgentRunner 直接 `--model opts.model`，缺省走 pi 默认）。
  合并后 executeAndAwait 走 SubagentService，是否触发 ModelConfigService 的三层回退？
  若触发 → workflow agent 调用获得更丰富的模型解析（**行为变更**，非回归）；若不触发 →
  需明确 executeAndAwait 绕过 ModelConfigService 只透传 model。初稿 G3「零功能回归」
  对此未定义——「更丰富解析」算回归还是增强？
- **证据**：`model-config-service.ts`、`model-resolver.ts`（subagents 三层）；workflow
  `types.ts` AgentCallOpts.model/scene + `pi-runner.ts` buildArgs（直接 `--model`）；
  初稿 BC 表无模型解析条目，D-A2 只说「映射放 SubprocessAgentRunner」未提解析归属。
- **为什么漏了**：主 agent 把 model 当透传字段，没识别 subagents 有一整个 ModelConfigService
  是 workflow 从未有过的能力。

---

**[M-6] [M] WorkflowRun + ExecutionRecord 双重记账未处理**
- **类型**：MISSING（架构决策）
- **发现**：合并后一次 workflow agent 调用同时被两个聚合根追踪：workflow 的
  `WorkflowRun`（JsonlRunStore 持久化）和 subagents 的 `ExecutionRecord`（record-store）。
  kill-9 / pause / abort 时两侧状态是否一致？初稿 D-A4 只处理了 pending emit 不冲突
  （id 不同），没处理 state-store 重叠。T2「删 sync + 通知合并」会更深地动 record 生命周期，
  T1 留下双重记账会给 T2 埋雷。
- **证据**：workflow `engine/models/workflow-run.ts`（聚合根）；subagents record-store
  （ExecutionRecord 聚合）；初稿 §4 模型表把两者并列但未讨论一致性。
- **为什么漏了**：同 M-4，主 agent 只看接口委托，没看状态归属。

---

### MISMATCH（初稿写了但断言不对 / 自相矛盾）

---

**[X-1] [M] deprecated 标记：UC-2/AC-2.1/F3 与 §7/D-004/D-A5 直接冲突**
- **类型**：MISMATCH（初稿内部自相矛盾）
- **发现**：
  - UC-2 标题「旧包向后兼容（**deprecated**）」+ AC-2.1「旧两包 package.json 含
    **deprecated 标记**」+ F3「旧两包标记 deprecated」
  - 但 §7 业务约束「旧两包代码原样保留（**不动、不标记 deprecated**）」+ D-004
    「旧包原样保留（**不需 deprecated 标记**）」+ D-A5「**不标记 deprecated**」
  - 已确认的决策是 D-004（不标记）。UC-2/AC-2.1/F3 是早期迭代残留，未与新决策对齐。
- **为什么漏了**：决策从「标记 deprecated」演进到「不动不标记」（D-004），但 UC-2、
  AC-2.1、F3 三处旧文案没回溯更新。典型 stale-residual。
- **修正**：UC-2 应改为「旧包原样保留（不标记）」，删 AC-2.1 的 deprecated 标记断言，
  F3 改为「旧两包代码原样保留不动」。

---

**[X-2] [L-M] AC-3.4「worktree 隔离」混淆两种 worktree 机制**
- **类型**：MISMATCH（断言不准）
- **发现**：AC-3.4「agent({cwd}) 的 **worktree 隔离**执行正确（ADR-029 契约不变）」。
  但 workflow 的 ADR-029 cwd 是 **spawn 子进程的 cwd 绑定**（AgentCallOpts.cwd →
  `child_process.spawn({cwd})`），**不创建 git worktree**。subagent tool 的
  `worktree:true` 才是 `WorktreeManager.create`（创建 git worktree 分支 + pid 注册表）。
  两者是完全不同的机制。AC-3.4 用「worktree 隔离」描述 cwd 绑定是误导。
  更关键：合并后 executeAndAwait 映射 AgentCallOpts.cwd → ExecuteOptions 时，映射到
  `cwd`（等价 ADR-029，正确）还是 `worktree`（会凭空创建 git worktree，行为变更）？
  初稿 D-A2 未明确这个映射，AC-3.4 又用歧义词，组合起来有误改风险。
- **证据**：workflow `types.ts` AgentCallOpts.cwd 注释「per-call 工作目录…spawn 的
  cwd option」；subagents `worktree-manager.ts`（git worktree 创建）；初稿 D-A2
  「映射放 SubprocessAgentRunner」未列字段映射表。
- **为什么漏了**：主 agent 没区分「cwd 透传」与「WorktreeManager 隔离」。

---

**[X-3] [L] requirements F6 与 architecture D-A7 删除边界不一致**
- **类型**：MISMATCH（requirements vs architecture 未对齐）
- **发现**：F6「删除 workflow 重复 infra（**pi-runner/agent-discovery/concurrency-gate 等**）」
  把 concurrency-gate 列为删除对象；但 D-A7 明确「concurrency-gate **保留 withSlot 封装层**」、
  「pi-runner 删，**但前提**是从 session-runner 抽取 spawn-args」。F6 的「等」掩盖了
  D-A7 细分的「直接删 / 适配保留 / 有条件删」三档。
- **为什么漏了**：requirements 先写（粗粒度），architecture 后做深度对比（D-A7）细化了
  边界，但 requirements F6 没回填修正。
- **修正**：F6 应引用 D-A7 的分类表，或改为「按 D-A7 分类处理重复 infra」。

---

### PHANTOM（初稿有、查不到依据）

---

**[P-1] [L] 「约 1200 行重复代码」为估值，非实测**
- **类型**：PHANTOM（弱，定量断言无测量依据）
- **发现**：requirements G2.2 与 architecture §7/D-A7 反复引用「约 1200 行重复」、
  「可直接删约 400 行」。实测 workflow 侧候选文件行数：live/execution-record 544 +
  live/types 185 + jsonl-to-agent-event 123 + jsonl-parser 131 + concurrency-gate 340
  + pi-runner 198 + agent-discovery 263 = 1784 行（文件总量，非重复量）。真正「零改动
  复制可直接删」的只有 live/execution-record + live/types + extractYamlField，远不到
  400 行的「重复」（544+185 是文件全量，其中 types.ts 是子集）。「1200 / 400」是合理
  量级的估算，但初稿把它当既定事实写入验收口径（G2.2 成功标准隐含这个数）。
- **为什么漏了**：主 agent 做了深度对比（D-A7 的 API 差异分析很扎实），但行数是目测，
  没跑测量脚本。
- **影响**：低。量级正确，不影响方案。建议 issues 阶段以实测行数替代估值，避免 Wave
  工作量估算偏差。

---

**[P-2] [L] D-A6「index.ts:216」引用准确，无 phantom**
- 核验：`extensions/structured-output/src/index.ts` L216 `const schemaEnv =
  process.env[ENV_SCHEMA]` 确实存在，D-A6 前提成立。**此条不成立为 phantom**，
  仅记录已核验。runSpawn 当前 `childEnv = { ...process.env }`（session-runner.ts L462）
  确实不设 PI_WORKFLOW_SCHEMA，D-A6 的 gap 识别正确。

---

## 2. 汇总与处置建议

| id | 类型 | 严重度 | 建议处置 |
|----|------|--------|---------|
| M-1 | MISSING | H | requirements §1 补「doc/code 漂移」作为合并动机佐证；T3 文档更新里显式列「subagents in-process→spawn」订正项 |
| M-2 | MISSING | H | 补 BC：executeAndAwait **不得**触发 followUp 注入；D-A1 明确「剥离 notify/kickOffBackground，仅复用 runSpawn+槽+record」 |
| M-3 | MISSING | M-H | 补 BC：executeAndAwait 必须经嵌套护栏（或显式声明 workflow 路径豁免并给出理由） |
| M-4 | MISSING | M | issues 阶段补「子进程 kill 归属迁移」决策点 |
| M-5 | MISSING | M | D-A2 补字段映射表；明确 executeAndAwait 是否经 ModelConfigService |
| M-6 | MISSING | M | issues 阶段补「双重记账一致性」决策点（或显式标记 T2 处理） |
| X-1 | MISMATCH | M | 修 UC-2/AC-2.1/F3 与 D-004 对齐 |
| X-2 | MISMATCH | L-M | AC-3.4 改「cwd 透传」措辞；D-A2 补 cwd→ExecuteOptions 字段映射 |
| X-3 | MISMATCH | L | F6 引用 D-A7 分类表 |
| P-1 | PHANTOM | L | issues 阶段以实测行数替代估值 |

**总评**：初稿在「已覆盖部分」的源码贴合度高（D-A6 的 line 引用、D-A7 的 API 差异分析
均经核验准确），三 topic 拆分（D-001）与 D-003 AgentRegistry 统一策略合理。主要缺陷
集中在 **executeAndAwait 这条新代码路径的契约面**——主 agent 把合并建模为接口委托，
却没追溯新路径对安全护栏（M-3）、消息注入（M-2）、子进程/状态归属（M-4/M-6）的影响。
M-1（文档漂移）则削弱了合并动机的可信度叙述。建议进入 issues 阶段前至少闭合 M-1/M-2/M-3。

**未修改任何源文件。** 本文件为唯一产出。
