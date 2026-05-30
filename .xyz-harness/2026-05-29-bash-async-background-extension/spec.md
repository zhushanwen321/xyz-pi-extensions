---
verdict: pass
---

# bash-async: 增强版 Bash 工具

## Background

Pi 的内置 bash 工具是同步阻塞的——进程执行期间 AI agent 被挂起，无法继续工作。当命令长时间无输出（编译、测试套件、部署、长运行 server）时，AI 会被无限卡住。

用户的核心痛点：
1. 执行 bash 后卡住长时间无输出，AI 被 block，不会自动终止
2. 无法在后台运行命令然后继续做其他事
3. 无法查询或终止之前启动的进程

本项目创建 `bash-async` 扩展，通过 `registerTool("bash", ...)` 覆盖内置 bash 工具，增加 background 执行、超时 detach、poll 查询和 kill 终止四种能力。

## Functional Requirements

### FR-1: 工具覆盖与兼容性

扩展注册名为 `bash` 的工具，完全替代内置 bash 工具。**必须保持与内置 bash 的向后兼容**。

**进程管理方式**：使用 `child_process.spawn` 直接管理进程生命周期（与 subagent 扩展一致，是 CLAUDE.md 中已知的例外）。不使用 `BashOperations.exec()`，因为其 timeout 机制会 kill 进程，与 detach 需求冲突。

**Shell 发现逻辑**（参照 Pi 内部 `getShellConfig` 实现自行编写，约 30 行）：
1. 检查用户配置的 `shellPath`（从 Pi settings 文件读取）
2. Unix: `/bin/bash` → PATH 上的 bash → `sh` fallback
3. Windows: Git Bash → PATH 上的 bash.exe → 报错

**Shell 环境变量**（参照 Pi 内部 `getShellEnv` 实现）：
- 复制 `process.env`，将 Pi bin 目录（`~/.pi/agent/bin`）加入 PATH 前面

**进程启动参数**：
- `detached: process.platform !== "win32"` — 支持进程组 kill
- `stdio: ["ignore", "pipe", "pipe"]`

**命令前缀**：从 Pi settings 文件（`~/.pi/agent/settings.json`）读取 `shellCommandPrefix` 字段，在命令前注入。字段不存在时不注入。

**输出截断**：使用 Pi 导出的 `truncateTail`、`DEFAULT_MAX_LINES`、`DEFAULT_MAX_BYTES`、`formatSize`（纯工具函数，无进程耦合）。

**工作目录检查**：执行前检查 cwd 是否存在，不存在时 throw Error（与内置 bash 一致）。

**AbortSignal 支持**：sync 模式下支持 AbortSignal。当 tool call 被取消（用户中断 Ctrl+C），向进程发送 SIGTERM 终止。不 detach。

**非零退出码**：sync 模式下进程以非零退出码结束时 throw Error（与内置 bash 一致）。Background 模式下标注 "FAILED"。

### FR-2: Sync 模式（默认）

当只传 `command` 参数时，行为与内置 bash 一致：await 进程退出，流式输出到 TUI（通过 `onUpdate` 回调）。

**超时 detach 行为：**
- 有默认超时 120s（可通过配置文件 `~/.pi/agent/bash-async.json` 的 `defaultTimeout` 字段覆盖，设为 0 表示无超时）
- 用户显式传 `timeout` 时使用用户值
- 超时后**不 kill 进程**，而是将进程 detach 为 background job：
  - stdout/stderr pipe 已有的数据保留在内存
  - 将 pipe 切换到临时文件写入模式（或重新 pipe 到 WriteStream）
  - 将 job 注册到 session 闭包的 job Map
  - resolve execute() 返回：已收集输出 + jobId + 提示信息
- detach 后进程的后续输出持续写入临时文件，可通过 poll 读取
- 不设 timeout 或 timeout=0 时，永不 detach（与内置 bash 一致）

### FR-3: Background 模式

当传 `background: true` + `command` 时：
- spawn 进程后立即返回 jobId
- stdout/stderr 从一开始就写入临时文件（`$TMPDIR/pi-bash-jobs/{jobId}.out`）
- 进程完成后，通过 `pi.sendMessage({ customType: "bash-async-result", deliverAs: "followUp", triggerTurn: true })` 自动注入结果到对话中
- **pi 引用安全**：`pi` 在 `session_start` 闭包中捕获，execute() 返回后仍可使用。sendMessage 调用需 try-catch（session shutdown 时 sendMessage 可能失败，忽略错误，参考 subagent 扩展 spawn.ts:429）
- 注入结果包含：jobId、命令、exitCode、耗时、截断输出
- 返回结果包含 jobId、命令预览、启动确认

### FR-4: Poll 模式

