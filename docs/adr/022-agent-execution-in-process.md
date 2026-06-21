# ADR-022: Agent 执行引擎从子进程改为进程内

## Status: Accepted

## Context

workflow 扩展当前通过 `spawn("pi", ["--mode", "json"])` 子进程执行 agent。每次调用都创建一个新 Pi 进程，包含完整的扩展加载和模型初始化。Pi SDK 提供了 `createAgentSession()` API，可在当前进程内创建独立 session 执行 agent，tintinweb/pi-subagents 和 nicobailon/pi-subagents 均采用此方式。

## Decision

采用进程内 `createAgentSession()` 执行模式，替代子进程 spawn。

## Consequences

- 性能提升：无进程启动开销，无重复扩展加载
- 支持 steer/abort：进程内 session 可通过 `session.steer()` 注入消息、`session.abort()` 优雅终止
- 资源共享：子 agent 可访问主进程的所有 extension tools
- 隔离降低：多个 agent 共享进程内存和 LLM API quota，一个 agent 的 OOM 可能影响主进程
- 通信简化：从 JSONL 事件流解析改为直接回调
