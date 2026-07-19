# 00 — 主汇总：修复计划仲裁 + 实施分阶

> 主 agent 视角，对 4 份 subagent 设计文档（01-04）的：
> 1. 冲突裁决
> 2. 统一接口契约
> 3. 实施分阶（依赖图 + 验收标准）
> 4. 回填到原 topic 的方案

---

## 〇、4 份文档快速导航

| 文件 | 主题 | 核心改动 |
|------|------|---------|
| `01-protocol-and-method-dispatch.md` | spawn-event-adapter 解析协议 + handleUiRequest method 分发 | `ParsedSpawnLine` 判别联合、`isExtensionUiRequest` 按 Pi 原生格式重写、handler 签名设计 |
| `02-handler-injection-and-observability.md` | handler 注入机制 + 可观测性 | `setUiRequestHandler` setter、handler 工厂、可观测性 appendEntry |
| `03-mode-dispatch.md` | TUI/GUI/Headless 三模式分流 + W4 提示词守卫 | spawn 不分流（E1-E3 技术约束），W4 加 mode 守卫，stdio headless 微调 |
| `04-integration-tests.md` | 4 类新测试 + 修复 TC-W2 mock | TC-E2 协议解析、TC-E3 method 分发、TC-E4 注入端到端、TC-E5 真集成 |

---

## 一、冲突裁决（4 处核心冲突）

> **用户最终裁决（2026-07-17）**：冲突 1 单函数；冲突 2 系统化为 marker 前缀注册表；冲突 3 TUI 必须注入 + 跨子进程并发队列；冲突 4 封装 mode 工具，TUI 可注入。下方已据此更新，保留原 subagent 论证作历史参考。

### 冲突 1：handler 签名设计（subagent 1 vs subagent 2）

**subagent 1 方案**（01 §2.3）：
- `UiRequestHandlers` 多 handler 对象
- 每个 method 一个 handler：`onSelect?`/`onConfirm?`/`onInput?`/`onEditor?`/`onNotify?`/`onSetStatus?` ...
- 每个 handler 入参类型不同：`onSelect({id, title, options, timeout}) => {value}|{cancelled}`
- `dispatchUiRequest` 在 session-runner 内 switch method 调对应 handler

**subagent 2 方案**（02 §2.1）：
- `UiRequest` discriminated union + `UiResponse` 联合 + `UiRequestHandler` 单函数
- 签名 `(req: UiRequest) => Promise<UiResponse>`，handler 内部按 `req.method` switch
- session-runner 调单 handler 函数，内部路由交给 handler 实现方

**裁决**：**采用 subagent 2 的单 handler 函数 + UiRequest 判别联合**（用户确认）。

理由（按优先级）：
1. **subagent 4 测试设计按 subagent 2 的契约编写**（04 §5.1、§13.1）。已写就绪，如果回退到 subagent 1 的设计，需要改测试。
2. **分层更清晰**：session-runner 只做"协议消费 + 转发"（构造 UiRequest、调 handler、写回 extension_ui_response），handler 实现方做"路由 + 业务"。subagent 1 把 method 路由塞进 session-runner，违反 subagent 1 自己的 §3.3 决策"adapter 是 Core 叶子原语，零业务感知"。
3. **UiRequest 判别联合**用 TypeScript discriminated union，按 `method` 收窄字段，比"9 个独立 handler 类型"更符合函数 ≤80 行 + 职责单一原则。
4. **subagent 1 的"按需注入"优势可保留**：handler 内部可这样写：
   ```ts
   async (req) => {
     if (req.method === "select" && req.channel) {
       return handleByChannel(req);  // 按 channel 分发，只实现关心的通道
     }
     return { cancelled: true };  // 其他走取消
   }
   ```
   多 handler 对象的"按需注入"优势不丢。

**相应修改**：
- subagent 1 的 `dispatchUiRequest` 改为只做"协议消费"（构造 UiRequest、写 extension_ui_response），不调 handler
- handler 调用挪到 session-runner 的 enqueue/queue 流程里（与现有 handleUiRequest 等价，但签名换）
- subagent 1 的"marker 过滤在 adapter 层做"决策保留（详见冲突 2）

### 冲突 2：通用化 UI 透传（**两轮重设计：从 marker 过滤 → method 交互模型 + channel 注册表**）

> **演进**：原 subagent 方案只盯着 `ASK_USER_MARKER` + `isAskUser:boolean`。第一轮重设计（2026-07-17）改为 channel 注册表但错误地把 channel 提取绑死在 select.title。**用户指出 gui_widget 也要透传、逻辑应更通用化**。第二轮重设计（当前）纠正：channel 提取位置随 method 变，排队策略随 method 交互模型定——两个维度正交。

**Pi ctx.ui 方法实测分类**（源：rpc-mode.ts:135-303，`--mode rpc` 子进程的 ctx.ui 实现）：

10 个会发 `extension_ui_request` 的 method，按交互模型分两类：

| 交互模型 | method | 行为 | 子进程不回会怎样 |
|---|---|---|---|
| **dialog（占输入焦点，等响应）** | `select` `confirm` `input` `editor` | 子进程在 pendingExtensionRequests 注册 Promise 等 id 对应 response | Promise 永挂 + 内存泄漏 |
| **fire-and-forget（纯展示/写入，不等响应）** | `notify` `setStatus` `setWidget` `setTitle` `set_editor_text` | output() 完即返回，不注册 pending | 无影响 |

**marker 与 method 的映射（实测 extension-protocol）**：

