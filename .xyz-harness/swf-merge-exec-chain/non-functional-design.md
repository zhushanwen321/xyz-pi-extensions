---
verdict: pass
upstream: issues.md
downstream: code-architecture.md
backfed_from: []
---

# 非功能性设计 — swf-merge-exec-chain（T1：包结构合并 + 执行链统一）

> **refactor 模式** — 合并两个已有 extension，保持行为等价。多数改动是结构重组 + 执行链委托，
> 安全/数据/性能等维度大面积 ✅。本文聚焦真正的行为变更点（executeAndAwait 新管道、SAR 委托、
> withSlot 改造、重复代码删除）的副作用。代码路径已逐条核对（subagent-service.ts execute/finalize、
> ConcurrencyGate.withSlot、session-runner.spawnedChildren、live/execution-record.ts projectLiveProgress）。

## 分析矩阵

| Issue | 方案 | 安全 | 数据 | 性能 | 并发 | 稳定性 | 兼容性 | 可观测 |
|-------|------|:----:|:----:|:----:|:----:|:------:|:------:|:------:|
| #1 包结构合并基建 | A cp 新建 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #2 executeAndAwait | A 独立方法 | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ |
| #3 schemaEnv bridge | A RunOptions 扩展 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #4 SAR 委托重写 | A per-session 注入 | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ |
| #5 重复代码消除 | D-A7 分类执行 | ✅ | ✅ | ✅ | ⚠️ | ✅ | ⚠️ | ✅ |
| #6 依赖声明更新 | json 更新 | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #7 全量测试+契约验证 | 流程 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

（✅ 无风险 / ⚠️ 有风险已缓解 / ❌ 不可接受需回退 / — 不适用+理由）

---

## 详细分析

### Issue #1: 包结构合并基建 — 方案 A（cp 新建）

#### ✅ 安全 / 数据 / 性能 / 并发 / 稳定性 / 可观测
纯文件复制 + 目录重组，无新权限模型/注入面、无 schema 变更（旧包数据不动）、无运行时热路径影响（编译/加载期）、无共享可变状态引入、旧包原样保留（D-004）独立加载、日志结构不变。

#### ⚠️ 兼容性：新旧包并存 tool/command 注册冲突

**风险**: 用户同时安装新旧包时，`subagent`/`workflow`/`workflow-script` tool 与 `/subagents` `/workflows` command 在三个 extension 中重复注册，Pi 加载器对同名 tool 的处理（报错 or last-wins）未保证。
**影响范围**: 升级期终端用户的加载行为；dev 环境若同时 link 新旧包。
**缓解方案**: T1 不动旧包（D-004 确认），由 T3 的 CHANGELOG/迁移指引明确告知用户「装新包前卸载旧两包」；dev 环境只 link 新包（旧包 npm 安装态不影响本地开发）。
**残余风险**: 升级窗口期内仍装旧包的用户会撞注册冲突——接受，理由：D-004 锁定旧包不动，冲突引导属 T3 文档职责，非代码可解。

---

### Issue #2: SubagentService +executeAndAwait — 方案 A（独立方法，剥离 notify）

#### ✅ 安全 / 数据 / 性能 / 并发
- **数据** ✅: AgentResult 映射是 RecordSnapshot 的只读投影（详见兼容性维度，丢字段风险归兼容性）。
- **性能** ✅: 内部 await background record 的 settle，无额外轮询/新定时器。
- **并发** ✅: 与 `execute()` 共享同一 ConcurrencyPool 是 G2「单池统一并发」的设计目标（跨路径配额正是合并的意义）；双重 acquire 风险不在 #2——executeAndAwait 单次 acquire 是正确语义，嵌套双重 acquire 归 #5 withSlot 改造（见 #5 并发）。

#### ⚠️ 稳定性：剥离 notify/kickOffBackground 后 record finalize/dispose 路径完整性