当传 `pollJobId: "xxx"` 时：
- 查询指定 job 的当前状态和已收集输出
- 不启动新进程
- 返回：jobId、状态（running/done/failed/killed）、exitCode（如已完成）、已收集输出（使用 `truncateTail` 截断）
- 如果 jobId 不存在，返回错误

### FR-5: Kill 模式

当传 `killJobId: "xxx"` 时：
- 向目标进程发送 SIGTERM（进程组 kill：`process.kill(-pid, "SIGKILL")`，Windows 使用 taskkill），5 秒后如果进程仍在则 SIGKILL
- 返回 kill 之前已收集的 stdout/stderr 输出（方便 AI 诊断）
- 如果 jobId 不存在，返回错误信息
- 如果进程已自然结束，返回"已结束"状态 + 完整输出

### FR-6: Session 隔离

- 所有 job 状态存储在 `session_start` 事件回调中创建的闭包 Map 中
- `pi` 引用在同一闭包中捕获
- 多 session 间互不影响（Map 和 pi 引用是闭包局部变量，不是模块级变量）
- `session_shutdown` 时：对所有 running job 调用 kill，删除临时文件
- sendMessage 的 try-catch 错误不传播到调用者

### FR-7: 输出截断

使用 Pi 导出的工具函数保持一致：
- `truncateTail` 截断（保留尾部，与内置 bash 一致）
- `DEFAULT_MAX_LINES` = 2000 行
- `DEFAULT_MAX_BYTES` = 50KB
- 超出时写入临时文件，返回截断输出 + 文件路径 + 截断信息（格式与内置 bash 一致：`[Showing lines X-Y of Z. Full output: /path/to/file]`）
- Background 模式：输出持续写入临时文件，完成时读取并截断
- Poll 模式：读取临时文件已写入部分并截断

### FR-8: TUI 渲染

覆盖 `renderCall` / `renderResult`：
- renderCall：显示命令预览 + 模式标识（sync/bg/poll/kill）+ 超时设置
- renderResult：显示输出 + job 状态 + exitCode + 耗时
- **Sync 模式执行中**（timeout 到达前）：使用 `setInterval` + `context.invalidate()` 每秒刷新耗时显示（与内置 bash 一致）
- **Background 模式**：execute() 返回时显示「已启动，jobId=xxx」静态信息，后续状态查询通过 poll 模式
- 颜色使用 theme.fg() 语义 token，不硬编码 ANSI

### FR-9: 工具描述（prompt）

工具的 `description` 字段必须详尽覆盖所有模式用法、参数说明和行为差异。`promptSnippet` 和 `promptGuidelines` 需要明确引导 AI：

1. Sync 模式：与原 bash 一致，默认 120s 超时。**重要：超时后进程仍在运行，不要重新执行同一命令，应使用 pollJobId 查询**
2. Background 模式：用于已知会长时间运行的命令
3. Poll 模式：查询之前启动的 job，建议 10-30 秒后再查
4. Kill 模式：终止不再需要的 job
5. 四种模式的参数互斥：每次调用只传一种模式参数

### FR-10: 配置文件

支持可选配置文件 `~/.pi/agent/bash-async.json`：
```json
{
  "defaultTimeout": 120,
  "maxBackgroundJobs": 10
}
```
- `defaultTimeout`：sync 模式默认超时秒数。默认 120。设为 0 表示无超时
- `maxBackgroundJobs`：最大并发 background job 数量。默认 10。超过时返回错误
- 配置文件不存在时使用默认值，不报错
- JSON 解析失败时使用默认值，不报错

### FR-11: Spawn 失败处理

当 `child_process.spawn` 失败时（命令不存在 ENOENT、权限不足 EACCES、shell 不存在等）：
- 返回 `isError: true` + 错误信息
- 不创建 job
- 错误信息包含：错误类型、命令、建议（如"检查命令拼写"）

### FR-12: 并发限制

最大并发 background job 数量默认为 10（可通过 FR-10 配置）。超过时返回错误提示「已达最大并发数 N，请先 kill 已有 job」。

## Acceptance Criteria

### AC-1: Sync 正常命令
- 给定 `command: "echo hello"`，返回 "hello" + exitCode 0
- 行为与内置 bash 一致

### AC-2: Sync 超时 detach
- 给定 `command: "sleep 200"` 且 defaultTimeout=2（测试配置）
- 2 秒后返回部分输出 + jobId + 提示"进程仍在运行"
- 进程实际仍在运行（ps 确认）
- 用 `pollJobId` 可查到 running 状态
- sleep 结束后 poll 返回 done 状态 + exitCode 0

### AC-3: Sync 显式 timeout
- 给定 `command: "sleep 200", timeout: 5`
- 5 秒后 detach，返回 jobId
- 进程仍在运行

