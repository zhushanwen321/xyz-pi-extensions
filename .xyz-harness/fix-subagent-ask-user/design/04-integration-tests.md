# 04 — 集成测试补强设计（subagent-ask-user）

> 范围：只设计测试，不修复协议层 / handler 注入本身（那是 subagent 1/2 的活）。
> 所有测试针对**修复后应有的正确接口**编写；当前实现会全红，正好验证修复有效。

---

## 一、问题分析（带证据）

### 1.1 TC-E1 从未跑过 — placeholder 文件

`.xyz-harness/subagent-ask-user/screenshots/TC-E1.txt` 全文仅一行：

```
Integration test placeholder - requires real Pi environment
```

`test.json` 中 TC-E1 声明 `executor: "shell"` + `requiresScreenshot: true`，但既无 shell 脚本也无真实截图。retrospect.md 却写「TC-E1: 集成测试 PASS（需要真实环境）」——**声明 PASS 但零证据**。

### 1.2 TC-W2 mock 格式与 Pi 真实输出完全不匹配

`ui-request-handler.test.ts:14-29` 的 mock：

```js
{
  jsonrpc: "2.0",                        // ← Pi 从不发这个字段
  id: "ui-req-001",
  method: "extension_ui_request",        // ← 错。真实 method 是 "select"
  params: {                              // ← Pi 从不嵌套 params
    marker: "ASK_USER",                  // ← 错。真实是 title = "\0XYZ_ASK_USER"
    questions: [...],                    // ← 错。真实是 options = [JSON.stringify({questions,...})]
    context: "Choosing a coding style",  // ← Pi select 消息无此字段
    timeout: 30000,
  },
}
```

而 `spawn-event-adapter.ts:96-106` 的 `isExtensionUiRequest` 守卫恰好匹配这个错误 mock（要求 `jsonrpc === "2.0"` + `method === "extension_ui_request"` + `params`）——**测试和生产代码对着错，互相「印证」了一个 Pi 永远不会发的协议**。真实 Pi 子进程 stdout 走到这行会被当成 `invalid` 丢弃。

### 1.3 TC-W3 绕过 handler 注入的生产 bug

`ui-request-queue.test.ts` 直接构造 `ctx = { uiRequestHandler: handler }` 喂给 `createUiRequestQueue`，且 enqueue 的 payload 直接是 `{questions, context}` 对象。两个问题：

- 绕过了 `parseSpawnLine → handleUiRequest` 的真实数据流（队列测试与协议解析脱钩）
- **生产代码 `index.ts:209` 构造 `SubagentService` 时根本没传 `uiRequestHandler`**：

```ts
// src/index.ts:209
const service = existingService ?? new SubagentService({
  cwd, modelService, getMainSessionFile: getCachedMainSessionFile,
  // ← 缺 uiRequestHandler！永远是 undefined
});
```

即使协议层和队列都对，生产中 `handleUiRequest` 第 426 行 `const handler = ctx.uiRequestHandler` 拿到的永远是 `undefined` → 静默忽略 → 子进程 ask_user 永远超时。**测试从未暴露这个 bug，因为测试永远手动注入 handler。**

### 1.4 整体覆盖缺口

现有测试（TC-W1~W4）全部是「协议层函数对不对」，没有任何一个测试验证「协议层函数跟 Pi 真实 stdout 格式匹不匹配」。集成层（parseSpawnLine ←→ Pi rpc-mode.ts output）和注入层（index.ts ←→ SubagentService）完全空白。

---

## 二、Pi 真实 RPC 协议（所有测试的 base truth）

来源：`pi-mono-workspace/main/packages/coding-agent/src/modes/rpc/rpc-mode.ts`（`output()` line 59、`createExtensionUIContext` line ~95）+ `rpc-types.ts:230-265`。

### 2.1 `extension_ui_request`（子进程 stdout → 父进程）

**平铺字段，无 `jsonrpc`，无 `params` 嵌套**。按 method 分（`rpc-types.ts:230-258`）：

| method | 顶层字段 | ask_user 用？ |
|--------|---------|--------------|
| `select` | `title, options: string[], timeout?` | ✅ ask_user 走这个 |
| `confirm` | `title, message, timeout?` | — |
| `input` | `title, placeholder?, timeout?` | — |
| `editor` | `title, prefill?` | — |
| `notify` | `message, notifyType?` | — |
| `setStatus` | `statusKey, statusText` | — |
| `setWidget` | `widgetKey, widgetLines, widgetPlacement?` | — |
| `setTitle` | `title` | — |
| `set_editor_text` | `text` | — |

所有 method 共有：`type: "extension_ui_request"`, `id: "<uuid>"`, `method: "<上面之一>"`。

### 2.2 ask_user 的 select 特殊编码（askUserInteract）

来源：`@xyz-agent/extension-protocol/dist/index.mjs:58-78`。

```js
ASK_USER_MARKER = "\0XYZ_ASK_USER"   // 注意 \0 前缀
ctx.ui.select(ASK_USER_MARKER, [JSON.stringify({questions, allowCancel})], {signal})
```

Pi 的 `ExtensionUIContext.select`（rpc-mode.ts line ~95）把它编成：

```json
{
  "type": "extension_ui_request",
  "id": "<uuid>",
  "method": "select",
  "title": "\u0000XYZ_ASK_USER",
  "options": ["{\"questions\":[...],\"allowCancel\":true}"]
}
```

父进程识别规则：`method === "select"` **且** `title === "\0XYZ_ASK_USER"` → 解析 `JSON.parse(options[0])` 得到 `{questions, allowCancel}` payload。普通 select（非 ask_user）的 title 不是这个 marker，走另一条路。

### 2.3 `extension_ui_response`（父进程 stdin → 子进程）

来源：`rpc-types.ts:259-263` + `rpc-mode.ts:142-150`（`pendingExtensionRequests` resolve 逻辑）。

**三种合法形状**（不是 JSON-RPC 2.0 的 `{result, error}`）：

```json
{ "type": "extension_ui_response", "id": "<uuid>", "value": "<string>" }     // select/input/editor
{ "type": "extension_ui_response", "id": "<uuid>", "confirmed": true|false }  // confirm
{ "type": "extension_ui_response", "id": "<uuid>", "cancelled": true }        // 取消
```

