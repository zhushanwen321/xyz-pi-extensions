---
verdict: pass
---

# Subagents Runtime + Workflow 进程内执行改造

## Background

当前 xyz-pi-extensions 的 workflow 扩展通过 `spawn("pi", ["--mode", "json"])` 子进程模式执行 agent。这带来三个问题：

1. **启动慢**：每次 agent 调用都 spawn 一个新 Pi 进程，包含完整的扩展加载、模型初始化
2. **无法实时控制**：子进程模式不支持 steer（注入消息到运行中的 agent）和优雅 abort
3. **资源浪费**：每个子进程独立加载扩展、独立初始化 SDK，无法复用主进程资源

Pi SDK 提供了 `createAgentSession()` API，可在当前进程内创建独立 session 执行 agent。tintinweb/pi-subagents 和 nicobailon/pi-subagents 均采用此方式。

本方案将 agent 执行能力从 workflow 中抽出，形成独立的运行时包（`@zhushanwen/pi-subagents`），并改造 workflow 的 agent-pool 使用进程内执行。该包同时作为第三方可复用的 subagent 编排基础库。

## Functional Requirements

### FR-1: Agent Session 管理（L1）

**FR-1.1** 封装 Pi SDK `createAgentSession()`，提供 `runAgent(options)` 函数，完成从参数解析到 session 创建到执行到结果收集的完整流程。

**FR-1.1.0** `runAgent()` 执行步骤（必须在**主线程**调用，Worker 线程无 Pi SDK 上下文）：

```
1. 参数解析
   a. model string ("provider/modelId") → modelRegistry.find(provider, modelId) → Model<any>
      - find() 返回 null 时走 FR-4.2 的 fallback 链
      - 找不到任何可用模型时抛出 Error，message 包含尝试过的所有候选
   b. thinkingLevel string → 验证为 ThinkingLevel 枚举值 ("off"|"minimal"|"low"|"medium"|"high"|"xhigh")
   c. 从 AgentRegistry 解析 agent 的 systemPrompt/model/tool 配置

2. 并发控制
   - 获取 pool（opts.pool ?? runtime.globalPool）
   - await pool.acquire(opts.priority)
   - try/finally 确保异常时 release

3. 构建 ResourceLoader（**不含 tool 配置**——tool 选择在步骤 4 传入）
   - new DefaultResourceLoader({
       cwd, agentDir,
       appendSystemPrompt: opts.appendSystemPrompt,
       additionalSkillPaths: opts.skillPath ? [opts.skillPath] : undefined,
     })
   - await resourceLoader.reload()
   - **SDK 约束**：`DefaultResourceLoaderOptions` 没有 `tools`/`excludeTools` 字段。
     tool 控制只能在 `CreateAgentSessionOptions` 上设置（步骤 4）。

4. 创建 Session（tool 配置在此传入）
   - const { session } = await createAgentSession({
       model: resolvedModel,           // Model<any> 对象，非 string
       thinkingLevel: resolvedLevel,   // ThinkingLevel 枚举
       resourceLoader,                 // 上面构建的
       sessionManager: SessionManager.inMemory(), // 不持久化子 session
       // FR-6 tool 过滤：subagents 层把 allowedTools − excludedTools 算成 allowlist
       tools: resolvedToolAllowlist,   // string[] allowlist；undefined=全部，[]=无（配合 noTools）
     })
   - **tool 过滤实现（FR-6）**：`resolvedToolAllowlist` 由 tool-filter 计算——
     从 `session.getAllTools()` 取全部 tool 名，减去 `EXCLUDED_TOOL_NAMES`（FR-6.2）和
     agent 配置的 `excludeTools`，再按 `builtinTools` 白名单过滤。结果作为 `tools` allowlist 传入。
     注意：`createAgentSession` 无 `excludeTools` 参数，排除须在 subagents 层预先算成 allowlist。
   - subscribe(session, onEvent 回调) — FR-8 事件桥接

5. 执行（try/finally 确保 dispose）
   a. 如果有 schema → 拼入 task 末尾（FR-9.6 模板）
   b. await session.prompt(task)
   c. prompt resolve 后从 session.messages 提取最终文本
   d. 从事件流累计的 toolCalls/usage 构建结果

6. Soft turn limit 监控（通过 turn_end 事件计数，FR-1.4）

7. 清理
   - session.dispose() — 无论成功/失败/abort 都执行
   - pool.release()
```

**FR-1.1.1** `RunAgentOptions` 完整类型：
```typescript
interface RunAgentOptions {
  /** Task prompt — 发送给 agent 的任务描述 */
  task: string;
  /** Agent 名称（从 AgentRegistry 解析 systemPrompt、model 等） */
  agent?: string;
  /** 模型 "provider/modelId" 格式（覆盖配置链解析结果） */
  model?: string;
  /** Thinking level（"off" | "minimal" | "low" | "medium" | "high" | "xhigh"） */
  thinkingLevel?: string;
  /** 最大 agent turns（超出时 soft limit + hard abort） */
  maxTurns?: number;
  /** Soft limit 后的 grace turns（默认 2） */
  graceTurns?: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
  /** Skill 路径（注入到 session 的 resourceLoader.additionalSkillPaths） */
  skillPath?: string;
  /** Structured-output schema（拼入 task prompt 末尾 + 追踪 structured-output tool 调用） */
  schema?: Record<string, unknown>;
  /** System prompt 追加内容（注入到 resourceLoader.appendSystemPrompt） */
  appendSystemPrompt?: string[];
  /** 事件回调（AgentSessionEvent → AgentEvent） */
  onEvent?: (event: AgentEvent) => void;
  /** 并发池覆盖（不传则用全局 pool） */
  pool?: ConcurrencyPool;
  /** 优先级（0=最高，默认 Infinity=无优先级） */
  priority?: number;
}
```

**FR-1.1.2** `AgentResult` 完整类型：
```typescript
interface AgentResult {
  /** Agent 输出的文本（从 session.messages 最后一条 assistant message 提取） */
  text: string;
  /** Structured-output 工具返回的解析后数据（仅在 schema 被传入且 agent 调用了 structured-output tool 时存在） */
  parsedOutput?: unknown;
  /** Token 使用量（从 message_end 事件累计） */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  /** Agent 执行的 turn 数 */
  turns: number;
  /** 墙钟耗时（ms） */
  durationMs: number;
  /** 是否成功完成（true = 正常结束或 soft limit 后正常收尾，false = hard abort 或错误） */
  success: boolean;
  /** 错误描述（仅在 success=false 时存在） */
  error?: string;
  /** Pi session ID（用于定位 session JSONL 文件） */
  sessionId: string;
  /** 所有 tool 调用记录（从事件流收集） */
  toolCalls: ToolCallEntry[];
}
```

**FR-1.2** 支持 `ManagedSession` 模式：创建 session 后可多次 `prompt()`、`steer()`、`abort()`，不自动销毁。供编排层（如 chain 的多步执行）使用。

`ManagedSession` 接口定义：
```typescript
interface ManagedSession {
  /** 向 session 发送 prompt，等待执行完成。与 runAgent() 的区别是不自动 dispose，可多次调用 */
  prompt(task: string, options?: {
    maxTurns?: number;
    signal?: AbortSignal;
  }): Promise<AgentResult>;
  /** 注入 steer 消息到运行中的 session。通过 session.steer() 将消息入队，在当前 tool 完成后注入 */
  steer(message: string): void;
  /** 硬终止当前 session。中断 LLM API 调用，等待 agent idle。之后 prompt() resolve 得到部分结果 */
  abort(): void;
  /** 释放 session 资源。dispose 后不能再使用。session 的 dispose 内部调用（FR-1.6）与此方法独立 */
  dispose(): void;
  /** 当前 Pi session ID（用于定位 session JSONL 日志） */
  readonly sessionId: string;
  /** session 是否仍可用（未 dispose） */
  readonly alive: boolean;
}

interface ManagedSessionOptions {
  /** Agent 名称（从 AgentRegistry 解析 systemPrompt、model 等） */
  agent?: string;
  /** 模型 "provider/modelId" 格式 */
  model?: string;
  /** Thinking level */
  thinkingLevel?: string;
  /** Skill 路径 */
  skillPath?: string;
  /** System prompt 追加内容 */
  appendSystemPrompt?: string[];
  /** 事件回调 */
  onEvent?: (event: AgentEvent) => void;
}
```

