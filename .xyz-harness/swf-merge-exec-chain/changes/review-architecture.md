---
verdict: APPROVED
reviewer_role: 独立 reviewer（架构合理性 + 边界）
scope: system-architecture.md + requirements.md
source_verified:
  - extensions/workflow/src/engine/models/ports.ts
  - extensions/workflow/src/infra/subprocess-agent-runner.ts
  - extensions/workflow/src/engine/error-recovery.ts (L255-300)
  - extensions/workflow/src/engine/live/execution-record.ts
  - extensions/workflow/src/engine/live/jsonl-to-agent-event.ts
  - extensions/workflow/src/engine/models/types.ts (AgentCallOpts/AgentResult)
  - extensions/subagents/src/runtime/subagent-service.ts (execute L260-380)
  - extensions/subagents/src/core/session-runner.ts (runSpawn + RunOptions)
  - extensions/subagents/src/types.ts (ExecuteOptions)
  - extensions/subagents/src/core/output-collector.ts (parsedOutput 提取)
  - extensions/structured-output/src/index.ts (ENV_SCHEMA gate)
---

# 架构审查结论

**总体**：三层划分方向正确，AgentRunner port 证伪三连成立，executeAndAwait 独立方法
（D-A1）与映射归属（D-A2）理由扎实，D-A6 schema bridge 是真实 gap 且方案正确。
**但有 2 个 critical 行为缺口**（onEvent/live-record 数据通路断裂、per-call timeoutMs
静默回归），会让 refactor 模式的"零功能回归"目标 (G3) 不成立。需修订后重审。

## 立场声明（已确认 OK，不当 gap 重报）

| 审查点 | 结论 | 依据 |
|--------|------|------|
| 分层方向 Orchestration→Execution | ✅ 正确 | Engine 定义 AgentRunner port（ports.ts:32），Infra 实现，依赖向下 |
| AgentRunner 证伪三连（删/翻/挪）| ✅ 真边界 | ports.test.ts:24 用 mock runner 证明可测性；port 在 Engine 定义、Infra 实现，方向不可反 |
| D-A1 executeAndAwait 独立方法 | ✅ 成立 | execute() 返回 ExecutionHandle（service L357），executeAndAwait 需返回 AgentResult——返回类型确实不同；内部走 background 管道（非 sync 路径），T2 删 sync 不牵连 |
| D-A2 映射放 SubprocessAgentRunner | ✅ 成立 | AgentCallOpts 与 ExecuteOptions 字段集正交（见 MF-4），adapter 归调用方 |
| D-A6 schema bridge 必要性 | ✅ 真实 gap | structured-output index.ts:216 只在 `process.env.PI_WORKFLOW_SCHEMA` 存在时注册 tool；subagents runSpawn 的 childEnv 不设它（grep 0 命中）→ 不 bridge 则 schema enforcement 失效 |
| parsedOutput 契约（BC-8）可延续 | ✅ 成立 | subagents collectResult L86 `extractParsedOutput(toolCalls)` 已填充 parsedOutput，与 workflow pipeline.parsedOutput 语义等价 |
| 模型关联图（§4）主干 | ✅ 准确 | WorkflowRun→AgentCallOpts→ExecuteOptions→ExecutionRecord→AgentResult→WorkflowRun 链路与源码一致 |

---

## must_fix 发现

### MF-1 [Critical] onEvent / live-record 数据通路断裂 + 删除自相矛盾

**现象**：§7 删除清单列了
`orchestration/live/execution-record.ts` 和 `orchestration/live/jsonl-to-agent-event.ts`，
但 BC-7 声明保留的 `error-recovery.ts` 直接依赖这两者，且 executeAndAwait 的接口不携带 onEvent。
这是编译级矛盾 + 行为回归，双重问题。

**证据链**：

1. `error-recovery.ts:32` `import { createRecord, updateFromEvent } from "./live/execution-record.js"`
2. `error-recovery.ts:208` `const liveRecord = createRecord(...)` → 存入 `node.live`（L223）
3. `error-recovery.ts:278-281` onEvent 闭包：
   ```ts
   const onEvent = (raw) => {
     for (const agentEvent of jsonlToAgentEvent(raw)) {  // ← 来自 live/jsonl-to-agent-event.ts
       updateFromEvent(liveRecord, agentEvent);           // ← 来自 live/execution-record.ts
     }
   };
   ```
