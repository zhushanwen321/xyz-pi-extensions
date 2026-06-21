# 核心层 — Background 执行、回注通知、Dedup

> 源：subagent-orchestration FR-O1/FR-O2/FR-O5.4

---

## 1. startBackground

```typescript
startBackground(opts: BackgroundOptions): BackgroundHandle

interface BackgroundOptions {
  task: string;
  agent?: string;
  model?: string;
  thinkingLevel?: string;
  skillPath?: string;
  appendSystemPrompt?: string[];
  schema?: Record<string, unknown>;
  maxTurns?: number;
  graceTurns?: number;
  signal?: AbortSignal;
  onUpdate?: (details: Partial<AgentExecutionState>) => void;  // 回流 live 状态
  onComplete?: (record: BgRecord) => void;
}

interface BackgroundHandle {
  readonly id: string;
  readonly status: "running";
}
```

### 执行流程

```
1. buildContext()
2. resolveModelForAgent(agent) → model, thinkingLevel（创建时确定，写入 state）
3. 创建 BgRecord（内嵌 AgentExecutionState，agent/model 即时填，turns=0, totalTokens=0）
4. _bgRecords.set(id, record) + FIFO 淘汰（cap 50, skip running）
5. detached runAgent({... onEvent: state.onEvent() + onUpdate 回流})
   → _skipWidget: true（不注册 widget，不写 sync history）
   → priority: 1000（低，不抢占 sync）
   → controller.signal（cancelBackground 用，不是 opts.signal）
6. .then(result):
   → completeState(state, result, status)
   → sendMessage 回注通知
   → appendEntry("subagent-bg-record") + history.append
7. .catch: 区分 abort（cancelled）vs 真实 error（failed）（D-P0-05）
```

### opts.signal 转发

```typescript
const signal = controller.signal;
if (opts.signal) {
  if (opts.signal.aborted) controller.abort();
  else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
}
```

外部 Esc（opts.signal abort）→ 转发到 controller → runAgent abort。

---

## 2. 回注通知（FR-O1）

### sendMessage 注入

background 完成（success/fail/cancel）→ 注入完成通知到主对话：

```typescript
pi.sendMessage(
  { customType: "subagent-bg-notify", content: formatBgCompletionMessage(record), display: true },
  { triggerTurn: true },
);
```

### triggerTurn 时序（G-016 已验证）

| 主 agent 状态 | triggerTurn 行为 |
|--------------|-----------------|
| idle（!isStreaming） | 新 LLM turn（消息作为 prompt） |
| executing（isStreaming） | triggerTurn **忽略**，消息进 steering 队列（注入下一次 assistant response 前）。不中断当前 turn。 |

### formatBgCompletionMessage

```
Background task {status}: **{agent}**{taskInfo}

{result 摘要 或 error}

backgroundId: {id}
Session file: {sessionFile}（如有）
```

- status：done→"completed"，failed→"failed"，cancelled→"cancelled"
- taskInfo：orchestration 进度 ` (2/4)`；single 无

### sendMessage 异常处理（G-025, FR-O1.7）

```typescript
try {
  pi.sendMessage({ customType: "subagent-bg-notify", ... }, { triggerTurn: true });
} catch (err) {
  // stale runtime sync throw → 不标记 background failed（agent 已完成）
  // fallback: appendEntry 持久化（best-effort）
  try { pi.appendEntry("subagent-bg-record", { id, status: record.status }); } catch {}
}
```

异步投递失败（session closed）不可感知——接受限制，结果仍可通过 getBackground 查询。

---

## 3. Dedup（防双发）

### sendMessage 双发（FR-O1.3）

cancelBackground 写 cancelled + runAgent catch 写 failed → 两次 sendMessage。

**方案**：移植 completion-dedupe.ts 的 TTL 机制：
- `Map<string, number>`（key → expiry timestamp）
- `buildCompletionKey(data, scope)` 构造 dedup key
- TTL = 10 分钟
- key 存在且未过期 → skip；否则记录 key + now+TTL → allow

### history 双写（FR-O1.6）

cancelBackground 写 cancelled + runAgent catch 写 failed → history.jsonl 两条。

**方案**：listHistory 按 id merge，同 id 取最新 endedAt（cancelled 优先）。长期：cancelBackground 不写 history，让 runAgent catch 检查 signal.aborted → 写一条 cancelled。

---

## 4. Multi-background merge window（FR-O1.5）

多个 background 完成在短窗口内 → 合并为一条通知。

```
first completion → 立即 sendMessage（零延迟）+ 启动 2000ms 窗口
窗口内完成 → 入队
窗口到期 → 合并队列中所有完成 → 一条 sendMessage + triggerTurn
```

- G-028：第一个事件零延迟（不等窗口），后续入队
- G-029：窗口 timer `unref()`，runtime dispose() 清理
- orchestration 不受影响（内部 Promise.all 同步聚合，完成即一次 sendMessage）

---

## 5. Per-agent defaultBackground（FR-O2）

```typescript
// agent.md frontmatter
defaultBackground: true
```

### 判定逻辑

```typescript
let effectiveWait: boolean;
if (params.wait !== undefined) {
  effectiveWait = params.wait;              // 显式优先
} else {
  const config = rt.getAgentConfig(params.agent);
  effectiveWait = config?.defaultBackground ? false : true;  // 配置其次，默认 sync
}
```

### D-P0-02

`defaultBackground: false` → normalized to `undefined`（与 missing 同）。解析器只 `"true"`→`true`。

---

## 6. priority 方向（FR-O4, G-001）

**小 = 高**（concurrency-pool.ts 事实）：
- sync：`priority: 0`（最高，保证响应）
- background：`priority: 1000`（低，不抢占 sync）
- orchestration sync step：`priority: 0`
- orchestration async step：`priority: 1000`
- 不传：`Infinity`（无优先级）

---

## 7. BgRecord 清理（FR-O5.9, D-P0-01）

- cap 50 FIFO
- 淘汰时**跳过 running**（evict running 会破坏 cancelBackground）
- 全 running → 暂时超限（宁可超限也不丢失 cancel 能力）