Pi 的 `createDialogPromise` 按 method 解析 response（rpc-mode.ts line ~100-120）：
- select/input/editor：`cancelled ? undefined : value`
- confirm：`cancelled ? false : confirmed`

ask_user 的 response value 是 `JSON.stringify(AskUserAnswers)` 字符串，子进程 `askUserInteract` 再 `JSON.parse`。

### 2.4 RPC command `response`（注意：与 ui_response 不同）

命令响应（如 `get_state`、`prompt`）是 `{id?, type: "response", command: string, success: boolean, data?/error?}`（rpc-types.ts:120-220）——**也不是 JSON-RPC 2.0**。当前 `spawn-event-adapter.ts:75-85` 的 `isRpcResponse` 期望 `jsonrpc === "2.0"`，同样错配，但本 topic 范围只管 extension_ui_request/response。

---

## 三、修复方案：4 类测试 + 1 个现有测试修复

### 概览

| ID | 文件 | 层级 | 依赖真实 Pi？ | 覆盖什么 |
|----|------|------|--------------|---------|
| TC-E2 | `spawn-event-adapter-rpc.test.ts` | unit (mock) | 否 | parseSpawnLine 对 Pi 原生格式的分类 |
| TC-E3 | `handle-ui-request-dispatch.test.ts` | unit (mock) | 否 | handleUiRequest 的 method 分发 + response 形状 |
| TC-E4 | `handler-injection-e2e.test.ts` | integration (fake child) | 否 | parseSpawnLine → queue → handler → stdin 全链路 |
| TC-E5 | `real-subagent-askuser.test.ts` | e2e (real spawn) | **是** | 真 pi 子进程端到端 |
| TC-W2-fix | 修改 `ui-request-handler.test.ts` | unit (mock) | 否 | 用 Pi 原生格式替换 JSON-RPC 2.0 mock |

所有测试位置：`extensions/subagent-workflow/src/execution/__tests__/`。

详细设计见下方各节。

---

## 四、TC-E2：parseSpawnLine 解析 Pi 原生格式（unit test）

**文件**：`extensions/subagent-workflow/src/execution/__tests__/spawn-event-adapter-rpc.test.ts`（新增）

**目的**：用 Pi 真实输出样例验证 `parseSpawnLine` 的分类正确性。这是「协议契约测试」——Pi rpc-mode.ts 怎么 output，这里就怎么喂。

### 4.1 测试数据来源

优先级（选第一个可行的）：

1. **从 pi-mono 源码手工构造**（最稳，不依赖运行时）：直接按 `rpc-mode.ts` 的 `createExtensionUIContext` 各方法 `output({...})` 的字段逐字构造。本节下方给出全部样例。
2. **真 pi 触发截取**（最真实，但需本地有 pi）：`pi --mode rpc` 启动后喂一个调 `ctx.ui.select(...)` 的扩展，`head -n 20` 截 stdout。作为可选补充，不作为测试主数据源（依赖环境）。

### 4.2 样例（Pi 原生格式，逐 method）

```ts
// 共有字段
const base = { type: "extension_ui_request", id: "11111111-2222-3333-4444-555555555555" };

const samples = {
  select:        { ...base, method: "select", title: "Pick one", options: ["A","B","C"], timeout: 30000 },
  selectAskUser: { ...base, method: "select", title: "\u0000XYZ_ASK_USER",
                   options: [JSON.stringify({questions:[{question:"q",options:[{label:"a"}]}], allowCancel:true})] },
  confirm:       { ...base, method: "confirm", title: "Sure?", message: "Delete file?", timeout: 30000 },
  input:         { ...base, method: "input", title: "Name", placeholder: "enter name" },
  editor:        { ...base, method: "editor", title: "Edit", prefill: "initial text" },
  notify:        { ...base, method: "notify", message: "done", notifyType: "info" },
  setStatus:     { ...base, method: "setStatus", statusKey: "build", statusText: "running" },
  setWidget:     { ...base, method: "setWidget", widgetKey: "progress",
                   widgetLines: ["50%"], widgetPlacement: "belowEditor" },
  setTitle:      { ...base, method: "setTitle", title: "My Session" },
  setEditorText: { ...base, method: "set_editor_text", text: "hello" },
};
```

### 4.3 测试用例（每 method 至少一个，共 ~12 case）

```ts
describe("TC-E2: parseSpawnLine 解析 Pi 原生 extension_ui_request", () => {
  // 每个 method 一个 case：验证 kind + method + 关键字段平铺提取
  it.each([
    ["select",        samples.select,        { method:"select", title:"Pick one" }],
    ["select(ask_user)", samples.selectAskUser, { method:"select", title:"\u0000XYZ_ASK_USER" }],
    ["confirm",       samples.confirm,       { method:"confirm", title:"Sure?", message:"Delete file?" }],
    ["input",         samples.input,         { method:"input", placeholder:"enter name" }],
    ["editor",        samples.editor,        { method:"editor", prefill:"initial text" }],
    ["notify",        samples.notify,        { method:"notify", notifyType:"info" }],
    ["setStatus",     samples.setStatus,     { method:"setStatus", statusKey:"build" }],
    ["setWidget",     samples.setWidget,     { method:"setWidget", widgetKey:"progress" }],
    ["setTitle",      samples.setTitle,      { method:"setTitle" }],
    ["set_editor_text", samples.setEditorText, { method:"set_editor_text", text:"hello" }],
  ])("%s → kind=extension_ui_request + 平铺字段", (_name, line, expectFields) => {
    const r = parseSpawnLine(JSON.stringify(line));
    expect(r?.kind).toBe("extension_ui_request");
    // 修复后接口假设：method/title/options 平铺在 result 上（不在 params 嵌套）
    if (r?.kind === "extension_ui_request") {
      expect(r.method).toBe(expectFields.method);
      Object.entries(expectFields).forEach(([k,v]) => {
        if (k !== "method") expect((r as any)[k]).toBe(v);
      });
    }
  });

  it("select options 是 string[]（不是 params 对象）", () => {
    const r = parseSpawnLine(JSON.stringify(samples.select));
    if (r?.kind === "extension_ui_request") {
      expect(r.options).toEqual(["A","B","C"]);  // 不是 {options:...} 嵌在 params
    }
  });

  it("id 被提取（response 关联用）", () => {
    const r = parseSpawnLine(JSON.stringify(samples.confirm));
    if (r?.kind === "extension_ui_request") expect(r.id).toBe(base.id);
  });

  it("不带 type:extension_ui_request 的纯 select 不被误判", () => {
    // 防御：只看 method不看 type 会误判普通 event
    const r = parseSpawnLine(JSON.stringify({ type: "tool_execution_start", method: "select" }));
    expect(r?.kind).not.toBe("extension_ui_request");
  });
});
```

