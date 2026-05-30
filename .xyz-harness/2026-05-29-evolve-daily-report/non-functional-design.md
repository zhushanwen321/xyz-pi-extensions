---
verdict: pass
---

# Non-Functional Design — Evolve Daily Report

## 1. 稳定性

每日自动分析通过 fire-and-forget 模式执行，不阻塞 session_start 的核心流程（monitor.ts 检查 + flag 注入）。pipeline 中的任何环节失败（analyzer 超时、Judge 空输出、文件权限错误）都被 try/catch 兜底，错误写入 `.last-run-status` 和日志。下一次 session 启动时不会重试当天已标记为 failed 的分析（因为 lock 释放后不会再触发），但用户可以通过手动 `/evolve` 获取建议。这种设计确保了即使每日分析模块整体崩溃，现有 `/evolve`、`/evolve-apply` 等命令不受影响。

## 2. 数据一致性

并发控制通过 lock 文件 + PID 检测实现。lock 文件写入 `{ pid, timestamp }`，后续检测到 lock 时先验证 PID 是否存活，避免 stale lock 阻塞后续执行。报告文件使用 temp-file-rename 模式（写 `.tmp` → `rename`），确保读方要么看到完整报告，要么看不到文件，不会读到截断内容。`pending.json` 的并发写入风险较低（同一台机器上不太可能同时运行两个 Pi session 并同时触发每日分析），但 lock 机制仍然提供了保护。

## 3. 性能

每日分析的耗时主要在 Python analyzer（最多 60s 超时）和 LLM Judge（spawn pi 子进程，约 10-30s）。由于是 fire-and-forget，不影响 session 响应时间。文件扫描（GC、报告列表）操作的是 `daily-reports/` 目录，文件数量受 30 天 GC 限制（最多 30 个 Markdown 文件），`readdir` + `stat` 的开销可忽略。Markdown 报告生成是纯字符串拼接，无性能风险。

## 4. 业务安全

每日分析产出的建议与手动 `/evolve` 产出的建议性质相同——都是 LLM 生成的修改指令。不自动 apply 任何建议，所有 apply 需要用户显式通过 `/evolve-apply` 或与 AI 对话触发。每日报告本身是只读的 Markdown 文件，不修改任何配置。`.last-run-status` 和 lock 文件是内部元数据，不影响用户可见行为。

## 5. 数据安全

每日报告存储在 `~/.pi/agent/evolution-data/daily-reports/`，权限继承用户主目录的 umask。报告内容包含指标数据（session 数量、token 消耗、工具调用统计）和建议（修改目标路径、修改指令），不包含用户代码、对话内容或敏感信息。建议的 `targetPath` 指向用户本地的 `~/.pi/agent/` 下的文件路径，不泄露远程服务信息。GC 清理确保报告不会无限累积。
