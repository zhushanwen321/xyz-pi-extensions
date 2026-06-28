---
verdict: pass
---

# E2E Test Plan — Workflow Extension 整体重构

## Test Scenarios

覆盖 spec.md AC-1~AC-6 + 3 个业务用例（UC-1/UC-2/UC-3）。

### E2E-1: AI 驱动 workflow 执行（UC-1 主路径）

**覆盖 AC:** AC-4（脚本格式不变）、AC-5（跨 session 恢复）

**步骤：**
1. AI 调用 `workflow { action: "run", name: "test-simple", mode: "auto" }`
2. 系统 fuzzy 匹配脚本 → 确认 → 后台启动
3. workflow 执行 agent()/parallel() 调用
4. 完成时通过 completion notification 唤醒 AI
5. AI 收到 scriptResult + trace

**预期：** workflow 完成，AI 收到结构化结果，trace 完整记录所有 agent 调用

### E2E-2: 外部扩展程序化调用（UC-2 pi.__workflowRun）

**覆盖 AC:** AC-4（pi.__workflowRun 签名）

**步骤：**
1. coding-workflow gate 调用 `pi.__workflowRun("phase1-review-gate", args, signal, timeoutMs)`
2. 等待执行完成
3. 消费返回值 `{status: "done", reason, scriptResult, error, runId}`
4. 根据 `reason === "completed"` 判断 pass/fail

**预期：** gate 拿到结构化结果，正确判断 pass/fail + 给出 fixGuidance

### E2E-3: 用户交互式查看（UC-3 /workflows 面板）

**覆盖 AC:** FR-6（仅 /workflows）、D-9（移除 restart）

**步骤：**
1. 用户输入 `/workflows`
2. TUI 面板打开，显示三级导航（phase → agent → detail）
3. 浏览实时进度和 trace
4. 确认无 'r' restart 快捷键

**预期：** 面板正常显示，快捷键集不含 restart

### E2E-4: 跨 session pause/resume（AC-5 核心）

**覆盖 AC:** AC-5（跨 session 恢复）、G3-001（RunRuntime 重建）

**步骤：**
1. 启动 workflow，执行到一半
2. `workflow { action: "pause" }`
3. 重启 Pi（session_shutdown → session_start）
4. `workflow { action: "resume" }`
5. 确认已完成调用从 callCache replay，worker 重跑剩余部分

**预期：** callCache 保留，worker 重建，workflow 从中断点继续

### E2E-5: 状态机合法性（AC-1 + FR-3）

**覆盖 AC:** AC-1（架构合规）、FR-3（3 态+doneReason）

**步骤：**
1. 验证合法转换：running→paused→running→done(completed)
2. 验证非法转换抛错：done→running、done→paused
3. 验证 done 转换必须携带 reason
4. 验证 abort 从 running 和 paused 都可调用

**预期：** 非法转换抛 Error，合法转换正常

### E2E-6: 错误恢复（AC-5 失败路径）

**覆盖 AC:** AC-5（Worker error 重试）、domain-models.md §失败处理矩阵

**步骤：**
1. 模拟 Worker error → 确认 3 次重试 + 指数退避
2. 模拟 script error → 确认 3 次重试后转 failed
3. 模拟 stale-context → 确认不重试
4. 模拟 Worker exit 竞态 → 确认旧 handle exit 不误判新 handle
5. 模拟 budget 超限 → 确认转 budget_limited
6. 模拟 timeout → 确认转 time_limited

**预期：** 每种失败类型按失败处理矩阵正确处理

### E2E-7: 架构合规验证（AC-1 + AC-2）

**覆盖 AC:** AC-1（三层依赖）、AC-2（重复消除）

**步骤：**
1. `rg -n "from \"@mariozechner" extensions/workflow/src/engine/` → 零匹配（Engine 不依赖 Pi SDK）
2. `ls extensions/workflow/src/domain/ extensions/workflow/src/application/` → 不存在（三层无 Domain/Application 层）
3. `rg -n "OrchestratorCore|terminateDeps|errorHandlerContext|agentCallContext|budgetCallbacks" extensions/workflow/src/` → 零匹配
4. `rg -n "cleanupWorker|keepController|cleanupTempFiles|deletePool" extensions/workflow/src/` → 零匹配
5. `rg -n "pi.registerTool" extensions/workflow/src/interface/` → 2 个匹配（workflow + workflow-script）
6. `rg -n "api.registerCommand" extensions/workflow/src/interface/commands.ts` → 1 个匹配（仅 /workflows）

**预期：** 全部验证通过

## Test Environment

- **运行时：** Pi coding agent（安装重构后的 @zhushanwen/pi-workflow + 更新后的 @zhushanwen/pi-coding-workflow）
- **测试脚本：** 使用现有的 workflow 脚本（`.pi/workflows/` 下的 phase1-review-gate 等）
- **Mock 需求：** E2E-1~E2E-4 需要真实 Pi 环境（不 mock）；E2E-5~E2E-6 可用单元测试 + mock 覆盖
- **手动验证：** E2E-1~E2E-4 为手动验证场景（启动 Pi 后执行）；E2E-5~E2E-7 为自动化验证（单元测试 + rg/grep 命令）