### 4.4 依赖的修复后接口（subagent 1 提供）

`ParsedSpawnLine` 的 `extension_ui_request` 分支必须从：

```ts
{ kind: "extension_ui_request"; id: string; params: Record<string, unknown> }
```

改为（字段平铺）：

```ts
{ kind: "extension_ui_request"; id: string; method: string; title?: string;
  options?: string[]; message?: string; placeholder?: string; prefill?: string;
  notifyType?: string; statusKey?: string; statusText?: string;
  widgetKey?: string; widgetLines?: string[]; widgetPlacement?: string;
  text?: string; timeout?: number; raw: Record<string, unknown> }
```

`isExtensionUiRequest` 守卫改为：`obj.type === "extension_ui_request"` + `typeof obj.id === "string"` + `typeof obj.method === "string"`（去掉 `jsonrpc`/`params` 要求）。保留 `raw` 字段存原始对象，method 专属字段由 handleUiRequest 按需读取。

---

## 五、TC-E3：handleUiRequest method 分发（unit test）

**文件**：`extensions/subagent-workflow/src/execution/__tests__/handle-ui-request-dispatch.test.ts`（新增）

**目的**：验证 `handleUiRequest` 按 `method` 走不同 handler 入口，并按 method 生成正确的 `extension_ui_response` 形状写回 stdin。

### 5.1 依赖的修复后接口（subagent 1 + 2 共同提供）

`SessionRunnerContext.uiRequestHandler` 签名必须从「只处理 ask_user」泛化为「按 method 分发」：

```ts
// 修复后：单一 handler 接收完整请求上下文，内部按 method 路由
uiRequestHandler?: (req: UiRequest) => Promise<UiResponse>;

interface UiRequest {
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify"
        | "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
  title?: string; options?: string[]; message?: string;
  placeholder?: string; prefill?: string; /* ...各 method 字段 */
  isAskUser: boolean;          // title === ASK_USER_MARKER 时 true
  askUserPayload?: { questions: AskUserQuestion[]; allowCancel: boolean };
}

type UiResponse =
  | { value: string }          // select/input/editor → 回写 {type:extension_ui_response, id, value}
  | { confirmed: boolean }     // confirm → 回写 {..., confirmed}
  | { cancelled: true }        // 取消 → 回写 {..., cancelled:true}
  | { ack: true };             // notify/setStatus/setWidget/setTitle/set_editor_text → 不回写（fire-and-forget）
```

**关键设计**：`handleUiRequest` 内部按 method 调 handler，handler 返回 `UiResponse` 后，`handleUiRequest` 负责按 method 包装成 Pi 期望的 `extension_ui_response` 形状写 stdin。这样 handler 实现方（index.ts / xyz-agent）只需关心业务语义，不用管 RPC 编码。

### 5.2 mock 策略

```ts
// 复用 ui-request-queue.test.ts 的 makeFakeChild（PassThrough stdin）
const stdinWrites: string[] = [];
const child = makeFakeChild();
child.stdin.on("data", (d) => stdinWrites.push(d.toString()));

const handler = vi.fn(async (req: UiRequest): Promise<UiResponse> => {
  if (req.method === "select" && req.isAskUser) {
    return { value: JSON.stringify({ "q": "a" }) };  // ask_user answers JSON
  }
  if (req.method === "select") return { value: "A" };
  if (req.method === "confirm") return { confirmed: true };
  if (req.method === "input") return { value: "hello" };
  if (req.method === "notify") return { ack: true };
  throw new Error("unexpected");
});

const ctx = { uiRequestHandler: handler } as SessionRunnerContext;
```

### 5.3 测试用例

```ts
describe("TC-E3: handleUiRequest method 分发", () => {
  it("ask_user select（title=ASK_USER_MARKER）→ isAskUser=true，调 handler，stdin 收 value response", async () => {
    await handleUiRequest(child, "id-1", parseSelectAskUserLine(), ctx);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      method: "select", isAskUser: true,
      askUserPayload: { questions: expect.any(Array), allowCancel: true },
    }));
    const written = stdinWrites.join("");
    expect(written).toContain('"type":"extension_ui_response"');
    expect(written).toContain('"id":"id-1"');
    expect(written).toContain('"value":"');
    // 不是 JSON-RPC 2.0
    expect(written).not.toContain('"jsonrpc"');
    expect(written).not.toContain('"result"');
  });

  it("普通 select（非 ask_user title）→ isAskUser=false，仍调 handler", async () => {
    await handleUiRequest(child, "id-2", parseSelectPlainLine("Pick", ["A","B"]), ctx);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      method: "select", isAskUser: false, askUserPayload: undefined,
    }));
  });

  it("confirm → stdin 收 {confirmed: true}，非 {value}", async () => {
    await handleUiRequest(child, "id-3", parseConfirmLine(), ctx);
    const written = stdinWrites.join("");
    expect(written).toContain('"confirmed":true');
    expect(written).not.toContain('"value"');
  });

  it("input → stdin 收 {value: 'hello'}", async () => {
    await handleUiRequest(child, "id-4", parseInputLine(), ctx);
    expect(stdinWrites.join("")).toContain('"value":"hello"');
  });

  it("notify → fire-and-forget，stdin 无写入（Pi 不等 response）", async () => {
    await handleUiRequest(child, "id-5", parseNotifyLine(), ctx);
    expect(stdinWrites).toHaveLength(0);
    expect(handler).toHaveBeenCalled();
  });

  it("handler reject → stdin 写 cancelled（不是 error 对象）", async () => {
    handler.mockRejectedValueOnce(new Error("user closed"));
    await handleUiRequest(child, "id-6", parseSelectPlainLine("x",["y"]), ctx);
    // Pi createDialogPromise 对非预期 response 走默认 resolve(undefined)
    // 最安全是回 cancelled（让 select 返回 undefined）
    expect(stdinWrites.join("")).toContain('"cancelled":true');
  });

  it("uiRequestHandler 未设置（undefined）→ 静默忽略，不崩", async () => {
    const ctxNoHandler = { uiRequestHandler: undefined } as SessionRunnerContext;
    await expect(handleUiRequest(child, "id-7", parseSelectPlainLine("x",["y"]), ctxNoHandler))
      .resolves.toBeUndefined();
    expect(stdinWrites).toHaveLength(0);
  });
});
```

