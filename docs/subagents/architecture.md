# Subagents 架构

> 本文件是 subagents 扩展内部架构的**真相源**：记录已落地的分层结构与契约。
> 设计动机、缺陷诊断、重构目标见
> [`.xyz-harness/2026-06-15-subagent-architecture-consolidation/spec.md`](../../../.xyz-harness/2026-06-15-subagent-architecture-consolidation/spec.md)（只读引用，不复制内容）。

---

## 1. 三层架构

```
            ┌─────────────────────────────────────────────┐
            │              外壳（薄壳）                    │
            │  tools/subagent-tool   commands/subagents   │
            │           index.ts（装配）                   │
            └────────────────────┬────────────────────────┘
                                 │ 调用
                                 ▼
   ┌─────────────────────────────────────────────────────────┐
   │                     TUI 层（展示）                       │
   │  tool-render · list-view · progress-widget              │
   │  category-confirm · config-wizard · format              │
   │  职责：只读消费 RecordSnapshot / Details，永不回写状态   │
   └────────────────────────▲────────────────────────────────┘
                            │ 投影（snapshot/project）
                            │
   ┌────────────────────────┴────────────────────────────────┐
   │                   Runtime 层（编排）                     │
   │  ── 双 Service（按领域划分）──                           │
   │  ModelConfigService（配置/模型域）                       │
   │  SubagentService（执行/记录/通知域）                     │
   │  ── 编排与基础设施 ──                                    │
   │  executor · record-store · notifier · history-store      │
   │  config · session-file-gc                                │
   │  职责：编排 Core，管理 record 生命周期，持久化，回注通知  │
   └────────────────────────▲────────────────────────────────┘
                            │ 委托
                            │
   ┌────────────────────────┴────────────────────────────────┐
   │                    Core 层（核心）                       │
   │                                                          │
   │  ── 编排子层（Orchestration）──                          │
   │  session-runner（一次性，含原 session-factory 组装       │
   │  + EventBridge 事件翻译，已内联）                        │
   │                                                          │
   │  ── 基础子层（Foundation）──                              │
   │  output-collector（拆：Record → AgentResult）            │
   │                                                          │
   │  ── 叶子原语 ──                                          │
   │  execution-record · model-resolver · agent-registry      │
   │  concurrency-pool · turn-limiter · path-encoding         │
   │  职责：零 Pi 依赖的执行与状态原语，可独立单测            │
   └──────────────────────────────────────────────────────────┘
```

## 2. 分层铁律

依赖方向严格自上而下。违反即为架构缺陷。

| 层 | 可 import | 禁止 import |
|---|---|---|
| **Core** | 自身 + `types.ts` + Node 内置 | Runtime / TUI / Pi SDK 实例 |
| **Runtime** | Core + `types.ts` + Pi SDK（动态 import） | TUI |
| **TUI** | `types.ts` + Runtime 的只读快照类型 | Core 可变状态、Pi SDK 执行 API |
| **外壳** | Runtime 公共 API + Pi SDK 注册 API | Core 内部实现 |

Core 零 Pi 依赖是可测试性的根基——`execution-record`、`concurrency-pool` 等纯函数可在无 Pi 进程下单测。Pi SDK 只在 `session-runner`（`getSdk` 动态 import + `createAgentSession` 装配）和外壳（注册）两处出现。

### Core 子层依赖铁律

Core 内部进一步分两子层，依赖严格自上而下，禁止反向或同层横穿：

| 子层 | 文件 | 可 import | 禁止 import |
|---|---|---|---|
| **编排（Orchestration）** | session-runner | 基础子层 + 叶子原语 + types | 基础子层禁止反向引用 |
| **基础（Foundation）** | output-collector | 自身 + types + 叶子原语 | 编排子层 |
| **叶子原语** | execution-record · model-resolver · agent-registry · concurrency-pool · turn-limiter · path-encoding | 自身 + types | 编排/基础子层 |

> **[HISTORICAL]** 早期实现有独立的 `session-factory.ts`（造 bundle：input → BuiltSession）和 `event-bridge.ts`（SDK 事件翻译 + 累积）。技术债治理（debt-governance Wave 1/3）把它们内联进 `session-runner.ts`——session-factory 是 session-runner 的唯一调用方（四步组装中两步是一行包装），EventBridge 的 switch 翻译逻辑无独立状态、无独立生命周期。合并后 session-runner 完整表达「跑一次 session」，依赖方向不变。详见 [debt-governance spec](../../../.xyz-harness/2026-06-22-subagent-debt-governance/spec.md)。

