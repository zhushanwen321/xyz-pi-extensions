---
verdict: pass
---

# Use Cases — structured-output extension

## UC-1: Workflow 获取审查结果

- **Actor**: Workflow 脚本（通过 agent-pool enqueue）
- **Preconditions**:
  - `@zhushanwen/pi-structured-output` 已安装
  - `@zhushanwen/pi-workflow` 已安装
  - workflow 脚本定义了 schema `{ type: "object", properties: { mustFix: boolean, issues: string[] } }`
- **Main Flow**:
  1. Workflow 脚本调用 `agent({ prompt: "审查这段代码...", schema })`
  2. agent-pool.buildArgs 设置 STRUCTURED_OUTPUT_SCHEMA 环境变量
  3. Pi 子进程启动，structured-output extension 检测到环境变量，注册 tool
  4. System prompt 注入结构化输出指令
  5. LLM 分析代码后调用 `structured-output({ mustFix: true, issues: ["..."] })`
  6. Ajv 校验通过，tool 返回 `terminate: true`
  7. agent-pool 从 `tool_execution_start` 事件提取 args → `parsedOutput`
  8. Workflow 脚本拿到 `{ mustFix: true, issues: [...] }` JS 对象
- **Alternative Paths**:
  - LLM 未调用 tool → FR-4 第一层 sendUserMessage 提醒 → LLM 补偿调用
  - 第一层无效 → FR-4 第二层 agent-pool 检测失败 → executeWithRetry 重启子进程
  - Schema 校验失败 → tool throw Error → LLM 收到错误 → 修正后重试
- **Postconditions**: Workflow 脚本得到符合 schema 的 JS 对象
- **Module Boundaries**: agent-pool (spawn/JSONL) ↔ pi subprocess ↔ structured-output extension (tool/ajv)

## UC-2: 并行 agent 各自返回不同 schema

- **Actor**: Workflow 脚本（parallel 调用）
- **Preconditions**: 同 UC-1，3 个 agent 使用不同 schema
- **Main Flow**:
  1. Workflow 脚本调用 `parallel([agent({ schema: A }), agent({ schema: B }), agent({ schema: C })])`
  2. 3 个 agent-pool.spawnAndParse 并发执行，各自注入独立的 STRUCTURED_OUTPUT_SCHEMA
  3. 各 Pi 子进程独立加载 structured-output extension，编译各自的 schema
  4. 各 LLM 调用 `structured-output` 返回各自 schema 的数据
  5. 各 agent-pool 独立提取 parsedOutput
- **Postconditions**: 3 个独立的 JS 对象，互不干扰
- **Module Boundaries**: 同一 AgentPool 实例，3 个独立子进程，3 个独立 extension 实例

## UC 覆盖映射

| UC | 覆盖的 AC |
|----|----------|
| UC-1 | AC-1, AC-2, AC-3, AC-5, AC-6, AC-8 |
| UC-2 | AC-7 |
| (补充) | AC-4（非 workflow 场景 block），AC-6b（schema 解析失败） |