**FR-1.3** `prompt()` 返回 `Promise<void>`，在 agent 完成所有 turns 后 resolve（包括 tool call 循环）。Pi SDK 保证 `prompt()` resolve 时 `session.messages` 已包含最终 assistant message（messages 是同步属性，prompt 内部在写入完成后才 resolve Promise）。`collectResponseText()` 在 `prompt()` resolve 后直接读取 `session.messages` 最后一条 assistant message 的 text content，无需额外等待。`subscribe()` 事件流用于实时收集 tool call 记录和 token usage（不需要等到 prompt resolve）。

**FR-1.4** 支持 soft turn limit + hard abort：当 turn 数达到 `maxTurns` 时 steer "wrap up" 消息，grace turns 后 `session.abort()` 硬终止。

**FR-1.5** 支持 `AbortSignal` 外部取消：signal 触发时调用 `session.abort()`。

**FR-1.6** Session 清理：`runAgent()` 内部使用 `try/finally` 模式，无论成功、失败、还是 abort，`finally` 块中都调用 `session.dispose()` 释放内存。如果 `createAgentSession()` 本身抛异常（如模型不可用），则不需要 dispose（session 未创建成功）。

**FR-1.7** `createAgentSession()` 的配置策略：
- 使用 `DefaultResourceLoader` 构造子 session 的资源加载器
- `appendSystemPrompt: opts.appendSystemPrompt` — 注入 agent systemPrompt
- `additionalSkillPaths: opts.skillPath ? [opts.skillPath] : undefined` — 注入 skill
- **tool 过滤不在 ResourceLoader 上**——`DefaultResourceLoaderOptions` 无 `tools`/`excludeTools` 字段。tool 控制在 `CreateAgentSessionOptions` 上：`tools: string[]`（allowlist）、`noTools?: "all"|"builtin"`。subagents 层把 FR-6 的三层过滤结果（allowed − excluded）预算成 allowlist，传入 `createAgentSession({ tools })`
- `createAgentSession()` 内部已通过 `resourceLoader` 加载扩展，**不需要**调用 `session.bindExtensions()`（那是 interactive mode 专用）

### FR-2: Agent 发现与注册（L2）

**FR-2.1** `AgentRegistry` 扫描 `~/.pi/agent/agents/`（user 级）和 `.pi/agents/`（project 级）下的 `.md` 文件，解析 YAML frontmatter（name、description、tools、extensions、skills 等）。

**FR-2.2** 支持 builtin agent 注册：代码中预定义的 agent 配置。内置 agent 列表：

| Agent | 默认用途 | systemPrompt | 默认 Model | Tool 策略 |
|-------|---------|-------------|-----------|----------|
| `worker` | 通用执行 agent（编码、修复、文件操作） | "You are a coding agent. Complete the task precisely." | 由 category 解析 | builtin=all, extensions=true |
| `reviewer` | 代码审查 agent（diff 分析、问题发现） | "You are a code reviewer. Find bugs, logic errors, and security issues." | 由 category 解析 | builtin=[read], extensions=false |
| `researcher` | 网络调研 agent | "You are a web researcher. Search, evaluate, and synthesize findings." | 由 category 解析 | builtin=[read,web_search], extensions=false |
| `scout` | 快速代码库侦查 | "You are a codebase recon agent. Explore structure and return compressed context." | 由 category 解析 | builtin=[read,bash,grep], extensions=false |
| `planner` | 实施计划 agent | "You are a planning agent. Break down tasks and create implementation plans." | 由 category 解析 | builtin=[read], extensions=false |
| `oracle` | 高上下文决策一致性守护 | "You are a decision oracle. Protect inherited state and prevent drift." | 由 category 解析 | builtin=[read], extensions=false |
| `context-builder` | 需求分析与元提示生成 | "You are a context builder. Analyze requirements and generate meta-prompts." | 由 category 解析 | builtin=[read], extensions=false |

默认 model 通过 category 解析（FR-4.5）：`worker`/`reviewer` → `coding`，`researcher`/`scout` → `research`，`planner`/`oracle`/`context-builder` → `planning`。

`BuiltinAgentRegistry` 提供 `register(config: AgentConfig)` 方法让第三方扩展添加自定义 builtin agent。

**FR-2.3** `get(name)` 方法按名称查找 agent，优先 project 级 > user 级 > builtin。

### FR-3: Agent 配置合并（L2）

**FR-3.1** 5 级配置优先级（后者覆盖前者）：
1. agent 定义文件的默认值（frontmatter 中的 model 字段）
2. 全局配置文件 category 默认（`config.json` 中该 category 的 model/thinkingLevel）
3. 会话级 per-category 状态（本会话中用户为某类别指定的）
4. 会话级 per-agent 状态（本会话中用户为特定 agent 指定的）
5. 调用时参数覆盖（tool call params 中的 model/thinkingLevel）

环境变量 `SUBAGENT_MODEL` 作为最终 fallback（无任何匹配时）。

**FR-3.2** System prompt 构建策略：`replace`（agent 的 systemPrompt 替换默认）、`append`（追加到默认）、`none`（不注入）。

### FR-4: 模型解析（L2）

**FR-4.1** `resolveModelForAgent()` 按 FR-3 的 5 级优先级链解析模型。每级解析结果通过 `modelRegistry.find(provider, modelId)` 验证可用性，不可用时降级到下一级。

**FR-4.2** 支持 model fallback：首选模型不可用时，按 fallback 链依次尝试。**完整降级链**：

```
agent.model                    ← frontmatter 中定义的默认模型
  ↓ (不可用)
agent.modelCandidates[0..n]    ← frontmatter 中的候选列表
  ↓ (全部不可用)
global config.fallback.model   ← config.json 的 fallback 字段
  ↓ (不可用)
env SUBAGENT_MODEL             ← 环境变量
  ↓ (未设置)
throw Error("No available model") ← 明确报错，列出尝试过的所有候选
```

Fallback 触发条件：模型在 `ModelRegistry` 中不存在（`modelRegistry.find(provider, modelId)` 返回 null）或 `hasConfiguredAuth()` 返回 false（未配置 API key）。API 运行时错误（rate limit、quota exceeded）不触发 fallback，直接报错。

每级候选在验证前需要 string→Model 转换：`modelRegistry.find(provider, modelId)` 返回 `Model<any>` 对象。`RunAgentOptions.model` 是 string 格式，`runAgent()` 内部在步骤 1a 完成转换（FR-1.1.0）。

**FR-4.3** Thinking level 从选定 model 的 `thinkingLevelMap` 字段提取支持的级别。`thinkingLevelMap` 是 `{ off?, minimal?, low?, medium?, high?, xhigh? }` 映射到 `string | null`：
- 值为 `null` = 该级别不可用，必须排除
- 值为 `string` = 可用，string 是 Pi SDK 内部使用的 provider 侧映射值
- `model.reasoning === false` = 该模型完全不支持 thinking，跳过 thinking level 选择，不注入

**FR-4.3.1** 调用 `createAgentSession({ thinkingLevel })` 时传入 Pi 内部的级别名（如 `"high"`），Pi SDK 通过 `thinkingLevelMap` 自动转换为 provider 侧值（如 `"max"`）。subagents 不需要自己做映射。

**FR-4.3.2** 当前环境实际可用模型示例（来自 `~/.pi/agent/models.json`）：

| Provider | Models | 可用 Thinking Levels |
|----------|--------|---------------------|
| zhipu-coding-plan-router | glm-5.1, glm-5-turbo | xhigh |
| deepseek-router | ds-flash, ds-pro | high, xhigh |
| mimo-router | mimo-v2.5, mimo-v2.5-pro | low, medium, high |
| kimi-coding-plan-router | kimi-for-coding | xhigh |
| minimax-token-plan-router | minimax-m3 | xhigh |
| carbon-router | qwen3-0.6b | 无（reasoning=false） |

注意：glm-5.1 的 `thinkingLevelMap` 中 off/minimal/low/medium/high 均为 `null`，仅 `xhigh` 有值。这意味着用户选择 glm-5.1 后，thinking level 只能选 xhigh，不能选其他级别。