## 3. 文件归属

按层 + 状态标注。状态：✅ 已实现 ｜ ⬜ 骨架（签名+流程图，待填）。

### Core 层（8）

> 分编排 / 基础 / 叶子三个子层（依赖方向见 §2 Core 子层依赖铁律）。

#### 编排子层（Orchestration）— 1

| 文件 | 职责 | 状态 |
|---|---|---|
| `session-runner.ts` | 一次性 session 执行编排，sync/bg 共用，零 mode 感知。含原 session-factory 的 session 组装（四步 → BuiltSession）+ EventBridge 的 SDK 事件翻译（已内联） | ✅ |

#### 基础子层（Foundation）— 1

| 文件 | 职责 | 状态 |
|---|---|---|
| `output-collector.ts` | Record → AgentResult 收集（text/usage/toolCalls/parsedOutput 字段单源，全部从 record.turns[] 派生） | ✅ |

#### 叶子原语（Primitives）— 6

| 文件 | 职责 | 状态 |
|---|---|---|
| `execution-record.ts` | 唯一状态对象（turns[] 收口）+ 创建/更新/完成/投影/派生入口 | ✅ |
| `model-resolver.ts` | 5 级 fallback 模型解析链 + category 推断 | ✅ |
| `agent-registry.ts` | agent `.md` 文件发现与解析（hot-reload） | ✅ |
| `concurrency-pool.ts` | 并发控制 + 优先级排队（sync=0，bg=1000），maxConcurrent 下限 1 | ✅ |
| `turn-limiter.ts` | soft/hard turn 限制器（steer + abort） | ✅ |
| `path-encoding.ts` | cwd → 安全目录名编码（session-runner + history-store 共享，消除旧重复） | ✅ |

### Runtime 层（7）

> 按**领域**拆为双 Service：ModelConfigService（配置/模型解析域）+ SubagentService（执行/记录/通知域）。
> 两个 Service 平级——SubagentService 持有 ModelConfigService 引用（execute 内部调 resolveModel），
> 但 command/wizard 直接用 ModelConfigService（不经 SubagentService，配置操作不碰执行）。
> executor 逻辑已合并进 subagent-service.ts（不独立文件——无独立状态/生命周期）。
> 主入口（两个 Service）+ discovery-config/session-file-gc 留在 `runtime/` 根；
> 执行域组件下沉 `runtime/execution/`，配置域下沉 `runtime/config/`。

| 文件 | 职责 | 状态 |
|---|---|---|
| `model-config-service.ts` | 配置/模型域 Service：globalConfig + sessionState + agentRegistry + modelRegistry + resolveModel | ✅ |
| `subagent-service.ts` | 执行/记录/通知域 Service：execute 编排（含原 executor 逻辑）+ query/cancel + 组件持有（pool/store/history/notifier，全 private） | ✅ |
| `execution/record-store.ts` | Record 单 Map 容器（按 status/mode 过滤替代物理分区）+ history 合并 | ✅ |
| `execution/notifier.ts` | background 完成回注主对话（滑动窗口合并 + 去重 TTL） | ✅ |
| `execution/history-store.ts` | 跨 session 执行记录持久化（jsonl + GC） | ✅ |
| `config/config.ts` | 全局配置（单一真相源读 config.json）+ session 级状态（纯函数，被 ModelConfigService 调用） | ✅ |
| `session-file-gc.ts` | 过期 subagent session 文件清理 | ✅ |

> 另：`discovery-config.ts`（ADR-025 资源发现契约）留在 `runtime/` 根——被 index.ts（resources_discover）与 ModelConfigService 双消费，不归任一 Service 子目录。

### TUI 层（7）