| marker | 走的 method | 出现字段 | 语义 |
|---|---|---|---|
| `ASK_USER_MARKER = "\0XYZ_ASK_USER"` | `select` | `title`（options[0]=JSON payload） | ask_user 富交互借 select dialog 通道透传 |
| `GUI_WIDGET_MARKER = "\0XYZ_GUI_WIDGET:"` | `setWidget` | `widgetLines[0]` | gui_widget Vue 组件借 setWidget 写入通道透传 |

**关键纠正**：marker **不在同一字段**。ASK_USER_MARKER 在 select.title，GUI_WIDGET_MARKER 在 setWidget.widgetLines[0]。channel 提取位置**依赖 method**——这是第一轮重设计的 bug。

**裁决（两维度正交设计）**：

```
维度 1: 透传 + 排队策略 ← 由 method 交互模型决定（Pi 协议固定，自动判定）
维度 2: 业务路由       ← 由 channel 决定（扩展协议自定义，注册表分发）
```

**维度 1：透传判定规则（用户最终决策）**

> 用户原话：「当前在输入框位置有交互的功能要排队，纯展示的功能不用排队」「不影响 TUI 交互就无所谓，就不用透传」

| method | 交互模型 | TUI 影响 | 透传 | 排队 |
|---|---|---|---|---|
| `select`（含 ask_user channel） | dialog | 占输入焦点 | ✅ | ✅ L2 队列 |
| `confirm` | dialog | 占输入焦点 | ✅ | ✅ L2 队列 |
| `input` | dialog | 占输入焦点 | ✅ | ✅ L2 队列 |
| `editor` | dialog | 占输入焦点 | ✅ | ✅ L2 队列 |
| `setWidget`（含 gui_widget channel） | fire-and-forget | TUI 无 Vue 前端 | ❌ | ❌ |
| `set_editor_text` | fire-and-forget | 改编辑器内容（干扰大） | ❌ | ❌ |
| `notify` `setStatus` `setTitle` | fire-and-forget | TUI 留痕（通知/状态/标题） | ❌（默认） | ❌ |

规则汇总：
- **dialog 类全部透传 + 排队**（4 个 method）——占输入焦点必须争用域串行
- **fire-and-forget 类全部不透传**（5 个 method）——不影响 TUI 输入交互，子进程自行处理
- 透传判定**不看 channel**，只看 method。channel 只管业务路由

**维度 2：channel 注册表（业务路由）**

```ts
// extensions/subagent-workflow/src/execution/ui-channels.ts（新建）
export type ChannelHandler = (req: UiRequest) => Promise<UiResponse>;

/** channel 提取位置随 method 变：
 *  - select → 从 title 解析 NUL 前缀
 *  - setWidget → 从 widgetLines[0] 解析 NUL 前缀
 *  - 其他 method → 无 channel（undefined）
 *  NUL 前缀格式：\0<UPPER_CASE_ID>（如 \0XYZ_ASK_USER、\0XYZ_GUI_WIDGET:）
 *  channel 名规范化：取 UPPER_CASE_ID 小写化（XYZ_ASK_USER → ask_user）。 */
export function parseChannel(req: ExtensionUiRequest): { channel?: string; payload?: unknown } {
  switch (req.method) {
    case "select":      return parseFromMarkerString(req.title);
    case "setWidget":   return parseFromMarkerArray(req.widgetLines);
    default:            return {};
  }
}

export interface UiChannelRegistry {
  register(channel: string, handler: ChannelHandler): void;
  resolve(channel: string): ChannelHandler | undefined;
  list(): string[];
}
```

**注入链路（session_start）**：
```
ask-user 扩展（如已安装）→ registry.register("ask_user", handleAskUser)
[未来] gui-widget 扩展 → registry.register("gui_widget", handleGuiWidget)
SubagentService 持有 UiChannelRegistry 单例（进程级）
```

**总 handler 分发逻辑**（`createUiRequestHandlerForMode` 返回）：
```ts
return async (req: UiRequest) => {
  // 维度 1：dialog 才透传。fire-and-forget 的 setWidget/notify/... 不进 handler
  //         （session-runner 层根据 method 交互模型决定是否调 handler）
  
  // 维度 2：channel 业务路由
  const h = registry.resolve(req.channel);
  if (h) return h(req);                        // ask_user channel → ask-user 扩展 handler
  
  // 无 channel 的 dialog（普通 select/confirm/input/editor）→ 默认透传到主 agent ctx.ui.*
  return defaultDialogForward(req, ctx);       // 调 ctx.ui.select/confirm/input/editor
};
```

**关键设计决策**：

1. **排队绑定 method 交互模型，不绑定 channel**。dialog 类自动排队，未来新 channel 走 select 通道自动获得排队，不需 channel 注册时声明 `serialize`。这比第一轮设计（channel 声明 serialize）干净——排队是 Pi 协议固有属性，不是业务属性。

2. **gui_widget 不透传到 TUI**。gui_widget 走 setWidget（fire-and-forget），按维度 1 规则整体不透传。**但 GUI 主进程下仍透传**——维度 1 规则是「不影响 TUI 交互就不透传」，gui_widget 在 GUI 下不影响 TUI（根本没 TUI），所以 GUI 下 setWidget 要透传到前端 Vue 组件。这需要修正：**透传判定要按主进程 mode 分**。

   **修正后的透传矩阵**：

   | 主进程 mode | dialog 类 | fire-and-forget 类 |
   |---|---|---|
   | TUI | 全透传 + 排队 | 全不透传（子进程自行处理，不影响 TUI 输入交互） |
   | GUI（rpc） | 全透传 + 排队 | 全透传（GUI 前端能呈现所有 UI 元素） |
   | headless | 全不透传 | 全不透传 |

   这才是真正通用的设计：**TUI 只代理输入交互，GUI 代理所有 UI**。

