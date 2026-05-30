# ADR-010: bash-async 覆盖内置 bash 工具 + 进程管理方式

## Context

bash-async 扩展需要增加 background 执行、超时 detach、poll/kill 能力。有两个决策点：

1. 工具名：覆盖内置 `bash`（方案 A）或新建 `bash-async` 工具（方案 B）
2. 进程管理：使用 Pi 导出的 `BashOperations.exec()` 或 `child_process.spawn` 直接管理

## Decision

1. 选择方案 A：通过 `registerTool("bash", ...)` 覆盖内置 bash
2. 选择 `child_process.spawn` 直接管理（不使用 `BashOperations.exec()`）

## Rationale

**工具覆盖（方案 A）：**
- AI 无需改变使用习惯，同一个工具名处理所有场景
- Pi 官方 `tool-override.ts` 示例已验证可行性

**spawn 直接管理：**
- `BashOperations.exec()` 的 timeout 机制会 kill 进程（`killProcessTree`），与 detach 需求根本冲突
- `BashOperations.exec()` 是阻塞 Promise，无法实现 background 模式的「spawn 后立即返回」
- 与 subagent 扩展的模式一致（CLAUDE.md 中已知的 `child_process.spawn` 例外）

## Trade-off

- 需要自行实现 shell 发现逻辑（参照 Pi 内部 `getShellConfig` 约 30 行），因为 Pi 不导出 `getShellConfig`/`getShellEnv`
- 截断逻辑使用 Pi 导出的 `truncateTail`（纯工具函数，无进程耦合），不需要重新实现
- 用户卸载扩展后 bash 恢复为内置版本，timeout 语义恢复为 kill
