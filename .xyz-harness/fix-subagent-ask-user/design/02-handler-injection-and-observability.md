# 02 — uiRequestHandler 注入机制 + 可观测性设计

> Topic: cw-2026-07-17-subagent-ask-user（feat-ask-user-time-limit 分支）
> 边界：只做 handler 注入机制 + 可观测性设计。**不碰**协议格式（method 有哪些、params 结构）与 mode 分流（ask_user tool 在子进程如何注册），那两项归 subagent 1 / 其他 subagent。

---

## 一、问题分析（直接引用 line 号）

### 问题 1：uiRequestHandler 注入完全缺失

`extensions/subagent-workflow/src/index.ts:209`：

```ts
const service = existingService ?? new SubagentService({
  cwd, modelService, getMainSessionFile: getCachedMainSessionFile,
});
```

`SubagentServiceInit.uiRequestHandler`（`subagent-service.ts:104-107`）是可选字段，但**整个 monorepo grep 无任何一处传入**。`buildSessionRunnerContext`（`:962`）透传的是 `this.uiRequestHandler`，而构造函数（`:204`）只从 `init.uiRequestHandler` 读——构造时没传，永远是 `undefined`。

后果：子进程发 `extension_ui_request` 到父进程，`handleUiRequest`（`session-runner.ts:427`）读到 `handler === undefined`，直接 `return Promise.resolve()`。子进程的 ask_user tool 永远收不到 response，只能等超时降级。

### 问题 2：handler 缺失时静默失败

`session-runner.ts:425-429`：

```ts
const handler = ctx.uiRequestHandler;
if (!handler) {
  // 无 handler：静默忽略，子进程超时后自行降级
  return Promise.resolve();
}
```

注释写明了"静默忽略"。无 warn、无 metric、无 log。后果：
- 用户和 LLM 不知道功能没工作（子进程 ask_user 超时后的降级行为不可观测）
- 每个子进程每次 ask_user 都走一遍超时，浪费 token + 时间
- 排查时无任何痕迹可循

### 问题 3：字段语义不够灵活

`subagent-service.ts:174`：

```ts
private readonly uiRequestHandler: SubagentServiceInit["uiRequestHandler"];
```

`readonly` + 构造函数唯一注入点。问题：
- `SubagentService` 是进程级单例（`globalThis` Symbol 持有，见 `:884-905`），`existingService ?? new` 语义下，首次 session_start 后跨 session 复用同一实例
- `uiRequestHandler` 的合理注入时机是 `session_start`（需要 `ctx.mode` 判断），但 `session_start` 调的是 `initSession`，不是 `new`
- 若未来需要按 session 动态切换 handler（如 ctx 变化、sidecar 通道重连），`readonly` 会卡住

---

## 二、修复方案

### 2.1 handler 签名重构：method-based dispatch（对齐 subagent 1）

**当前签名**（`session-runner.ts:200-205` + `subagent-service.ts:104-107`）：

```ts
uiRequestHandler?: (
  questions: Record<string, unknown>[],
  context?: string,
) => Promise<unknown>;
```

这是 ask_user 专用签名——把 `params.questions` / `params.context` 在 `handleUiRequest` 里拆出来再调 handler。一旦未来加第二个 UI 请求类型（如 `extension_form_request`、`extension_confirm_request`），签名得改、调用方得改、handler 实现得改。

**目标签名**（method-based，handler 内部分发）：

```ts
/** UI 请求的统一入口契约（与 subagent 1 的协议层对齐）。 */
interface UiRequest {
  /** JSON-RPC method，决定 params 的语义。当前只有 "ask_user"，未来可扩展。 */
  method: string;
  /** method-specific 参数（ask_user 时为 { questions, context, timeout }）。 */
  params: Record<string, unknown>;
  /** JSON-RPC request id（handler 可选用于关联日志，不参与业务逻辑）。 */
  id: string;
}

interface UiResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

type UiRequestHandler = (request: UiRequest) => Promise<UiResponse>;
```

handler 实现内部按 `request.method` 分发：

