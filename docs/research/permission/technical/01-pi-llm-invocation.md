# Pi Extension 直接调用 LLM 的机制

**调研日期**：2026-07-27 | **置信度**：高（pi-mono 源码逐行核实 + xyz-pi-extensions 现有扩展交叉验证）
**调研方式**：主 agent 亲自查 pi-mono fork 源码（`~/Code/git-fork/pi-mono-workspace/main/`）+ xyz-pi-extensions 现有实现

---

## 核心结论

**Pi 扩展可以直接调用 LLM，无需 spawn 子进程，无需走主对话循环。** 机制是 `@earendil-works/pi-ai` 的 `getApiProvider(api).streamSimple(model, context, options)`，同进程调用，继承主进程已注册的 provider 和 API key 配置。

pi-permission-system 的 AI Classifier 已用此机制验证可行。xyz-pi-extensions 项目内目前没有用此机制的扩展（vision 走 spawn 子进程），但 pi-permission-system（同生态）提供了完整范例。

---

## 1. API 契约（pi-mono 源码确认）

### 1.1 核心调用链

```typescript
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import type { Model, Context, SimpleStreamOptions, AssistantMessageEvent } from "@earendil-works/pi-ai";

// 1. 获取 provider（主进程已注册，扩展无需初始化）
const provider = getApiProvider(model.api);  // model.api 如 "openai-completions"
if (!provider) throw new Error(`No provider for ${model.api}`);

// 2. 构造 context（systemPrompt + messages，不传 tools 就是无工具调用）
const context: Context = {
  systemPrompt: "你是权限风险分类器，只返回 JSON...",
  messages: [{
    role: "user",
    content: [{ type: "text", text: "Tool: bash\nCommand: rm -rf /" }]
  }],
  // tools 不传 → 模型不能调工具，只能返回文本
};

// 3. 调 streamSimple，拿到事件流
const stream = provider.streamSimple(model, context, {
  temperature: 0,
  maxTokens: 256,
  signal: abortSignal,        // 可选，用于 race 时取消
  timeoutMs: 90_000,          // 90 秒超时
});

// 4. 消费流，累积文本
let fullText = "";
for await (const event of stream) {
  if (event.type === "text_delta" && event.delta) {
    fullText += event.delta;
  }
  // event.type 还可能是: "start" | "text_start" | "text_end" | "thinking_*" | "done" | "error"
}
```

### 1.2 关键类型定义（源码路径）

| 类型 | 定义位置 | 关键字段 |
|---|---|---|
| `getApiProvider` | `packages/ai/src/compat.ts:134` | `(api: Api) => ApiProviderInternal \| undefined` |
| `registerApiProvider` | `packages/ai/src/compat.ts:120` | 主进程在 `coding-agent/src/core/model-registry.ts:905` 调用，注册所有 builtin provider |
| `ProviderStreams` | `packages/ai/src/types.ts:222` | `stream(model, context, options)` + `streamSimple(model, context, options)` |
| `SimpleStreamOptions` | `packages/ai/src/types.ts:290` | extends `StreamOptions` + `reasoning?` + `thinkingBudgets?` |
| `StreamOptions` | `packages/ai/src/types.ts:109` | `temperature`, `maxTokens`, `signal`, `apiKey`, `timeoutMs`, `maxRetries`, `headers`, `env`, ... |
| `Context` | `packages/ai/src/types.ts:439` | `{ systemPrompt?: string; messages: Message[]; tools?: Tool[] }` |
| `AssistantMessageEvent` | `packages/ai/src/types.ts:453` | 联合类型，见下表 |
| `AssistantMessageEventStream` | `packages/ai/src/utils/event-stream.ts` | `extends EventStream<AssistantMessageEvent, AssistantMessage>`，有 `.result(): Promise<AssistantMessage>` |

### 1.3 事件协议（AssistantMessageEvent）

| event.type | 含义 | 关键字段 |
|---|---|---|
| `start` | 流开始 | `partial: AssistantMessage` |
| `text_start` | 文本块开始 | `contentIndex`, `partial` |
| `text_delta` | 文本增量 | `contentIndex`, `delta: string`, `partial` |
| `text_end` | 文本块结束 | `contentIndex`, `content: string`, `partial` |
| `thinking_start/delta/end` | 思考链（reasoning model） | 同 text_* |
| `toolcall_start/delta/end` | 工具调用（streamSimple 不传 tools 时不会出现） | `toolCall` |
| `done` | 成功结束 | `reason: "stop"\|"length"\|"toolUse"`, `message: AssistantMessage` |
| `error` | 失败/中止 | `reason: "aborted"\|"error"`, `error: AssistantMessage` |