3. **channel 提取按 method 分派**，纠正第一轮绑死 select.title 的 bug。adapter 层 `parseChannel(req)` 内部 switch method，仍属协议层（method 是协议概念）。

4. **channel registry 只管业务路由，不管排队、不管透传判定**。职责单一。

**副作用与约束**：
- `UiRequest` 类型加 `channel?: string` + `channelPayload?: unknown`（不绑 method，所有 method 都可能有 channel 字段，由 parseChannel 填充）
- adapter 层新增 `parseChannel` + `parseFromMarkerString` + `parseFromMarkerArray` + 单测
- session-runner 层新增 method 交互模型分类（`isDialogMethod(method)` 工具）+ 按分类决定是否调 handler / 是否排队
- `@xyz-agent/extension-protocol` 新增 marker 时，主 agent 侧对应扩展注册新 channel 即可，不改本仓库
- **channel 名规范化规则**：取 marker NUL 后的字面量小写化（`XYZ_ASK_USER` → `ask_user`，`XYZ_GUI_WIDGET` → `gui_widget`）。在 `parseFromMarkerString` 实现中固化 + 单测覆盖。去 `XYZ_` 前缀（协议命名空间标识，非业务语义）

**通用化收益总结**：
- 新增 dialog 透传场景（如未来 select 里加 form_request marker）：注册 channel handler → 自动透传 + 自动排队，零改动 adapter/session-runner
- 新增 GUI fire-and-forget 透传（如 gui_widget）：注册 channel handler → GUI 下自动透传，TUI 下自动忽略
- method 交互模型分类固化在 `isDialogMethod`，Pi 新增 method 时只改这一处

### 冲突 3：TUI 模式 handler 注入策略 + 跨子进程并发队列（**用户要求 TUI 必须支持，并要求并发队列**）

**subagent 2 方案**（D4）：TUI 下不注入 handler，子进程超时降级。

**subagent 3 方案**（2.6）：TUI 下必须注入 handler（用 `ctx.ui.custom` 复用 AskUserComponent），推翻 subagent 2 的 D4。

**裁决**：**TUI 必须注入 handler**（用户明确要求 TUI 也要支持 ask_user 透传）。同时**新增跨子进程并发队列需求**（用户要求：多个 ask_user 同时触发要排队）。

**现有队列机制勘误（2026-07-17 实测）**：
- `createUiRequestQueue`（session-runner.ts:366-400）是 **per-child 闭包**，每个子进程独立队列
- 它解决的是**同一子进程内**多个 extension_ui_request 的串行（FIFO），防止一个子进程并发问多个问题
- 它**不解决跨子进程并发**：`SubagentService.execute` 走 `ConcurrencyPool`（subagent-service.ts:168/205），多个 subagent 子进程可并发运行 → 每个都通过自己的 `createUiRequestQueue` 同时调主 agent handler → **多个 ask_user 同时涌向父 UI**
- 用户场景：3 个并行 subagent 同时 ask_user，TUI/GUI 上同时弹 3 个问题——需要全局串行

**重设计：两级队列（通用化，不绑 channel）**

1. **L1 per-child 队列**（现有，保留）：同一子进程内 extension_ui_request FIFO 串行。`createUiRequestQueue` 不动。
2. **L2 跨子进程全局队列**（**新增**）：所有子进程的 **dialog 类请求**（select/confirm/input/editor，**不只是 ask_user**），在主 agent handler 入口前再排一次队，保证**同一时刻主 agent 只呈现一个 dialog 给用户**。

**关键修正**：L2 排队**不看 channel**，看 method 交互模型。普通 confirm、未来 select 里的新 channel dialog，都自动进 L2 队列。这比第一轮设计（只排 ask_user channel）通用——排队是 dialog 类的固有需求（都争输入焦点），不是 ask_user 独有。

**L2 队列设计**：

```
位置：SubagentService 内（进程单例，跨所有子进程共享）
触发条件：isDialogMethod(req.method) === true（select/confirm/input/editor）
实现：
  class DialogGlobalQueue {
    private queue: Array<{ req: UiRequest; resolve: (r: UiResponse) => void }> = [];
    private processing = false;
    
    enqueue(req: UiRequest): Promise<UiResponse> {
      return new Promise(resolve => {
        this.queue.push({ req, resolve });
        this.processNext();
      });
    }
    
    private async processNext() {
      if (this.processing || this.queue.length === 0) return;
      this.processing = true;
      const { req, resolve } = this.queue.shift()!;
      try {
        const result = await this.delegateHandler(req);  // 调真正的 TUI/GUI handler
        resolve(result);
      } finally {
        this.processing = false;
        this.processNext();
      }
    }
  }
```

**接入点**：`createUiRequestHandlerForMode(ctx)` 返回的总 handler 内，对 dialog 类请求先过 L2 队列：
```ts
const dialogQueue = new DialogGlobalQueue(realHandler);  // realHandler 按 mode 分 TUI/GUI

return async (req: UiRequest) => {
  // 维度 1：fire-and-forget 在 session-runner 层已被过滤，能进这里的都是 dialog
  
  // L2 全局串行：所有子进程的 dialog 请求排队
  return dialogQueue.enqueue(req);
};
```

> 注：fire-and-forget 类（setWidget 等）的透传判定在更外层（session-runner 按 method + 主进程 mode 决定），不进这个 handler。详见冲突 2 的透传矩阵。