<!-- FR-4.4 编号故意跳过 —— ThinkgingLevel 相关内容已合并到 FR-4.3 -->

### FR-4.5: Category 系统

**FR-4.5.1** 6 个默认 category：`coding`（编码/修复/重构）、`research`（调研/搜索）、`testing`（测试）、`vision`（图像分析）、`planning`（规划/架构）、`general`（通用 fallback）。

**FR-4.5.2** 用户可在 config.json 的 `categories` 字段中新增自定义 category（key=名称，value=label+model+thinkingLevel）。

**FR-4.5.3** `inferCategory(agentName, agentConfig, overrides)` 推断 agent 类别：优先使用 `agentConfig.category`，其次查 `config.agentCategoryOverrides`，最后按名称约定正则推断。

### FR-4.6: 全局配置

**FR-4.6.1** 配置文件路径：`~/.pi/agent/extensions/subagents/config.json`。

**FR-4.6.2** 配置结构：
```json
{
  "version": 1,
  "yoloByDefault": false,
  "maxConcurrent": 4,
  "categories": {
    "coding":   { "label": "编码", "model": "deepseek-router/ds-flash", "thinkingLevel": "high" },
    "research": { "label": "调研", "model": "mimo-router/mimo-v2.5", "thinkingLevel": "medium" },
    "testing":  { "label": "测试", "model": "mimo-router/mimo-v2.5", "thinkingLevel": "low" },
    "vision":   { "label": "视觉", "model": "zhipu-coding-plan-router/glm-5.1", "thinkingLevel": "xhigh" },
    "planning": { "label": "规划", "model": "deepseek-router/ds-pro", "thinkingLevel": "xhigh" },
    "general":  { "label": "通用", "model": "mimo-router/mimo-v2.5", "thinkingLevel": "low" }
  },
  "agentCategoryOverrides": { "worker": "coding", "reviewer": "coding", "scout": "research" },
  "fallback": { "model": "mimo-router/mimo-v2.5", "thinkingLevel": "low" }
}
```

**FR-4.6.3** `loadGlobalConfig()` 加载配置，缺失字段用默认值填充。文件不存在时返回全默认配置。

**FR-4.6.4** `saveGlobalConfig()` 写入配置，使用 atomic write（写入 temp 文件 → `fs.renameSync` 覆盖目标文件），避免并发写入时的数据损坏。进程内并发保护：使用 `Promise` 队列串行化写操作（`let writeChain = Promise.resolve(); writeChain = writeChain.then(() => actualWrite())`），防止多个 agent 在不同微任务中同时修改 config.json 导致后写覆盖前写。

### FR-4.7: 会话模型状态

**FR-4.7.1** `SessionModelState` 在工厂闭包内维护，通过 `pi.appendEntry("subagent-model-state", ...)` 持久化到 session，在 `session_start` 时从 entries 恢复。

**FR-4.7.2** 数据结构（使用 Record 而非 Map，确保 `JSON.stringify` 正确序列化）：
```typescript
interface SessionModelState {
  yoloMode: boolean;
  perAgent: Record<string, { model: string; thinkingLevel?: string }>;
  perCategory: Record<string, { model: string; thinkingLevel?: string }>;
}
```
注意：`Map` 类型在 `JSON.stringify` 时序列化为 `{}`（空对象），因此使用 `Record` 替代。如果内部实现需要 `Map` 的查找性能，在 `appendEntry` 时用 `Object.fromEntries(map)` 序列化，恢复时用 `new Map(Object.entries(obj))` 反序列化。

**FR-4.7.3** 向后兼容反序列化：字段缺失时用默认值。

### FR-4.8: `/subagents` 命令

**FR-4.8.1** 命令注册与入口行为：
- `/subagents`（不带参数）：显示当前配置摘要（所有 category 的 model/thinkingLevel、YOLO 状态、全局并发数）+ 可用子命令列表
- `/subagents config`：进入交互式配置向导
- `/subagents config <category>`：快捷路径，直接跳到指定 category 的 provider 选择（省掉前两步）

命令通过 `pi.registerCommand("subagents", ...)` 注册，配置向导通过 `ctx.ui.select()` 实现级联交互。`ctx.ui.select()` 每次调用展示选项列表并返回用户选择，是同步返回 Promise 的简单交互原语。级联通过多个顺序 `await ctx.ui.select()` 调用实现，每步根据前一步结果动态构建选项。

**FR-4.8.2** 交互流程（完整路径 4 步，快捷路径 2 步）：

完整路径（`/subagents config`）：
1. 选择操作（Edit category model / Add custom category / Remove custom category / Toggle YOLO / Override agent category / Show current config）
2. 选择 category
3. 选择 provider → 选择 model → 选择 thinking level（三者联动，见下）
4. 保存到 config.json

快捷路径（`/subagents config coding`）：
1. 直接进入 Step A 的 provider 选择（跳过操作选择和 category 选择）
2. 选择 model → 选择 thinking level
3. 保存到 config.json

`config-wizard.ts` 伪代码结构：
```typescript
async function runConfigWizard(ctx, args: string[]) {
  const quickCategory = args[0]; // 快捷路径
  if (!quickCategory) {
    const operation = await ctx.ui.select({ options: ["Edit category model", ...] });
    if (operation === "Show current config") { showCurrentConfig(ctx); return; }
    if (operation === "Toggle YOLO") { toggleYolo(); return; }
    const category = await ctx.ui.select({ options: getAllCategories() });
    await editCategoryModel(ctx, category);
  } else {
    await editCategoryModel(ctx, quickCategory);
  }
}

async function editCategoryModel(ctx, category) {
  const providers = getAvailableProviders(ctx.modelRegistry);
  const provider = await ctx.ui.select({ options: providers });        // Step A
  const models = getModelsForProvider(provider);
  const model = await ctx.ui.select({ options: models });               // Step B
  const levels = getAvailableThinkingLevels(model);
  if (levels.length > 0) {
    const level = await ctx.ui.select({ options: levelsWithDesc(levels) }); // Step C
    // levelsWithDesc: ["high — 深度推理，耗时较长", "medium — 平衡推理", ...]
    saveCategoryConfig(category, model, level);
  } else {
    saveCategoryConfig(category, model, undefined);
  }
}
```

**FR-4.8.3** Provider → Model → ThinkingLevel 联动选择规则：

```
Step A: 选择 provider
  数据源: ctx.modelRegistry.getAvailable() → 去重 model.provider
  展示: provider 名（完整名如 "zhipu-coding-plan-router"）

Step B: 选择 model（依赖 Step A 选中的 provider）
  数据源: getAvailable().filter(m => m.provider === selectedProvider)
  展示: model.name + contextWindow + reasoning 状态
  示例: "glm-5.1 (200k ctx · reasoning ✓)"

Step C: 选择 thinking level（依赖 Step B 选中的 model）
  数据源: 从 model.thinkingLevelMap 提取
  过滤: 排除值为 null 的级别
  排序: off → minimal → low → medium → high → xhigh
  展示: 级别名 + 简短说明
    - off: "off — 不使用推理"
    - minimal: "minimal — 极轻推理"
    - low: "low — 轻度推理"
    - medium: "medium — 平衡推理"
    - high: "high — 深度推理，耗时较长"
    - xhigh: "xhigh — 最深度推理，耗时最长"
  特殊: model.reasoning === false 时跳过此步，不设 thinking level
  示例: glm-5.1 仅显示 "xhigh — 最深度推理，耗时最长"；mimo-v2.5 显示 low/medium/high；qwen3-0.6b 跳过
```

**FR-4.8.4** 联动约束总结：
- 更换 provider 后，model 列表必须刷新（不同 provider 有不同 models）
- 更换 model 后，thinking level 列表必须刷新（不同 model 支持不同级别）
- 如果用户当前选的 thinking level 在新 model 上不可用，自动降级到该 model 支持的最高级别
- `getAvailable()` 只返回有 auth 配置的模型（`modelRegistry.hasConfiguredAuth(model) === true`），未配置 API key 的模型不展示

**FR-4.8.5** 新增自定义 category：通过 `ctx.ui.input()` 输入名称，然后进入 Step A-C 的 provider/model/thinking 级联选择。