### 5.4 覆盖场景小结

- ✅ ask_user 路径（marker 识别）正向
- ✅ 普通 select 不误入 ask_user
- ✅ confirm/input/editor 的 response 形状各不同
- ✅ notify/setStatus 等 fire-and-forget 不回写
- ✅ handler 缺失的降级（呼应 TC-E4 暴露的注入 bug）
- ✅ 错误路径回 cancelled 而非 JSON-RPC error

---

## 六、TC-E4：handler 注入完整链路（integration, fake child）

**文件**：`extensions/subagent-workflow/src/execution/__tests__/handler-injection-e2e.test.ts`（新增）

**目的**：验证 `parseSpawnLine → createUiRequestQueue → handleUiRequest → child.stdin` 完整链路在 Pi 原生格式的 fake child 上端到端跑通。这是「不 spawn 真 pi 的最强测试」——mock 掉 `child_process.spawn` 返回 FakeChild，由测试驱动 stdout 写入 Pi 原生 JSON 行。

### 6.1 为什么单独立一个测试

TC-E2/E3 只测单个函数。但 bug 常出在接线处：
- `runSpawn` 的 stdout pump（`session-runner.ts:799` `parseSpawnLine`）是否把 `extension_ui_request` 分支的 `parsed.id` / `parsed.params` 正确传给 `enqueueUiRequest`
- 修复后 `parsed` 字段从 `params` 改为平铺，`enqueueUiRequest(id, parsed)` 的传参是否同步改
- 队列 FIFO + handler resolve → stdin 写入时序

### 6.2 mock 策略（复用 run-spawn-integration.test.ts 的成熟模式）

直接 copy `run-spawn-integration.test.ts:21-96` 的 mock 骨架：
- `vi.mock("node:child_process")` → FakeChild（EventEmitter + 3 个 PassThrough）
- `vi.mock("node:fs")` → 同步方法 mock
- `vi.mock("../alive-store.ts")` → mock writeAliveMarker
- `vi.mock("../temp-prompt.ts")` → mock writePromptToTempFile

**新增**：注入真实 `uiRequestHandler`（不是 mock，是测试内定义的可断言 handler）。

```ts
const handlerCalls: UiRequest[] = [];
const ctx: SessionRunnerContext = {
  ...baseCtx,
  uiRequestHandler: async (req) => {
    handlerCalls.push(req);
    if (req.isAskUser) return { value: JSON.stringify({ "Which lib?": "Vue" }) };
    return { value: "default" };
  },
};
```

### 6.3 测试用例

```ts
describe("TC-E4: handler 注入完整链路（Pi 原生格式）", () => {
  it("ask_user 全链路：stdout 写 select(marker) → handler 被调 → stdin 收 extension_ui_response(value)", async () => {
    const child = await runSpawnWithCtx(ctx, opts);
    // 1. 模拟 Pi 子进程发 ask_user select
    child.stdout.write(JSON.stringify({
      type: "extension_ui_request", id: "uuid-1", method: "select",
      title: "\u0000XYZ_ASK_USER",
      options: [JSON.stringify({questions:[{question:"Which lib?",options:[{label:"Vue"},{label:"React"}]}],allowCancel:true})],
    }) + "\n");

    // 2. 等 handler 被调（handler 是异步的，stdin 写入在 handler resolve 后）
    await vi.waitFor(() => expect(handlerCalls).toHaveLength(1));
    expect(handlerCalls[0].method).toBe("select");
    expect(handlerCalls[0].isAskUser).toBe(true);
    expect(handlerCalls[0].askUserPayload?.questions[0].question).toBe("Which lib?");

    // 3. stdin 收到 Pi 原生 response（不是 JSON-RPC）
    await vi.waitFor(() => expect(child.stdinWrites.some(l => l.includes('"id":"uuid-1"'))).toBe(true));
    const respLine = child.stdinWrites.find(l => l.includes('"id":"uuid-1"'))!;
    expect(respLine).toContain('"type":"extension_ui_response"');
    expect(respLine).toContain('"value":"');
    expect(respLine).not.toContain('"jsonrpc"');
    expect(respLine).not.toContain('"result"');
    // value 是 AskUserAnswers JSON
    const resp = JSON.parse(respLine);
    expect(JSON.parse(resp.value)).toEqual({ "Which lib?": "Vue" });

    child.kill(); // 触发 close 收尾
  });

  it("多个 ui_request 按序排队（FIFO），前一个未 resolve 不发第二个", async () => {
    // 复用 ui-request-queue.test.ts 的可控 Promise 模式
    const child = await runSpawnWithCtx(ctx, opts);
    const order: string[] = [];
    let resolveFirst!: (v: UiResponse) => void;
    ctx.uiRequestHandler = vi.fn((req) => {
      order.push(req.id);
      if (req.id === "r1") return new Promise(r => { resolveFirst = r; });
      return Promise.resolve({ value: "ok" });
    });

    child.stdout.write(uiReqLine("r1", "select") + "\n");
    child.stdout.write(uiReqLine("r2", "confirm") + "\n");
    await vi.waitFor(() => expect(order).toEqual(["r1"]));
    expect(order).not.toContain("r2");

    resolveFirst({ value: "a1" });
    await vi.waitFor(() => expect(order).toEqual(["r1", "r2"]));
    child.kill();
  });

  it("子进程退出（close）→ pending handler 被 abort，不阻塞队列", async () => {
    const child = await runSpawnWithCtx(ctx, opts);
    let resolveHandler!: () => void;
    ctx.uiRequestHandler = vi.fn(() => new Promise(r => { resolveHandler = () => r({value:"x"}); }));
    child.stdout.write(uiReqLine("pending", "select") + "\n");
    await vi.waitFor(() => expect(ctx.uiRequestHandler).toHaveBeenCalled());

    child.emit("close", 0);   // 模拟子进程退出
    // 队列应清空，resolveHandler 即使不调也不泄漏（runSpawn 的 Promise 已 resolved via close）
    resolveHandler();
    await expect(Promise.race([runSpawnPromise, Promise.reject("should not leak")]))
      .resolves.toBeDefined();
  });

  it("handler 缺失（uiRequestHandler=undefined）→ stdout 的 ui_request 被吞，不崩（暴露 index.ts:209 bug）", async () => {
    // 这个测试刻意不注入 handler，模拟当前 index.ts:209 的生产行为
    const ctxNoHandler = { ...baseCtx, uiRequestHandler: undefined };
    const child = await runSpawnWithCtx(ctxNoHandler, opts);
    child.stdout.write(uiReqLine("orphan", "select") + "\n");

    // 等一会让 pump 处理完
    await new Promise(r => setTimeout(r, 50));
    expect(child.stdinWrites.some(l => l.includes("orphan"))).toBe(false);
    // 子进程会 hang（Pi 侧等 response 直到 timeout）——这正是 bug 的表现
    child.kill();
  });
});
```

