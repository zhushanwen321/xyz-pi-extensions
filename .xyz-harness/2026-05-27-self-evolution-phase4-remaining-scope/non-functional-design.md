---
verdict: pass
---

# Non-Functional Design — Self-Evolution Phase 4

## 1. 稳定性

evolution-engine 以 Pi extension 形式运行在主进程内。`runJudge` 通过 `child_process.spawn` 启动独立 pi 进程做 LLM 推理，主进程设置 120s 超时和 SIGTERM 清理，不会因 Judge 卡死而阻塞主循环。`execFileSync` 调用 analyzer 设置了 60s 超时。两个外部进程调用的失败都不会导致主进程崩溃（catch 后 throw Error，由 pi 框架转为用户可见错误信息）。

## 2. 数据一致性

状态文件使用简单的 read-merge-write 模式（`pending.json`、`history.jsonl`、`auto-trigger.flags/`）。`history.jsonl` 采用 append-only 写入，避免了并发覆盖。`pending.json` 在每次 apply/skip 后全量覆写，单 session 使用时无并发风险。多 session 并行写入 pending.json 时可能丢失数据，但这是已知限制（Phase 1 注释中已标注）。

## 3. 性能

`/evolve` 的主要延迟来自 LLM Judge 子进程（典型 5-30s）。analyzer 脚本处理 7 天数据通常 < 10s。`handleEvolveStats` 读取 7 个 daily JSON 文件（每个 < 50KB），聚合计算在毫秒级完成。自动触发规则在 session_start 时检查，读取 14 个 daily 文件 + 1 个 skill-triggers 文件，不影响 session 启动延迟（< 100ms）。

## 4. 业务安全

LLM Judge 产出的建议通过 diff 修改 CLAUDE.md 或 skill 文件。这些文件直接作为 AI 行为的系统提示词。恶意或低质量建议可能降低 AI 行为质量。缓解措施：（1）路径白名单限制只能修改 `~/.pi/agent/` 下的 `.md` 文件；（2）D3.3 门控确保建议质量 ≥ 7/10；（3）所有 apply 操作前自动备份，支持一键 rollback；（4）尝试 git commit 保留审计记录。用户应始终审查 diff 内容后再 apply。

## 5. 数据安全

evolution-data 目录（`~/.pi/agent/evolution-data/`）存储 session 级别的聚合统计数据，不含源代码内容或用户敏感信息。daily JSON 记录 token 消耗、工具调用计数、skill 触发频率——这些都是聚合指标，不包含 prompt/response 文本。analyzer 生成报告时处理原始 session JSONL（可能含代码片段），但输出报告只包含统计摘要。报告文件保存在 `~/.pi/agent/` 下，权限由操作系统文件系统控制。