4. 该 onEvent 经 `executeAgentCall` → `runner.run(call.opts, signal, onEvent)`（execute-agent-call.ts:148）
   传入 SubprocessAgentRunner，**数据源是子进程 raw JSONL 流**。
5. `live/types.ts:146` 注释：「dispatchAgentCall 时 createRecord() → onEvent 回调 updateFromEvent()
   实时更新」——`node.live` 供 TUI（WorkflowsView）轮询 `trace.toArray()` 展示 agent 实时进度。

**合并后的断裂**：

- §9 泳道图把 executeAndAwait 画成 `executeAndAwait(mappedOpts, signal)`——**无 onEvent 参数**。
- subagents 的 runSpawn 确实有 `opts.onEvent`，但发射的是**已解析的强类型 `AgentEvent`**
  （session-runner.ts handleSdkEvent 出口），而 workflow 的 onEvent 期望的是
  **raw `Record<string,unknown>` JSONL**——形状不同，不能直接对接。
- 删 `live/jsonl-to-agent-event.ts`（raw→AgentEvent 翻译）后，workflow 侧再无翻译层；
  删 `live/execution-record.ts` 后，`createRecord/updateFromEvent` 无处可来，error-recovery 不编译。

**冲突项**：

| 被违反的架构声明 | 冲突点 |
|----------------|--------|
| BC-4「run(opts, signal, onEvent) 签名不变」| onEvent 保留即死参（无数据源），丢弃则签名变 |
| BC-7「error-recovery 重试行为不变」| error-recovery 顶部即依赖被删模块 + onEvent 闭包 |
| §5 / §8「TUI 保持不变」| node.live 实时进度数据通路被切断，WorkflowsView agent 进度退化 |

**要求**：架构必须二选一并显式记录：
- (a) **保留 live-record TUI 进度**：给 executeAndAwait 增加类型化 onEvent 回调
  （发 `AgentEvent`，复用 runSpawn 已有出口），SubprocessAgentRunner 把它桥接回 workflow
  的 live record（此时 `jsonl-to-agent-event.ts` 确实可删，因为不再需要 raw→AgentEvent 翻译；
  `live/execution-record.ts` 保留或明确改用 execution/ 副本）；或
- (b) **显式放弃 live-record 实时进度**：在 §8「不做」声明 node.live 不再填充、
  WorkflowsView 退化为无 agent 级实时进度，并相应改写 error-recovery L208-281 与 BC-7。

不能维持当前「既删数据源又声称行为不变」的状态。

---

### MF-2 [Critical] per-call timeoutMs 静默回归

**现象**：`AgentCallOpts.timeoutMs`（per-call 墙钟超时，G-027，源码带 `[HISTORICAL]` 标记）
在委托路径中无落点，合并后 `agent({timeoutMs:5000})` 会静默失效。

**证据**：

| 路径 | timeoutMs 处理 |
|------|----------------|
| workflow AgentCallOpts | `timeoutMs?: number`（types.ts:94）|
| SubprocessAgentRunner（当前）| L58-59 `opts.timeoutMs > 0 ? setTimeout(() => controller.abort(), opts.timeoutMs)` —— 合并进自己的 AbortController |
| subagents ExecuteOptions | **无 timeoutMs 字段**（grep 0 命中）|
| subagents RunOptions / runSpawn | **无 timeoutMs**，仅有 maxTurns + 30min 硬 watchdog（SPAWN_WATCHDOG_MS）|

§7 模块表把 subprocess-agent-runner.ts 标为「-90 重写为委托」——重写若丢弃 timeoutMs 合并逻辑，
则 per-call 墙钟超时能力消失，且 ExecuteOptions / RunOptions 都没有承接字段。

**冲突项**：

| 被违反的架构声明 | 冲突点 |
|----------------|--------|
| G3「零功能回归」| 一个 documented feature（带历史标记）静默丢失 |
| AC-3.3「agent 超时/abort → 返回 error」| 只归因于外部 signal，未覆盖 per-call timeoutMs |
| §12 BC 清单 | **无 timeoutMs 行为契约**——遗漏 |

**要求**：
- 在 BC 清单补一条 BC-timeout（per-call timeoutMs 行为保持）；
- 在 D-A1/D-A2 或新决策里明确 timeoutMs 的承接方式：
  ExecuteOptions 增 `timeoutMs?` 并由 SubagentService/runSpawn 兑现 abort，或
  SubprocessAgentRunner 在委托前自行把 timeoutMs 合并进它传给 executeAndAwait 的 signal
  （注意：ExecuteOptions.signal 当前语义是「sync=Pi tool 框架 / bg=hub 忽略自建 controller」，
  需确认 executeAndAwait 路径下 signal 是否真的被 runSpawn 消费——session-runner.ts 的
  `opts.signal?.addEventListener("abort", onAbort)` 表明 runSpawn 消费 signal，故
  在 SubprocessAgentRunner 侧合并 timeoutMs 进 signal 是可行落点）。