```ts
function createUiRequestHandler(ctx: ExtensionContext): UiRequestHandler {
  return async (req) => {
    switch (req.method) {
      case "ask_user":
        return handleAskUser(req.params, ctx);  // 实现 xyz-agent sidecar 转发
      default:
        return { error: { code: -32601, message: `method not found: ${req.method}` } };
    }
  };
}
```

**边界声明**：`handleUiRequest`（`session-runner.ts:419`）内部如何从 `params` 提取字段、如何回写 JSON-RPC response，属于**协议消费层**，归 subagent 1。本设计只负责：
1. handler 的**签名契约**（`UiRequest`/`UiResponse`）
2. handler 的**注入机制**（factory → setter → SessionRunnerContext）

`session-runner.ts` 需要的对应调整（把 `handler(questions, context)` 改成 `handler({ method, params, id })`）在变更清单里标注为"配合 subagent 1"，不在本设计实现。

### 2.2 注入路径：index.ts session_start + handler 工厂

在 `index.ts` 的 `session_start` handler 里，根据 `ctx.mode` 决定注入哪个 handler：

```ts
// index.ts session_start 内，new SubagentService 之后、initSession 之前
const uiRequestHandler = createUiRequestHandlerForMode(ctx);
service.setUiRequestHandler(uiRequestHandler);
service.initSession({ pi, sessionId, streamSink, mode: ctx.mode });
```

**handler 工厂**（接收 ctx，返回 handler 或 undefined）：

```ts
/** 按 ctx.mode 选择 UI 请求 handler 工厂。
 *  - rpc（xyz-agent GUI）：返回 sidecar 转发 handler
 *  - tui（纯 Pi TUI）/ json / print：返回 undefined（子进程 ask_user 超时降级）
 *
 *  返回 undefined 是合法语义——表示"本进程不处理子进程 UI 请求"，
 *  可观测性层会记 missing-handler（见 2.4）。 */
function createUiRequestHandlerForMode(ctx: ExtensionContext): UiRequestHandler | undefined {
  switch (ctx.mode) {
    case "rpc":
      return createRpcSidecarHandler(ctx);  // xyz-agent sidecar 通道（具体实现待 subagent 4 集成测试确认）
    case "tui":
    case "json":
    case "print":
      return undefined;  // 子进程是 --mode rpc，TUI 主进程无 stdin UI 通道给子进程
    default:
      return undefined;
  }
}
```

**rpc mode 下 sidecar 通道的具体调用方式**（`createRpcSidecarHandler` 内部）待 subagent 4 设计集成测试时确认。本设计的契约是：handler 返回 `Promise<UiResponse>`，具体怎么把 questions 呈现给用户、怎么收回答案，是实现细节，不阻断本设计的接口定义。

### 2.3 setUiRequestHandler setter + 字段语义调整

**SubagentServiceInit**（`subagent-service.ts:97-110`）：`uiRequestHandler` 保持可选，不再唯一注入点。

**SubagentServiceSessionInit**（`:111-119`）新增字段：

```ts
export interface SubagentServiceSessionInit {
  pi: PiLike;
  sessionId: string;
  streamSink?: StreamSink;
  /** 当前 session 的 ExtensionMode（可观测性用，不参与业务逻辑）。 */
  mode?: ExtensionMode;
  /** session 级 UI 请求 handler（session_start 时注入，优先级高于构造时）。 */
  uiRequestHandler?: UiRequestHandler;
}
```

**SubagentService 类**（`:174`）：

```ts
// old: private readonly uiRequestHandler
// new: 去掉 readonly，允许 setter 替换
private uiRequestHandler: UiRequestHandler | undefined;
private sessionMode: ExtensionMode | undefined;

/** 动态替换 UI 请求 handler（session_start 后、sidecar 重连等场景）。
 *  传 undefined 清除 handler（回到 missing-handler 降级路径）。 */
setUiRequestHandler(handler: UiRequestHandler | undefined): void {
  this.uiRequestHandler = handler;
  // handler 变化时重置 warn 去重集合，允许新 handler 缺失场景重新 warn 一次
  this.warnedMissingHandlerSessions.clear();
}
```