### AC-4: Sync 无超时
- 给定 `defaultTimeout: 0` + `command: "sleep 3"`
- 3 秒后正常返回，无 detach

### AC-5: Sync AbortSignal
- 给定 `command: "sleep 100"` + AbortSignal abort
- 进程被 SIGTERM 终止
- 返回 "Command aborted"（与内置 bash 一致）

### AC-6: Background 模式
- 给定 `command: "echo done", background: true`
- 立即返回 jobId（< 1s）
- 完成后 `pi.sendMessage()` 注入结果，包含 "done" 输出

### AC-7: Poll 查询
- 先启动 background job（`sleep 5`）
- 立即 poll 返回 running + 空输出
- 5 秒后 poll 返回 done + exitCode 0

### AC-8: Kill 终止
- 先启动 background job（`sleep 100`）
- 给定 `killJobId`，进程被终止
- 返回 kill 前已收集的输出

### AC-9: Job 不存在
- `pollJobId: "nonexistent"` 返回 isError: true
- `killJobId: "nonexistent"` 返回 isError: true

### AC-10: Session 隔离
- Session A 的 job 对 Session B 不可见
- Session shutdown 后所有 job 被清理

### AC-11: 配置文件
- 无配置文件时 defaultTimeout=120, maxBackgroundJobs=10
- 有配置文件时读取值
- JSON 非法时使用默认值

### AC-12: Spawn 失败
- `command: "nonexistent_cmd"` 返回 isError + 错误信息

### AC-13: 非零退出码
- Sync: `exit 1` 抛出 Error "Command exited with code 1"
- Background: `exit 1` 注入结果标注 "FAILED"

### AC-14: 输出截断
- 大量输出（> 2000 行或 > 50KB）正确截断
- 截断格式包含 `[Showing lines X-Y of Z. Full output: /path]`

### AC-15: 并发限制
- 已有 10 个 running job 时，新 background 请求返回错误

### AC-16: Cwd 不存在
- 在不存在的目录执行命令时 throw Error "Working directory does not exist"

### AC-17: Shell 兼容性
- macOS/Linux 使用 /bin/bash 或 PATH bash
- shellCommandPrefix 配置存在时被正确注入
- shellPath 配置存在时被使用

## Constraints

- **技术栈**：TypeScript，Pi Extension API（`@mariozechner/pi-coding-agent`），typebox，pi-tui
- **进程管理**：`child_process.spawn` 直接管理（不使用 `BashOperations.exec()`），与 subagent 扩展模式一致
- **Shell 发现**：自行实现（参照 Pi 内部 `getShellConfig` 逻辑约 30 行），因为 Pi 不导出 `getShellConfig` / `getShellEnv`
- **截断工具**：使用 Pi 导出的 `truncateTail`、`DEFAULT_MAX_LINES`、`DEFAULT_MAX_BYTES`、`formatSize`（纯工具函数）
- **模块导入**：使用 `@mariozechner/*` scope（兼容原版 pi 和 xyz-pi）
- **无外部依赖**：扩展无 `node_modules`，所有依赖由 Pi 运行时提供
- **架构**：遵循项目扩展标准结构（index.ts → src/index.ts + src/*.ts）
- **单文件限制**：单文件不超过 1000 行，函数不超过 80 行
- **禁用 any**：用 `unknown` 或具体类型
- **Session 隔离**：状态必须存储在 `session_start` 重建的闭包变量中

## 业务用例

### UC-1: 长时间编译
- **Actor**: AI agent
- **场景**: 执行 `cargo build --release`，预计耗时数分钟
- **预期结果**: 超时后 agent 收到 jobId，继续其他工作。稍后 poll 查询编译结果

### UC-2: 测试套件
- **Actor**: AI agent
- **场景**: 执行 `npm test`，可能运行 5-10 分钟
- **预期结果**: Background 启动，完成后自动注入结果

### UC-3: 部署脚本
- **Actor**: AI agent
- **场景**: 执行 `./deploy.sh`，需监控进度
- **预期结果**: Background 启动，定期 poll 检查

### UC-4: 开发服务器
- **Actor**: AI agent
- **场景**: 启动 `npm run dev`，server 持续运行
- **预期结果**: Background 启动，需要时 kill 终止

### UC-5: 卡住的命令
- **Actor**: AI agent
- **场景**: 命令进程卡住无输出
- **预期结果**: 120s 超时后 detach，AI 收到 jobId，判断是否 kill

## Complexity Assessment

**Medium** — 核心复杂度在于超时 detach 的 pipe 管理和进程生命周期。需要自行实现 shell 发现（~30 行），但截断等使用 Pi 导出函数。进程管理与 subagent 扩展模式一致。总估计 ~550 行代码。