---

### MF-3 [Medium] SAR 层归属与目录归属自相矛盾

**现象**：SubprocessAgentRunner 的层归属在图与目录之间不一致。

- §6 分层图：SAR 在 **Execution (Infra)** 子图内（与 SubagentService/ConcurrencyPool 同层）；
- §7 目录结构：`orchestration/subprocess-agent-runner.ts`（在 **orchestration/** 目录）。

合并后 SAR 依赖 `execution/SubagentService`。若按 §7 放 orchestration/，则
`orchestration/ → execution/` 形成跨层 import，与 §6「SAR 属 Execution 层」矛盾，
也模糊了 Orchestration 不应反向依赖 Execution 的边界主张。

**要求**：二选一并对齐图与目录：
- SAR 是 AgentRunner port 的 Infra adapter，依赖 Execution 层服务——按 §6 图归
  `execution/`（或独立 adapter 目录），port 接口定义留在 `orchestration/models/ports.ts`；或
- 若坚持放 orchestration/，则修订 §6 图，并显式说明 orchestration→execution 这一依赖
  为允许的「port adapter 反向引用」，不能让图与目录各说各话。

（这影响 §11 AC-ARCH-1 grep 验收基目录，需一并澄清。）

---

### MF-4 [Low] §4 模型图漏列 AgentCallOpts.schemaEnv

**现象**：§4 classDiagram 的 AgentCallOpts 只画了 `schema?: Record`，但源码
（types.ts:118-123）还有 `schemaEnv?: string`——**SubprocessAgentRunner 实际读取的是
schemaEnv 而非 schema**（subprocess-agent-runner.ts: `if (opts.schemaEnv)
{ rawEnv.PI_WORKFLOW_SCHEMA = opts.schemaEnv; }`）。agent-opts-resolver 把 `schema`
序列化为 `schemaEnv` 字符串。

**影响**：D-A2 映射 + D-A6 bridge 的**源字段**是 `schemaEnv`（string），不是 `schema`
（Record）。模型图漏画会让 issue 拆分阶段误以为只需映射 schema 对象。ExecuteOptions 当前
只有 `schema: Record`（types.ts:401），没有 schemaEnv——映射需新增字段或在
executeAndAwait 内 `JSON.stringify(schema)` 派生 env 值，此设计点应在 D-A6 明确。

**要求**：模型图补 `schemaEnv?: string` 字段；D-A6 补一句映射源（schemaEnv string）
与目标（PI_WORKFLOW_SCHEMA env / runSpawn 新 schemaEnv 入参）的字段对应。

---

## 行为契约（BC）可验证性评估

| BC | 可验证? | 备注 |
|----|--------|------|
| BC-1 AgentResult 形状 | ✅ | types.ts:163 |
| BC-2 AgentCallOpts 形状 | ✅ | types.ts:70（但补 schemaEnv，见 MF-4）|
| BC-3 pi.__workflowRun 签名 | ✅ | index.ts |
| BC-4 run(opts,signal,onEvent) | ⚠️ | 见 MF-1：onEvent 死参/签名变二选一未决 |
| BC-5 workflow pending emit | ✅ | |
| BC-6 subagent tool | ✅ | |
| BC-7 error-recovery 重试 | ⚠️ | 见 MF-1：依赖被删模块 + onEvent 闭包 |
| BC-8 structured-output schema | ✅ | collectResult L86 已证 parsedOutput 可延续 |

**遗漏的 BC**（需补）：
- **BC-timeout**：per-call timeoutMs 行为保持（见 MF-2）
- **BC-live-progress**：workflow agent 实时进度（node.live→TUI）是否保持——无论保留或放弃，
  必须有一条 BC 显式声明（见 MF-1）

---

## 修订后即可放行

MF-1 与 MF-2 是阻断项（直接动摇 G3 零回归目标）。MF-3、MF-4 是一致性/准确性问题，
修订成本低。四处补齐后，本架构的三层方向、port 边界、executeAndAwait 定位、schema
bridge 均已验证成立，可进入 issue 拆分。