| 文件 | 职责 | 状态 |
|---|---|---|
| `tool-render.ts` | 对话流 tool block 渲染（renderCall + renderResult） | ✅ |
| `list-view.ts` | `/subagents list` 全屏左右分屏 overlay | ✅ |
| `progress-widget.ts` | aboveEditor 常驻进度 widget（静态内容，防 TUI ghosting） | ✅ |
| `config-wizard.ts` | `/subagents config` 交互向导 | ✅ |
| `bg-notify-render.ts` | background 完成通知的对话流渲染 | ✅ |
| `format.ts` | 纯格式化函数（tokens/duration/firstLine/extractAgentName 共享 helper） | ✅ |
| `format-helpers.ts` | 配置摘要格式化（拆出避免循环依赖） | ✅ |

### 测试（23 文件，356 tests）

`src/__tests__/` 下 23 个测试文件覆盖 Core + Runtime + TUI 关键模块。详见 [pi-extension-standards.md](../../pi-extension-standards.md) §7 测试要求。

| 文件 | 覆盖 |
|---|---|
| `turn-limiter.test.ts` | steer/abort 时序 + didSteer/didAbort getter |
| `concurrency-pool.test.ts` | 满载阻塞/优先级抢占/FIFO/maxConcurrent=0 clamp/防负 |
| `throttle.test.ts` | leading/trailing edge/flush/默认 150ms |
| `execution-record.test.ts` | turns[] 收口累积/派生视图(getEventLog/getCurrentActivity/getFullText/getAllToolCalls/getTotalUsage)/tryTransition CAS/project/snapshot/toPersisted |
| `output-collector.test.ts` | collectResult 字段单源（从 record 派生）+ extractParsedOutput |
| `session-runner.test.ts` | run() 编排骨架 + 事件处理内联 |
| `session-factory.test.ts` | session-runner 内联纯函数（applyToolFilter/buildAppendSystemPrompt/buildEnvBlock/getSubagentSessionDir）——文件名为历史遗留，测的是合并进 session-runner 的函数 |
| `record-store.test.ts` | 单 Map 容器 + status/mode 过滤 + sync linger/bg FIFO + history 合并 |
| `notifier.test.ts` | 滑窗合并/dedup TTL/dispose 清 dedup/buildLlmContent |
| `history-store.test.ts` | jsonl 持久化 + recent merge + GC |
| `subagent-service.test.ts` | execute 编排 + mode 分叉 + CAS 收尾竞争 |
| `execute-integration.test.ts` | execute() 集成（run() 事件处理 → record 投影） |
| `model-resolver.test.ts` | 5 级 fallback 模型解析链 |
| `agent-registry.test.ts` | agent `.md` 发现与 hot-reload |
| `config.test.ts` | 全局配置 + session 状态 |
| `discovery-config.test.ts` | ADR-025 资源发现契约 |
| `session-file-gc.test.ts` | 过期 session 文件清理 |
| `path-encoding.test.ts` | cwd → 安全目录名编码 |
| `format.test.ts` | formatTokens/formatElapsedSeconds/truncLine(ANSI SGR)/segFillColored/formatEventLine |
| `tool-render-spinner.test.ts` | 对话流 block spinner 启停（sync running gate） |
| `bg-notify-render.test.ts` | background 完成通知渲染 |
| `tool-action.test.ts` | tool action 分发（start/list/cancel）契约 |
| `sdk-contract.test.ts` | 命令/工具注册契约/notifier sendMessage followUp/session_start 编译期契约 |

### 外壳（4）

| 文件 | 职责 | 状态 |
|---|---|---|
| `index.ts`（根） | 工厂函数，注册 tool/command/widget/events | ✅ |
| `types.ts` | 跨层共享类型契约（316 行） | ✅ |
| `tools/subagent-tool.ts` | `subagent` LLM 工具薄壳 | ⬜ |
| `commands/subagents.ts` | `/subagents` 命令薄壳 | ⬜ |

## 4. 核心设计原则

三条原则是旧实现 bug 的结构性根治。详见专题文档。

**1. 唯一状态源** — 所有执行路径共用一个 `ExecutionRecord` 对象，由 Core 层 `execution-record.ts` 的四个入口（create/update/complete/project）唯一操作。消灭旧实现 11 种状态形状、6 个 turns 累加器、双状态构建。
→ 详见 [data-model.md](./data-model.md)

**2. 统一执行入口** — sync/background 共用一条 `executor.execute()` 路径，mode 分叉点集中在此函数顶部 4 处。`session-runner.run()` 完全不感知 mode。消灭旧实现 runAgent + startBackground 两份重复逻辑、死 state、history 双写。
→ 详见 [execution-flow.md](./execution-flow.md)