### FR-4.9: YOLO 模式

**FR-4.9.1** YOLO 模式下，`resolveModelForAgent()` 在无任何用户指定时自动按全局配置选择，不阻塞执行。

**FR-4.9.2** YOLO 状态按会话存储（`sessionModelState.yoloMode`），也受 `config.yoloByDefault` 影响。

**FR-4.9.3** 通过 `/subagents config` → Toggle YOLO 切换，或 `config.json` 中 `yoloByDefault: true`。

### FR-5: 父对话 Fork（L2）

**FR-5.1** `forkContext()` 从父 session（`ctx.sessionManager.getBranch()`）提取 user/assistant 消息文本，跳过 toolResult。

**FR-5.1.1** 截断策略：
1. 最多提取最后 **5 轮** 完整的 user→assistant 消息交换
2. 总文本量达到 **4000 tokens**（约 12000 中文字符）时停止，丢弃更早的消息
3. 提取的消息按原始顺序排列，拼接到子 agent 的 task prompt 前
4. 如果父对话不足 5 轮，提取全部可用内容

**FR-5.1.2** `ForkOptions` 允许调用方自定义截断参数（v1 用默认值即可，接口预留）：
```typescript
interface ForkOptions {
  /** 最大提取轮数，默认 5 */
  maxExchanges?: number;
  /** 最大 token 数，默认 4000 */
  maxTokens?: number;
}
```

**FR-5.2** fork 模式下，将提取的父对话作为 `# Parent Conversation Context` 拼接到子 agent 的 task prompt 前。

### FR-6: Tool 过滤（L2）

**FR-6.1** 三层过滤机制：
1. `builtinTools`：agent 配置允许的内置 tool（undefined=全部，[]=无）
2. `extensions`：extension tool 加载策略（true=全部，false=无，string[]=白名单）
3. `excludeTools`：明确排除的 tool 名

**FR-6.2** 递归排除：子 agent 不应继承编排层的 tool（防止无限嵌套）。通过 `EXCLUDED_TOOL_NAMES` 常量控制。

```typescript
/**
 * 子 agent 不应继承的编排层 tool（防止无限嵌套）。
 * 这些 tool 会启动/控制/中止 agent 执行流，子 agent 不应拥有。
 */
const EXCLUDED_TOOL_NAMES: readonly string[] = [
  'workflow_run',   // 启动子 workflow
  'workflow_pause', // 暂停 workflow
  'workflow_abort', // 中止 workflow
  'workflow_lint',  // workflow 脚本校验（编排层特有）
  'subagent',       // [预留] V2 subagent tool 名称
] as const;
```

`EXCLUDED_TOOL_NAMES` 在 subagents 层的 tool-filter 中预先减去（FR-1.1.0 步骤 4），把剩余 tool 名算成 allowlist 传入 `createAgentSession({ tools })`。在每次 `runAgent()` 调用中自动生效。

> **SDK 约束**：`createAgentSession()` 无 `excludeTools` 参数，只有 `tools?: string[]`（allowlist）。因此排除逻辑 = 从全部 tool 名集合中移除被排除的名称，得到 allowlist。全部 tool 名来源：session 创建后 `session.getAllTools().map(t => t.name)`，或从 `resourceLoader.getExtensions()` 收集。

实现时需注意：实际 tool 注册名可能带 `@scope/tool-name` 格式（如 `@zhushanwen/workflow_run`）。排除逻辑应支持**后缀匹配**：检查 toolName 是否以 `EXCLUDED_TOOL_NAMES` 中的任一名字结尾。

### FR-7: 并发管理（L1）

**FR-7.1** `ConcurrencyPool` 控制最大并发数，由 `SubagentRuntime` 持有全局实例（`maxConcurrent` 来自 `config.json`）。

**FR-7.1.1** Workflow 与并发池的关系：
- orchestrator 不再创建自己的 `AgentPool`（已删除）
- orchestrator 的 `handleAgentCall()` 直接调用 `runAgent({ pool: runPool })` 传递一个 per-run `ConcurrencyPool` 实例
- per-run pool 隔离各 workflow run 的并发，互不影响
- 第三方扩展不传 pool 时使用 `SubagentRuntime` 的全局 pool

**FR-7.2** `RunAgentOptions.pool` 可覆盖全局 pool：orchestrator 传入 per-run `ConcurrencyPool` 实例隔离各 workflow run 的并发，第三方扩展用全局 pool。

**FR-7.3** 支持优先级：高优先级任务插队。

**FR-7.4** 提供活跃数/排队数/最大并发数的只读属性。

### FR-8: 事件桥接（L1）

**FR-8.1** 将子 session 的 `AgentSessionEvent` 转换为 agent-runtime 的 `AgentEvent` 回调。

**FR-8.1.1** 事件转换映射（基于 `@mariozechner/pi-agent-core` 的 `AgentEvent` 与 `pi-coding-agent` 的 `AgentSessionEvent` 真实定义）：

| Pi SDK AgentSessionEvent | subagents AgentEvent | 附加数据 / 提取逻辑 |
|---|---|---|
| `{type: "tool_execution_start", toolCallId, toolName, args}` | `{type: "tool_start", toolName}` | 丢弃 args/toolCallId（subagents 事件只暴露 toolName） |
| `{type: "tool_execution_end", toolCallId, toolName, result, isError}` | `{type: "tool_end", toolName, result, isError}` | `result` 是 `AgentToolResult`（携带 `content` 和 `details`，structured-output 的 parsedOutput 在 `details` 中） |
| `{type: "message_update", message, assistantMessageEvent}` | `{type: "text_delta", delta}` | `delta` 从 `assistantMessageEvent` 提取增量文本（SDK 无独立 `text_delta` 事件） |
| `{type: "turn_end", message, toolResults}` | `{type: "turn_end"}` | turn 计数器 +1。丢弃 message/toolResults 负载（turn_end 仅用于计数和 soft limit 检测） |
| `{type: "message_end", message}` | `{type: "message_end", usage}` | usage 从 `message.usage`（`AssistantMessage.usage: Usage`）提取 |
| `{type: "compaction_start"}` | `{type: "compaction"}` | — |
| `{type: "message_end", message}` 且 `message.stopReason === "error"\|"aborted"` | `{type: "error", error}` | SDK 无独立 `error` 事件，错误通过 `message_end.message.stopReason` + `message.errorMessage` 表达。event-bridge 检查 stopReason 映射为 error 事件 |

> **SDK 事件名校正**：Pi SDK 实际事件名是 `tool_execution_start`/`tool_execution_end`（非 `tool_start`/`tool_end`），`turn_end`/`turn_start` 是原生事件（非从 `agent_end` 转换）。`agent_end { messages }` 不映射为 turn_end，而是作为整个 run 完成的信号（可忽略或用于生命周期追踪）。
>
> **无 messages 负载传递**：`session.messages`（同步属性）是消息历史的权威来源，`prompt()` resolve 后可完整读取。事件流仅用于实时收集 tool call 记录、token usage 和 turn 计数。

**FR-8.1.2** `AgentEvent.tool_end.result` 结构（对应 SDK 的 `AgentToolResult<T>`）：
```typescript
interface ToolEndEvent {
  type: "tool_end";
  toolName: string;
  /** SDK AgentToolResult: { content: (TextContent|ImageContent)[]; details: T } */
  result?: {
    content: Array<{ type: string; text?: string }>;
    details?: unknown;
  };
  /** SDK tool_execution_end.isError：true 表示 tool 执行抛异常 */
  isError: boolean;
}
```
当 `toolName === "structured-output"` 且 `result.details` 存在时，`runAgent()` 从 `result.details` 中提取 parsedOutput 填充到 `AgentResult.parsedOutput`。

**FR-8.2** 事件类型（subagents 对外统一的 AgentEvent union）：`tool_start`、`tool_end`（含 result + isError）、`text_delta`、`turn_end`、`message_end`（含 usage）、`compaction`、`error`。