`initSession` 增加 `this.uiRequestHandler = init.uiRequestHandler ?? this.uiRequestHandler`（session 级注入优先，但不覆盖已有值除非显式传）。`buildSessionRunnerContext`（`:962`）不变——仍读 `this.uiRequestHandler`，但现在它可被 setter 动态更新。

### 2.4 可观测性补强

**(a) session-level warn 去重**（`SubagentService` 内新增字段）：

```ts
/** 已 warn 过 missing-handler 的 session 集合（避免每个 subagent 都刷屏）。 */
private warnedMissingHandlerSessions = new Set<string>();
```

`handleUiRequest`（`session-runner.ts:427`）的 missing-handler 分支改为调 `SubagentService` 暴露的 `notifyMissingHandler(sessionId)` 方法，内部判断 Set 是否已有该 session，首次才 warn + appendEntry。

**(b) appendEntry 记录**（复用 `index.ts:136` 的 `pi.appendEntry` 模式，但走 `SubagentService` 的 `this.pi`）：

- `subagent:ui-request-missing-handler`：首次缺失时记一次
  ```ts
  pi.appendEntry("subagent:ui-request-missing-handler", {
    sessionId, mode: this.sessionMode, subagentCount: this.store.listRunning().length, timestamp: Date.now(),
  });
  ```
- `subagent:ui-request-stats`：周期性记录（每 10s 或每 100 次 invoke）
  ```ts
  pi.appendEntry("subagent:ui-request-stats", {
    invoked, missingHandler, errors, windowMs: Date.now() - lastFlushAt, timestamp: Date.now(),
  });
  ```
- `subagent:session-init`：`initSession` 时记一次 mode + handler 状态
  ```ts
  pi.appendEntry("subagent:session-init", {
    sessionId, mode, hasHandler: !!handler, timestamp: Date.now(),
  });
  ```

**(c) invoke 计数**（`SubagentService` 内新增字段）：

```ts
private uiRequestStats = { invoked: 0, missingHandler: 0, errors: 0, lastFlushAt: Date.now() };
private static readonly STATS_FLUSH_INTERVAL_MS = 10_000;
private static readonly STATS_FLUSH_THRESHOLD = 100;
```

`handleUiRequest` 的三个分支（missing / success / error）各递增计数，达到阈值或间隔时 flush（appendEntry + 重置）。

---

## 三、关键决策点

### D1：为什么用 setter 而不是 constructor-only

`SubagentService` 是进程级单例（`globalThis[Symbol.for(...)]`，见 `:884-905`）。`index.ts:209` 的 `existingService ?? new` 语义决定了：**首次 session_start 创建后，后续 session 复用同一实例**。`readonly` + 构造函数注入意味着 handler 只能在首次 `new` 时传入——但首次 `new` 时 `ctx.mode` 还没拿到（`new` 在 session_start handler 内，ctx 是参数）。虽然技术上可以在 `new` 之前先读 ctx.mode，但有两个场景 setter 更优：

1. **sidecar 重连**：xyz-agent 的 sidecar WebSocket 可能断开重连，handler 持有的通道引用需要替换。
2. **测试隔离**：单测可以 `new SubagentService()` 后再 `setUiRequestHandler(mockHandler)`，不必在构造时塞 mock。

代价：并发安全（见风险 R1）。但 subagent 的 `execute` 是 async + pool 调度的，handler 读取（`buildSessionRunnerContext` 在 execute 入口同步读）与 handler 替换（setUiRequestHandler 同步写）在 JS 单线程下不会撕裂——最坏情况是「一次 execute 用了旧 handler、下次用新 handler」，可接受。

### D2：为什么用 handler 工厂模式而不是直接传闭包

用户要求「handler 工厂：接收 ctx，返回 handler」。直接传闭包（`handler = (req) => ...` 直接内联在 session_start）也能工作，但工厂模式有两个优势：