**⚠️ 兼容性注意**：pi-permission-system 的 `ai-classifier.ts:168` 用的是 `event.type === "text"`，但当前 pi-ai 版本（0.75+）的事件名是 `text_delta`/`text_end`。这说明 pi-permission-system 的代码基于旧版 pi-ai，**移植时必须改成 `text_delta`**。可以用 `stream.result()` 拿最终 AssistantMessage 更简单（不用手动累积 delta）。

### 1.4 两种累积文本的方式

**方式 A：手动累积 delta（pi-permission-system 做法，适配旧版）**
```typescript
let text = "";
for await (const event of stream) {
  if (event.type === "text_delta" && event.delta) {  // 旧版是 "text"
    text += event.delta;  // 旧版是 event.text
  }
}
```

**方式 B：用 stream.result()（推荐，更简洁）**
```typescript
const finalMessage = await stream.result();  // Promise<AssistantMessage>
const text = finalMessage.content
  .filter(c => c.type === "text")
  .map(c => c.text)
  .join("");
```

方式 B 利用了 `AssistantMessageEventStream` 继承的 `.result()` 方法（`event-stream.ts`），它会等 `done`/`error` 事件返回最终 AssistantMessage。更简洁，且自动处理错误事件。

---

## 2. Model 解析（选哪个模型做 classifier）

### 2.1 从 models.json 读取（pi-permission-system 做法）

`src/models-json.ts` 的 `loadModelsJson()` + `findCheapestModel()`：
- 读 `~/.pi/agent/models.json`（Pi 的模型配置）
- `findCheapestModel` 按 `cost.input` 排序选最便宜的可用模型（有 API key 的）
- 返回 `{ modelId, provider, api }`

### 2.2 显式指定

`"provider/model-id"` 格式（如 `"zhipu/glm-4-flash"`），解析：
```typescript
const slashIdx = modelSpec.indexOf("/");
const provider = modelSpec.substring(0, slashIdx);
const modelId = modelSpec.substring(slashIdx + 1);
// 从 models.json 查 provider 的 api 类型
const api = modelsData.providers?.[provider]?.api ?? "openai-completions";
```

### 2.3 推荐：用最便宜的模型

Classifier 是风险判断，不需要强模型。推荐：
- `"auto"` → `findCheapestModel`（glm-4-flash / qwen-turbo 这类）
- temperature=0 确保确定性
- maxTokens=256 限制输出长度（JSON 输出够用）

---

## 3. 主进程 provider 注册时机（关键）

**问题**：扩展调 `getApiProvider(api)` 时，provider 是否已注册？

**答案**：**是的，主进程已注册**。

源码证据：`packages/coding-agent/src/core/model-registry.ts:905` 在主进程启动时会调 `registerApiProvider` 注册所有 builtin provider（anthropic/openai/google/... 共 9 个，见 `compat.ts:172-182` 的 `BUILTIN_APIS`）。

所以扩展运行时（在 `pi.on(...)` 回调里）调 `getApiProvider` 一定能拿到 provider，**无需扩展自己调 `registerBuiltInApiProviders()`**。

**注意**：`compat` 不在 pi-ai 的主 index 导出（`index.ts:5` 注释明确），必须从子路径 import：
```typescript
import { getApiProvider } from "@earendil-works/pi-ai/compat";
```

---

## 4. 包名澄清：`@earendil-works/pi-ai` vs `@mariozechner/pi-ai`

xyz-pi-extensions 里混用两个包名：
- `@earendil-works/pi-ai` — pi-mono 里的真实包名（`packages/ai/package.json` 的 `name`）
- `@mariozechner/pi-ai` — xyz-pi-extensions 里的 alias（workspace 映射或旧名）

**两者是同一个包**。新代码应统一用 `@earendil-works/pi-ai`（pi-mono 当前真实名）。pi-permission-system 也用 `@earendil-works/pi-ai`。

