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
   │  runtime · executor · record-store · notifier           │
   │  history-store · config · session-file-gc               │
   │  职责：编排 Core，管理 record 生命周期，持久化，回注通知  │
   └────────────────────────▲────────────────────────────────┘
                            │ 委托
                            │
   ┌────────────────────────┴────────────────────────────────┐
   │                    Core 层（核心）                       │
   │                                                          │
   │  ── 编排子层（Orchestration）──                          │
   │  session-runner（一次性）· managed-session（长生命周期） │
   │                                                          │
   │  ── 基础子层（Foundation / Engine）──                    │
   │  session-factory（造 bundle）· output-collector（拆）    │
   │  event-bridge（事件翻译+累积，内核数据通路）             │
   │                                                          │
   │  ── 叶子原语 ──                                          │
   │  execution-record · model-resolver · agent-registry      │
   │  concurrency-pool · turn-limiter · worktree              │
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

Core 零 Pi 依赖是可测试性的根基——`execution-record`、`concurrency-pool` 等纯函数可在无 Pi 进程下单测。Pi SDK 只在 `session-factory`（动态 import + 装配）和外壳（注册）两处出现。

### Core 子层依赖铁律

Core 内部进一步分两子层，依赖严格自上而下，禁止反向或同层横穿：

| 子层 | 文件 | 可 import | 禁止 import |
|---|---|---|---|
| **编排（Orchestration）** | session-runner · managed-session | 基础子层 + 叶子原语 + types | 互相 import（两模式独立，平级） |
| **基础（Foundation）** | session-factory · output-collector · event-bridge | 自身 + types + 叶子原语 | 编排子层 |
| **叶子原语** | execution-record · model-resolver · agent-registry · concurrency-pool · turn-limiter · worktree | 自身 + types | 编排/基础子层 |

- `event-bridge` 是基础子层的 leaf（只依赖 types.ts），是 session-factory / output-collector 共享的数据通路内核。
- `session-factory`（造 bundle：input → BuiltSession）与 `output-collector`（拆 bundle：BuiltSession → AgentResult）方向对称，都被两个编排器复用。
- `session-runner` 与 `managed-session` 互不 import——它们是同一套基础引擎的两种用法（一次性 / 长生命周期），各自独立。

## 3. 文件归属

30 个文件，按层 + 状态标注。状态：✅ 已实现 ｜ ⬜ 骨架（签名+流程图，待填）。

### Core 层（11）

> 分编排 / 基础 / 叶子三个子层（依赖方向见 §2 Core 子层依赖铁律）。

#### 编排子层（Orchestration）— 2

| 文件 | 职责 | 状态 |
|---|---|---|
| `session-runner.ts` | 一次性 session 执行编排，sync/bg 共用，零 mode 感知 | ⬜ |
| `managed-session.ts` | 长生命周期 session 变体（多次 prompt/steer/abort） | ⬜ |

#### 基础子层（Foundation）— 3

| 文件 | 职责 | 状态 |
|---|---|---|
| `event-bridge.ts` | SDK 事件 → AgentEvent 翻译 + turn/toolCall/usage 累积（内核数据通路，leaf） | ⬜ |
| `session-factory.ts` | Pi session 组装（四步 → BuiltSession）：env block + resourceLoader + createAgentSession + bridge 订阅 | ⬜ |
| `output-collector.ts` | BuiltSession → AgentResult 收集（text/usage/toolCalls/parsedOutput 字段单源） | ⬜ |

#### 叶子原语（Primitives）— 6

| 文件 | 职责 | 状态 |
|---|---|---|
| `execution-record.ts` | 唯一状态对象 + 创建/更新/完成/投影入口 | ⬜ |
| `model-resolver.ts` | 5 级 fallback 模型解析链 + category 推断 | ⬜ |
| `agent-registry.ts` | agent `.md` 文件发现与解析（hot-reload） | ⬜ |
| `concurrency-pool.ts` | 并发控制 + 优先级排队（sync=0，bg=1000） | ⬜ |
| `turn-limiter.ts` | soft/hard turn 限制器（steer + abort） | ⬜ |
| `worktree.ts` | isolation:worktree 隔离执行 + commit/preserve | ⬜ |

### Runtime 层（7）

| 文件 | 职责 | 状态 |
|---|---|---|
| `runtime.ts` | 进程单例，组合 Core，注入/复活/dispose 生命周期 | ⬜ |
| `executor.ts` | 统一执行入口，sync/bg 唯一分叉点 | ⬜ |
| `record-store.ts` | Record 三 map 容器（live/completed/bg）+ 四源合并 | ⬜ |
| `notifier.ts` | background 完成回注主对话（合并窗口 + 去重） | ⬜ |
| `history-store.ts` | 跨 session 执行记录持久化（jsonl + GC） | ⬜ |
| `config.ts` | 全局配置 + session 级状态 | ⬜ |
| `session-file-gc.ts` | 过期 subagent session 文件清理 | ⬜ |

### TUI 层（8）

| 文件 | 职责 | 状态 |
|---|---|---|
| `tool-render.ts` | 对话流 tool block 渲染（renderCall + renderResult） | ⬜ |
| `list-view.ts` | `/subagents list` 全屏左右分屏 overlay | ⬜ |
| `progress-widget.ts` | belowEditor 常驻进度 widget | ⬜ |
| `category-confirm.ts` | 首次 category 模型确认组件 | ⬜ |
| `config-wizard.ts` | `/subagents config` 交互向导 | ⬜ |
| `bg-notify-render.ts` | background 完成通知的对话流渲染 | ⬜ |
| `format.ts` | 纯格式化函数（tokens/duration） | ⬜ |
| `format-helpers.ts` | 配置摘要格式化（拆出避免循环依赖） | ⬜ |

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

## 5. ManagedSession（长生命周期变体）

支持多次 prompt/steer/abort 的长生命周期 session，作为 `session-runner` 的变体实现：复用 `createAndConfigureSession`，仅生命周期管理不同（懒创建 + pendingSteers 缓存 + activePrompt 互斥）。
→ 详见 [session-runner.md](./session-runner.md) §7 ManagedSession 变体

## 相关文档

- [data-model.md](./data-model.md) — ExecutionRecord 唯一状态源与投影契约
- [execution-flow.md](./execution-flow.md) — 统一执行流与 sync/bg 分叉
- [session-runner.md](./session-runner.md) — SessionRunner 深化与 ManagedSession 变体
- [.xyz-harness 重构 spec](../../../.xyz-harness/2026-06-15-subagent-architecture-consolidation/spec.md) — 设计动机与缺陷诊断（只读溯源）