**风险**: `execute()` 体内 `emitPendingRegister`(L309) → sync 路径 `runAndFinalize`(L349) / bg 路径 `kickOffBackground`(L360)。executeAndAwait 不复用 execute() 也不调 kickOffBackground，须自行串起「护栏 → acquire 槽 → create record → runSpawn → runAndFinalize → await settled → map AgentResult」。若 spawn 同步抛错或 runAndFinalize 未覆盖某异常分支，record 永驻 `running` 态 → record 泄漏 + pending 永不 unregister。
**影响范围**: workflow 编排层每次 agent() 调用（高频路径）；record store 内存增长；pending-notifications 注册项堆积。
**缓解方案**: executeAndAwait 的 try/catch 必须在所有异常分支调 `finalizeFailed(record, err)`（与 execute L325-326 同款收尾），保证 record 必然 settle；复用 execute 已有的 finalizeFailed/finalizeRecord 而非新写收尾逻辑。
**残余风险**: 无——只要复用既有 finalize 路径即与 execute 等价；实现偏差由 AC-2.3（内部失败 → AgentResult.error 不 reject）测试兜住。

#### ⚠️ 兼容性：D-A10 AgentResult 双类型映射字段丢失

**风险**: subagents 内部形状 `{text, success, turns, sessionFile?, toolCalls}` → workflow 形状 `{content, error?, parsedOutput?, usage?, toolCalls?}` 映射。`turns`/`sessionFile` 在 workflow 侧无对应字段（丢弃，可接受）；但 `parsedOutput`/`usage`/`toolCalls` 若映射遗漏，下游 `worker-script-builder.ts:120` 的 `parsedOutput ?? content` fallback 与 budget 统计会静默退化。
**影响范围**: structured-output 契约（parsedOutput）、budget 超限判定（usage）、workflow script 对 toolCalls 的消费。
**缓解方案**: 映射表显式列全：`text→content`、`!success→error`、`parsedOutput`/`usage`/`toolCalls` 直通；映射函数单独可测（纯函数，不依赖 Pi 运行时）。
**残余风险**: 无——映射是确定性纯函数，字段对齐由单元测试断言。

#### ⚠️ 可观测性：剥离 notify 后 pending emit 是否保持

**风险**: D-A4 声称 executeAndAwait 正常 emit pending。核对代码：`emitPendingRegister/Unregister` 是独立函数（L65/73），在 execute() 体内显式调用（L309），与 notifier（BgNotifier.sendMessage followUp）是两套机制。executeAndAwait 作为新方法若漏调 emitPendingRegister/Unregister，pending-notifications 看不到 workflow agent 执行状态（BC-5 回归）。
**影响范围**: pending-notifications 注册表对 workflow agent 调用的可见性；`/pending` 查询完整性。
**缓解方案**: executeAndAwait 入口/出口显式调 emitPendingRegister/emitPendingUnregister（与 execute L309 对称），不依赖 kickOffBackground。
**残余风险**: 无——pending emit 与 notify 解耦已由代码结构证实，遗漏由 BC-5 回归测试兜住。

---

### Issue #3: session-runner schemaEnv bridge — 方案 A（RunOptions 扩展）

#### ✅ 安全 / 数据 / 性能 / 并发 / 稳定性 / 可观测
RunOptions 新增 `schemaEnv?: string` 可选参数，runSpawn 构造 childEnv 时条件注入 `PI_WORKFLOW_SCHEMA`；env 注入 O(1)；无共享状态/无新依赖/日志不变。

#### ⚠️ 兼容性：BC-6 等价性（不传 schemaEnv 时 childEnv 必须不含 PI_WORKFLOW_SCHEMA）

**风险**: tool 层 execute() 不传 schemaEnv，若 runSpawn 默认注入或残留 env，会改变 subagent tool 子进程的 structured-output 注册行为（破坏 BC-6）。
**影响范围**: subagent tool 的所有 background/sync 调用（BC-6 行为契约）。
**缓解方案**: 严格条件注入 `if (opts.schemaEnv) childEnv.PI_WORKFLOW_SCHEMA = opts.schemaEnv`；AC-3.2 断言不传时 childEnv 无此 key。
**残余风险**: 无——条件注入是确定性逻辑，AC-3.2 单元测试覆盖。

---

### Issue #4: SAR 委托重写 — 方案 A（per-session 注入，run 内全映射）

#### ✅ 安全 / 数据 / 可观测
- **数据** ✅: 映射逻辑在 #2（executeAndAwait 内），#4 是消费侧，SAR.run 收到的已是 workflow 形状 AgentResult，无二次转换。
- **可观测** ✅: onEvent 桥接维持 live-record TUI 进度（BC-10），观测通路保留。

