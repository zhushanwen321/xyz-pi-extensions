# 核心层 — Runtime、runAgent、ManagedSession、ConcurrencyPool

> 源：agent-runtime-workflow FR-1/FR-7/FR-11 + D1-D7

---

## 1. SubagentRuntime（进程单例）

- 工厂函数 `export default function(pi)` 创建骨架（无 modelRegistry）
- `pi.on("session_start")` 注入 `ctx.modelRegistry` + `ctx.sessionManager`
- `getRuntime()` 返回单例；session_start 前调用 resolveModel 抛清晰错误

### 公共 API

```typescript
// 核心执行
runAgent(opts: RunAgentOptions): Promise<AgentResult>
startBackground(opts: BackgroundOptions): BackgroundHandle  // 见 core-background.md
getBackground(id: string): BackgroundStatus | undefined
cancelBackground(id: string): boolean
listBackground(): BackgroundStatus[]

// ManagedSession（P2）
createManagedSession(opts: ManagedSessionOptions): ManagedSession

// 状态查询
listRunningAgents(): AgentExecutionState[]
getAllRecords(): SubagentRecord[]  // 见 core-state.md

// Model 解析
resolveModelForAgent(agent?, override?): ResolvedModel | undefined  // 见 core-model.md

// 配置
getAgentConfig(name?): AgentConfig | undefined
onChange(fn: () => void): () => void  // 事件总线（/subagents list 刷新用）

// 生命周期
dispose(): void
```

---

## 2. runAgent（一次执行的全生命周期）

### 执行步骤

```
1. PARAM PARSING
   model string → resolveModelForAgent → Model<any>（fallback chain 见 core-model.md）
   thinkingLevel → validate enum + model.thinkingLevelMap
   agent config → AgentRegistry.get（systemPrompt/tools/model）

2. CONCURRENCY
   pool.acquire(priority)  // sync=0, bg=1000

3. BUILD CONTEXT
   DefaultResourceLoader（appendSystemPrompt, skillPath）
   tool filtering（三层 → allowlist，见 core-model.md）

4. CREATE SESSION
   createAgentSession({ model, thinkingLevel, resourceLoader, tools })
   session.setActiveToolsByName(allowlist)  // D1: post-creation filtering
   EventBridge.subscribe(session, onEvent)

5. CREATE STATE
   AgentExecutionState（id, agent, model, thinkingLevel, startedAt）
   → _runningAgents.set(id, state)

6. EXECUTE
   session.prompt(task)
   onEvent → updateStateFromEvent(state, event) → executionStateToDetails → onUpdate

7. COLLECT RESULT
   collectResult(bridge) → AgentResult
   completeState(state, result, status)

8. CLEANUP
   session.dispose()
   pool.release()
   _completedAgents.set(id, { state })  // 归档
```

### RunAgentOptions

```typescript
interface RunAgentOptions {
  task: string;
  agent?: string;
  model?: string;            // "provider/modelId"，override config chain
  thinkingLevel?: string;
  maxTurns?: number;
  graceTurns?: number;       // default 2
  signal?: AbortSignal;
  skillPath?: string;
  schema?: Record<string, unknown>;
  appendSystemPrompt?: string[];
  onEvent?: (event: AgentEvent) => void;
  pool?: ConcurrencyPool;
  priority?: number;         // 0=highest, Infinity=none
  _skipWidget?: boolean;     // internal: bg 跳过 widget 注册
}
```

### AgentResult

```typescript
interface AgentResult {
  text: string;
  parsedOutput?: unknown;     // structured-output tool 的 details
  usage?: { input, output, cacheRead, cacheWrite, cost };
  turns: number;
  durationMs: number;
  success: boolean;
  error?: string;
  sessionId: string;
  sessionFile?: string;
  toolCalls: ToolCallEntry[];
  worktree?: { branch?: string; hasChanges: boolean };
}
```

---

## 3. ManagedSession（P2，长生命周期 session）

```typescript
interface ManagedSession {
  prompt(task: string, opts?: { maxTurns?; signal? }): Promise<AgentResult>;
  steer(message: string): void;
  abort(): void;
  dispose(): void;
  readonly sessionId: string;
  readonly alive: boolean;
}
```

- 第一次 prompt 创建 + 缓存 Pi AgentSession；后续复用（D3）
- prompt() 串行化（Pi session 不支持并发 prompt）
- 用于 orchestration steer（FR-O5.7，P2）

---

## 4. ConcurrencyPool

```typescript
class ConcurrencyPool {
  constructor(maxConcurrent: number);
  acquire(priority?: number): Promise<void>;  // 0=highest
  release(): void;
  get activeCount(): number;
  get queueCount(): number;
  get maxConcurrent(): number;
}
```

- 全局实例（`config.maxConcurrent`，default 4），runtime 持有
- priority 小 = 高（G-001 修正）：sync=0，bg=1000
- workflow 可传 per-run pool（FR-7.1.1）
- 第三方扩展不传 pool 时用全局

---

## 5. EventBridge（SDK 事件翻译）

| SDK AgentSessionEvent | AgentEvent | 提取 |
|----------------------|-----------|------|
| tool_execution_start | tool_start | toolName（丢弃 args） |
| tool_execution_end | tool_end | toolName, result, isError |
| message_update (assistantMessageEvent) | text_delta | delta |
| message_update (reasoning field) | thinking_delta | delta（SDK 支持时） |
| turn_end | turn_end | （计数用） |
| message_end | message_end | usage |
| message_end (stopReason error/aborted) | error | error |
| compaction_start | compaction | — |

### 降级策略

如果 SDK 的 `assistantMessageEvent` 不暴露 reasoning 字段：不产出 `thinking_delta`。thinking 类型在 AgentEventLogEntry 中不出现。**这是可接受的降级**——滚动区只显示 tool/text_output。

---

## 6. forkContext（父对话 fork）

```typescript
forkContext(parentSession: SessionManager, opts?: { maxExchanges?: 5; maxTokens?: 4000 }): ForkResult
```

- 提取父 session 最近 5 轮 user→assistant 对话（跳过 toolResult）
- ≤ 4000 token（~12000 中文字）
- 作为 `# Parent Conversation Context` 前缀到 subagent task