### 6.4 关键辅助

```ts
// 包装 runSpawn 返回 fake child + stdin 收集器（run-spawn-integration.test.ts 已有同款）
async function runSpawnWithCtx(ctx, opts): Promise<FakeChild & { stdinWrites: string[] }> {
  const stdinWrites: string[] = [];
  const runP = runSpawn({...});
  const child = await waitForSpawn();  // 复用 run-spawn-integration.test.ts:131
  child.stdin.on("data", d => stdinWrites.push(d.toString()));
  // 不 await runP（子进程常驻），测试结束 child.kill()
  runP.catch(() => {});  // swallow，测试自己断言
  return Object.assign(child, { stdinWrites });
}
```

### 6.5 覆盖场景

- ✅ Pi 原生 select(ask_user) 端到端
- ✅ handler 返回值 → Pi 原生 extension_ui_response 编码
- ✅ FIFO 队列在真实 stdout pump 下工作
- ✅ 子进程 close 时 pending handler abort（防泄漏）
- ✅ **handler 缺失时的降级**（直接暴露 index.ts:209 的注入 bug——这个 case 在生产环境会 hang，测试明确记录预期行为）

---

## 七、TC-E5：真集成测试（替代 TC-E1 placeholder）

**文件**：`extensions/subagent-workflow/src/execution/__tests__/real-subagent-askuser.test.ts`（新增）

**目的**：用真实 `pi --mode rpc` 子进程验证整条链路。CI 默认跳过，本地或 `PI_INTEGRATION=1` 环境跑。

### 7.1 标记与跳过机制

```ts
const RUN_REAL = process.env.PI_INTEGRATION === "1";
const describeOrSkip = RUN_REAL ? describe : describe.skip;

describeOrSkip("TC-E5: 真 pi 子进程 ask_user 端到端", () => { ... });
```

CI 配置：`.github/workflows/ci.yml` 增加一个 job `integration-pi`，`env: PI_INTEGRATION: 1`，只在有 pi 二进制的环境跑（或 `if: contains(github.event.head_commit.message, '[run-integration]')` 按需触发）。

### 7.2 怎么驱动 subagent 调 ask_user（关键决策）

**方案对比**：

| 方案 | 实现 | 可靠性 | 复杂度 |
|------|------|--------|--------|
| A. 真 LLM + ask_user system prompt | spawn 真 pi，task 写「请调 ask_user 问 X」 | 低（LLM 不一定调） | 低 |
| B. mock LLM provider（拦截 HTTP） | 启 pi 时 `--model mock://always-ask-user`，mock provider 固定返回 ask_user tool_call | 高 | 中 |
| C. 自定义 agent + 假 task | 用 `general-purpose` agent，task 直接是 `Call the ask_user tool with question "Test?"` | 中（依赖 LLM 遵从） | 低 |
| **D. 本地 mock pi 子进程脚本** | 写一个 50 行 node 脚本模拟 pi：读 stdin，立即 echo 一行 ask_user 的 extension_ui_request，等 response 后 echo turn_end 退出 | **最高** | **低** |

**推荐 D**（短期）+ B（长期）：

- **D 的价值**：完全不依赖 LLM 和 pi 二进制的版本，验证的是「父进程（subagent-workflow）对 Pi RPC 协议的处理是否正确」。脚本写死 `ctx.ui.select(ASK_USER_MARKER, [...])` 触发的确切 stdout，就是 rpc-mode.ts 会发的格式。这把「pi 是否正确实现了 RPC」和「我们是否正确处理了 RPC」解耦——前者是 pi 团队的责任，后者才是本仓库的责任。
- **B 的价值**：端到端验证真 pi 的 RPC 实现与我们对接的一致性。但需要 mock LLM provider（pi 支持的 mock provider 配置），复杂度高，作为可选增强。
- **不推荐 A/C**：LLM 行为不确定，测试会 flaky。

**方案 D 的 mock-pi 脚本**（放在 `extensions/subagent-workflow/src/execution/__tests__/fixtures/mock-pi-rpc.ts`）：

```ts
// 模拟 pi --mode rpc 的最小行为：
// 1. stdout 写 session header
// 2. 立即触发一次 ask_user（写 extension_ui_request select with ASK_USER_MARKER）
// 3. 等 stdin 的 extension_ui_response
// 4. 收到后写 message_end + turn_end
// 5. exit 0
import * as readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
// 1. header
process.stdout.write(JSON.stringify({
  type: "session", id: "mock-sess-1", timestamp: new Date().toISOString(), cwd: process.cwd(),
}) + "\n");
// 2. ask_user request
const askUserPayload = JSON.stringify({
  questions: [{ question: "Pick option", options: [{ label: "A" }, { label: "B" }] }],
  allowCancel: true,
});
process.stdout.write(JSON.stringify({
  type: "extension_ui_request", id: "ui-mock-1", method: "select",
  title: "\u0000XYZ_ASK_USER", options: [askUserPayload],
}) + "\n");
// 3-5. 等 response
rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.type === "extension_ui_response" && msg.id === "ui-mock-1") {
      // 收到 response，写结束事件
      process.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant" } }) + "\n");
      process.stdout.write(JSON.stringify({ type: "turn_end" }) + "\n");
      process.exit(0);
    }
    // 忽略其他 stdin 消息（如 prompt）
  } catch { /* ignore */ }
});
```

### 7.3 测试用例（方案 D）

