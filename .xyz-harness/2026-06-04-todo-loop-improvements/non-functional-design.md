---
verdict: pass
---

# Non-Functional Design — Todo Extension v4

## 1. 稳定性

**影响评估**：低风险。所有改动集中在 Todo 扩展内部，不涉及跨扩展依赖。新增的 `agent_end` handler 是 Pi 平台已存在的生命周期事件（Goal 扩展也在使用），不会影响其他扩展的事件处理。如果 `agent_end` handler 抛出异常，只会影响当前 tool call 的返回，不会导致 Pi 进程崩溃。

**风险缓解**：
- `agent_end` handler 中所有操作使用 try-catch 包裹，异常时只打日志不 crash
- 向后兼容函数 `migrateTodo` 处理旧数据，新增字段用 `??` 提供默认值
- 原有功能（list/add/update/delete/clear）的行为和返回格式不变

## 2. 数据一致性

**方案**：继续使用 `pi.appendEntry` 写入 + `reconstructState` 从 entries 重建状态。每个 tool call 的变更都在 handler 中立即序列化到 entry，不缓存中间状态。如果某个 `updates[]` 批量更新中途出错，全部回滚（不写 entry）。

**并发控制**：不适用。Pi 是单进程单线程处理 tool call，不存在并发竞争。

**YAML frontmatter 安全性**：不适用。Todo 扩展不涉及 YAML 解析。

## 3. 性能

**影响评估**：可忽略。`agent_end` handler 每次运行只需遍历 todos 数组（通常 ≤ 10 个元素），时间复杂度 O(N)。与 Goal 扩展的 `agent_end` handler 处于同一量级。

`verifyText` 字段长度控制在 80 字以内，`<todo_context>` 注入的文本量很小（预期 < 500 字符），不会显著增加 token 消耗。

## 4. 业务安全

**影响评估**：低风险。Todo 扩展的 tool 调用在 AI context 中执行，新增 `verifyText` 和批量 `updates[]` 是标准化 API 扩展，不引入新的执行能力。PromptGuidelines 中的规则（"goal 激活时不用 todo"）由 AI 自觉遵守，非代码级强制，不构成安全门控。

## 5. 数据安全

**影响评估**：低风险。Todo 数据存储在 session entries 中，随 Pi session 持久化。`verifyText` 内容在 `<todo_context>` 中以 `display: false` 注入到 AI 上下文——不显示在 TUI 中、不进用户视野。TUI 仅显示 `[待验证]` 标签。这与 Goal 扩展的 `<goal_context>` 注入方式一致。

所有文件操作仅涉及扩展自身的 `index.ts` 和测试文件，不读取或写入用户文件系统上的敏感数据。