**为何 dialog 排队、fire-and-forget 不排队**：
- dialog（select/confirm/input/editor）**占输入焦点**，多个同时弹会争抢 → 必须串行
- fire-and-forget（setWidget/notify/...）**纯展示/写入**，不占焦点 → 不需串行（写同一 key 的交替覆盖是展示层问题，非排队问题）
- 这与用户语义完全对齐：「输入框位置有交互的功能要排队，纯展示的功能不用排队」

**TUI handler 实现要点（subagent 2 + subagent 3 选项 A 落入此处）**：
- 父 TUI 用 `ctx.ui.custom(component, props, callback)` 复用 ask-user 扩展的 `AskUserComponent`（ask-user/src/index.ts:54 `runTuiInteraction` 已证明可用）
- 收到子进程 channel="ask_user" 请求 → decode channelPayload 得 {questions, allowCancel} → 调主 agent 的 `ctx.ui.custom` 弹 AskUserComponent → 用户回答 → encode 答案回 `{type:"extension_ui_response", id, value}` 写子进程 stdin
- 收到无 channel 的普通 dialog（select/confirm/input/editor）→ 调主 agent 对应的 ctx.ui.select/confirm/input/editor 透传
- **L2 队列天然解决 R1（ctx.ui.custom 槽位冲突）**：全局串行意味着同一时刻只有一个 dialog 在用主 agent UI，不会并发抢占

**实现要求（合并到 subagent 2）**：
- `createUiRequestHandlerForMode(ctx)` 对 TUI/GUI 模式返回包装了 L2 队列的 handler
- L2 队列在 SubagentService 内构造（进程单例），dispose 时清空
- 新增 `isDialogMethod(method): boolean` 工具（session-runner 层消费，决定是否入 L2 队列 + 是否调 handler）
- 失败兜底：handler 实现时若 `ctx.ui.custom`/sidecar 抛错，捕获 → appendEntry "subagent:dialog-handler-failed" → 该请求回 `{cancelled:true}`（不阻塞队列后续）→ 继续处理下一个

**遗留风险（实施时验证）**：
- `ctx.ui.custom` 在主 agent 正在渲染其他组件（如主 agent 自己的 todo widget）时能否被 dialog 抢占——这是 Pi 平台能力问题，L2 队列只保证 dialog 之间不冲突，不保证 dialog 与主 agent 其他 UI 元素不冲突。需 Stage 4a 验证

### 冲突 4：W4 提示词 mode 守卫 + 封装 mode 判断工具（**用户要求封装工具**）

**subagent 3 方案**：W4 注入条件改为 `ctx.mode === "tui" || ctx.mode === "rpc"`，headless 不注入。

**潜在风险**：TUI 下若 handler 注入失败（冲突 3 的兜底路径），W4 已注入但 handler 缺失 → LLM 被误导。但冲突 3 已裁决 TUI 必须注入 + L2 队列，handler 成功率大幅提高。

**裁决**：**保留 subagent 3 方案（tui/rpc 注入 W4），并封装 mode 判断为独立工具**（用户要求）。

**封装工具设计**（`extensions/subagent-workflow/src/execution/host-mode.ts`，新建）：

```ts
import type { ExtensionMode } from "@mariozechner/pi-coding-agent";

/** 主进程运行模式分类。基于 ExtensionMode（"tui"|"rpc"|"json"|"print"）聚合为业务语义。
 *  判定依据见 AGENTS.md「运行时环境区分」章节 + docs/pi-tui-development-guide.md 第四部分第 8 节。
 *  ExtensionMode 来自 pi 源码 packages/coding-agent/src/core/extensions/types.ts:299。 */

export type HostMode = "tui" | "gui" | "headless";

/** 从 ExtensionContext.mode 解析主进程模式分类。
 *  - "tui" → tui（纯 Pi TUI，ctx.ui.custom 可用）
 *  - "rpc" → gui（xyz-agent GUI，sidecar 通道可用）
 *  - "json"/"print" → headless（无交互通道） */
export function resolveHostMode(mode: ExtensionMode | undefined): HostMode {
  if (mode === "tui") return "tui";
  if (mode === "rpc") return "gui";
  return "headless";  // json/print/undefined
}

/** 主进程是否会响应子进程的 ask_user（UI 透传）。
 *  tui + gui 都会（冲突 3 裁决），headless 不会。 */
export function willRespondToAskUser(mode: ExtensionMode | undefined): boolean {
  const host = resolveHostMode(mode);
  return host === "tui" || host === "gui";
}

/** 主进程是否有交互 UI 通道（TUI 组件 / GUI sidecar）。 */
export function hasInteractiveUI(mode: ExtensionMode | undefined): boolean {
  return resolveHostMode(mode) !== "headless";
}
```

**消费点**：
- W4 守卫（session-runner.ts:706）：`if (opts.agentConfig?.tools?.includes("ask_user") && willRespondToAskUser(ctx.mode))`
- handler 工厂（index.ts createUiRequestHandlerForMode）：按 `resolveHostMode(ctx.mode)` 分流
- stdio 选择：`hasInteractiveUI(ctx.mode)` 决定 stdin 是 pipe 还是 ignore

**封装收益**：
1. **AGENTS.md 知识固化**：AGENTS.md「运行时环境区分」章节定义的 ctx.mode 语义从文档注释变成可执行代码，避免散落在多处的 `ctx.mode === "tui" || ctx.mode === "rpc"` 字面量比较
2. **单一修改点**：未来 Pi 新增 mode 值或语义变化时，只改 `host-mode.ts` 的 `resolveHostMode`
3. **测试集中**：mode 分类逻辑单测集中在 host-mode.test.ts，不用在各消费点重复 mock ctx.mode
4. **可读性**：`willRespondToAskUser(ctx.mode)` 比 `ctx.mode === "tui" || ctx.mode === "rpc"` 语义清晰

