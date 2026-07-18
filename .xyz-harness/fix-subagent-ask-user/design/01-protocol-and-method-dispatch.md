# 01 — 协议格式 + method 分发修复设计

> 作用域：仅协议层（spawn-event-adapter 解析 + session-runner 分发 + 响应回写）。
> 不含：ask_user handler 业务实现、subagent-service 接线、超时/取消语义、UI 渲染。

---

## 1. 问题分析（对照 pi-mono rpc-types.ts）

权威协议源：`pi-mono/main/packages/coding-agent/src/modes/rpc/rpc-types.ts`。

### 1.1 Pi 真实格式（事实）

**UI 请求**（子进程 stdout → 父进程），`RpcExtensionUIRequest` 联合类型，rpc-types.ts **L230–265**：

```ts
| { type: "extension_ui_request"; id: string; method: "select";   title: string; options: string[]; timeout?: number }
| { type: "extension_ui_request"; id: string; method: "confirm";  title: string; message: string;  timeout?: number }
| { type: "extension_ui_request"; id: string; method: "input";    title: string; placeholder?: string; timeout?: number }
| { type: "extension_ui_request"; id: string; method: "editor";   title: string; prefill?: string }
| { type: "extension_ui_request"; id: string; method: "notify";   message: string; notifyType?: "info"|"warning"|"error" }
| { type: "extension_ui_request"; id: string; method: "setStatus";   statusKey: string; statusText: string|undefined }
| { type: "extension_ui_request"; id: string; method: "setWidget";   widgetKey: string; widgetLines: string[]|undefined; widgetPlacement?: "aboveEditor"|"belowEditor" }
| { type: "extension_ui_request"; id: string; method: "setTitle";    title: string }
| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
```

特征：顶层 `type:"extension_ui_request"` + `id:string(uuid)` + 顶层 `method` 字段 + 各 method 自己的字段。**无 `jsonrpc`，无 `params` 包裹**。

**UI 响应**（父进程 stdin → 子进程），`RpcExtensionUIResponse`，rpc-types.ts **L271–274**：

```ts
| { type: "extension_ui_response"; id: string; value: string }      // select / input / editor 答案
| { type: "extension_ui_response"; id: string; confirmed: boolean } // confirm 答案
| { type: "extension_ui_response"; id: string; cancelled: true }    // 取消
```

子进程消费点：rpc-mode.ts `handleInputLine`，仅识别 `parsed.type === "extension_ui_response"`，按 id 查 `pendingExtensionRequests` resolve。**不认 `{jsonrpc:"2.0",...}`**。

**普通 RPC 响应**（非 UI），`RpcResponse`，rpc-types.ts **L140–237**：

```ts
{ id?: string; type: "response"; command: string; success: boolean; data?: ...; error?: string }
```

**各 method 的交互模型**（rpc-mode.ts createExtensionUIContext）：

| method | 是否等响应 | 创建路径 | 默认值（timeout/abort 时） |
|---|---|---|---|
| select / confirm / input | 是（createDialogPromise） | L137–151 | undefined / false / undefined |
| editor | 是（手写 Promise，不走 createDialogPromise） | L273–292 | undefined |
| notify / setStatus / setWidget / setTitle / set_editor_text | **否**（fire-and-forget） | 各自 output() | — |

### 1.2 当前实现的错误（对照 spawn-event-adapter.ts）

| # | 位置 | 当前判定 | Pi 真实 | 后果 |
|---|---|---|---|---|
| A | `isExtensionUiRequest` L70–81 | `jsonrpc==="2.0"` ∧ `method==="extension_ui_request"` ∧ `params:object` | `type==="extension_ui_request"` ∧ `id:string` ∧ `method`∈{select,…} | Pi 行无 `jsonrpc`、`method` 是 `select` 等 → 判定 false |
| B | `isRpcResponse` L57–68 | `jsonrpc==="2.0"` ∧ 有 id ∧ 无 method ∧ (result\|error) | `type==="response"` ∧ `command` ∧ `success` ∧ (data\|error) | 判定 false（subagent-workflow 当前不发 RpcCommand，**结构性错但运行期未触发**） |
| C | `parseSpawnLine` 末尾 L132–138 | `typeof obj.type==="string"` → `kind:"event"` | extension_ui_request 也有 string `type` | **被误判为 event**，喂 `handleSdkEvent` default 分支**静默丢弃**（比"invalid"更隐蔽） |
| D | `ParsedSpawnLine` L32 `extension_ui_request` 分支 | `{id, params:Record<string,unknown>}` | 需带 `method` + method-specific 字段 | 丢失 method，下游无法分发 |
| E | `handleUiRequest` L426–427 | 从 `params.questions/context` 抠字段，假设全是 ask_user | 9 种 method 字段各异 | confirm/notify/… 抠不到 questions → 走 error 分支 |
| F | `handleUiRequest` 响应 L448/L465 | `{jsonrpc:"2.0", id, result}` / `{jsonrpc, id, error}` | `{type:"extension_ui_response", id, value\|confirmed\|cancelled}` | 子进程 `handleInputLine` 不认 → pending 永不 resolve → ask_user tool 挂起到 timeout |