**3. 投影单点** — `ExecutionRecord` 到展示层（Details/Snapshot/Persisted）的转换各只有一个入口，三路径字段一致。消灭旧实现 6 处手工构造 Details 导致的字段丢失（Mode 3 cancelled 丢 turns/tokens、poll 无 model 等）。
→ 详见 [data-model.md](./data-model.md) §6 投影入口

## 5. 架构决策记录

记录骨架深化过程中讨论并落地的关键架构决策。每条包含"问题 → 推理 → 决策 → 代价"。

### 5.1 为什么拆双 Service（ModelConfigService + SubagentService）

**问题**：runtime.ts（361 行）同时承担配置管理、模型解析、执行编排、状态容器、生命周期五种职责，是典型的"上帝类"。

**推理**：用"变化轴"分析——哪些东西会**一起变**？
- globalConfig/sessionState/agentRegistry/modelRegistry → 配置变化（用户改 config.json、注入新 modelRegistry）
- pool/store/history/notifier → 执行状态变化（并发槽分配、record 生命周期、历史落盘）

这两组东西**从不一起变**。command/wizard 只碰配置，不碰执行；executor 只碰执行组件，不碰配置。是**正交的关注点**。

进一步验证：`/subagents config` wizard 接收 `globalConfig` 作为函数参数，修改后调 `saveGlobalConfig()`——它**根本不 import runtime.ts**，只碰 config 函数。这证明配置域和执行域已经是解耦的，runtime.ts 只是强行把它们塞进同一个类。

**决策**：按领域拆为两个平级 Service：
- ModelConfigService（配置/模型域）：globalConfig + sessionState + agentRegistry + modelRegistry + resolveModel
- SubagentService（执行/记录/通知域）：pool + store + history + notifier + execute/query/cancel

**代价**：index.ts 从一个 `rt.initSession(...)` 变成两个 init 调用（modelService.initModel + service.initSession）。但这两个调用的时序是确定的（先配置后执行），index.ts 作为装配层承担这个协调是合理的。

### 5.2 为什么 executor 合并进 SubagentService（不独立文件）

**问题**：executor 原本是独立文件 `executor.ts`，访问 SubagentService 的 pool/store/notifier 需要这些组件可跨文件访问。TS 的 `private` 只在类内有效——跨文件的模块级函数访问不到 private 成员。这逼出了 5 个 public 行为方法（acquireSlot/releaseSlot/registerRecord/finalizeRecord/notifyComplete），名义上是"契约抽象"，实际是实现约束倒逼的妥协。

**推理**：executor 不是一个独立概念域——它是 `SubagentService.execute()` 的编排逻辑，没有独立状态、没有独立生命周期、没有独立调用方（只有 SubagentService.execute 调它）。独立文件带来的不是模块化，而是封装漏洞：为了让 executor 能操作组件，不得不把本该 private 的行为方法升为 public。

合并进 SubagentService.ts 后，行为方法自然降为 private——TS 的 `private` 在同类内生效，executor 逻辑作为 SubagentService 的 private 方法访问组件，无需任何妥协。

**决策**：executor 逻辑合并进 `subagent-service.ts`，作为 SubagentService 的 private 方法（resolveIdentity/createRecordForMode/runAndFinalize/kickOffBackground/cancelBackground/finalizeRecord/notifyComplete/onEventThrottled）。删除 `executor.ts` 文件。组件（pool/store/history/notifier）全 private，编排方法全 private，SubagentService 对外只有业务方法。

**代价**：subagent-service.ts 从 ~240 行增到 ~400 行。但 SubagentService 本来就是这个文件的主角，400 行可接受——它现在完整表达了"执行编排"这个领域。

### 5.3 为什么用 ensureConfirmed + ConfirmCancelledError（已废弃，D-1）

> **状态：已废弃（D-1 决策）**。首次 category 确认拦截已取消——`categoryConfirmed` 恒为 true，`ensureConfirmed`/`ConfirmCancelledError` 不再使用。本节保留作历史决策记录；用户改 category 模型走 `/subagents config`（写 globalConfig）。