**与冲突 3 的联动**：因冲突 3 裁决 TUI 必须注入 handler，`willRespondToAskUser` 对 tui 返回 true，W4 在 TUI 下会注入——这与「TUI 有 handler 能响应」一致，不再有「W4 注入但 handler 缺失」的矛盾（handler 缺失的兜底由 L2 队列 + appendEntry 处理，见冲突 3）。

**实施细节**：subagent 2 的可观测性层额外加一个 metric "subagent:ui-request-actually-handled vs missed"，让用户能区分"handler 真正响应了"和"handler 缺失超时降级"。

---

## 二、统一接口契约（4 份 subagent 文档的交点）

下面这套契约是 subagent 4 的测试代码假设的接口，也是 subagent 1/2/3 实现必须满足的接口。

### 2.1 `ParsedSpawnLine`（spawn-event-adapter.ts）

```ts
// 修复后（subagent 1 §2.1 + 冲突 2 通用化综合）
export type ExtensionUiRequest =
  | { method: "select"; title: string; options: string[]; timeout?: number }
  | { method: "confirm"; title: string; message: string; timeout?: number }
  | { method: "input"; title: string; placeholder?: string; timeout?: number }
  | { method: "editor"; title: string; prefill?: string }
  | { method: "notify"; message: string; notifyType?: "info"|"warning"|"error" }
  | { method: "setStatus"; statusKey: string; statusText: string|undefined }
  | { method: "setWidget"; widgetKey: string; widgetLines: string[]|undefined; widgetPlacement?: "aboveEditor"|"belowEditor" }
  | { method: "setTitle"; title: string }
  | { method: "set_editor_text"; text: string }
  | { method: string; raw: Record<string, unknown> };  // 未知 method fallback

export type ParsedSpawnLine =
  | { kind: "header"; header: SpawnSessionHeader }
  | { kind: "event"; event: SdkEvent }
  | { kind: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string }
  | { kind: "extension_ui_request"; id: string; request: ExtensionUiRequest }
  | { kind: "invalid"; raw: string; error: string };
```

关键改动：
- `extension_ui_request` 分支的 `params: Record<string, unknown>` 改为 `request: ExtensionUiRequest`（按 method 平铺，与 Pi rpc-types.ts L230-265 1:1）
- 删掉 JSON-RPC 2.0 守卫（`jsonrpc === "2.0"`、`method === "extension_ui_request"`、`params: object`）
- **不再有 `isAskUser` / `askUserPayload` 字段**——channel 提取移到 session-runner 层的 `parseChannel(req)`（见冲突 2），adapter 层只做纯协议解析（method + method-specific 字段平铺）

**判定顺序修复**（subagent 1 发现的关键 bug）：
- 原代码 `parseSpawnLine` 末尾分支 `typeof obj.type === "string"` → 当 event 处理
- 新代码：`isExtensionUiRequest` 在"事件行"判定**之前**调用（避免 extension_ui_request 被误判为 event 静默吞掉）

### 2.2 `UiRequest` / handler 签名（session-runner.ts:200，通用化版本）

```ts
// 修复后（subagent 2 §2.1 + 冲突 2 channel 字段 + 冲突 3 dialog 分类）
export interface UiRequest {
  /** Pi rpc-types.ts 的 method（select/confirm/input/editor 为 dialog 类；
   *  notify/setStatus/setWidget/setTitle/set_editor_text 为 fire-and-forget 类）。
   *  dialog 分类由 isDialogMethod(method) 判定，决定是否透传+排队。 */
  method: "select" | "confirm" | "input" | "editor" | "notify"
        | "setStatus" | "setWidget" | "setTitle" | "set_editor_text" | (string & {});
  id: string;
  // method-specific 字段（按 method 类型可选，与 ExtensionUiRequest 1:1）
  title?: string; options?: string[]; message?: string;
  placeholder?: string; prefill?: string; notifyType?: string;
  statusKey?: string; statusText?: string | undefined;
  widgetKey?: string; widgetLines?: string[] | undefined;
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string; timeout?: number;
  /** channel 名（从 method 对应字段的 NUL 前缀解析）。
   *  select → 从 title 解析；setWidget → 从 widgetLines[0] 解析；其他 method → undefined。
   *  当前已知值："ask_user"（select）、"gui_widget"（setWidget）。
   *  handler 按 channel 分发到注册的 channel handler，未注册走默认转发。 */
  channel?: string;
  /** channel 解析后的结构化 payload（已 JSON.parse）。
   *  ask_user: {questions, allowCancel}；gui_widget: {component}；
   *  无 channel 或 payload 解析失败: undefined。 */
  channelPayload?: unknown;
}

export type UiResponse =
  | { value: string }          // select/input/editor 答案
  | { confirmed: boolean }     // confirm 答案
  | { cancelled: true }        // 取消
  | { ack: true };             // fire-and-forget（当前不透传，留作协议完整）

export type UiRequestHandler = (req: UiRequest) => Promise<UiResponse>;

export interface SessionRunnerContext {
  // 现有字段...
  uiRequestHandler?: UiRequestHandler;
  mode?: ExtensionMode;   // subagent 3 §2.5 新增
}
```

### 2.3 stdin 回写格式（handleUiRequest 内）