#### ⚠️ 性能：onEvent 桥接 AgentEvent 逐条回调 + liveRecord 更新开销

**风险**: 合并前 workflow 经 pi-runner 读 raw JSONL → jsonl-to-agent-event 翻译 → updateFromEvent(liveRecord)；合并后 executeAndAwait 直接出类型化 AgentEvent（session-runner handleSdkEvent 出口），SAR 桥接 updateFromEvent。回调频率 = SDK event 频率（assistant delta / tool call，每 agent 调用数十至数百次）。理论上每 event 多一次函数调用跳转，但合并**移除了 raw→typed 翻译步骤**，净开销接近中性或略降。
**影响范围**: WorkflowsView agent 实时进度渲染流畅度（TUI re-render）。
**缓解方案**: 不引入额外优化（YAGNI）——翻译层移除抵消回调跳转；updateFromEvent 保持增量更新（已是现状）。
**残余风险**: 低——event 频率与合并前同源（SDK event ↔ JSONL line 一一对应），无 SLA 阈值可量化压测；接受，#7 集成测试人工观测 WorkflowsView 无卡顿即可。

#### ⚠️ 并发：timeoutMs 合并 signal 的竞态与清理

**风险**: SAR.run 现状（L50-59）已用单 AbortController 合并 `外部 signal abort` + `setTimeout(timeoutMs) abort`，二者都调 `controller.abort()`（幂等，无竞态）。委托后须把这段合并逻辑（含 L144-145 的 `removeEventListener` 清理，防止 listener 随 agent 调用数线性泄漏）忠实移植到委托前的 signal 构造。风险不在竞态本身，而在**移植遗漏清理逻辑**导致 listener 泄漏。
**影响范围**: 长 workflow（数十次 agent 调用）的 signal listener 累积；外部 signal 生命周期长于单次 run。
**缓解方案**: 抽 `mergeSignals(external, timeoutMs): AbortSignal` 工具函数（SAR 复用），正常完成路径摘除 listener（与现状 L144-145 对称）；AC-4.2 断言 timeoutMs 超时 → AgentResult.error。
**残余风险**: 无——合并逻辑是现状的等价移植，listener 清理由 AC-4.2 + 现有 ConcurrencyGate.run 对称实现保证。

#### ⚠️ 稳定性：M-4 子进程 kill 归属迁移（SAR → session-runner.spawnedChildren）

**风险**: 合并前 SAR 经 runPiProcess 在 signal abort 时直接 SIGKILL 子进程；合并后子进程由 session-runner 的 `spawnedChildren` Set 统一追踪，kill 路径变为：workflow abort → signal → executeAndAwait record abort → session-runner controller → child kill；dispose 兜底由 `killAllSpawnedChildren`（session-runner L99）覆盖。M-4 判定为「行为增强非回归」，但须确认 dispose 兜底对 workflow 路径等价（workflow 无自己的 kill 路径了）。
**影响范围**: workflow abort/dispose 时 agent 子进程的终止及时性；孤儿进程风险。
**缓解方案**: session-runner spawnedChildren 已覆盖 sync + background 全部子进程（L71-81 注释明确），dispose 兜底 killAllSpawnedChildren 对 workflow 委托的子进程同样生效；AC-4.6 断言 dispose 后无存活子进程。
**残余风险**: 无——spawnedChildren 是 process 级全局 Set（session-runner L81），覆盖面广于 SAR 原 per-call kill；行为增强已由 M-4 确认。

#### ⚠️ 兼容性：AgentCallOpts → ExecuteOptions 映射保真

**风险**: D-A2 映射集中在 SAR（`prompt→task, agent, schema→JSON.stringify→schemaEnv, cwd, model: opts.model ?? ctxModel`）。`systemPromptFiles`/`skillPath` 等 workflow 特有字段若映射遗漏，agent 行为退化（system prompt 缺失）。
**影响范围**: workflow agent() 的 system prompt / skill 注入完整性。
**缓解方案**: 映射表显式列全（含 resolveAgentOpts 已解析的 systemPromptFiles/skillPath）；映射集中在 SAR 单点，便于测试。
**残余风险**: 无——映射是 adapter 单点逻辑，字段对齐由 AC-4.1/AC-4.4/AC-4.5 覆盖。