**结论**：A→C→F 三环全断，即便 handler 逻辑正确，ask_user 请求也进不来、响应回不去。端到端必然失效。

### 1.3 select 通道的通用性问题

`ctx.ui.select` 是 Pi 通用 UI 原语，任意扩展（statusline / goal / todo / 第三方）都可调。ask_user 在 RPC 模式经 `askUserInteract`（`@xyz-agent/extension-protocol@^0.2.0`）把结构化 questions **编码进 select.title**，并携带 `ASK_USER_MARKER`（title 前缀约定）让 xyz-agent 前端 AskUserOverlay 识别渲染。

⇒ 父进程收到 `method:"select"` **不能假定都是 ask_user**，必须按 marker 过滤；无 marker 的 select 不转 ask_user handler。

> 注：`ASK_USER_MARKER` 的具体字符串值与 title 编码格式是 `@xyz-agent/extension-protocol` 的外部契约（本仓库未安装该包源码，属黑盒）。父进程 ask_user handler 需导入或复刻其 decode 逻辑，二者必须对齐（见风险点 R3）。

---

## 2. 修复方案

### 2.1 `ParsedSpawnLine` 重设计（discriminated union）

替换 spawn-event-adapter.ts L32 的单一分支为按 method 分的联合：

```ts
// method-specific 字段对照 rpc-types.ts L230-265，命名 1:1
export type ExtensionUiRequest =
  | { method: "select";         title: string; options: string[]; timeout?: number }
  | { method: "confirm";        title: string; message: string;  timeout?: number }
  | { method: "input";          title: string; placeholder?: string; timeout?: number }
  | { method: "editor";         title: string; prefill?: string }
  | { method: "notify";         message: string; notifyType?: "info"|"warning"|"error" }
  | { method: "setStatus";      statusKey: string; statusText: string|undefined }
  | { method: "setWidget";      widgetKey: string; widgetLines: string[]|undefined; widgetPlacement?: "aboveEditor"|"belowEditor" }
  | { method: "setTitle";       title: string }
  | { method: "set_editor_text"; text: string }
  // 前向兼容：未知 method 不丢弃，透传给分发层记日志
  | { method: string; raw: Record<string, unknown> };

export type ParsedSpawnLine =
  | { kind: "header"; header: SpawnSessionHeader }
  | { kind: "event"; event: SdkEvent }
  | { kind: "response"; id?: string; command: string; success: boolean; data?: unknown; error?: string }
  | { kind: "extension_ui_request"; id: string; request: ExtensionUiRequest }
  | { kind: "invalid"; raw: string; error: string };
```

> `response` 分支同步修正为 Pi 真实结构（type+command+success+data|error），顺带修问题 B。

### 2.2 `isExtensionUiRequest` / `isRpcResponse` 重写

```ts
// 替换 L57-68
function isRpcResponse(obj: unknown): obj is { id?: string; command: string; success: boolean; data?: unknown; error?: string } {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return r.type === "response"
    && typeof r.command === "string"
    && typeof r.success === "boolean";
}

// 替换 L70-81。只做结构守卫，不做 method 白名单（未知 method 走 fallback 分支透传）
function isExtensionUiRequest(obj: unknown): obj is { id: string; method: string; fields: Record<string, unknown> } {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return r.type === "extension_ui_request"
    && typeof r.id === "string"
    && typeof r.method === "string";
}
```

`parseSpawnLine` 内：`isExtensionUiRequest` 命中后，按 `method` 构造对应的 `ExtensionUiRequest` 变体（switch 收窄字段；未知 method → `{method, raw}`）。**必须在"事件行"判定之前调用**，否则被 L132 末尾分支抢先当 event 吞掉（修问题 C）。

### 2.3 `handleUiRequest` 改 method 分发

handler 接口从单函数改为**多 handler 对象**（决策见 §3.1）：

