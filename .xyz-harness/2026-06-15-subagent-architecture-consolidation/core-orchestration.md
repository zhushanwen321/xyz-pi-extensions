# 核心层 — Orchestration（chain / parallel / fanout DAG）

> 源：subagent-orchestration FR-O3/FR-O5

---

## 1. orchestrate 工具

```typescript
orchestrate({
  tasks?: TaskItem[],         // parallel
  chain?: ChainStep[],        // chain（含 wave/fanout）
  concurrency?: number,
  failFast?: boolean,         // chain/parallel default true
  async?: boolean,            // 整个 DAG 后台
})
```

与 `subagent` 工具独立（G-013）。`subagent` 保持 single sync/bg/poll 不变。

---

## 2. 执行模式

### parallel（tasks 并发）

```
tasks: [{agent:"scout", task:"a"}, {agent:"reviewer", task:"b"}]
→ mapConcurrent（concurrency 限制）并发执行
→ Promise.all → aggregateParallelOutputs（按 task 顺序拼接）
→ failFast=true：任一失败 → abort 其余 → 返回 partial + error
```

### chain（顺序传递）

```
chain: [{agent:"scout", task:"gather", as:"ctx"},
        {agent:"worker", task:"implement from {outputs.ctx}"}]
→ scout 执行 → 结果存 ChainOutputMap["ctx"]
→ worker 的 task 模板 {outputs.ctx} 替换为 scout 结果文本
→ 严格顺序，无并发
→ failFast=true（default）：步骤失败 → abort 后续（mark skipped）
```

**`{outputs.name}` 规则**（G-003）：纯文本替换，不支持 JSON path（`{outputs.scan.files}` 非法）。JSON path 仅在 fanout 的 `expand.from.path` 和 `{item.path}` 中支持。

### wave（chain 内的 parallel barrier）

```
chain: [{tasks:[A,B,C]}, {tasks:[D,E]}]
→ wave 1: [A,B,C] 并发 → Promise.all barrier → 聚合
→ wave 2: [D,E] 并发 → barrier → 聚合
→ 每个 wave 是 chain 的一个步骤
```

### fanout（动态展开）

```
chain: [{
  expand: { from: { output: "scan", path: "/files" }, maxItems: 8 },
  parallel: { task: "review {item.path}" },
  collect: { as: "reviews" }
}]
→ resolveDynamicFanoutItems：从 scan 的结构化输出 JSON Pointer /files 提取 N items
→ 每个 item 按 parallel.task 模板 + {item.path} 生成子任务
→ 并发执行（concurrency 限制）
→ collect.as 收集为数组，注入 ChainOutputMap["reviews"]
```

**约束**：
- maxItems **必须显式配置**（step 级 `expand.maxItems` 或 config `dynamicFanout.maxItems`），否则 throw（G-002）
- expand 引用的 output 必须有 `outputSchema`（结构化输出前提）
- expand.onEmpty：`"skip"`（default，返回空数组）/ `"fail"`（throw）
- expand.key：配置则去重，重复 key throw

---

## 3. ChainOutputMap

```typescript
type ChainOutputMap = Record<string, {
  text: string;
  structured?: unknown;
  agent: string;
  stepIndex: number;
}>;
```

- 执行期中间数据，orchestration 完成后清理（G-032）
- `{outputs.name}` 替换：`resolveOutputReferences(task, chainMap)` → `entry.text`

### 大输出 auto-spill（G-012）

单步结果 > `CHAIN_OUTPUT_INLINE_MAX_TOKENS`（default 4000）：
- spill 到 `{tmpdir}/chain-{runId}/step-{n}-output.md`
- 下一步 `{outputs.name}` 替换为 `"[Large output saved to {path}. Summary: {前 500 字}...]"`
- spill 失败 → fallback inline 截断 + warning（G-035）
- chain 完成/取消后清理 temp 目录（G-031）

### file-only 输出（FR-O3.5）

`output: "reports/x.md", outputMode: "file-only"`：结果只写文件，不注入下一步 context。