---

### Issue #5: 重复代码消除 — D-A7 分类执行

#### ✅ 安全 / 数据 / 性能 / 稳定性 / 可观测
删重复文件（live 三件套 + agent-discovery + extractYamlField + pi-runner）/ 适配保留（concurrency-gate withSlot 委托）/ 保留（jsonl-parser）；无新权限面、无 schema 变更、无热路径新增、dispose/通知机制不变、日志不变。

#### ⚠️ 并发：withSlot 改委托 ConcurrencyPool 的双重 acquire

**风险**: 现状 ConcurrencyGate 有**自己的**并发池（`active` 计数 + `slotQueue`，独立于 subagents ConcurrencyPool）。error-recovery 经 `gate.withSlot(() => executeAgentCall(...))`（L284）占 workflow 侧槽，executeAgentCall → SAR.run → （合并后）executeAndAwait → ConcurrencyPool.acquire 占 subagents 侧槽。**两次独立池的占槽 = 同一 agent 调用消耗双份并发配额**（workflow 4 + subagents N），实际并发上限可能翻倍或互相饿死。
**影响范围**: workflow 并发 agent 调用的实际并发度；error-recovery 重试的排队行为（AC-ARCH-5 / AC-5.3）。
**缓解方案**: #5 改造 withSlot 时**不再独立占池**——withSlot 退化为「保留 signal abort 队列移除 + AbortError 语义」的薄封装，并发控制唯一来源是 executeAndAwait 内的 ConcurrencyPool.acquire（单池）。withSlot 只承接 abort/remove 行为契约（AC-5.3），不重复 acquire。
**残余风险**: 若 withSlot 保留独立池（误判为「语义不变」），双重 acquire 静默生效——必须由 AC-5.3 显式断言「嵌套调用槽位占用 = N 而非 2N」兜住。

#### ⚠️ 兼容性：projectLiveProgress 差异处理

**风险**: `live/execution-record.ts` 删除后改用 `execution/execution-record.ts`，但 `projectLiveProgress`（live/execution-record.ts:526）是 workflow 独有函数，被 WorkflowsView（L755）+ detail-content（L78/L220/L273）消费。若随文件删除而消失，WorkflowsView agent 实时进度渲染断裂。
**影响范围**: workflow TUI 的 live 进度展示（BC-10）。
**缓解方案**: projectLiveProgress 不随 live/execution-record.ts 删除——迁移到 execution/execution-record.ts（与 ExecutionRecord 同源）或独立 live-projection 工具；保留对 liveRecord 的消费契约。
**残余风险**: 无——函数迁移是机械操作，BC-10 回归测试覆盖渲染不变。

---

### Issue #6: 依赖声明更新 — extension-dependencies.json + coding-workflow 指向

#### ✅ 安全 / 数据 / 性能 / 并发 / 稳定性 / 可观测
JSON 元数据更新 + ajv 校验；无运行时行为变化、无共享状态、无日志变化。

#### ⚠️ 兼容性：coding-workflow dependsOn 指向变更

**风险**: coding-workflow 若在 package.json `dependencies` 硬编码 `@zhushanwen/pi-workflow`（用于类型 import），改指 `@zhushanwen/pi-subagents-workflow` 后 import 路径需同步；若仅靠运行时 `pi.__workflowRun` 挂载消费（非直接 import），则仅 install 顺序变化。需核对 coding-workflow 实际 import 形态。
**影响范围**: coding-workflow 的 typecheck / 构建可用性（AC-7.5）。
**缓解方案**: 核对 coding-workflow 对 pi-workflow 的 import 形态——纯运行时消费（pi.__workflowRun）则只改 extension-dependencies.json + 安装声明；有类型 import 则同步改 import 路径；AC-7.5 全量 typecheck 兜底。
**残余风险**: 无——import 形态可静态核对，typecheck 全绿即闭合。

---

### Issue #7: 全量测试 + 下游契约验证 — 流程

#### ✅ 全维度
本 issue 是验证门本身（BC-1~12 + AC-ARCH-1~5 + 三包现有测试 + coding-workflow 集成），不引入新副作用；它是上述所有 ⚠️ 缓解项的验收落点，非风险源。兼容性维度即 BC/AC 回归覆盖，可观测即 BC-5 pending emit 回归。