**原问题**：category 确认是 async（UI 交互），但 `resolveModel` 是 sync（纯 5 级 fallback）。async 函数内调 sync 函数没问题，但 sync 函数内**触发 async 确认**再继续——怎么表达？

**原方案**（已移除）：方案 C + 信号类。`ensureConfirmed(onConfirm)` 是 async（可 await），`resolveModel` 保持 sync（纯解析）。

**为什么废弃**：首次确认增加交互摩擦且无实际收益——用户改 category 模型走 `/subagents config` wizard 即可，执行路径直接解析（5 级 fallback 兜底，解析失败抛错让用户感知）。

### 5.4 双 Service 依赖方向 + mode 判定归属

```
SubagentService ──引用──→ ModelConfigService（单向）
                              ↑
SubagentService 内部调：       │
  resolveMode()               │  → modelService.getAgentConfig()（判 defaultBackground）
  resolveIdentity()           │  → resolveModel()
  buildSessionRunnerContext() │ → modelService.getModelRegistry()/getAgentDir()
  collectRecords()            │  → modelService.sessionId（history 过滤）
```

**铁律**：SubagentService → ModelConfigService 单向引用，**禁止反向**。ModelConfigService 不知道 SubagentService 的存在。tool/command 层不穿透 SubagentService 调 ModelConfigService——tool 只传 `wait` 意图，mode 判定（wait + defaultBackground → ExecutionMode）完全内化在 SubagentService.resolveMode()。

**mode 判定归属**（从 tool 层移入 Service）：tool 层不再预判 mode（不调 getAgentConfig/assertAgentExists），只传 `wait?: boolean`。SubagentService.resolveMode 按 `wait > agentConfig.defaultBackground > sync` 判定。这是业务规则，归 Service，不归 tool。

**初始化时序**：index.ts session_start 时先 `modelService.initModel(...)` 再 `service.initSession(...)`——因为 SubagentService 构造时需要 `modelService.getGlobalConfig().maxConcurrent`（初始化 pool）。如果反序，pool 拿不到 maxConcurrent。

### 5.5 深拷贝访问器的 trade-off

**问题**：globalConfig / sessionState 是配置数据对象，wizard 需要读改。暴露 public 字段（哪怕 readonly）等于宣布外部可依赖其结构——改内部形状时所有调用方跟着改。

**决策**：`getGlobalConfig()` / `getSessionState()` 返回 `structuredClone()` 深拷贝。调用方拿到的是**副本**，改不影响 Service 内部。改完后调 `modelService.saveGlobalConfig(config)` 写回。

**代价**：每次读配置多一次结构化克隆。但配置对象很小（几十个字段），且只在 wizard / command 调用时读——非热路径。性能影响可忽略。

**替代方案**（未采用）：行为方法（`toggleYolo()` / `setCategoryModel()` 等）替代直接改字段——更安全但更啰嗦。wizard 的配置修改是开放集（用户可能改 categories/maxConcurrent/fallback 等任意字段），行为方法无法穷举。深拷贝 + saveGlobalConfig 是更灵活的方案。

### 5.6 getAgentDir 是否该暴露

**问题**：SubagentService 构造 SessionRunnerContext 需要 `agentDir`，这个值存在 ModelConfigService 里。暴露这个 getter 是否破坏封装？

**推理**：这个值是**构造参数的只读透传**（init 时传入，永不改变），不是内部状态。暴露它不比把它存到 SubagentService 自己的字段里更好或更差——但存在 ModelConfigService 里避免了重复存储。如果 SubagentService 也存一份 agentDir，两个 Service 就有**同一数据的两份拷贝**，改 init 参数时要同步两处——这是更差的设计。

**决策**：暴露只读 getter（`getAgentDir()`）。它是**数据归属**的表达——agentDir 归配置域（agent 的 .md 在 agentDir 下扫描），执行域只是借用。

## 相关文档

- [data-model.md](./data-model.md) — ExecutionRecord 唯一状态源与投影契约
- [execution-flow.md](./execution-flow.md) — 统一执行流与 sync/bg 分叉
- [session-runner.md](./session-runner.md) — SessionRunner 深化（run 编排骨架 + H1/H2 资源清理修复）
- [.xyz-harness 重构 spec](../../../.xyz-harness/2026-06-15-subagent-architecture-consolidation/spec.md) — 设计动机与缺陷诊断（只读溯源）