```ts
export interface UiRequestHandlers {
  /** ask_user 经 select 通道（需 marker 过滤）。返回 value 或 cancelled。 */
  onSelect?: (req: { id: string; title: string; options: string[]; timeout?: number }) => Promise<{ value: string } | { cancelled: true }>;
  onConfirm?: (req: { id: string; title: string; message: string; timeout?: number }) => Promise<{ confirmed: boolean } | { cancelled: true }>;
  onInput?:   (req: { id: string; title: string; placeholder?: string; timeout?: number }) => Promise<{ value: string } | { cancelled: true }>;
  onEditor?:  (req: { id: string; title: string; prefill?: string }) => Promise<{ value: string } | { cancelled: true }>;
  // fire-and-forget：无返回值，handler 内部自行决定是否转发到主 UI
  onNotify?:    (msg: string, type?: "info"|"warning"|"error") => void;
  onSetStatus?: (key: string, text: string|undefined) => void;
  onSetWidget?: (key: string, lines: string[]|undefined, placement?: "aboveEditor"|"belowEditor") => void;
  onSetTitle?:  (title: string) => void;
  onSetEditorText?: (text: string) => void;
}
```

`SessionRunnerContext.uiRequestHandler` 字段类型从 `(questions, context) => Promise<unknown>` 改为 `UiRequestHandlers`（subagent-service.ts L104/L174/L204/L962 同步）。

分发伪代码（替换单一 handleUiRequest）：

```ts
async function dispatchUiRequest(
  child: ChildProcess, id: string, req: ExtensionUiRequest,
  handlers: UiRequestHandlers, signal?: AbortSignal,
): Promise<void> {
  switch (req.method) {
    case "select": {
      // ★ marker 过滤：仅 ask_user 的 select 转 onSelect
      if (!handlers.onSelect || !hasAskUserMarker(req.title)) {
        return respond(child, id, { cancelled: true });  // 非 ask_user select：立即取消，不阻塞子进程
      }
      const out = await handlers.onSelect({ id, ...req });
      return respond(child, id, out);  // {value} | {cancelled}
    }
    case "confirm": {
      if (!handlers.onConfirm) return respond(child, id, { cancelled: true });
      return respond(child, id, await handlers.onConfirm({ id, ...req }));
    }
    // input / editor 同 confirm（{value}|{cancelled}）
    case "notify":    handlers.onNotify?.(req.message, req.notifyType);    return;  // 无响应
    case "setStatus": handlers.onSetStatus?.(req.statusKey, req.statusText); return;
    case "setWidget": handlers.onSetWidget?.(req.widgetKey, req.widgetLines, req.widgetPlacement); return;
    case "setTitle":  handlers.onSetTitle?.(req.title);  return;
    case "set_editor_text": handlers.onSetEditorText?.(req.text); return;
    default:
      // 未知 method：回 cancelled，避免子进程 pending 永挂（若该 method 本是 fire-and-forget 则无害）
      return respond(child, id, { cancelled: true });
  }
}

// 统一响应写入：构造 RpcExtensionUIResponse（修问题 F）
function respond(child: ChildProcess, id: string, out: { value: string } | { confirmed: boolean } | { cancelled: true }): void {
  if (signal?.aborted) return;
  const line = JSON.stringify({ type: "extension_ui_response", id, ...out }) + "\n";
  safeWriteStdin(child, line, id);  // 复用现有背压/序列化防护（原 [R1][R2]）
}
```

### 2.4 `createUiRequestQueue` 签名同步

入队参数从 `(id, params: Record<string, unknown>)` 改为 `(id, request: ExtensionUiRequest)`。runSpawn stdout pump（L760 附近）改 `enqueueUiRequest(parsed.id, parsed.request)`。

### 2.5 ask_user select 的 marker 过滤契约

`onSelect` 实现方（ask_user handler，非本设计范围）职责：

1. `hasAskUserMarker(title)`：按与 `@xyz-agent/extension-protocol` 约定的 marker 前缀判定（具体值/magic 由该包定义，本设计只规定**判定发生在 title 字段、判定函数名**）。
2. 命中 marker：从 title decode 出 protoQuestions → 调主 agent ask_user tool → 收 answers → encode 回 `{value: string}`（value 格式同样是对端契约）。
3. 未命中：`dispatchUiRequest` 已在调用 `onSelect` 前过滤，handler 不会被调。

**关键约束**：`hasAskUserMarker` 与 decode/encode 三处必须与 `@xyz-agent/extension-protocol` 同版本对齐。本设计将 `hasAskUserMarker` 的实现位置定在 **ask_user handler 侧**（不在 adapter / session-runner），adapter 层只透传 `title` 原文。

---

## 3. 关键决策点

### 3.1 多 handler 对象 vs 单 switch 函数