---

## 缓解项回灌登记（Mitigation Rollback）

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | 验收方式 | 状态 |
|--------|------------|------|---------|--------|----------|------|
| executeAndAwait 异常分支 finalize 覆盖（record 必 settle） | #2 | 稳定性 | ⑤test-matrix | spawn 失败/超时 → record settled 为 failed，无泄漏用例（AC-2.3） | 代码测试 | 待落 |
| D-A10 AgentResult 映射纯函数字段对齐 | #2 | 兼容性 | ⑤test-matrix | 映射函数单测：text→content/!success→error/parsedOutput+usage+toolCalls 直通（AC-2.2） | 代码测试 | 待落 |
| executeAndAwait pending emit 显式调用 | #2 | 可观测 | ⑤test-matrix | BC-5 回归：executeAndAwait 触发 pending:register/unregister | 代码测试 | 待落 |
| schemaEnv 不传时 BC-6 childEnv 等价 | #3 | 兼容性 | ⑤test-matrix | AC-3.2：不传 schemaEnv → childEnv 不含 PI_WORKFLOW_SCHEMA | 代码测试 | 待落 |
| onEvent 桥接 liveRecord 无渲染卡顿 | #4 | 性能 | ⑦集成观测 | #7 集成测试人工观测 WorkflowsView 流畅度 | 代码测试 | 待落 |
| mergeSignals 工具函数 + listener 清理移植 | #4 | 并发 | ⑤test-matrix | AC-4.2：timeoutMs 超时 → AgentResult.error；listener 不累积 | 代码测试 | 待落 |
| M-4 dispose 兜底覆盖 workflow 子进程 | #4 | 稳定性 | ⑤test-matrix | AC-4.6：dispose 后无存活 agent 子进程 | 代码测试 | 待落 |
| AgentCallOpts→ExecuteOptions 映射保真 | #4 | 兼容性 | ⑤test-matrix | AC-4.1/4.4/4.5：systemPromptFiles/skillPath/cwd/model 填底 | 代码测试 | 待落 |
| withSlot 不独立占池（abort 语义薄封装） | #5 | 并发 | ⑤test-matrix | AC-5.3 + 嵌套调用槽位占用=N 而非 2N 断言 | 代码测试 | 待落 |
| projectLiveProgress 迁移保留 | #5 | 兼容性 | ⑤test-matrix | BC-10：WorkflowsView live 进度渲染不变 | 代码测试 | 待落 |
| coding-workflow import 形态核对 + typecheck | #6 | 兼容性 | ⑤test-matrix | AC-7.5：coding-workflow tsc 全绿 | 代码测试 | 待落 |
| 新旧包并存迁移指引 | #1 | 兼容性 | ③issue(T3) | T3 CHANGELOG 告知「装新包前卸载旧两包」 | 运维项 | 待落 |

---

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|
| 新旧包并存 tool/command 注册冲突 | 升级期用户加载异常 | D-004 锁定旧包不动；冲突引导属 T3 文档职责，非代码可解 | 用户反馈 / T3 CHANGELOG |
| onEvent 桥接性能（理论中性） | WorkflowsView 渲染 | 合并移除 raw→typed 翻译层抵消回调跳转；event 频率与合并前同源 | #7 集成测试人工观测 |

---
| 双重记账一致性（M-6）已移交 T2 | T2 record 生命周期统一 | D-009 已确认 T1 不改 record 生命周期；T2「通知合并」时统一处理 | 在 T2 启动时作为输入显式登记 |

## 需⑤骨架验证的副作用

> 标记后 stub 进⑤骨架，结论回写本节。

| 副作用 | 验证什么 | 预期结论方向 | stub 落点 |
|--------|---------|-------------|----------|
| withSlot 委托后是否独立 acquire | withSlot 在 SAR→executeAndAwait 路径上是否重复占池 | withSlot 退化为 abort 薄封装，不 acquire；单池配额生效 | withSlot 签名 + acquire 调用点（concurrency-gate.ts） |
| executeAndAwait record finalize 全分支覆盖 | spawn 抛错/超时/正常三路径是否都 settle record | 所有异常分支调 finalizeFailed，record 必然离开 running 态 | executeAndAwait 方法签名 + try/catch finalize 调用点（subagent-service.ts） |