**FR-8.3** Token usage 从 `message_end.message.usage`（`AssistantMessage.usage: Usage`）提取。`Usage` 完整结构：
```typescript
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number; output: number; cacheRead: number; cacheWrite: number;
    total: number;   // ← AgentResult.usage.cost 用此字段
  };
}
```
`AgentResult.usage.cost` 映射 `Usage.cost.total`。`AgentResult.usage` 累加所有 `message_end` 事件的 usage（一次 run 可能有多个 message_end：主消息 + tool 触发的 follow-up）。

### FR-9: Workflow Agent-Pool 改造

**FR-9.1** `AgentPool` 整体重写为轻量级 `ConcurrencyPool` 包装。原有的 `AgentPool` 类（350 行 spawn 逻辑）替换为直接调用 `agentRuntime.runAgent()`。orchestrator 的 `handleAgentCall()` 流程变更：

```
旧流程（spawn）:
  Worker postMessage('agent-call')
  → orchestrator.handleAgentCall()
  → resolveAgentOpts() → 构建 spawn 参数
  → AgentPool.enqueue() → spawn pi 进程 → JSONL 解析
  → AgentResult → postMessage('agent-result') → Worker

新流程（进程内）:
  Worker postMessage('agent-call', { callId, opts: AgentCallOpts })
  → orchestrator.handleAgentCall()
  → resolveAgentOpts() → 构建 RunAgentOptions（FR-9.4）
  → runAgent(runOpts) → createAgentSession + prompt + collect
  → subagents AgentResult → 映射为 Worker AgentResult（FR-9.5）
  → postMessage('agent-result', { callId, result }) → Worker
```

**FR-9.1.1 Worker→Main 桥接时序（B1 修复）：**

```
Worker 线程                    主线程
─────────────────────────────────────────────────────
agent("worker", "Fix typo")
  ↓
postMessage({
  type: 'agent-call',
  callId: 42,
  opts: { prompt, agent, schema, ... }
})
  ↓                              ↓ handleAgentCall(runId, inst, 42, opts)
  ↓                              ↓ 1. callCache.get(42) → miss
  ↓                              ↓ 2. resolveAgentOpts(opts)
  ↓                              ↓    → 构建 RunAgentOptions
  ↓                              ↓ 3. resolveModel(scene) → model string
  ↓                              ↓ 4. runAgent(runOpts)
  ↓                              ↓    → createAgentSession
  ↓                              ↓    → session.prompt(task)
  ↓                              ↓    → collectResponseText
  ↓                              ↓    → AgentResult { text, ... }
  ↓                              ↓ 5. 映射 AgentResult → Worker格式
  ↓                              ↓ 6. callCache.set(42, workerResult)
  ↓                              ↓ 7. appendTraceNode(...)
await (Promise pending)          ↓ 8. postMessage({
  ↓                                  type: 'agent-result',
  ↓                                  callId: 42,
  ↓                                  result: workerResult
  ↓                                })
  ↓                              ↓
parentPort.on('message')
  ↓ resolve(msg.result.parsedOutput ?? msg.result.content)
  ↓
返回值给 workflow 脚本
```

关键约束：
- `createAgentSession()` 只能在主线程调用（Worker 无 Pi SDK 上下文）
- Worker 的 `agent()` 是 `await` 阻塞的，等 `postMessage` 返回结果
- 主线程的 `runAgent()` 是异步的，不阻塞事件循环
- 如果 Worker 被 terminate（pause/abort），进行中的 `runAgent()` 通过 `AbortSignal` 取消（FR-1.5）
- `runAgent()` 失败时仍返回 `AgentResult(success=false, error=...)`，不抛异常（与旧 AgentPool 行为一致）

**FR-9.2** 删除以下文件（被 agent-runtime 替代）：
- `infra/pi-runner.ts` — 子进程管理
- `infra/jsonl-parser.ts` — JSONL 解析
- `engine/model-resolver.ts` — 模型解析
- `infra/agent-discovery.ts` — agent 发现

**FR-9.3** 保留但适配的文件：
- `infra/agent-opts-resolver.ts` — 参数解析，改为构建 `RunAgentOptions`。**Temp file 逻辑完全删除**：不再写 temp file 给 `--append-system-prompt`，改为直接读取 agent systemPrompt 内容传入 `RunAgentOptions.appendSystemPrompt` 数组
- `infra/execution-trace.ts` — 执行追踪，事件源从 JSONL 改为 agent-runtime 回调
- `infra/state-store.ts` — 状态持久化，不变
- `infra/config-loader.ts` — workflow 脚本加载，不变

orchestrator 的 `activeTempFiles` Set 和 `cleanupAllTempFiles()` / `cleanupTempFile()` 调用全部移除——不再有 temp file 需要管理。`resolveAgentOpts()` 不再接受 `activeTempFiles` 参数。

**FR-9.4** `AgentCallOpts` → `RunAgentOptions` 转换逻辑（在 `agent-opts-resolver.ts` 中）：

| AgentCallOpts 字段 | RunAgentOptions 映射 | 说明 |
|---------------------|---------------------|------|
| `prompt` | `task` | 直接映射 |
| `agent` | `agent` | 直接映射 |
| `model` | `model` | 直接映射（如果非空则覆盖 5 级配置链） |
| `scene` | *(不映射)* | scene 解析在主线程完成，结果写入 `model` |
| `schema` | `schema` | 直接映射 |
| `skill` / `skillPath` | `skillPath` | skill 路径解析保留在 agent-opts-resolver |
| `systemPromptFiles` | `appendSystemPrompt` | 直接读取文件内容，传入字符串数组（不再写 temp file） |
| `schemaEnv` | *(不映射)* | 废弃。schema 指令通过 `RunAgentOptions.schema` 传递 |
| `description` | *(不映射)* | 仅用于日志，传给 runAgent 无意义 |

**FR-9.5** `AgentResult` → Worker `AgentResult` 映射（在 `AgentPool` 中）：

| subagents AgentResult | Worker AgentResult | 说明 |
|----------------------|-------------------|------|
| `text` | `output` | 字段名映射 |
| `parsedOutput` | `parsedOutput` | 直接映射 |
| `usage` | `usage`（格式适配） | 字段名相同，结构需适配（turns → 单独字段） |
| `turns` | *(融入 usage.turns)* | |
| `durationMs` | `durationMs` | 直接映射 |
| `success` | `success` | 直接映射 |
| `error` | `error` | 直接映射 |
| `sessionId` | `sessionId` | 直接映射 |
| `toolCalls` | `toolCalls` | 直接映射 |
| *(无)* | `callId` | 从 orchestrator 内部生成 |
| *(无)* | `content` | Worker 需要此字段做 fallback（`msg.result.parsedOutput ?? msg.result.content`）。映射值 = `AgentResult.text` |

**FR-9.5.1 Pause/Resume callCache 格式一致性（B3 修复）：**

callCache 存储的 `StateAgentResult` 格式必须与 Worker 的 `parentPort.on('message')` 期望的格式完全一致。Worker 代码使用（位于 `engine/worker-script.ts` 的 `buildWorkerScript()` 生成的 Worker 源码字符串中，`parentPort.on("message")` 处理 `agent-result` 分支）：
```javascript
pending.resolve(msg.result.parsedOutput ?? msg.result.content);
```

因此 `StateAgentResult` 必须同时包含 `content` 和 `parsedOutput` 字段。映射规则：
- `content` = subagents `AgentResult.text`（Worker 的 fallback 字段）
- `output` = subagents `AgentResult.text`（orchestrator 日志用）
- `parsedOutput` = subagents `AgentResult.parsedOutput`
- `success` / `error` / `usage` / `toolCalls` / `durationMs` / `sessionId` — 直接映射

Pause 时：进行中的 `runAgent()` 通过 `AbortSignal` 取消，返回 `AgentResult(success=false, error='aborted')`。此结果按上述规则映射为 `StateAgentResult` 写入 callCache。
Resume 时：Worker 重放 callCache 中的结果，格式正确，无需额外转换。

