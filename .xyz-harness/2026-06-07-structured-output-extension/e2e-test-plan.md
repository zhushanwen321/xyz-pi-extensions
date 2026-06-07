---
verdict: pass
---

# E2E Test Plan — structured-output extension

## Test Scenarios

### TS-1: 基本结构化输出（AC-1, AC-8）
1. 编写最小 workflow 脚本，调用 `agent({ prompt: "...", schema: { type: "object", properties: { answer: { type: "string" } } } })`
2. 运行 workflow，验证返回的 `parsedOutput` 是 `{ answer: "..." }` JS 对象
3. 验证 agent 只消耗 2 个 turn（1 个 assistant + 1 个 tool call），无多余 turn

### TS-2: Schema 校验失败反馈（AC-3）
1. 编写 workflow 脚本，schema 要求 `{ count: number }`，但 prompt 诱导 LLM 返回字符串
2. 运行 workflow，验证最终仍然得到正确类型的结果（LLM 修正后重试）
3. 或者验证 error 中包含 Ajv 校验错误信息

### TS-3: 无 schema 时不干扰（AC-6）
1. 编写 workflow 脚本，调用 `agent({ prompt: "say hello" })`（无 schema）
2. 运行 workflow，验证正常返回文本输出
3. 验证 structured-output tool 未被注册（检查子进程日志）

### TS-4: 并行 agent 各自独立（AC-7）
1. 编写 workflow 脚本，使用 `parallel([agent({ schema: A }), agent({ schema: B })])`
2. 验证两个 agent 各自返回符合各自 schema 的结果
3. 验证无交叉污染

## Test Environment

- Pi 已安装 `@zhushanwen/pi-structured-output` 和 `@zhushanwen/pi-workflow`
- 测试用最小 workflow JS 脚本（手动创建 `.js` 文件，通过 `pi workflow run` 执行）
- 验证方式：检查 workflow 返回结果中 `parsedOutput` 的值和类型
