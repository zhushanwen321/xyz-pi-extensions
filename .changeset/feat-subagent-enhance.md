---
"@zhushanwen/pi-subagents": minor
"@zhushanwen/pi-workflow": minor
---

新增 `@zhushanwen/pi-subagents` 包（首次发布），提供进程内 subagent 执行运行时（agent 发现、模型解析、并发控制）。`@zhushanwen/pi-workflow` 改用 subagents 进程内执行，移除 spawn 子进程模型，添加 `@zhushanwen/pi-subagents` 依赖，删除 `agents/` 资源、清理 3 个内部模块（agent-discovery / jsonl-parser / agent-pool 重构）。