```ts
describeOrSkip("TC-E5: 真 pi 子进程 ask_user 端到端", () => {
  it("mock-pi 发 ask_user → 父进程 handler 响应 → mock-pi 收到 response 退出", async () => {
    const handler = vi.fn(async (req: UiRequest) => {
      expect(req.method).toBe("select");
      expect(req.isAskUser).toBe(true);
      return { value: JSON.stringify({ "Pick option": "A" }) };
    });

    // runSpawn 但把 pi 命令换成 mock 脚本
    const result = await runRealSpawn({
      command: "node",
      args: [mockPiScriptPath, "--mode", "rpc"],
      ctx: { ...baseCtx, uiRequestHandler: handler },
      task: "test",
      timeoutMs: 5000,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(result.exitCode).toBe(0);
    // mock-pi 收到 response 才会 exit 0（否则会因 stdin EOF 触发 shutdown）
  }, 10000);

  it("真 pi 二进制（如果可用）：ask_user 全链路", async () => {
    const piBin = process.env.PI_BIN ?? "pi";
    const handler = vi.fn(async (req) => ({ value: JSON.stringify({ "q": "a" }) }));
    const result = await runRealSpawn({
      command: piBin,
      args: ["--mode", "rpc", "-p", "--session-dir", tmpSessionDir, "Call ask_user with question q and option a"],
      ctx: { ...baseCtx, uiRequestHandler: handler },
      task: "...",
      timeoutMs: 30000,
    });
    expect(handler).toHaveBeenCalled();
    expect(result.exitCode).toBe(0);
  }, 45000);  // 真 LLM 慢，给足时间
});
```

### 7.4 测试隔离

- **session-dir**：每个 case 用 `fs.mkdtempSync(path.join(os.tmpdir(), "pi-int-"))`，afterEach `fs.rmSync(..., {recursive:true})`
- **timeout**：mock-pi 用例 5s，真 pi 用例 30-45s（LLM 慢）
- **并发**：`describe.serial`（避免多 case 同时 spawn 抢端口/文件）
- **不依赖网络**：方案 D 完全离线；方案 B（mock provider）也离线；只有「真 LLM」用例需要网络，单独标 `RUN_REAL_LLM`

### 7.5 覆盖场景

- ✅ mock-pi 路径：协议对接正确性（无 LLM 依赖，CI 可跑）
- ✅ 真 pi 路径（可选）：端到端含 Pi 实现验证
- ✅ exitCode 验证（response 收不到子进程会 hang → timeout → 非 0 退出）

---

## 八、修复 TC-W2：用 Pi 原生格式替换 JSON-RPC 2.0 mock

**文件**：`extensions/subagent-workflow/src/execution/__tests__/ui-request-handler.test.ts`（修改，非新增）

### 8.1 改动（line 14-29 的 askUserRequest 常量）

**删除**：
```js
const askUserRequest = JSON.stringify({
  jsonrpc: "2.0",
  id: "ui-req-001",
  method: "extension_ui_request",
  params: { marker: "ASK_USER", questions: [...], context: "...", timeout: 30000 },
});
```

**替换为**（Pi 原生 ask_user select 编码）：
```js
const ASK_USER_MARKER = "\u0000XYZ_ASK_USER";
const askUserQuestions = [
  { question: "What is your preference?", options: [{ label: "Option A" }, { label: "Option B" }] },
];
const askUserRequest = JSON.stringify({
  type: "extension_ui_request",
  id: "ui-req-001",
  method: "select",
  title: ASK_USER_MARKER,
  options: [JSON.stringify({ questions: askUserQuestions, allowCancel: true })],
});
```

### 8.2 断言更新（line 31-60 的 expect 块）

```js
it("extension_ui_request 被识别为 extension_ui_request kind", () => {
  const result = parseSpawnLine(askUserRequest);
  expect(result?.kind).toBe("extension_ui_request");
});

it("method=select 被正确提取", () => {
  const result = parseSpawnLine(askUserRequest);
  if (result?.kind === "extension_ui_request") {
    expect(result.method).toBe("select");           // ← 改：原 expect params.marker
  }
});

it("title === ASK_USER_MARKER 标识 ask_user", () => {
  const result = parseSpawnLine(askUserRequest);
  if (result?.kind === "extension_ui_request") {
    expect(result.title).toBe(ASK_USER_MARKER);     // ← 新增
  }
});

it("ask_user payload 从 options[0] 解析（questions 被正确提取）", () => {
  const result = parseSpawnLine(askUserRequest);
  if (result?.kind === "extension_ui_request" && result.options) {
    const payload = JSON.parse(result.options[0]);  // ← 改：从 options[0] 解析
    expect(payload.questions).toHaveLength(1);
    expect(payload.questions[0].question).toBe("What is your preference?");
    expect(payload.questions[0].options).toHaveLength(2);
    expect(payload.allowCancel).toBe(true);
  }
});

it("id 被正确提取", () => {
  const result = parseSpawnLine(askUserRequest);
  if (result?.kind === "extension_ui_request") expect(result.id).toBe("ui-req-001");
});

// 删除：context 被正确提取（Pi select 消息无 context 字段，context 在 ask_user payload 内）
```

### 8.3 删除的断言

原 `"context 被正确提取"` 测试（line 52-58）删除——Pi 的 `extension_ui_request` 消息本身**没有 context 字段**，context（如果需要）在 ask_user payload 的 `questions[i].context` 内（AskUserQuestion 类型字段）。这个字段原本就是凭空发明的。

### 8.4 保留的断言

W4 的 `ASK_USER_RPC_PROMPT` 相关测试（line 64-95）保留不动——那部分是系统提示词注入，与 RPC 格式无关，且测试本身合理。

---

## 九、关键决策点

### 9.1 为什么 TC-E5 推荐 mock-pi 脚本（方案 D）而非高级 mock

- **职责边界**：本仓库的责任是「正确处理 Pi 发出的 RPC 协议」，不是「Pi 是否正确实现 RPC」。mock-pi 脚本固定输出 Pi rpc-mode.ts 的确切格式，把这两个责任解耦——pi 协议变了我们改脚本（单点维护），pi 协议没变但我们的处理错了，测试照样红。
- **可重复性**：mock-pi 无 LLM、无网络、无文件系统副作用（除 session-dir），跑 100 次结果一致。真 LLM 会因模型版本/采样温度 flaky。
- **速度**：mock-pi 用例 <1s，真 LLM 用例 10-30s。CI 默认跑前者，后者按需触发。
- **高级 mock（方案 B 拦截 HTTP）的问题**：pi 的 LLM 调用走 `@earendil-works/pi-ai`，mock provider 需要深入 pi 的 provider 注册机制，侵入性强且随 pi 版本变化。投入产出比低于 mock-pi 脚本。