**FR-9.6** Structured-output 集成方式变更：
- schema 指令不再通过 temp file + `--append-system-prompt` 注入
- 不再通过 `PI_WORKFLOW_SCHEMA` env 激活 hook
- 改为：schema 指令拼入 `RunAgentOptions.task` 末尾（格式与现有 `agent-opts-resolver.ts` 的 `MANDATORY: Structured Output Requirement` 模板相同）
- `runAgent()` 内部通过 `tool_end` 事件回调追踪 `structured-output` tool 调用：当 `toolName === "structured-output"` 且 `result.details` 存在时，从 `result.details` 提取 parsedOutput 填充 `AgentResult.parsedOutput`
- `turn_end` hook 安全网在 v1 不提供。如果 agent 忘记调用 structured-output tool，`AgentResult.parsedOutput` 为 undefined，`AgentResult.error` 记录原因

**FR-9.7** 事件处理从 JSONL 解析改为 agent-runtime 回调。

**FR-9.8** 错误处理适配：子进程 exit code 改为 agent-runtime 的异常类型。

**FR-9.9** Model 解析发生位置：`resolveModel()` 在**主线程**执行（需要 `ctx.modelRegistry`）。Worker 通过 `AgentCallOpts.model` 传递显式模型，通过 `AgentCallOpts.scene` 传递场景名——主线程在 `agent-opts-resolver.ts` 中调用 `resolveModelForScene()` 解析 scene 为具体 model，然后写入 `RunAgentOptions.model`。

> `engine/model-resolver.ts` 已在 FR-9.2 标记删除。其中的 `resolveModelForScene()` 函数迁移到 `agent-opts-resolver.ts` 中实现。迁移后的实现调用 subagents 的 `resolveModelForAgent()`（将 scene 作为 agent 名称传入 subagents 的 5 级配置链解析）。scene→agent 的映射规则：`scene` 名直接作为 `agent` 名传参（如 `scene="coding"` → `resolveModelForAgent("coding", ...)`），通过 category 配置链解析到具体 model。

### FR-10: 包结构与依赖

**FR-10.1** 新建 `extensions/subagents/` 目录，包含完整的 L1+L2 实现。

**FR-10.2** `package.json` 命名为 `@zhushanwen/pi-subagents`，声明 `pi.extensions`。

**FR-10.3** workflow 的 `package.json` 添加 `@zhushanwen/pi-subagents` 为 `dependency`（`workspace:*`），因 workflow 编译时需要 import 其类型和函数。

**FR-10.4** 更新 `extension-dependencies.json`，声明 workflow 对 subagents 的 package 依赖。

**FR-10.5** 更新 CLAUDE.md 的目录结构说明。

### FR-11: 公开 API

包通过 `src/api/index.ts` 统一 re-export，提供以下公开接口供外部 import：

**FR-11.1** 核心 API：
- `runAgent(options: RunAgentOptions): Promise<AgentResult>` — 一次性执行
- `createManagedSession(options: ManagedSessionOptions): ManagedSession` — 长生命周期 session
- `ConcurrencyPool` — 并发控制类（全局实例 + 可覆盖）

**FR-11.2** 注册表 API：
- `AgentRegistry` — 发现/注册 agent
- `BuiltinAgentRegistry` — 注册自定义 builtin agent

**FR-11.3** 工具函数：
- `resolveModelForAgent(agentName, config, sessionState, modelRegistry): ResolvedModel` — 完整的 5 级模型解析
- `inferCategory(agentName, agentConfig, overrides): string` — 类别推断
- `forkContext(parentSession: SessionManager): ForkResult` — 父对话 fork
- `filterTools(config: ToolFilterConfig, allTools: ToolInfo[]): ToolInfo[]` — Tool 过滤

**FR-11.3.1** Runtime 扩展方法（v1 预留）：
- `registerCategory(name, defaults)` — 注册自定义 category（FR-14.6）
- `registerHooks(hooks)` — 注册执行钩子（FR-14.7）

**FR-11.4** 类型（全部 export）：`RunAgentOptions`, `AgentResult`, `ManagedSession`, `AgentConfig`, `AgentEvent`, `AgentEventType`, `ModelResolution`, `ToolFilterConfig`, `CategoryDefinition`, `SessionModelState`, `SubagentsGlobalConfig`, `ResolvedModel` 等。

**FR-11.5** Runtime 引用获取与初始化时机：
- `getRuntime(): SubagentRuntime | undefined` — 返回当前进程内的单例
- 初始化策略：扩展工厂函数 `export default function(pi)` 中创建 `SubagentRuntime` 骨架（不含 `modelRegistry`），在 `pi.on("session_start", ...)` 中注入 `ctx.modelRegistry` 和 `ctx.sessionManager`
- 第三方扩展通过 `import { getRuntime } from "@zhushanwen/pi-subagents"` 获取
- 在 `session_start` 之前调用 `getRuntime()` 可获得实例但 `resolveModelForAgent()` 会因缺少 registry 而抛出明确错误（优雅降级，非 undefined 静默失败）

### FR-12: 目录结构

**FR-12.1** `extensions/subagents/` 目录结构：

```
extensions/subagents/
├── index.ts                  # re-export: export { default } from "./src/index.ts"
├── package.json              # @zhushanwen/pi-subagents
├── src/
│   ├── index.ts              # Pi extension 工厂函数
│   ├── types.ts              # 所有类型 + TypeBox schema + 常量
│   ├── runtime.ts            # SubagentRuntime 单例（组合所有能力）
│   ├── category.ts           # Category 定义 + inferCategory()
│   │
│   ├── api/                  # 公开 API 层（统一 re-export）
│   │   └── index.ts          # package 的 public surface
│   │
│   ├── core/                 # L1: Agent Session 管理（进程内执行）
│   │   ├── run-agent.ts      # runAgent(options) → AgentResult
│   │   ├── session.ts        # ManagedSession 创建/steer/abort/dispose
│   │   ├── output-collector.ts # collectResponseText()
│   │   ├── turn-limiter.ts   # soft turn limit + hard abort
│   │   └── event-bridge.ts   # AgentSessionEvent → AgentEvent 回调
│   │
│   ├── pool/                 # L1: 并发管理
│   │   └── concurrency-pool.ts # ConcurrencyPool
│   │
│   ├── registry/             # L2: Agent 发现与注册
│   │   ├── agent-registry.ts  # AgentRegistry.discover() / get(name)
│   │   ├── frontmatter.ts     # YAML frontmatter 解析
│   │   └── builtin-agents.ts  # 内置 agent 定义
│   │
│   ├── resolution/           # L2: 配置合并 + 模型解析 + Tool 过滤
│   │   ├── config-merger.ts   # 5 级配置优先级合并
│   │   ├── model-resolver.ts  # resolveModelForAgent()
│   │   ├── tool-filter.ts     # 三层 tool 过滤
│   │   └── fork-context.ts    # forkContext()
│   │
│   ├── config/               # L2: 全局配置管理
│   │   ├── global-config.ts   # loadGlobalConfig() / saveGlobalConfig()
│   │   └── config-path.ts     # 路径常量
│   │
│   ├── state/                # L2: 会话状态管理
│   │   └── session-model-state.ts # SessionModelState 持久化/恢复
│   │
│   ├── tui/                  # TUI 渲染
│   │   ├── format.ts          # 纯格式化函数（可测试）
│   │   └── config-wizard.ts   # /subagents config 级联选择
│   │   # [V2] render-call.ts / render-result.ts — subagent tool 的 TUI 渲染
│   │
│   ├── commands/             # 命令注册
│   │   └── config.ts          # /subagents config 命令
│   │
│   └── __tests__/
│       ├── run-agent.test.ts
│       ├── concurrency-pool.test.ts
│       ├── agent-registry.test.ts
│       ├── config-merger.test.ts
│       ├── model-resolver.test.ts
│       ├── tool-filter.test.ts
│       ├── category.test.ts
│       └── format.test.ts
├── vitest.config.ts
└── README.md
```

**FR-12.2** Workflow 改造范围（仅列出变更文件）：