1. **延迟捕获 ctx 状态**：`ctx.sessionManager.getSessionId()` 在 session_start 时和后续可能不同（session 切换）。工厂返回的 handler 闭包内若需 sessionId，可在每次 invoke 时通过工厂重新读取（若工厂本身被重新调用），而不是固化在闭包里。实际实现中 handler 通常只持有「通道引用」（sidecar ws），不持有 sessionId，所以这个优势较弱——但工厂为未来预留了扩展点。
2. **mode 分流集中化**：`createUiRequestHandlerForMode(ctx)` 把「哪个 mode 用哪个 handler」的决策集中在一处，而不是散落在 session_start 的 if-else。新增 mode 时只改工厂。

**反方观点（记录）**：工厂增加了一层间接性，debugger 追栈多一层。对于当前只有一个 handler 实现（rpc sidecar）的情况，工厂有过度设计之嫌。权衡后选择工厂，因为 ask_user 是第一个 UI 请求类型，未来大概率会有第二个（form/confirm），工厂的扩展价值会兑现。

### D3：warn 频率控制策略

**选择：session-level Set 去重 + 周期性 stats flush**。

- **不选「每次 missing 都 warn」**：一个 session 可能跑 10+ 个 subagent，每个 subagent 可能多次 ask_user，全 warn 会刷屏（日志噪音 + 用户困惑）。
- **不选「全局只 warn 一次」**：跨 session 的 missing-handler 可能原因不同（TUI 下不注入是预期行为；rpc 下不注入是 bug），需要分别记录。
- **选择 session-level 去重**：每个 sessionId 首次 missing 记一次 `subagent:ui-request-missing-handler`，后续同 session 静默。handler 变化时（setUiRequestHandler）清空 Set，允许新状态重新 warn。
- **stats 周期 flush**：累计计数每 10s 或每 100 次 flush 一次 `subagent:ui-request-stats`，避免每 invoke 都写盘。

### D4：tui mode 下不注入 handler 的语义

`tui` mode 下 `createUiRequestHandlerForMode` 返回 `undefined`。这意味着：**纯 Pi TUI 下，子进程的 ask_user tool 会超时降级**。

这是合理的——子进程是 `--mode rpc`（`buildSpawnArgs` line 332 `args.push("--mode", "rpc")`），没有 TUI 交互通道。子进程的 ask_user 通过 `extension_ui_request` RPC 转发到父进程，但父进程是 TUI mode，没有把 questions 呈现给用户的通道（TUI 的 stdin 归主 agent，不能中途插队给子 agent）。

可观测性层会记 `subagent:ui-request-missing-handler` + `mode: "tui"`，用户能看到「TUI 下子 agent ask_user 不可用」的信号，而不是静默。

长期方案（不在本设计范围）：TUI 下子 agent 不应配置 ask_user tool（agent.md 的 tools 列表里去掉），从源头避免。这归 agent 配置层。

## 四、风险点

### R1：setter 的并发安全

`setUiRequestHandler` 同步写 `this.uiRequestHandler`，`buildSessionRunnerContext` 同步读。JS 单线程下不会撕裂，但存在「execute A 已读到旧 handler 并在 pool 排队，期间 setter 替换为新 handler，execute A 执行时用的是它入口时读到的旧值」——这是可接受的（A 用旧 handler 完成后，后续 execute 自然用新 handler）。

**不可接受的反模式**：在 handler invoke 过程中（`handler(req)` 的 Promise 未 resolve 时）替换 handler。此时旧 handler 的 Promise 仍会 resolve/reject，调用方（`handleUiRequest`）正常拿到结果。无撕裂风险，但 sidecar 重连时可能有「旧 handler 持有已关闭的 ws」导致 invoke 失败——应在 `createRpcSidecarHandler` 内部处理 ws 健康检查，不依赖 setter 时序。

### R2：handler 工厂闭包持有 ctx 的内存泄漏

`createUiRequestHandlerForMode(ctx)` 返回的 handler 闭包持有 `ctx` 引用。`ctx`（`ExtensionContext`）可能持有 `sessionManager`、`modelRegistry` 等大对象。若 handler 生命周期长于 session（如被全局缓存），会泄漏。