**真 pi 二进制用例（7.3 第二个 case）保留**，但标记为「可选增强」，依赖 `PI_BIN` 环境变量存在。它的价值是抓 pi 团队改协议没通知我们的情况，频率低，按需跑即可。

### 9.2 怎么驱动 subagent 调 ask_user

见 7.2 方案对比。核心结论：**不依赖 LLM 自主决策**。要么用 mock-pi 脚本绕过 LLM（方案 D），要么用 mock provider 固定返回 tool_call（方案 B）。让 LLM「自己决定调 ask_user」的测试是 flaky 测试，不可接受。

### 9.3 测试隔离策略

| 维度 | 策略 |
|------|------|
| 文件系统 | 每个 case 独立 `mkdtempSync` 的 session-dir + worktree，afterEach `rmSync` |
| 进程 | FakeChild 测试用 `child.kill()` + `child.emit("close")` 显式收尾；真进程测试用 `AbortController` + timeout 双保险 |
| 模块状态 | `branchCache`（session-runner.ts 模块级 Map）在 run-spawn-integration.test.ts 已有清理模式，复用 |
| 并发 | 真集成用 `describe.serial`；unit/mock 测试可并行 |
| stdin/stdout | PassThrough 自带隔离，但注意 FakeChild 不 unref 会挂 event loop——afterEach 显式 destroy |

### 9.4 测试速度权衡

| 测试 | 预期耗时 | 频率 |
|------|---------|------|
| TC-E2 (12 case) | <100ms | 每次 commit |
| TC-E3 (7 case) | <200ms | 每次 commit |
| TC-E4 (4 case) | <500ms | 每次 commit |
| TC-E5 mock-pi (1 case) | <1s | 每次 commit（CI 默认开） |
| TC-E5 真 pi (1 case) | 10-30s | 按需（PI_INTEGRATION=1） |

总增量：常规 CI +2s 以内，可接受。

---

## 十、风险点

### 10.1 真 pi 进程的 CI 环境依赖（中风险）

- **问题**：`pi` 二进制未必在 CI runner 上可用；不同 pi 版本的 RPC 协议可能有细微差异
- **缓解**：mock-pi 脚本（方案 D）作为 CI 主路径，不依赖 pi 二进制；真 pi 用例用 `PI_BIN` env 显式指定路径，缺失则 `describe.skip`
- **残留风险**：pi 团队改协议没通知，mock-pi 脚本没同步更新 → CI 绿但生产挂。缓解：真 pi 用例每周/每发版跑一次（scheduled CI job）

### 10.2 mock LLM 实现复杂度（低风险，方案 B 才有）

- **问题**：pi 的 mock provider 配置文档不全，可能需要读 pi 源码逆向
- **缓解**：方案 B 是「可选增强」，不阻塞主路径。先用方案 D 覆盖协议对接，方案 B 等有需要再补
- **残留**：方案 B 缺失意味着「真 pi 的 RPC 实现是否与我们对接一致」只在手动测试时验证

### 10.3 测试运行时间（低风险）

- 见 9.4，常规 CI 增量 <2s。真 pi 用例按需触发，不拖慢主流程

### 10.4 测试可重复性（中风险）

- **FakeChild 测试**：高度可重复（纯内存，无 IO）
- **mock-pi 脚本**：可重复（子进程行为确定性）
- **真 pi 用例**：LLM 采样导致 tool_call 参数/时机不确定 → 可能 flaky。缓解：断言只验证「handler 被调过 + exitCode=0」，不验证具体调用次数/参数顺序；超时给足（45s）

### 10.5 Pi 协议版本演进（长期风险）

- Pi 的 `RpcExtensionUIRequest` 类型（rpc-types.ts:230）可能新增 method 或字段
- **缓解**：TC-E2 的样例集中维护（一个 fixtures 文件），pi 升版时单点更新；TC-E5 mock-pi 脚本是协议快照，pi 改了会立刻在「真 pi 用例」暴露

---

## 十一、代码变更清单

| 文件 | 函数/区域 | 改动类型 | 说明 |
|------|----------|---------|------|
| `__tests__/spawn-event-adapter-rpc.test.ts` | 整个文件 | **新增** | TC-E2，~120 行 |
| `__tests__/handle-ui-request-dispatch.test.ts` | 整个文件 | **新增** | TC-E3，~150 行 |
| `__tests__/handler-injection-e2e.test.ts` | 整个文件 | **新增** | TC-E4，~200 行 |
| `__tests__/real-subagent-askuser.test.ts` | 整个文件 | **新增** | TC-E5，~120 行 |
| `__tests__/fixtures/mock-pi-rpc.ts` | 整个文件 | **新增** | TC-E5 的 mock-pi 脚本，~40 行 |
| `__tests__/ui-request-handler.test.ts` | line 14-29 askUserRequest 常量 | **修改** | TC-W2-fix：JSON-RPC 2.0 → Pi 原生格式 |
| `__tests__/ui-request-handler.test.ts` | line 31-60 expect 块 | **修改** | 断言适配新格式（method/title/options[0]） |
| `__tests__/ui-request-handler.test.ts` | line 52-58 context 断言 | **删除** | Pi select 消息无 context 字段 |
| `.xyz-harness/subagent-ask-user/test.json` | TC-E1 条目 | **修改** | 替换为 TC-E2~E5 四条；标注 layer/requiresScreenshot |
| `.xyz-harness/subagent-ask-user/screenshots/TC-E1.txt` | 整个文件 | **删除** | placeholder 作废 |

**不改**（subagent 1/2 的范围，本任务边界外）：
- `spawn-event-adapter.ts` 的 `parseSpawnLine` / `isExtensionUiRequest` / `isRpcResponse`（subagent 1）
- `session-runner.ts` 的 `handleUiRequest` / `ParsedSpawnLine` 消费 / `enqueueUiRequest` 传参（subagent 1）
- `session-runner.ts` 的 `uiRequestHandler` 签名 / `UiRequest`/`UiResponse` 类型（subagent 1）
- `subagent-service.ts` / `index.ts:209` 的 handler 注入（subagent 2）