| 操作 | 文件 | 行数 | 改动说明 |
|------|------|------|----------|
| **删除** | `infra/pi-runner.ts` | 185 | spawn 子进程管理，被 `runAgent()` 替代 |
| **删除** | `infra/jsonl-parser.ts` | 131 | JSONL 解析，被事件回调替代 |
| **删除** | `engine/model-resolver.ts` | 48 | 模型解析，被 subagents 的 `resolveModel()` 替代 |
| **删除** | `infra/agent-discovery.ts` | 263 | agent 发现，被 subagents 的 `AgentRegistry` 替代 |
| **重写** | `infra/agent-pool.ts` | 350 | 删除 spawn 逻辑，改为调用 `runAgent()`。类名保留为 `AgentPool` 以减少改动面，内部改为轻量级 `ConcurrencyPool` 包装 |
| **适配** | `infra/agent-opts-resolver.ts` | 173 | 构建 `RunAgentOptions` 替代 spawn 参数 |
| **适配** | `infra/execution-trace.ts` | 229 | 事件源从 JSONL → agent-runtime 回调 |
| **适配** | `engine/error-handlers.ts` | 161 | 异常类型适配 |
| **新增 dep** | `package.json` | — | 添加 `@zhushanwen/pi-subagents` 为 dependency |

不动的文件：`infra/state-store.ts`, `infra/config-loader.ts`, `infra/script-lint.ts`, `domain/state.ts`, `orchestrator.ts`, `index.ts`, `interface/*`, `engine/worker-script.ts`, `engine/orchestrator-budget.ts`, `engine/orchestrator-events.ts`。

### FR-13: 依赖关系

```
@zhushanwen/pi-subagents (新)
  └── peerDep: @mariozechner/pi-coding-agent

@zhushanwen/pi-workflow (改)
  ├── peerDep: @mariozechner/pi-coding-agent
  ├── peerDep: @zhushanwen/pi-model-switch (optional)
  ├── peerDep: @zhushanwen/pi-structured-output (optional)
  └── dep: @zhushanwen/pi-subagents (workspace:*)
```

subagents 对 workflow 是 `dependencies`（非 peerDep），因 workflow 编译时需要 import 其类型和函数，且 subagents 不是 Pi 运行时提供的。

### FR-14: 扩展性设计

**v1 预留接口（FR-14.6、FR-14.7）：**

**FR-14.6** Category 运行时注册（v1 预留接口，实现为 no-op 或仅内存注册）：
```typescript
/** 注册自定义 category 默认配置。写入 config.json 的 categories 字段。 */
registerCategory(name: string, defaults: CategoryDefinition): void;
```
用途：第三方扩展在 `session_start` 时调用 `runtime.registerCategory("vision-analysis", { label: "视觉分析", model: "...", thinkingLevel: "high" })`，将该 category 写入全局配置。v1 实现为直接修改 config.json（FR-4.6 的 load/save 机制）。

**FR-14.7** Agent 执行钩子（v1 预留接口，内部实现为 passthrough）：
```typescript
interface SubagentHooks {
  /** runAgent() 执行前调用。可修改 RunAgentOptions（如注入 systemPrompt）。返回修改后的 opts */
  beforeRun?: (opts: RunAgentOptions) => RunAgentOptions | Promise<RunAgentOptions>;
  /** runAgent() 执行后调用。可记录日志/指标。不可修改结果 */
  afterRun?: (result: AgentResult, opts: RunAgentOptions) => void;
  /** runAgent() 出错时调用。可替换错误处理策略 */
  onError?: (error: Error, opts: RunAgentOptions) => void;
}

/** 注册执行钩子。按注册顺序调用（链式） */
registerHooks(hooks: SubagentHooks): void;
```
v1 实现：`runAgent()` 内部在关键节点调用已注册的 hooks。无注册时为零开销（空数组检查）。第三方可通过 `getRuntime().registerHooks({ beforeRun: ... })` 注入逻辑，无需 fork。

**以下扩展性机制在 v1 中不实现，待后续迭代根据实际需求决定 [DEFERRED]：**

**FR-14.1** Pi Event 通知（跨扩展，松耦合）：通过 `pi.events.emit("subagent:run_start", data)` 在关键节点广播事件。Pi SDK 的 `EventBus.emit()` 是**同步**的、`void` 返回，handler 也是同步的 `(data: unknown) => void`。

**FR-14.2** 策略注册（同进程，紧耦合）：`SubagentRuntime.registerAgentSource()` / `registerModelResolver()` / `registerToolFilter()` 允许第三方注入自定义策略。

**FR-14.3** Hook 中间件：`runtime.hooks.beforeRun` / `afterRun` / `onError` 允许第三方拦截执行流程。

**FR-14.4** Runtime 引用获取方式：
- 方案 A（已确认）：直接 `import { getRuntime } from "@zhushanwen/pi-subagents"`
- 方案 B（可选）：`pi.events` 广播 `"subagent:ready"` 事件
- 方案 C（可选）：`globalThis` 挂载（tintinweb/pi-subagents 已用此模式）

**FR-14.5** Pi SDK 跨扩展通信能力调研结论：
- `pi.getSharedState()` **不存在**，ExtensionAPI 无此 API
- `pi.events`（`EventBus`）是唯一的跨扩展通信机制，同步、无类型
- `globalThis` 是 JS 层面的共享手段，无类型安全
- `pi.appendEntry()` 用于持久化到 session，不适合运行时共享

## Acceptance Criteria

### AC-1: Subagents Runtime 核心

- `runAgent({ agent: "worker", task: "Fix typo" })` 能在进程内创建 session 并返回结果
- `runAgent()` 返回的 `AgentResult` 包含 `text`、`usage`、`turns`、`durationMs`
- soft turn limit：达到 `maxTurns` 时自动 steer "wrap up" 消息
- hard abort：grace turns 后 session 被 abort，返回已收集的部分结果
- `AbortSignal` 触发时 session 被 abort

### AC-2: Agent 发现

- `AgentRegistry.discover()` 返回 user 级 + project 级 + builtin agents
- frontmatter 解析支持 name、description、tools、extensions、skills 字段
- `get("nonexistent")` 抛出明确错误

### AC-3: Tool 过滤

- `builtinTools: ["read"]` 只允许 read tool
- `extensions: false` 不加载任何 extension tool
- `excludeTools: ["bash"]` 排除 bash
- 三层组合过滤结果正确

### AC-4: 并发控制

- `ConcurrencyPool(maxConcurrent=2)` 同时只跑 2 个任务，其余排队
- 完成一个后自动启动下一个
- 优先级任务插队到队首

### AC-5: Workflow 改造

- 现有 workflow 脚本无需修改即可运行
- `agent("worker", "task")` 在 Worker 线程中调用，主线程通过 agent-runtime 执行
- workflow 的 pause/resume/abort 正常工作
- `pi-runner.ts`、`jsonl-parser.ts`、`model-resolver.ts`、`agent-discovery.ts` 已删除
- `pnpm --filter @zhushanwen/pi-workflow typecheck` 零错误
- `pnpm -r typecheck` 全量零错误

### AC-6: 包管理

- `extension-dependencies.json` 包含 subagents 条目和 workflow 对它的依赖
- CLAUDE.md 目录结构已更新
- `bash .githooks/check-structure --quick` 通过
- `pnpm --filter @zhushanwen/pi-subagents typecheck` 零错误
- `pnpm -r typecheck` 全量零错误

## Constraints

- **Pi SDK API 限制**：`createAgentSession()` 创建的 session 是进程内的，不提供进程级隔离。多个 agent 共享主进程的内存和 LLM API quota
- **Worker 线程限制**：`agent()` 调用在 Worker 线程中发起，但 `createAgentSession()` 必须在主线程执行（Worker 没有 Pi SDK 上下文）。通信通过 `postMessage`。完整桥接时序见 FR-9.1.1
- **模型类型转换**：`RunAgentOptions.model` 是 `string`（"provider/modelId"），Pi SDK 的 `CreateAgentSessionOptions.model` 期望 `Model<any>` 对象。`runAgent()` 内部通过 `modelRegistry.find(provider, modelId)` 转换（FR-1.1.0 步骤 1a）
- **ThinkingLevel 枚举**：spec 中定义的 `"off"|"minimal"|"low"|"medium"|"high"|"xhigh"` 必须与 Pi SDK 的 `ThinkingLevel` 类型（来自 `@earendil-works/pi-agent-core`）完全一致。实现时需验证枚举值域
- **扩展加载**：`createAgentSession()` 通过 `resourceLoader` 参数加载扩展（返回 `extensionsResult`）。不需要也不应调用 `session.bindExtensions()`（那是 interactive mode 专用，需要 UI 上下文）。扩展加载失败时 `extensionsResult` 包含错误信息
- **Session 内存**：每个 `ManagedSession` 在完成前持有完整的消息历史。长 chain 或大 parallel 可能导致内存压力
- **Abort 行为**：`session.abort()` 会中断当前正在进行的 LLM API 调用并等待 agent idle。Hard abort 后的 `prompt()` resolve 返回已收集的部分结果（`success=false, error='aborted'`）
- **向后兼容**：workflow 脚本 API（`agent()`、`parallel()`、`pipeline()`）必须保持不变。现有的所有 workflow 脚本无需修改
- **Pi EventBus 是同步的**：`pi.events.emit()` 返回 void，handler 是 `(data: unknown) => void`，不返回 Promise
- **无共享状态 API**：Pi SDK 不提供 `getSharedState()`，跨扩展共享数据只能通过 `pi.events`（无类型）或 `globalThis`（无类型）或直接 import（有类型）