**选多 handler 对象**（`UiRequestHandlers`）。

- 单 switch 函数（`handleUiRequest(req): Promise<Response>`）会把 9 种 method 的处理压进一个函数体，违反"函数 ≤80 行"，且 ask_user 的 onSelect（重逻辑）与 notify 的 onNotify（轻日志）耦合在同一闭包，调用方无法只注入需要的 method。
- 多 handler 对象让调用方（subagent-service → ask_user 扩展）**按需注入**：只实现 `onSelect`（ask_user 关心的），其余 method 留 undefined → `dispatchUiRequest` 对 undefined handler 直接回 cancelled（dialog 类）或静默（fire-and-forget 类）。扩展性：未来加 `onConfirm` 不改 adapter。
- 符合项目"职责划分"规范（index.ts 只做注册胶水，业务逻辑独立）。

### 3.2 为什么 select 做 marker 过滤，其他 dialog method 不做

- `select` 是 Pi **通用 UI 原语**，ask_user 复用它的传输通道，靠 marker 区分语义。多个扩展共用 select。
- `confirm/input/editor` 虽也是通用原语，但**当前 subagent 场景下没有其他扩展在子进程里用它们**（子进程 tools 受 agent.tools 白名单限制）。即便将来有，每个扩展调 confirm 的语义就是"是/否确认"，转发给主 UI confirm 通道是合理默认，不需要 marker。
- 若将来发现 confirm/input 也被多扩展复用且语义冲突，再按需加 marker——**不为未发生的需求设计**（规范 §不加推测性功能）。

### 3.3 为什么把 marker 判定放 handler 侧而非 adapter 层

adapter（spawn-event-adapter）是 **Core 叶子原语**，刻意零业务感知（文件头注释："仅做行→分类事件对象的纯解析"）。把 ASK_USER_MARKER 这种业务约定塞进 adapter 会污染分层。`dispatchUiRequest` 在 session-runner（编排层）做"是否调 onSelect"的过滤，但具体 `hasAskUserMarker` 的字符串匹配委托给 handler——handler 持有 `@xyz-agent/extension-protocol` 的契约知识。

### 3.4 非 ask_user 的 select 为什么回 cancelled 而非静默

子进程 `createDialogPromise` 对 select 注册了 `pendingExtensionRequests[id]`，**必须 resolve 否则永久泄漏 Promise + 内存**。回 `{cancelled:true}` 让子进程按"用户取消"语义走默认值（undefined），调用方扩展自行降级。静默 = 内存泄漏 + 子进程挂死。

### 3.5 为什么 `ExtensionUiRequest` 保留 `method: string` fallback

Pi 未来可能加新 method（如 `setProgress`）。adapter 若硬编码 9 个 method 白名单，新 method 会被当 invalid 丢弃，破坏前向兼容。fallback 分支 `{method, raw}` 透传，dispatchUiRequest default 回 cancelled。代价：类型安全略降（接受未知 method），换兼容性值得。

---

## 4. 风险点

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | `notify/setStatus/setWidget/setTitle/set_editor_text` 是 fire-and-forget，**无 id 关联响应** | dispatchUiRequest 对它们不回响应是正确的，但若误回响应子进程会忽略（无害） | 文档标注 + dispatchUiRequest 内 `return;` 显式无响应 |
| R2 | `editor` 的 prefill 可能是大文本（多 KB） | title/prefill 透传到 handler，handler decode 时注意内存 | handler 侧处理，非本设计范围 |
| R3 | **`ASK_USER_MARKER` 与 title 编码格式是 `@xyz-agent/extension-protocol` 外部契约**（本仓库未装源码） | marker 值/编码若不对齐，父进程 onSelect 收到 select 也 decode 失败 | (1) 实现阶段先从 xyz-agent 项目取 marker 常量与 encode/decode 源码；(2) `hasAskUserMarker` 实现**必须**有单元测试夹具（真实 title 样本）；(3) 升级 extension-protocol 时需回归 |
| R4 | 现有测试 `ui-request-handler.test.ts` / `ui-request-queue.test.ts` **全部基于虚构的 JSON-RPC 格式** | 改完类型后这些测试编译失败 | 不是"修协议顺带改测试"，而是**协议修复的强制组成部分**——测试夹具必须换成 pi-mono rpc-types.ts 的真实格式样本 |
| R5 | dispatchUiRequest 对未知 method 回 cancelled，但若该 method 本是 fire-and-forget（无 pending），回 cancelled 被子进程忽略（pendingExtensionRequests.get 返回 undefined） | 无害 | 可接受 |
| R6 | `response` 分支（isRpcResponse）修正后，runSpawn stdout pump 需新增对 `kind==="response"` 的处理 | 当前 pump 无此分支（只处理 header/event/extension_ui_request），response 行会落 invalid | 变更清单含 pump 分支新增（即便当前不主动发 RpcCommand，日志/诊断需要） |