---

## 十二、测试运行命令

```bash
# 新增测试单跑（开发期迭代）
pnpm --filter @zhushanwen/pi-subagent-workflow test -- \
  src/execution/__tests__/spawn-event-adapter-rpc.test.ts

pnpm --filter @zhushanwen/pi-subagent-workflow test -- \
  src/execution/__tests__/handle-ui-request-dispatch.test.ts

pnpm --filter @zhushanwen/pi-subagent-workflow test -- \
  src/execution/__tests__/handler-injection-e2e.test.ts

# mock-pi 用例（CI 默认开）
pnpm --filter @zhushanwen/pi-subagent-workflow test -- \
  src/execution/__tests__/real-subagent-askuser.test.ts

# 真 pi 集成（按需）
PI_INTEGRATION=1 PI_BIN=/path/to/pi \
  pnpm --filter @zhushanwen/pi-subagent-workflow test -- \
  src/execution/__tests__/real-subagent-askuser.test.ts

# 全量回归
pnpm --filter @zhushanwen/pi-subagent-workflow test

# typecheck（确保新测试文件类型正确）
pnpm --filter @zhushanwen/pi-subagent-workflow typecheck
```

### 断言示例（最关键的三条机器可验证断言）

```ts
// 1. Pi 原生格式不被当 invalid 丢弃（TC-E2 核心）
const r = parseSpawnLine(JSON.stringify({
  type: "extension_ui_request", id: "x", method: "select",
  title: "\u0000XYZ_ASK_USER", options: ["{}"],
}));
expect(r?.kind).toBe("extension_ui_request");   // 当前实现会 fail（被当 invalid）

// 2. stdin 写回的是 Pi 原生 response，不是 JSON-RPC（TC-E4 核心）
expect(stdinWritten).toContain('"type":"extension_ui_response"');
expect(stdinWritten).not.toContain('"jsonrpc"');   // 当前实现会 fail（写的是 jsonrpc）

// 3. handler 在生产链路被真的调用（TC-E4 暴露 index.ts:209 bug）
expect(handlerCalls).toHaveLength(1);   // 当前实现会 fail（handler 永远 undefined）
```

---

## 十三、与其他 subagent 的接口约定

本任务（subagent 3 = 测试设计）依赖 subagent 1（协议层修复）和 subagent 2（handler 注入）提供以下接口。**测试代码按这些约定写，subagent 1/2 的实现必须满足，否则测试全红。**

### 13.1 依赖 subagent 1（协议层修复）

**`ParsedSpawnLine` 的 `extension_ui_request` 分支形状**（`spawn-event-adapter.ts`）：

```ts
| { kind: "extension_ui_request"; id: string; method: string;
    title?: string; options?: string[]; message?: string;
    placeholder?: string; prefill?: string; notifyType?: string;
    statusKey?: string; statusText?: string | undefined;
    widgetKey?: string; widgetLines?: string[] | undefined; widgetPlacement?: string;
    text?: string; timeout?: number;
    raw: Record<string, unknown> }   // 原始对象兜底
```

关键字段：`method`、`title`、`options` 必须平铺（不能嵌在 `params` 里）。`raw` 保留原始对象供 method 专属字段扩展。

**`parseSpawnLine` 守卫规则**（`isExtensionUiRequest`）：
- 匹配条件：`obj.type === "extension_ui_request"` + `typeof obj.id === "string"` + `typeof obj.method === "string"`
- **去掉** `jsonrpc === "2.0"` 和 `params` 对象要求

**`handleUiRequest` 签名**（`session-runner.ts`）：
```ts
function handleUiRequest(
  child: ChildProcess,
  id: string,
  parsed: ParsedSpawnExtensionUiRequest,   // ← 改：不再是 Record<string,unknown> params
  ctx: SessionRunnerContext,
  signal?: AbortSignal,
): Promise<void>
```

**回写 stdin 的格式**（`handleUiRequest` 内部）：必须按 method 包装成 Pi 原生 `extension_ui_response`（见 2.3），**禁止** `{jsonrpc:"2.0", id, result/error}`。

**`SessionRunnerContext.uiRequestHandler` 签名**：
```ts
uiRequestHandler?: (req: UiRequest) => Promise<UiResponse>;
```
（`UiRequest`/`UiResponse` 定义见 5.1）

**`runSpawn` 的 stdout pump**（`session-runner.ts:826`）：传给 `enqueueUiRequest` 的第二参数从 `parsed.params` 改为整个 `parsed`（平铺对象）。

### 13.2 依赖 subagent 2（handler 注入）

**`index.ts:209` 必须注入 handler**：

```ts
// src/index.ts（subagent 2 修复后）
const service = existingService ?? new SubagentService({
  cwd,
  modelService,
  getMainSessionFile: getCachedMainSessionFile,
  uiRequestHandler: createUiRequestHandler(pi, ctx),  // ← 新增
});
```

`createUiRequestHandler` 的实现由 subagent 2 决定（典型：在 TUI 模式走 `ctx.ui.custom` 渲染 ask_user Component，在 RPC 模式转发到 xyz-agent sidecar）。测试只验证「handler 被注入且会被调用」，不验证 handler 内部如何呈现给用户（那是 UI 层的事）。

**TC-E4 的「handler 缺失」用例（6.3 第 4 个）是契约测试**：它刻意不注入 handler，断言「stdout 的 ui_request 被吞、子进程会 hang」。这个用例的存在是为了**在任何时候都有人改 index.ts 忘了注入 handler 时立刻红**。subagent 2 修复后这个用例的语义不变（它测的就是「没注入会怎样」），但它的存在保护 subagent 2 的修复不被后续重构回退。

### 13.3 执行顺序约定

```
subagent 1（协议层）─┐
                     ├─→ subagent 3（本测试设计）──→ 全绿 = 集成层验证通过
subagent 2（注入）──┘
```

- subagent 1/2 可并行（互不依赖）
- subagent 3 的测试在 1/2 合并前会全红（红是正常的，证明测试有效）
- subagent 3 的测试在 1/2 都合并后应全绿
- 若 subagent 3 的测试在 1/2 合并后仍红，说明 1 或 2 的修复不完整——测试就是仲裁