```ts
// 修复后（subagent 1 §2.3 + subagent 4 §5.4 综合）
// 按 UiResponse 形状构造 Pi 原生 extension_ui_response
function respond(child, id, out: UiResponse): void {
  if (signal?.aborted) return;
  let line: string;
  if ("value" in out)       line = JSON.stringify({ type: "extension_ui_response", id, value: out.value });
  else if ("confirmed" in out) line = JSON.stringify({ type: "extension_ui_response", id, confirmed: out.confirmed });
  else if ("cancelled" in out) line = JSON.stringify({ type: "extension_ui_response", id, cancelled: true });
  else /* ack */ return;  // fire-and-forget：不写 stdin
  safeWriteStdin(child, line + "\n", id);  // 复用现有 [R1][R2] 防护
}
```

### 2.4 SubagentServiceInit / SessionInit / setter

```ts
// 修复后（subagent 2 §2.3）
export interface SubagentServiceInit {
  cwd: string;
  modelService: ModelConfigService;
  getMainSessionFile?: () => string | undefined;
  uiRequestHandler?: UiRequestHandler;   // 构造时可选
}

export interface SubagentServiceSessionInit {
  pi: PiLike;
  sessionId: string;
  streamSink?: StreamSink;
  mode?: ExtensionMode;                 // subagent 2 + 3 联合规划
  uiRequestHandler?: UiRequestHandler;  // session_start 注入
}

export class SubagentService {
  private uiRequestHandler: UiRequestHandler | undefined;   // 去掉 readonly
  private sessionMode: ExtensionMode | undefined;
  private warnedMissingHandlerSessions = new Set<string>();
  private uiRequestStats = { invoked: 0, missingHandler: 0, errors: 0, lastFlushAt: Date.now() };
  
  constructor(init: SubagentServiceInit) { /* ... */ this.uiRequestHandler = init.uiRequestHandler; /* ... */ }
  
  setUiRequestHandler(handler: UiRequestHandler | undefined): void {
    this.uiRequestHandler = handler;
    this.warnedMissingHandlerSessions.clear();  // 允许新状态重新 warn
  }
  
  initSession(init: SubagentServiceSessionInit): void {
    // session 级注入优先
    if (init.uiRequestHandler !== undefined) this.uiRequestHandler = init.uiRequestHandler;
    this.sessionMode = init.mode;
    // appendEntry "subagent:session-init"
    /* ... */
  }
  
  notifyMissingHandler(sessionId: string): void {
    if (this.warnedMissingHandlerSessions.has(sessionId)) return;
    this.warnedMissingHandlerSessions.add(sessionId);
    this.uiRequestStats.missingHandler++;
    this.pi.appendEntry("subagent:ui-request-missing-handler", { sessionId, mode: this.sessionMode, /* ... */ });
  }
  
  recordUiRequestInvoke(kind: "success" | "error"): void {
    this.uiRequestStats.invoked++;
    if (kind === "error") this.uiRequestStats.errors++;
    // 10s / 100 次 flush 阈值
    /* ... */
  }
  
  private buildSessionRunnerContext(overrideCwd?: string): SessionRunnerContext {
    return { /* ... */, uiRequestHandler: this.uiRequestHandler, mode: this.sessionMode };
  }
}
```

### 2.5 W4 提示词注入条件（session-runner.ts:706）

```ts
// 修复后（subagent 3 §2.4 + 冲突 4 host-mode 工具）
import { willRespondToAskUser } from "./host-mode.ts";
if (opts.agentConfig?.tools?.includes("ask_user") && willRespondToAskUser(ctx.mode)) {
  appendParts.push(ASK_USER_RPC_PROMPT);
}
// ASK_USER_TUI_PROMPT 不需要新文案（裁决 D3）
```

### 2.6 spawn stdio（session-runner.ts:755）

**保守路径先**（subagent 3 D5 优先）：
```ts
// 第一阶段：所有 mode 都保持 ["pipe","pipe","pipe"]（改动最小）
const stdioConfig: StdioOptions = ["pipe", "pipe", "pipe"];
```

激进路径（headless stdio=ignore）等到 R2 验证后再启用。

### 2.7 handler 工厂 + 透传/排队总控（冲突 2/3 通用化落地）

```ts
// index.ts session_start 内
const uiRequestHandler = createUiRequestHandlerForMode(ctx, channelRegistry, dialogQueue);
service.setUiRequestHandler(uiRequestHandler);

function createUiRequestHandlerForMode(
  ctx: ExtensionContext,
  registry: UiChannelRegistry,
  dialogQueue: DialogGlobalQueue,
): UiRequestHandler | undefined {
  // 维度 1：透传判定按主进程 mode + method 交互模型
  const hostMode = resolveHostMode(ctx.mode);
  if (hostMode === "headless") return undefined;  // headless 不透传任何 UI
  
  // TUI 和 GUI 都注入 handler，但透传范围不同（见 dispatchUiRequest 内的 method 过滤）
  const tuiHandler = hostMode === "tui" ? createTuiHandler(ctx) : null;
  const rpcHandler = hostMode === "gui" ? createRpcHandler(ctx) : null;
  const realHandler = tuiHandler ?? rpcHandler!;
  
  return async (req: UiRequest) => {
    // 维度 1：TUI 下只透传 dialog 类（fire-and-forget 不影响输入交互，不透传）
    //         GUI 下透传所有 method（前端能呈现全部 UI 元素）
    if (hostMode === "tui" && !isDialogMethod(req.method)) {
      return { ack: true };  // TUI 下 fire-and-forget 不透传，回 ack（不阻塞子进程）
    }
    
    // L2 全局队列：dialog 类必须串行（争输入焦点）。fire-and-forget 不进队列（GUI 下直接转发）
    if (isDialogMethod(req.method)) {
      return dialogQueue.enqueue(req, realHandler);
    }
    
    // GUI 下 fire-and-forget 直接转发（setWidget/notify 等 → 前端）
    return realHandler(req);
  };
}

// realHandler 内部按 channel 业务路由
function createTuiHandler(ctx: ExtensionContext): UiRequestHandler {
  return async (req) => {
    // 维度 2：channel 业务路由
    const channelHandler = channelRegistry?.resolve(req.channel);
    if (channelHandler) return channelHandler(req);
    
    // 无 channel 的 dialog → 默认转发到主 agent ctx.ui.* 透传
    return defaultDialogForward(req, ctx);  // ctx.ui.select/confirm/input/editor
  };
}
```