---

## 5. 代码变更清单

| 文件 | 函数/符号 | 改动类型 | 说明 |
|---|---|---|---|
| `extensions/subagent-workflow/src/execution/spawn-event-adapter.ts` | `ParsedSpawnLine` | 修改 | `extension_ui_request` 分支换为 `{id, request: ExtensionUiRequest}`；`response` 分支换为 Pi 真实结构 |
| 同上 | `ExtensionUiRequest` | 新增 | 判别联合类型（§2.1），含 method fallback |
| 同上 | `isRpcResponse` | 修改 | 改判 `type:"response"` + `command` + `success`（§2.2） |
| 同上 | `isExtensionUiRequest` | 修改 | 改判 `type:"extension_ui_request"` + `id` + `method`（§2.2） |
| 同上 | `parseSpawnLine` | 修改 | 调整判定顺序：isExtensionUiRequest 在"事件行"之前；命中后按 method 构造 `ExtensionUiRequest` 变体 |
| `extensions/subagent-workflow/src/execution/session-runner.ts` | `UiRequestHandlers` | 新增 | 多 handler 接口（§2.3） |
| 同上 | `SessionRunnerContext.uiRequestHandler` | 修改 | 类型从 `(questions,context)=>Promise<unknown>` 改为 `UiRequestHandlers` |
| 同上 | `handleUiRequest` | 修改→重命名为 `dispatchUiRequest` | method switch 分发 + marker 过滤 + RpcExtensionUIResponse 回写（§2.3） |
| 同上 | `respond` / `safeWriteStdin` | 新增/提取 | 统一响应写入（复用原 [R1][R2] 背压/序列化防护） |
| 同上 | `createUiRequestQueue` | 修改 | 入队签名 `(id, request: ExtensionUiRequest)`；闭包内调 `dispatchUiRequest` |
| 同上 | `runSpawn` stdout pump | 修改 | `enqueueUiRequest(parsed.id, parsed.request)`；新增 `kind==="response"` 分支（记日志/诊断，R6） |
| `extensions/subagent-workflow/src/execution/subagent-service.ts` | `SubagentServiceInit.uiRequestHandler` | 修改 | 类型同步为 `UiRequestHandlers`（L104） |
| 同上 | `SubagentService.uiRequestHandler` 字段 | 修改 | L174 类型同步 |
| 同上 | `SubagentService` 构造函数 | 修改 | L204 赋值不变（类型跟随） |
| 同上 | `execute` 内 `uiRequestHandler` 透传 | 修改 | L962 注入 ctx 的字段类型同步 |
| `extensions/subagent-workflow/src/execution/__tests__/ui-request-handler.test.ts` | 全文件 | 修改 | 夹具从虚构 JSON-RPC 换为 pi-mono rpc-types.ts 真实格式样本（R4）；新增 method 分发用例（select/confirm/notify 各一） |
| `extensions/subagent-workflow/src/execution/__tests__/ui-request-queue.test.ts` | 用例 | 修改 | 入队签名 `(id, request)` 同步 |

> **本次设计不动**：ask_user 扩展本体（`extensions/ask-user/`）、`@xyz-agent/extension-protocol` 的 encode/decode、subagent-service 的 handler 业务实现、超时/取消/abort 语义（已有 [R3] 机制复用）、worktree/fork/turnLimiter。

---

## 6. 验收标准（协议层）

1. `parseSpawnLine` 对 pi-mono rpc-types.ts 9 种 method 的真实 JSON 样本，全部返回 `kind:"extension_ui_request"` 且 `request.method` 正确、字段无损。
2. `parseSpawnLine` 对 `type:"response"` 行返回 `kind:"response"` 且 `command/success/data` 正确。
3. `dispatchUiRequest` 对 select（带 marker）调 `onSelect` 并回 `{type:"extension_ui_response", id, value}`；对 select（无 marker）直接回 `{cancelled:true}` 不调 handler。
4. `dispatchUiRequest` 对 fire-and-forget method（notify 等）调对应 handler 且**不写 stdin**。
5. 回写的响应行能被子进程 `handleInputLine`（rpc-mode.ts）正确 resolve（`type:"extension_ui_response"` 匹配）。
6. 旧测试夹具全部替换，无基于 `jsonrpc:"2.0"` 的残留。
