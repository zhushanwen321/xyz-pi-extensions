---
verdict: pass
---

# Non-Functional Design — Workflow Fullscreen TUI View

## 1. 稳定性

改动集中在 workflow extension 内部，不跨进程边界。最不稳定点是 `orchestrator-events.ts` 的 setInterval tick——设计为订阅数归零时清掉 interval，listener 抛异常用 try/catch 吞掉。视图关闭时必须 unsubscribe，否则 interval 持续空转。agent-pool.ts 的 `processJsonlEvent` 改动是纯增量（在现有 switch 分支中加一行 push），不影响已有的 structured-output 解析路径。

## 2. 数据一致性

`toolCalls[]` 是 append-only 数组，由 `processJsonlEvent` 在 JSONL 流中逐事件追加。因为 pi 子进程的 JSONL 是有序的，toolCalls 顺序与实际执行顺序一致，无并发问题。state.ts 序列化/反序列化自动覆盖新字段（JSON 序列化透传数组对象）。orchestrator 崩溃时 toolCalls 随 AgentResult 一起持久化到 session JSONL。

## 3. 性能

`toolCalls[]` 内存开销可忽略（每个 tool call 一个 `{ name, input }` 对象，input 完整存储但通常 < 1KB）。渲染侧只在 Activity section 格式化时遍历数组，O(n) 且 n 通常 < 50。tick 事件 1s 间隔触发视图重渲染，每次重渲染遍历 trace 节点构造 sidebar + main 文本——trace 节点通常 < 100，80×24 终端渲染耗时 < 5ms。

## 4. 业务安全

无敏感数据泄露风险。toolCalls 的 `input` 字段可能包含文件路径和 bash 命令，但都在用户本地终端展示，不发送到外部。`s save` 保存的 trace markdown 存放在 `~/.pi/agent/` 下，与 Pi 的其他 session 数据同目录，受相同的文件系统权限保护。

## 5. 数据安全

`s save` 写入文件使用 `fs.promises.writeFile`，目标目录 `~/.pi/agent/workflow-traces/` 在首次写入时 `mkdirSync({ recursive: true })`。无用户输入拼接到文件路径（runId 由 orchestrator 内部生成），不存在 path traversal 风险。
