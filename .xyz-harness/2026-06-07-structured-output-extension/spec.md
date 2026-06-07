---
verdict: pass
---

# StructuredOutput 独立扩展

## Background

### 问题

workflow 扩展的 `agent({ schema })` 调用通过 prompt 指令让 LLM 返回纯文本 JSON，然后用 `extractJSON()` 解析。这种方式不可靠——LLM 经常忽略 "只返回 JSON" 指令，返回 markdown 代码块、前后缀文本、或纯思考文本。当输出中完全没有 `{` 时，`extractJSON` 无能为力。

### Claude Code 的做法

通过逆向分析 claude-code-source-code，Claude Code 用 **tool call 机制**实现结构化输出：

1. `createSyntheticOutputTool(schema)` 动态创建 tool，用 Ajv 编译 schema 做严格校验
2. system prompt 注入 "MUST call StructuredOutput tool"
3. 注册 `Stop` function hook：agent 结束但未调用 StructuredOutput 时，注入 user message 强制重试
4. LLM 调用 StructuredOutput tool → 参数天生就是 JSON → 可靠

### Pi 的能力支撑

Pi extension 机制完整支持同等实现：

| 能力 | Pi API | 对应 Claude Code |
|------|--------|------------------|
| 注册自定义 tool | `pi.registerTool()` | `buildTool()` |
| Tool 终止 agent | `terminate: true` | 无（CC 多一个 turn） |
| 修改 system prompt | `before_agent_start` | function hook |
| 检测 turn 结束 | `turn_end { toolResults }` | `Stop` function hook |
| 注入 user message | `pi.sendUserMessage()` | hook errorMessage |
| 拦截 tool 调用 | `tool_call { block }` | `PreToolUse` hook |
| Ajv schema 校验 | `npm install ajv` | 内置 |

## Functional Requirements

### FR-1: Schema 环境变量检测与动态配置

Extension 在 `session_start` 时检测环境变量 `STRUCTURED_OUTPUT_SCHEMA`：

- **存在**：解析为 JSON schema，注册 `structured-output` tool（使用 Ajv 编译），注入 system prompt，注册 enforcement hook
- **不存在**：不注册 tool，不注入 prompt，完全静默

schema 通过环境变量传递的原因：`pi --mode json -p --no-session` 不支持自定义参数，每个子进程通过 `spawn` 的 `env` 参数注入各自的 schema，多 agent 并行无冲突。

### FR-2: StructuredOutput Tool 注册

注册一个名为 `structured-output` 的 tool：

- **parameters**: `Type.Object({})` + `Type.Record(Type.String(), Type.Unknown())`（passthrough，接受任意 JSON 对象）
- **execute**: 用 Ajv validate 校验输入。校验通过 → 返回 `{ content, details, terminate: true }`；校验失败 → throw Error（附带 Ajv 详细错误信息）
- **terminate: true**: tool 调用后结束 agent，省去额外 LLM turn
- **Ajv 缓存**: 同一个 schema 编译结果缓存，避免重复编译

### FR-3: System Prompt 注入

在 `before_agent_start` 事件中，当 schema 存在时，追加以下内容到 system prompt：

```
你正在以结构化输出模式运行。你必须在回复的最后调用 structured-output tool 来返回结果。
不要在 tool 调用之外输出任何 JSON。

正例：先进行思考和分析，然后调用 structured-output({ mustFix: true, issues: [...] })
反例：直接在回复中输出 ```json {...} ``` — 这是错误的
```

### FR-4: Enforcement Hook

在 `turn_end` 事件中检测当前 turn 是否调用了 `structured-output` tool：

- **调用了且校验通过**：不操作（agent 已通过 `terminate: true` 结束）
- **未调用**（`stop_reason === "end_turn"` 且 `toolResults` 中无 structured-output）：调用 `pi.sendUserMessage("你必须调用 structured-output tool 来返回结果。")`，触发新 turn

不设独立的 enforcement 重试上限。依赖 agent 的整体 token/turn 限制来自然终止。

### FR-5: 非法调用防护

在 `tool_call` 事件中，如果 `structured-output` tool 被调用但环境变量 `STRUCTURED_OUTPUT_SCHEMA` 不存在（即非 workflow agent 子进程场景），block 该调用并返回原因 "This tool is only available in workflow structured-output mode"。

### FR-6: workflow 侧改动

#### agent-pool.ts

1. **`buildArgs()`**: 当 `opts.schema` 存在时：
   - 设置子进程环境变量 `STRUCTURED_OUTPUT_SCHEMA=<schema JSON>`
   - 不再追加 "You MUST respond with ONLY valid JSON" 的 prompt 指令（由 extension 的 system prompt 接管）
2. **`processJsonlEvent()`**: 从 `tool_execution_start` 事件中检测 `toolName === "structured-output"` 的调用，提取 `args` 作为 `parsedOutput`
3. **移除 `extractJSON()` 函数**：不再需要
4. **移除 schema prompt 构建逻辑**：buildArgs 中不再拼接 schema 相关 prompt