**缓解**：handler 闭包**只持有必要的字段**（sidecar 通道引用、sessionId 字符串），不持有整个 ctx。工厂内部从 ctx 解构出需要的字段再关闭包：
```ts
function createRpcSidecarHandler(ctx: ExtensionContext): UiRequestHandler {
  const sidecar = getSidecarChannel(ctx);  // 只拿通道引用，不持有 ctx
  const sessionId = ctx.sessionManager.getSessionId();  // 只拿字符串
  return async (req) => { /* 用 sidecar + sessionId，不引用 ctx */ };
}
```

`SubagentService` 持有 handler 引用，session_shutdown 时 `dispose()` 应清空 handler（`this.uiRequestHandler = undefined`），打断闭包链。

### R3：metric 写盘开销

`pi.appendEntry` 每次调用都写 session.jsonl。若 stats flush 频率过高（如每 invoke 都 flush），会拖慢 ask_user 响应。

**缓解**：10s / 100 次 flush 阈值是经验值。ask_user 是低频操作（一个 subagent 一次执行最多 1-2 次 ask_user），100 次 invoke 阈值在实际场景中很难触发，主要是 10s 定时器兜底。`appendEntry` 本身是 append-only 写入，无锁，开销在微秒级。

### R4：session-level Set 无界增长

`warnedMissingHandlerSessions: Set<string>` 若从不清理，跨大量 session 会累积。

**缓解**：`setUiRequestHandler` 时 clear（handler 变化时重置）。`dispose` 时 clear。session 数量在实际场景中有限（单进程并发 session 数 ≤ 个位数）。

## 五、代码变更清单

| 文件 | 函数/字段 | 改动类型 | 说明 |
|------|----------|----------|------|
| `extensions/subagent-workflow/src/execution/types.ts`（或新建 `ui-request-types.ts`） | `UiRequest` / `UiResponse` / `UiRequestHandler` | 新增 | method-based handler 签名契约 |
| `subagent-service.ts:97-110` `SubagentServiceInit` | `uiRequestHandler` | 修改 | 类型改为 `UiRequestHandler`（已是可选，保持） |
| `subagent-service.ts:111-119` `SubagentServiceSessionInit` | `mode` / `uiRequestHandler` | 新增字段 | session 级注入 |
| `subagent-service.ts:174` | `uiRequestHandler` | 修改 | 去掉 `readonly` |
| `subagent-service.ts:174` 附近 | `sessionMode` / `warnedMissingHandlerSessions` / `uiRequestStats` | 新增字段 | 可观测性 |
| `subagent-service.ts` 类内 | `setUiRequestHandler(handler)` | 新增方法 | 动态替换 handler |
| `subagent-service.ts` 类内 | `notifyMissingHandler(sessionId)` / `flushUiRequestStats()` / `recordUiRequestInvoke(kind)` | 新增方法 | 可观测性内部 API |
| `subagent-service.ts` `initSession` | — | 修改 | 读 `init.mode` / `init.uiRequestHandler`；appendEntry `subagent:session-init` |
| `subagent-service.ts` `dispose` | — | 修改 | 清空 handler / Set / stats |
| `session-runner.ts:200-205` `SessionRunnerContext.uiRequestHandler` | 类型 | 修改 | 改为 `UiRequestHandler`（method-based） |
| `session-runner.ts:419-432` `handleUiRequest` | 调用方式 | **配合 subagent 1** | `handler(questions, context)` → `handler({ method, params, id })`；missing 分支调 `notifyMissingHandler` |
| `index.ts:209` 附近 | session_start handler | 修改 | `new` 后调 `createUiRequestHandlerForMode(ctx)` + `service.setUiRequestHandler(handler)` |
| `index.ts`（或新建 `ui-request-handler-factory.ts`） | `createUiRequestHandlerForMode(ctx)` / `createRpcSidecarHandler(ctx)` | 新增 | handler 工厂 |
| `extensions/subagent-workflow/src/execution/__tests__/` | `ui-request-injection.test.ts` / `ui-request-observability.test.ts` | 新增 | setter / warn 去重 / stats flush 单测 |

