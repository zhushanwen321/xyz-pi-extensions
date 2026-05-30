---
verdict: pass
---

# Non-Functional Design — bash-async-background-extension

## 1. 稳定性

扩展覆盖内置 bash 工具，是 AI agent 最高频使用的工具。失败会导致 agent 完全无法执行命令。缓解措施：(1) 扩展启动时如果 shell 发现失败（找不到 bash/sh），抛出明确错误而非静默降级，确保问题在第一时间暴露；(2) session_shutdown 时对所有 running job 执行 kill，防止孤儿进程累积；(3) 所有 child_process 操作（spawn、kill、pipe）使用 try-catch 包裹，错误通过 ToolResult isError 返回而非 crash Pi 进程。

## 2. 数据一致性

Job 状态存储在 session 闭包的 Map 中（内存），不涉及持久化。Job 状态变更（running → done/failed/killed）在单线程事件循环中执行，不存在竞态条件。临时文件（stdout/stderr 输出）写入和读取可能存在时序问题（进程仍在写入时读取），使用 `readFileSync` 读取文件快照而非 stream，接受"读取时输出可能不完整"的语义——这与 poll 模式的"查询当前已收集输出"语义一致。

## 3. 性能

每次 sync 命令执行会在 `$TMPDIR/pi-bash-jobs/` 创建一个临时文件。高频执行场景（AI agent 短时间内执行数十个命令）会创建大量小文件。缓解：(1) 命令正常完成后立即删除临时文件（sync 模式无需保留）；(2) 仅 timeout detach 和 background 模式的临时文件保留到 job 完成或 session 结束。truncateTail 操作在内存中进行，输入来自 `readFileSync`，2000 行 / 50KB 限制确保内存使用可控。

## 4. 业务安全

bash-async 的工具描述（description 字段）是 AI agent 的行为指令。如果描述引导不当（如"所有命令都应使用 background 模式"），可能导致 AI 滥用后台执行，消耗系统资源。缓解：描述中明确"仅在命令预计超过 120s 时使用 background"，并通过 maxBackgroundJobs 限制并发数。Kill 功能允许 AI 终止进程，但只能终止当前 session 的 job，不存在跨 session 攻击面。

## 5. 数据安全

命令输出可能包含敏感信息（密钥、token、内部 IP）。临时文件存储在 `$TMPDIR`（系统临时目录），权限遵循系统默认。风险与内置 bash 工具一致（内置 bash 也使用临时文件存储截断输出）。扩展不记录命令内容到任何持久化存储。Session shutdown 时删除所有临时文件。Pi settings 文件（`~/.pi/agent/settings.json`）和扩展配置文件（`~/.pi/agent/bash-async.json`）读取时不记录内容，仅在内存中使用。
