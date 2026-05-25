---
verdict: pass
---

# E2E Test Plan — Pi Workflow Extension

## Test Scenarios

### TS1: 最小可用验证（AC1）

- **Prerequisites**：`.pi/workflows/demo.js` 存在且语法正确
- **Steps**：
  1. 启动 Pi 会话，进入项目目录
  2. 执行 `/workflow run demo --args file=README.md`
  3. 验证返回 runId
  4. 执行 `/workflows` 查看 workflow 状态为 running
  5. 等待 workflow 完成（2 个 agent 调用结束）
  6. 验证对话中收到 workflow 结果通知
  7. 验证 `/workflows` 中该 workflow 状态为 completed

### TS2: 暂停与恢复（AC2）

- **Prerequisites**：一个运行中的 workflow（agent 调用中有 sleep 或长任务）
- **Steps**：
  1. 启动 `/workflow run demo`
  2. 在第一个 agent 调用执行期间，按 ctrl+p 暂停
  3. 验证 `/workflows` 中状态变为 paused
  4. 执行恢复操作（通过 `/workflows` 面板）
  5. 验证 workflow 继续执行，已完成的 agent 不重新调用
  6. 验证最终状态为 completed

### TS3: 跨会话恢复（AC2）

- **Prerequisites**：一个 paused 状态的 workflow
- **Steps**：
  1. 暂停一个 workflow
  2. 退出 Pi 会话
  3. 重新启动 Pi 会话
  4. 执行 `/workflows` — 应显示被中断的 workflow
  5. 系统提示"检测到中断的 workflow，是否恢复？"
  6. 确认恢复
  7. 验证 workflow 从断点继续

### TS4: parallel 并发（AC3）

- **Prerequisites**：包含 `await parallel([agent(A), agent(B), agent(C)])` 的 workflow 脚本
- **Steps**：
  1. 启动该 workflow
  2. 通过进程监控验证 A/B/C 三个 pi 子进程同时存在
  3. 故意让其中一个失败（如指定不存在的 MCP tool）
  4. 验证其他两个正常完成，失败的返回 Error
  5. 验证 parallel 整体在全部完成（或任一失败）后继续

### TS5: 错误重试（AC4）

- **Prerequisites**：包含会失败的 agent 调用的 workflow 脚本
- **Steps**：
  1. 启动 workflow，第一个 agent 调用失败（exitCode != 0）
  2. 验证系统自动重试（观察 1s/3s/9s 间隔）
  3. 3 次全部失败后验证节点状态为 failed，workflow 标记 failed
  4. 按 ctrl+r 手动重试该节点
  5. 验证该节点重新执行

### TS6: 多 workflow 并发（AC5）

- **Prerequisites**：两个不同的 workflow 脚本
- **Steps**：
  1. 同时启动 3 个 workflow
  2. 验证 `/workflows` 显示 3 个 running 条目
  3. 验证 agent 子进程最多 4 个同时运行（通过进程计数）
  4. 一个完成后不影响其他继续运行

### TS7: Token 预算（AC6）

- **Prerequisites**：任意 workflow 脚本
- **Steps**：
  1. 启动 `/workflow run demo --tokens 5000`（小预算迫使快速达限）
  2. 验证 agent 调用累加 token 消耗
  3. 达 90% 时验证 warning 发出（可通过 Worker 日志确认）
  4. 达 100% 时验证 workflow 标记为 budget_limited
  5. 验证已完成 agent 的结果已保留

### TS8: CC 兼容性（AC8）

- **Prerequisites**：使用 CC 格式（`const meta = { name, description, phases }`）的 workflow 脚本
- **Steps**：
  1. 分别在 `.pi/workflows/` 和 `~/.pi/agent/workflows/` 放置 workflow 脚本
  2. 执行 `/workflow list`
  3. 验证两个目录下的 workflow 均出现在列表中，含 name/description/phases
  4. 确认 `agent()`/`parallel()`/`pipeline()` 三种 API 签名可用

### TS9: Schema 结构化输出（AC7）

- **Prerequisites**：包含 `agent({..., schema: { type: "array", items: { type: "string" } } })` 的 workflow
- **Steps**：
  1. 启动 workflow
  2. 验证 agent 子进程 prompt 末尾包含 schema 要求
  3. 子进程返回有效 JSON 数组时，验证 Worker 收到已解析的数组
  4. 子进程返回无效 JSON 时，验证 Worker 收到原始文本

### TS10: _render 输出（AC9）

- **Prerequisites**：任意 workflow
- **Steps**：
  1. AI 在对话中调用 `workflow-run` tool
  2. 验证 tool 返回的 `details._render` 存在且 `type === "task-list"`
  3. 验证 `_render.data.items` 包含节点状态
  4. workflow 完成后验证通知消息包含 `_render` 字段

## Test Environment

- **运行环境**：本地 macOS，Node.js 24.x，Pi coding agent 安装
- **Workflow 脚本**：`.` 目录下的 `.pi/workflows/demo.js`
- **配置**：`~/.pi/agent/settings.json` 中无特殊配置（使用默认值）
- **清理**：每次测试前删除 Session JSONL 中的 workflow entries 避免干扰