**不在本设计实现**（标注清楚）：
- `handleUiRequest` 内部 `handler({ method, params, id })` 调用的具体协议消费（questions 提取、response 序列化）→ subagent 1
- `createRpcSidecarHandler` 的 sidecar 通道具体调用 → subagent 4 集成测试时确认
- TUI mode 下 agent 配置层去掉 ask_user tool → 不在本 topic 范围

## 六、与其他 subagent 设计文件的接口约定

### 与 subagent 1（协议层修复）的边界

**本设计交付**：`UiRequest` / `UiResponse` / `UiRequestHandler` 类型契约（`ui-request-types.ts`）。

**subagent 1 消费**：`session-runner.ts:419` `handleUiRequest` 改为按 `UiRequest` 调用 handler，不再在 session-runner 内部提取 `questions`/`context`。具体：
- `handleUiRequest` 从 `params` 构造 `UiRequest`（`{ method: "ask_user", params, id }`）传给 handler
- handler 返回 `UiResponse`，`handleUiRequest` 按 `{ result }` / `{ error }` 回写 stdin
- 若 subagent 1 需要在 session-runner 内做 protocol-level 校验（method 白名单、params schema），在本设计提供的 `UiRequest` 契约上叠加

**对齐约束**：`UiRequest.method` 当前固定 `"ask_user"`，但类型是 `string`（开放枚举）。subagent 1 若要收窄为联合类型（`"ask_user" | "form_request" | ...`），改 `ui-request-types.ts` 的 `method` 字段类型即可，不影响注入机制。

### 与 subagent 4（集成测试）的约定

`createRpcSidecarHandler(ctx)` 是 stub（返回 `{ error: { code: -32601, message: "not implemented" } }`）。subagent 4 设计集成测试时确认 sidecar 通道调用方式后，填充实现。本设计的 `setUiRequestHandler` 支持运行时替换，集成测试可在 `session_start` 后用真实 sidecar handler 覆盖 stub。

### 与现有 `streamSink` 注入模式的一致性

`streamSink` 的注入（`index.ts:224` `ctx.mode === "rpc" ? { setWidget: ... } : undefined`）是本设计的先例。`uiRequestHandler` 采用相同模式（`ctx.mode === "rpc"` 注入，否则 undefined），保持一致性。两者区别：
- `streamSink` 走 `initSession`（SubagentServiceSessionInit.streamSink）
- `uiRequestHandler` 走 `setUiRequestHandler`（独立 setter）

不一致的原因：`streamSink` 是纯输出通道（父→子 widget），session 级固定；`uiRequestHandler` 是双向通道（父↔子 ask_user），可能需要运行时替换（sidecar 重连）。若后续 review 认为 should 统一到 `initSession`，可合并——但当前选择 setter 以保留灵活性。

---

## 假设清单（需其他 subagent 确认）

1. **假设 `UiRequest.method` 当前只需 `"ask_user"`**——subagent 1 若规划了其他 method（form/confirm），需提前告知以收窄类型。
2. **假设 rpc mode 下 sidecar 通道能承载 ask_user 的请求/响应**——subagent 4 集成测试时确认通道能力（延迟、并发、断连行为）。
3. **假设 `ExtensionMode` 包含 `"tui" | "rpc" | "json" | "print"` 四值**——基于 `docs/pi-tui-development-guide.md` 第四部分第 8 节 + pi 源码 `packages/coding-agent/src/core/extensions/types.ts:299`。subagent 实现时若发现 SDK 类型有变化，同步更新 `createUiRequestHandlerForMode` 的 switch。
4. **假设 `pi.appendEntry` 的 customType 命名空间无冲突**——`subagent:ui-request-*` 前缀未见其他扩展使用。若 pending-notifications 或其他扩展已占用，需协调命名。
5. **假设 tui mode 下不注入 handler 是可接受降级**——TUI 用户若期望子 agent 能 ask_user，需在 agent 配置层（agent.md tools 列表）去掉 ask_user，否则用户体验是「子 agent 超时后自行降级」。这个产品决策需 subagent 4 / 用户确认。