## 业务用例

### UC-1: 开发者用 workflow 脚本编排多 agent 任务

- **Actor**: 开发者（通过 `/workflow` 命令）
- **场景**: 开发者编写了一个 3 步 workflow 脚本（review → fix → test），通过 `/workflow review-pipeline` 触发
- **桥接路径**: Worker `agent()` → `postMessage('agent-call')` → 主线程 `handleAgentCall()` → `runAgent()` → `createAgentSession` + `prompt` → 结果映射 → `postMessage('agent-result')` → Worker resolve（完整时序见 FR-9.1.1）
- **预期结果**: 3 个 agent 依次在进程内执行，每步的结果正确传递给下一步，最终汇总结果展示给用户。预期显著减少 agent 调用开销（无进程启动、无重复扩展加载）

### UC-2: 开发者在运行中的 workflow 里 steer 子 agent [V2]

> **V2 范围**：v1 只提供 `ManagedSession.steer()` API 能力（编程式调用），不提供用户直接使用的 UI 入口。

- **Actor**: 开发者（通过 `/workflow` 命令的交互模式）
- **场景**: workflow 执行到第 2 步时，开发者发现方向不对，通过 UI 注入 steer 消息
- **预期结果**: 子 agent 在当前 tool 执行完成后收到 steer 消息，调整执行方向。改造前无法做到（子进程模式不支持 steer）
- **V2 需要补充的设计**：
  - 用户触发 steer 的 UI 入口（新命令或扩展现有 workflow pause）
  - steer 消息到特定 ManagedSession 的路由机制
  - Worker 阻塞在 `agent()` 调用上时的 steer 透明传递（Worker 不感知中间 steer，只拿最终结果）

### UC-3: 第三方扩展基于 subagents 构建自己的编排

- **Actor**: 第三方开发者（安装 `@zhushanwen/pi-subagents`）
- **场景**: 第三方开发者想构建自己的 agent 调度系统，需要底层的 session 创建、agent 发现、模型解析能力
- **预期结果**: 安装 subagents 后，可以 `import { runAgent, AgentRegistry } from "@zhushanwen/pi-subagents"` 直接使用，不需要自己封装 Pi SDK

## Complexity Assessment

- **subagents（L1+L2）**: 高。涉及 Pi SDK 的 `createAgentSession` 深度集成、agent 发现的文件系统扫描、5 级配置优先级合并、category 系统、级联式模型选择 TUI、会话状态持久化。V1 不含 renderCall/renderResult（那是 V2 subagent tool 的一部分）。估计 2500-2800 行
- **workflow 改造（L3B）**: 中。主要是 `agent-pool.ts` 重写 + 删除 4 个文件 + 接口适配。核心改动集中，风险可控
- **包管理**: 低。更新 `extension-dependencies.json`、`CLAUDE.md`、`package.json`

## 实现偏差说明（v2 增强：steer / background / spec 对齐）

实现过程中发现以下 spec 与 Pi SDK 实际行为的差异，记录决策：

### D1: 工具过滤须创建后执行（FR-1.7 偏差）

**Spec 描述**：三层过滤结果作为 `tools: resolvedToolAllowlist` 传入 `createAgentSession`。

**实际**：`createAgentSession({ tools })` 构造时传入 allowlist 需要预先知道工具全集，但扩展工具要等 `createAgentSession` 内部加载 `resourceLoader` 后才注册（SDK 无 `resourceLoader.getTools()` 预加载 API）。

**决策**：工具过滤在 session 创建后通过 `session.setActiveToolsByName(allowlist)` 执行。封装在 `session-factory.ts` 的 `createAndConfigureSession()` 中，消除调用方重复。功能等价（allowlist 仍正确生效），规避了构造时的工具全集未知问题。

### D2: `engine/model-resolver.ts` 保留为 shim（FR-9.2 / FR-9.9）

**Spec FR-9.2** 要求删除 `engine/model-resolver.ts`；**FR-9.9** 要求 `resolveModelForScene()` 迁移到 `agent-opts-resolver.ts`。两条 spec 自相矛盾。

**决策**：保留 `engine/model-resolver.ts` 作为 33 行 shim，委托给 `SubagentRuntime.resolveModelForScene()`。orchestrator 仍直接调用 `resolveModel()`（保持原有 import 路径，减少改动面）。功能正确，文件未删除。

### D3: ManagedSession 真实 steer（FR-1.2 增强，超出原 V1 范围）

**Spec FR-1.2** 声明 `ManagedSession.steer()` 通过 `session.steer()` 注入。原 V1 实现是 no-op（steerBuffer 从不消费）。

**v2 修复**：`createManagedSession` 重写为缓存 Pi AgentSession——首次 `prompt()` 创建并持有 session，后续 `prompt()`/`steer()`/`abort()`/`dispose()` 复用同一引用。`steer()` 真实调用 `session.steer(msg)`，在运行中的 prompt 内中途注入消息。`sessionId` 稳定。prompt() 串行化（Pi session 不支持并发 prompt）。

### D4: Background fire-and-forget + subagent LLM 工具（超出原 spec，参考 tintinweb）

**Spec** 未要求 background 能力。**v2 新增**（参考 tintinweb/pi-subagents 的 `wait:false` 模式）：

- `SubagentRuntime.startBackground(opts): BackgroundHandle` — 立即返回，后台 runAgent()。完成时 emit `pi.events 'subagents:bg:done'` + appendEntry `subagent-bg-record`。
- `getBackground(id)` / `cancelBackground(id)` / `listBackground()`。
- `subagent` LLM 工具（`pi.registerTool`）：三模式——sync（await）、background（wait:false 返回 backgroundId）、poll（backgroundId 查询）。工具名在 `EXCLUDED_TOOL_NAMES` 预留，子 agent 不递归。

### D5: SessionModelState 持久化闭环（FR-4.7.1 bug 修复）

**Spec FR-4.7.1** 要求 `pi.appendEntry("subagent-model-state", ...)` 持久化。原实现：
1. **写侧缺失**：从未调用 `pi.appendEntry`。
2. **读侧 bug**：`restoreFromEntries` 读 `e.type === "subagent-model-state"`，但 Pi custom entry 形状是 `{type:"custom", customType, data}`，永不匹配。

**v2 修复**：
- `SubagentRuntime.injectPi(pi)` 注入 pi 引用。
- `persistState()` 调 `pi.appendEntry("subagent-model-state", serializeState(state))`。
- `restoreFromEntries` 改读 `e.type === "custom" && e.customType === "subagent-model-state"`。
- `toggleYolo()` / `setSessionAgentModel()` / `setSessionCategoryModel()` 封装 mutate + persistState。

### D6: artifacts 文档（parsedOutput）

`AgentResult.parsedOutput` 的 JSDoc 增强：明确说明它是 structured-output tool 回传的 artifacts，附给 AI / 调用方的使用指南（何时传 schema、何时用 text 回退）。`subagent` 工具的 `promptGuidelines` 和返回 `details` 中点明 artifacts 语义。

### D7: config-wizard 完整操作（FR-4.8.2）

原实现只有 4 个操作且 Toggle YOLO 是空操作。v2 补全为 6 个操作：Edit / Add / **Remove** custom category / **Override agent category** / **Toggle YOLO（真实切换）** / Show。Remove 过滤 6 个默认 category 不可删。
