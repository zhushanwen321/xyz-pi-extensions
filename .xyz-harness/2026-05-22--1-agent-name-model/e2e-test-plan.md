---
verdict: pass
---

# E2E Test Plan — Subagent TUI 渲染统一与优化

## Test Scenarios

以下测试覆盖 spec 中所有 AC，按模式分组。

### 测试环境

- Pi 启动并加载 subagent extension（symlinked 到 `~/.pi/agent/extensions/subagent`）
- 使用 `subagent {json}` 命令触发各模式
- 通过 `/todos list` 或观察 TUI 输出验证渲染效果

### SC1: Single 模式 — 成功

**验证 AC1**

1. 启动 Pi，确保 subagent 扩展已加载
2. 执行：`subagent { agent: "general-purpose", task: "list current directory files", taskComplexity: "low" }`
3. 观察 renderCall: 应显示 `⏳ single #XXXX` + agent/model/thinking
4. 等待执行完成
5. 观察 renderResult: 应显示 `✅ single #XXXX` + elapsed + turns/tokens/cost
6. 活动流应包含 `→` tool calls 和缩进 text output
7. 展开后 (Ctrl+O) 应显示完整的 Markdown 输出和 usage

### SC2: Single 模式 — 失败

**验证 AC1 + 错误状态**

1. 执行：`subagent { agent: "general-purpose", task: "exit with code 1", taskComplexity: "low" }`
2. 观察结果：应显示 `❌ single #XXXX` + error message

### SC3: Parallel 模式

**验证 AC2**

1. 执行：`subagent { tasks: [{ agent: "general-purpose", task: "ls", cwd: "." }, { agent: "general-purpose", task: "pwd", cwd: "." }], taskComplexity: "low" }`
2. 观察 renderCall: 应显示 `⏳ parallel #XXXX` + 任务数
3. 运行中：应显示进度 `m/n done, n-m running` + 表格带状态图标和 elapsed
4. 完成后：应显示 `✅ parallel #XXXX` + 聚合统计
5. 失败场景：tasks 中一个 agent 故意失败，应显示 `❌` + 部分失败行

### SC4: Chain 模式

**验证 AC3**

1. 执行：`subagent { chain: [{ agent: "general-purpose", task: "echo step1" }, { agent: "general-purpose", task: "echo {previous}" }], taskComplexity: "low" }`
2. 观察 renderCall: 应显示 `⏳ chain #XXXX` + 步骤数
3. 运行中：每步应显示编号 + icon + agent
4. 完成后：应显示 `✅ chain #XXXX` + 所有步骤状态 + 聚合统计
5. Chain 中断（某步失败）：应显示 `❌` + 中断步骤

### SC5: Background 模式

**验证 AC4**

1. 执行：`subagent { agent: "general-purpose", task: "echo hello", taskComplexity: "low", background: true }`
2. 观察 renderCall: 应显示 `⏳ single #XXXX [bg]`
3. 返回信息应包含 job ID
4. 等待 auto-inject 完成，注入的内容应以 Single 模式 renderResult 显示

### SC6: 实时计时

**验证 AC5**

1. 执行一个耗时 subagent (medium+ complexity，让 agent 多思考几秒)
2. 观察 elapsed 数字每秒刷新
3. 完成后 elapsed 固定，不再变化
4. 验证无可见性能开销

### SC7: collect_subagent 已移除

**验证 AC6**

1. 通过 Pi 的 tool list 确认 collect_subagent 不在注册列表中
2. 或尝试调用 collect_subagent（应有 "Tool not found" 错误）
3. 启动 background subagent，确认运行时不抛出因 collect_subagent 移除导致的错误（如 `spawnManager.getActiveJobs` 引用错误）
4. 关闭 session，确认 `session_shutdown` 时仍能正常 cleanup 后台 job 的 temp files（无 TypeError 或 ReferenceError）

### SC8: 活动流 text output

**验证 F3**

1. 执行 single 模式 subagent 做文件读写操作
2. 观察活动流：tool call (`→ $ ...`, `→ read ...`, `→ edit ...`) 和 text output（缩进，不含 thinking）
3. 只显示前 3 行文本（collapsed）
4. 展开后显示全部 text output
