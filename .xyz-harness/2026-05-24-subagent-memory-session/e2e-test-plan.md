---
verdict: pass
---

# E2E Test Plan — Subagent Memory Session

## Test Scenarios

### TS-1: 首次 memory 调用创建 session 文件
- 调用 subagent tool，memory="test-session"，agent="general-purpose"，task="列出当前目录文件"
- 验证：返回结果包含 memoryId="test-session"，memoryAction="create"
- 验证：主 session 同目录存在 `*.mem-test-session.jsonl` 文件
- 验证：subagent 使用 `--session` 参数（通过正常完成、无 "no session" 错误推断）

### TS-2: 后续 memory 调用恢复 session
- 在 TS-1 后，再次调用 subagent tool，memory="test-session"，task="我之前做了什么"
- 验证：返回结果包含 memoryId="test-session"，memoryAction="resume"
- 验证：subagent 正常完成（使用已有 session 文件）

### TS-3: 无 memory 调用不变
- 调用 subagent tool，不传 memory，agent="general-purpose"，task="hello"
- 验证：行为与改动前一致（正常完成）

### TS-4: memory 参数 sanitization
- 调用 subagent tool，memory="my agent/task:refactor"
- 验证：session 文件名包含 `my_agent_task_refactor`

### TS-5: memory 在 background 模式报错
- 调用 subagent tool，memory="test"，background=true，agent="general-purpose"，task="..."
- 验证：返回错误信息，提示 memory 仅支持 single 模式

### TS-6: memory 在 parallel 模式报错
- 调用 subagent tool，memory="test"，tasks=[{...}]
- 验证：返回错误信息，提示 memory 仅支持 single 模式

### TS-7: memory 在 chain 模式报错
- 调用 subagent tool，memory="test"，chain=[{...}]
- 验证：返回错误信息，提示 memory 仅支持 single 模式

### TS-8: In-memory session 下 memory 报错
- 当主 session 为 in-memory（无文件）时，调用 subagent tool，memory="test"
- 验证：返回错误信息，提示需要 file-backed session

### TS-9: 类型检查和 lint 通过
- `npx tsc --noEmit` 通过
- `npm run lint` 无新增 error

## Test Environment

- **前置条件:** Pi 已安装，subagent 扩展已 symlink 到 `~/.pi/agent/extensions/subagent`
- **手动测试:** 通过 Pi TUI 或 RPC mode 调用 subagent tool，观察返回结果和 session 文件
- **自动化验证:** `npx tsc --noEmit` + `npm run lint`
- **清理:** 测试完成后删除 `*.mem-test-session.jsonl` 和 `*.mem-my_agent_task_refactor.jsonl` 文件