**TUI handler 实现要点**：
- channel="ask_user" → ask-user 扩展注册的 handler（用 `ctx.ui.custom(AskUserComponent)` 渲染）
- 无 channel 的 dialog → 调主 agent 对应 `ctx.ui.select/confirm/input/editor`
- fire-and-forget 在 createUiRequestHandlerForMode 总入口被过滤（TUI 下回 ack 不透传）
- `ctx.ui.custom` 抛错时捕获 → appendEntry "subagent:dialog-handler-failed" → 回 cancelled

---

## 三、实施分阶（依赖图 + 验收标准）

### 新增模块清单（通用化设计引入）

| 文件 | 职责 | 所属 Stage |
|---|---|---|
| `extensions/subagent-workflow/src/execution/host-mode.ts` | `resolveHostMode` / `willRespondToAskUser` / `hasInteractiveUI` | Stage 1 |
| `extensions/subagent-workflow/src/execution/ui-channels.ts` | `parseChannel` / `parseFromMarkerString` / `UiChannelRegistry` | Stage 1 |
| `extensions/subagent-workflow/src/execution/ui-interaction-model.ts` | `isDialogMethod(method)` / method 交互模型分类 | Stage 1 |
| `extensions/subagent-workflow/src/execution/dialog-queue.ts` | `DialogGlobalQueue` L2 跨子进程串行队列 | Stage 2 |

### 实施顺序

```
Stage 1（基础接口 + 工具模块，必先做）
  ├─ 1a: subagent 1 协议层（spawn-event-adapter.ts 重写：Pi 原生格式 + method 平铺）
  ├─ 1b: subagent 2 setter + 可观测性（subagent-service.ts 去 readonly + setter）
  ├─ 1c: host-mode.ts（resolveHostMode + willRespondToAskUser + hasInteractiveUI）
  ├─ 1d: ui-interaction-model.ts（isDialogMethod + method 交互模型分类）
  └─ 1e: ui-channels.ts（parseChannel 按 method 分派 + UiChannelRegistry）
  
Stage 2（依赖 Stage 1 的接口/工具）
  ├─ 2a: session-runner.ts enqueueUiRequest/handleUiRequest 改新签名 + method 交互模型过滤
  ├─ 2b: subagent 3 W4 守卫（用 willRespondToAskUser）+ mode 穿透 SessionRunnerContext
  └─ 2c: dialog-queue.ts（L2 全局队列）+ 接入 createUiRequestHandlerForMode
  
Stage 3（依赖 Stage 1+2）
  └─ subagent 4 新增测试 + 修复 TC-W2
  
Stage 4（依赖 Stage 3 全绿）
  └─ handler 业务实现（index.ts createUiRequestHandlerForMode 真实接入）
      ├─ 4a: TUI handler（ctx.ui.custom）—— 风险高，先 disableAskUser 兜底
      └─ 4b: RPC handler（xyz-agent sidecar）—— 等 xyz-agent 接入
```

### 各 Stage 验收标准

**Stage 1**：
- `parseSpawnLine` 对 Pi 真实协议 10 种 method 样例全部正确分类（type guard 通过，字段平铺提取）
- `SubagentService.setUiRequestHandler(handler)` setter 可调用（移除 readonly 编译通过）
- `SubagentService.notifyMissingHandler(sessionId)` + stats flush 逻辑单元测试通过
- `resolveHostMode("tui"|"rpc"|"json"|"print"|undefined)` 返回正确 HostMode（单测覆盖）
- `willRespondToAskUser` 对 tui/rpc 返回 true，json/print/undefined 返回 false
- `isDialogMethod("select"|"confirm"|"input"|"editor")` 返回 true，其他返回 false
- `parseChannel` 对 select.title 带 ASK_USER_MARKER → `{channel:"ask_user", payload:{questions,allowCancel}}`；对 setWidget.widgetLines[0] 带 GUI_WIDGET_MARKER → `{channel:"gui_widget", payload:{component}}`；无 NUL 前缀 → `{}`

**Stage 2**：
- `handleUiRequest` 改用 `UiRequestHandler` 签名，构造 `UiRequest`（含 channel/channelPayload）传入，回写 `extension_ui_response`
- `runSpawn` stdout pump 把 `parsed.request` 完整传给 `enqueueUiRequest`
- W4 守卫用 `willRespondToAskUser(ctx.mode)`，headless 测试不注入 RPC 提示词
- `SessionRunnerContext.mode` 字段穿透：`ctx.mode === "tui"` 在 runSpawn 内可读
- `DialogGlobalQueue` 跨子进程串行：3 个并发 dialog 请求按 FIFO 顺序处理（单测 mock 验证）
- TUI 下 fire-and-forget method 被 createUiRequestHandlerForMode 总入口过滤（回 ack 不透传）