---

## 4. DAG 图结构

```typescript
interface OrchestrationGraphNode {
  id: string;              // "step-0", "step-1-agent-2"
  kind: "step" | "parallel-group" | "dynamic-parallel-group" | "agent";
  agent: string;
  label: string;
  phase?: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  stepIndex: number;
  outputName?: string;
  error?: string;
  // 渲染字段（G-039/040）
  model?: string;
  startedAt?: number;
  completedAt?: number;
  usage?: { input: number; output: number; totalTokens: number };
  result?: string;
  recentEvents?: AgentEventLogEntry[];  // ring buffer 20
  children?: OrchestrationGraphNode[];  // parallel-group / dynamic-parallel-group
}
```

### skipped 处理（G-041）

skipped 是 subagents 自定义状态（不在 WorkflowNodeStatus 中）：
- 不影响 group 聚合
- group 聚合：any failed → failed；any running → running；all completed+skipped → completed

---

## 5. sync vs async orchestration

### sync（阻塞调用者）

```
orchestrate({chain:[...]})
→ execute() 维护 OrchestrationToolDetails
→ 每个 step 的 runAgent 包 onEvent 闭包（捕获 node ref）
→ onEvent: updateNodeFromEvent(node, event) + pushUpdate() → block 刷新
→ 全部完成 → 聚合结果返回
```

### async（后台 DAG）

```
orchestrate({chain:[...], async:true})
→ 立即返回 { runId, status: "running" }
→ runtime.runOrchestrationDetached({details, onStepEvent, onComplete, signal})
  → 内部管理 DAG 执行 + 多 step onEvent 聚合
  → onStepEvent: updateNodeFromEvent + onUpdate → block 持续刷新
  → 全部完成 → 单个 BgRecord 聚合 + sendMessage 回注一次
```

**async 不走 startBackground**（G-042）——startBackground 是单 agent 设计。orchestration 用独立的 `runOrchestrationDetached`。

---

## 6. cancel orchestration（abort 整个 DAG）

```
cancelBackground(runId)
→ 遍历所有 in-flight step，abort 每个（cascade AbortController 树）
→ 未开始的 step mark skipped
→ 已完成的结果保留在 ChainOutputMap（post-mortem）
→ BgRecord.status = cancelled
→ listener { once: true } 自动清理（G-030）
```

---

## 7. steer（P2）

```
/subagents steer <runId> <stepIndex> <message>
→ runtime.steerBackground(runId, stepIndex, message)
→ 路由到对应 ManagedSession.steer(message)
→ 仅对当前执行中的 step 有效
```

需要 ManagedSession（非一次性 runAgent）。P2 阶段实现。

---

## 8. 预执行参数校验（FR-O3.1a）

`validateSubagentParams(params, rt): string | null` 在 execute() 入口、**任何执行前**全量校验：

| 检查 | 失败行为 |
|------|---------|
| agent 存在于 registry？ | tool error + 列出可用 agent |
| model 可解析 + hasConfiguredAuth？ | tool error + 列出可用 model |
| thinkingLevel 合法 + model 支持？ | tool error |
| task 非空？ | tool error |
| maxTurns/graceTurns/concurrency 正整数？ | tool error |
| skillPath 文件存在？ | tool error |
| schema 是合法 JSON Schema？ | tool error |
| chain `{outputs.name}` 引用完整？ | tool error |
| fanout maxItems 显式配置？ | tool error |
| fanout expand.from 合法 JSON Pointer？ | tool error |

多步错误 → 收集 ALL，一次返回。

---

## 9. 编排 × background 正交关系

```
                    ┌─ sync（阻塞，返回聚合结果）
orchestration DAG ──┤
（chain/parallel/   └─ async:true（返回 runId，DAG 后台，全完成回注一次）
 fanout）
```

single background（`wait:false`）vs orchestration background（`async:true`）：
- single：每个子 agent 独立 fire-and-forget，各自回注
- orchestration：整个 DAG 一个 BgRecord 聚合，全完成回注一次