---

## 5. 与 spawn 子进程方式的对比

xyz-pi-extensions 的 vision 扩展用 spawn 子进程方式（`vision/src/spawn.ts`）：

| 维度 | 直接调 streamSimple | spawn pi 子进程 |
|---|---|---|
| **延迟** | 低（同进程，无进程启动开销） | 高（进程启动 + Pi 初始化） |
| **token 成本** | 低（只算 classifier 的 input/output） | 高（子进程加载完整 system prompt + 工具描述） |
| **上下文污染** | 无（独立 context，不进主对话） | 无（子进程独立 session） |
| **错误处理** | 直接 try/catch | 解析 stdout JSON 事件 |
| **取消机制** | `AbortController` + `signal` | `proc.kill(SIGTERM)` |
| **复杂度** | 低（~30 行核心代码） | 高（vision/spawn.ts 354 行） |
| **能否用主对话工具** | 否（不传 tools） | 是（子进程有自己的工具集） |
| **适合场景** | **轻量判断（classifier）** | 需要完整 agent 能力（vision 分析） |

**结论**：permission 的 AI Classifier **必须用直接调 streamSimple**，因为：
1. 不需要工具（只做风险判断，返回 JSON）
2. 省 token（~200 token system prompt vs 子进程的完整 system prompt）
3. 省延迟（同进程 vs 进程启动）
4. pi-permission-system 已验证可行

---

## 6. 现成参考代码

**pi-permission-system 的 `src/ai-classifier.ts`（331 行）** 是完整的直接调 LLM 范例，包含：
- `createClassifier(deps)` 工厂函数（依赖注入，便于测试）
- `createProductionClassifier(onLog?)` 生产环境工厂（用真实 pi-ai）
- `collectStreamText(stream, timeoutMs, signal)` 带超时和取消的流消费
- `resolveClassifierModel(modelSpec)` model 解析（auto 或显式）
- `parseClassifierResponse(raw)` JSON 解析 + 字段验证 + fallback

**移植到 Pi 时需改的点**：
1. `event.type === "text"` → `event.type === "text_delta"`（或改用 `stream.result()`）
2. `event.text` → `event.delta`（若用 delta 累积）
3. `require("@earendil-works/pi-ai")` 动态 require → 改为顶层 import（Pi 扩展用 ESM）

---

## Sources

pi-mono fork 源码（权威）：
- `~/Code/git-fork/pi-mono-workspace/main/packages/ai/src/types.ts`（StreamOptions:109, ProviderStreams:222, SimpleStreamOptions:290, Context:439, AssistantMessageEvent:453）
- `~/Code/git-fork/pi-mono-workspace/main/packages/ai/src/compat.ts`（getApiProvider:134, registerApiProvider:120, BUILTIN_APIS:172, registerBuiltInApiProviders:191）
- `~/Code/git-fork/pi-mono-workspace/main/packages/ai/src/utils/event-stream.ts`（EventStream.result(), AssistantMessageEventStream）
- `~/Code/git-fork/pi-mono-workspace/main/packages/ai/src/index.ts`（导出策略：compat 不在主 index）
- `~/Code/git-fork/pi-mono-workspace/main/packages/coding-agent/src/core/model-registry.ts:905`（主进程注册 provider）
- `~/Code/git-fork/pi-mono-workspace/main/packages/ai/package.json`（name: @earendil-works/pi-ai）

xyz-pi-extensions 现有扩展（交叉验证）：
- `extensions/vision/src/spawn.ts`（spawn 子进程方式的范例，对比用）
- `extensions/structured-output/src/index.ts`（走主对话 + 强制工具调用方式）
- `extensions/coding-workflow/package.json` + `extensions/evolve-daily/package.json`（依赖 @earendil-works/pi-ai / @mariozechner/pi-ai，但都不直接调 streamSimple）

pi-permission-system（同生态范例）：
- `~/GitApp/ai-agent/pi-permission-system/src/ai-classifier.ts`（331 行，完整直接调 LLM 范例）
- `~/GitApp/ai-agent/pi-permission-system/src/models-json.ts`（model 解析）
- `~/GitApp/ai-agent/pi-permission-system/package.json`（依赖 @earendil-works/pi-ai ^0.74.0 || ^0.75.0）