**Stage 3**：
- TC-E2 全绿（Pi 原生格式解析正确，含 select.title 的 ASK_USER_MARKER channel 提取）
- TC-E3 全绿（method 交互模型分类 + dialog/fire-and-forget 分流 + channel 路由）
- TC-E4 全绿（fake child 端到端：含 L2 队列串行、channel handler 注入、handler 缺失降级）
- TC-E5 mock-pi 脚本用例在 PI_INTEGRATION 默认下全绿（CI 一致性）
- TC-W2 修改后单测仍绿（mock 换 Pi 真实格式 + channel 断言）

**Stage 4**：
- 真实 LLM 调 ask_user 时，子进程得到响应（answer），父端 UI 呈现问题（demo/test）
- TUI 下多个并行 subagent 同时 ask_user，父 TUI 按队列顺序逐个呈现（手动验证）
- GUI 下 setWidget 透传到 xyz-agent 前端 Vue 组件（手动验证）
- 至少一次端到端 manual test 通过 xyz-agent GUI 验证
- 可观测性日志能看到 ui_request invoke / handle / miss / queue 三种事件

---

## 四、回填到原 topic 的方案

原 topic `cw-2026-07-17-subagent-ask-user` 已 closeout。要把这次诊断+修复计划回填进去，用 cw 的 `assess` 命令（post-closeout 评估，不改 status）。

### 回填内容（两条评估记录）

**评估 1：质量评估（type=quality）**
- notes：当前 closeout 状态的端到端测试覆盖严重不足。TC-E1 placeholder、TC-W2 mock 格式与 Pi 真实协议不匹配、handler 注入缺失生产 bug 无测试覆盖。已用 subagent 设计 4 类新测试 + 修复 TC-W2。
- score：2/5（测试覆盖虽有设计但当前实现下全红）

**评估 2：缺陷登记（type=defect，最关键）**
- notes：subagent ask_user 主题端到端不可用——协议格式错误（JSON-RPC 2.0 vs Pi 原生）、handler 注入缺失（index.ts:209）、method 分发缺失、TUI/GUI/Headless mode 无分流、W4 提示词无 mode 守卫、uiRequestHandler 缺失时静默失败无任何可观测性、E1 集成测试 placeholder。已产出完整修复计划 `.fix-plans/00..04-*.md`。
- defect（JSON）：
  ```json
  {
    "severity": "blocker",
    "area": "extensions/subagent-workflow/src/execution/{spawn-event-adapter,session-runner,subagent-service}.ts + index.ts",
    "rootCause": "需求理解偏差 + 测试覆盖不足 + 协议设计假设错误（闭门造车，假设 JSON-RPC 2.0 而非核对 Pi 真实协议）",
    "foundInReview": false
  }
  ```

### cw assess 命令

```bash
# 1. 质量评估
cw assess --topicId cw-2026-07-17-subagent-ask-user \
  --type quality --score 2 \
  --notes "原 topic closeout 时 E1 集成测试为 placeholder、TC-W2 mock 格式与 Pi 真实协议不匹配、handler 注入缺失生产 bug 无测试覆盖。已用 4 subagent 并行产出完整修复计划见 .fix-plans/00..04-*.md，Stage 1-4 实施分阶明确。"

# 2. 缺陷登记（最关键）
cw assess --topicId cw-2026-07-17-subagent-ask-user \
  --type defect --notes "subagent ask_user 端到端完全不可用。详见 .fix-plans/00-master-summary.md。" \
  --defect '{"severity":"blocker","area":"extensions/subagent-workflow/src/execution/{spawn-event-adapter,session-runner,subagent-service}.ts + index.ts","rootCause":"协议层假设错误（期望 JSON-RPC 2.0 格式但 Pi 实际发 {type,method,...} 平铺字段） + handler 注入完全缺失（index.ts:209 new SubagentService 未传 uiRequestHandler） + method 分发缺失（select/confirm/notify 全部合并到同一 handler） + TUI/GUI/Headless 无 mode 分流（W4 提示词无 mode 守卫） + handler 缺失时静默失败无可观测性。E1 集成测试为 placeholder，从未跑过。","foundInReview":false}'
```

### 后续是否新建 topic 实施修复

**建议**：开新 topic（如 `cw-2026-07-18-fix-subagent-ask-user`）按 Stage 1-4 实施修复，原因：
1. 原 topic 已 closeout，状态机不再流转
2. 修复工作量很大（涉及 6 个核心文件 + 5 个测试文件），需要 dev/test gate 完整闭环
3. 可以复用本主汇总作为新 topic 的 plan 输入

**不立即开**：等用户先看汇总和裁决，决定是否按这个方向走。可能用户对某些冲突裁决有不同意见（比如冲突 4 的 W4 守卫）。

---

## 五、给主 agent 后续动作的建议

按用户期望「修复后可以走 cw 的 assessment 功能来补充到原先的 topic」，我建议分两步：

### 第 1 步：先把回填做掉（不需要用户决策）
- 跑上面两条 `cw assess` 命令，把汇总信息和缺陷登记回填到原 topic
- 这步不依赖设计决策，纯数据追加

### 第 2 步：等用户裁决
- 把本汇总（特别是 4 处冲突裁决）呈现给用户
- 用户确认后，再决定是否开新 topic 按 Stage 1-4 实施
- 或者用户可能想调整某些决策（比如 W4 守卫、handler 签名）

我先把第 1 步的回填跑掉，然后把汇总发给用户做裁决。**不擅自开新 topic 或动代码**。