#### worker-script.ts

1. **移除 `_callCache` 中 `hasSchema` 相关的 fallback 逻辑**：parsedOutput 现在由 tool call 产生，不再有 undefined 的场景（schema 场景下 LLM 必须调用 tool 才能结束）
2. **保留非 schema 场景的 fallback**：`parsedOutput ?? content` 仍然适用于不传 schema 的 agent 调用

#### 强制依赖检查

workflow 的 `session_start` 中检查 `structured-output` extension 是否已安装（通过 `pi.getActiveTools()` 检查 `structured-output` tool 是否存在）。如果未安装且用户尝试使用 schema 参数，抛出明确错误。

### FR-7: 依赖管理

- 在 `extension-dependencies.json` 中声明 `@zhushanwen/pi-workflow` → `@zhushanwen/pi-structured-output` (runtime)
- workflow 的 `package.json` 中添加 `peerDependencies` 声明（提示用户安装）
- 安装文档中说明：使用 workflow 的 schema 功能必须同时安装 structured-output

## Acceptance Criteria

### AC-1: Tool call 返回结构化数据

Given workflow agent 配置了 schema `{ type: "object", properties: { mustFix: { type: "boolean" } } }`
When agent 执行完毕
Then `agent-pool.ts` 从 `tool_execution_start` 事件中提取到 `{ mustFix: true }`
And `parsedOutput` 是一个 JS 对象（不是字符串）

### AC-2: LLM 未调用 tool 时自动重试

Given workflow agent 配置了 schema
When LLM 结束 turn 但未调用 `structured-output` tool
Then extension 通过 `sendUserMessage` 注入提醒
And agent 进入新 turn 继续执行

### AC-3: Schema 校验失败时 LLM 收到错误反馈

Given workflow agent 配置了 schema `{ type: "object", properties: { count: { type: "number" } } }`
When LLM 调用 `structured-output({ count: "not-a-number" })`
Then tool 抛出 Ajv 校验错误
And LLM 收到 tool error，可以在新 turn 中修正

### AC-4: 非 workflow 场景不可调用

Given Pi 正常交互模式（非 `--mode json` 子进程）
When LLM 尝试调用 `structured-output` tool
Then `tool_call` hook block 该调用
And 返回原因说明

### AC-5: 未安装 extension 时明确报错

Given structured-output extension 未安装
When workflow agent 使用 schema 参数
Then workflow 报错 "structured-output extension is required for schema-based agent calls. Install with: pi install npm:@zhushanwen/pi-structured-output"

### AC-6: 无 schema 时不干扰

Given Pi 正常交互模式且未设置 `STRUCTURED_OUTPUT_SCHEMA` 环境变量
Then `structured-output` tool 不被注册
Then system prompt 不被修改
Then enforcement hook 不被注册

### AC-7: 并行 agent 无冲突

Given 两个并行 agent 各自配置不同 schema
When 两个 agent 同时执行
Then 各自的 `STRUCTURED_OUTPUT_SCHEMA` 环境变量独立
Then 各自的 tool 注册和 enforcement 独立

### AC-8: terminate 省去额外 turn

Given LLM 调用了 `structured-output` tool 且校验通过
When tool 返回 `terminate: true`
Then agent 结束，不再有额外的 LLM turn

## Constraints

- **Ajv 依赖**：新增 `ajv` 作为 `@zhushanwen/pi-structured-output` 的 npm 依赖
- **Pi 版本要求**：需要 Pi 支持 `terminate: true`、`turn_end` 事件、`sendUserMessage`、`before_agent_start`（当前版本均支持）
- **运行时隔离**：structured-output extension 在 `pi --mode json` 子进程内运行，与主 Pi 进程的 extension 实例独立
- **向后兼容**：workflow 的非 schema agent 调用（不传 schema 参数）不受影响

## 业务用例

### UC-1: Workflow 获取审查结果

- **Actor**: Workflow 脚本（通过 agent-pool）
- **场景**: workflow 的 review-fix 循环中，需要 agent 返回 `{ mustFix: boolean, issues: string[] }` 结构
- **预期结果**: agent 调用 `structured-output` tool 返回结构化数据，workflow 脚本拿到 JS 对象，直接访问 `result.mustFix`

### UC-2: Workflow 并行 agent 各自返回不同 schema

- **Actor**: Workflow 脚本（并行 agent 调用）
- **场景**: 3 个并行 agent 分别审查不同文件，各自配置不同 schema（一个返回 `{ errors: string[] }`，另一个返回 `{ score: number }`）
- **预期结果**: 各 agent 独立执行，各自调用 `structured-output` tool 返回各自 schema 的数据

## Complexity Assessment

- **规模**: 中等。新增 1 个 extension（~3 个文件），修改 workflow extension 2 个文件
- **技术风险**: 低。所有 Pi API 均已在现有 extension 中验证过
- **外部依赖**: `ajv` npm 包（成熟稳定，Claude Code 同款）
