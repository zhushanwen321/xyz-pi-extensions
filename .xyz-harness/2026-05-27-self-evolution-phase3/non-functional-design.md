---
verdict: pass
---

# Non-Functional Design — Evolution Engine

## 1. 稳定性

evolution-engine 是 Pi 进程内执行的 Extension，judge.ts 的子进程崩溃不会影响主 Pi 进程。每个 command handler（handleEvolve、handleEvolveApply 等）内部 try-catch 包裹，未预期异常返回错误 content 而非崩溃。monitor.ts 在 session_start 中执行，任何异常被 catch 后静默跳过（不影响 session 启动）。

关键风险缓解：Judge 子进程 120s 超时保护 + analyze.py 60s 超时保护，防止无限等待。

## 2. 数据一致性

pending.json 使用覆盖写（write-over），不依赖 append，避免半写状态。history.jsonl 使用 append（追加写），即使写入中断也只影响最后一行，不影响已有记录。backup 操作先于 diff apply，确保 apply 失败时可以从 backup 恢复。

并发控制：Pi 单进程单 session 执行 command handler，不存在多 session 并发写同一文件的问题。但多 session 场景下（未来）可能需要文件锁，当前不处理。

## 3. 性能

monitor.ts 在 session_start 中执行，读取 daily/ 下 14 个 JSON 文件 + tool-stats.json + skill-triggers.json，总计约 1-2MB。同步读取延迟 < 100ms，不影响 session 启动体验。

judge.ts 的 LLM Judge 子进程是主要性能瓶颈：spawn Pi + 模型推理预计 30-60s。用 "Running evolution analysis..." 占位提示用户等待。analyze.py 执行约 5-15s（取决于 session 数量），通过 `--sample` 参数可加速。

## 4. 业务安全

evolution-engine 修改的文件是 CLAUDE.md 和 SKILL.md——这些是 AI 行为的指令文件。错误的修改可能导致 agent 行为异常。缓解措施：(1) 所有修改需人工 TUI 确认；(2) 每次修改前自动 backup；(3) 支持一键 rollback；(4) git commit 保留变更历史。

自动触发规则只产生提示消息，不自动执行任何修改，确保人工始终在环。

## 5. 数据安全

信号数据存储在 `~/.pi/agent/evolution-data/`，包含 session 工作目录路径（cwd）、工具调用内容摘要等。LLM Judge 子进程读取这些数据时，数据通过本地文件系统传递，不经网络。Judge 子进程使用 `--no-session`，不产生会话记录。

applySuggestion 写入的目标文件路径由 Judge 建议（targetPath），applier.ts 在应用前执行运行时路径白名单校验：targetPath 必须以 `~/.pi/agent/` 开头且扩展名为 `.md`。不在白名单内的路径直接拒绝，返回 `{ success: false, reason: "path not allowed" }`。
