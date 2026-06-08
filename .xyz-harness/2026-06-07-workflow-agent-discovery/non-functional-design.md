---
verdict: pass
---

# Non-Functional Design — Workflow Agent Discovery

## 稳定性

改动对系统稳定性的影响极低。AgentRegistry 是独立模块，不影响现有的 `agent()` 调用路径（无 agent 字段时完全跳过）。最坏情况是发现逻辑失败（目录不存在、文件读取错误），都做了静默跳过处理，不会中断 workflow 执行。

## 数据一致性

无持久化数据。AgentRegistry 是 session 级别的内存缓存（Map），每次 session_start 重建。临时文件是 write-once-read-once 的中转文件，用 UUID 防止并发冲突，finally 块确保清理。不存在数据一致性问题。

## 性能

`discoverAll()` 在 session_start 时同步执行，扫描 ~5 个目录、读取 < 20 个 `.md` 文件（每个 < 10KB）。预估耗时 < 50ms，远低于用户可感知阈值。不使用 glob 递归（只扫描 `agents/` 一级目录），文件过滤是简单的字符串匹配。对 pi 启动时间的影响可忽略。

## 业务安全

Agent `.md` 文件包含 system prompt 文本，通过 `--append-system-prompt` 注入到 pi 子进程。风险等同于用户在对话中手动输入这些文本——pi 的安全边界（文件访问控制、命令执行确认）不变。agent 注入的 system prompt 不能绕过 pi 的权限机制。

## 数据安全

临时文件写入 `os.tmpdir()/pi-workflow/`，内容为 agent system prompt 文本。无敏感信息（不含 API key、用户数据）。文件权限遵循系统默认（通常 644），在子进程退出后立即删除。`os.tmpdir()` 通常是 `/tmp`，系统重启后自动清理残留文件。
