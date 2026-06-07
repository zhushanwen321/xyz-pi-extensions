# ADR-018: StructuredOutput 独立扩展与 Extension 依赖管理

> 状态：proposed
> 日期：2026-06-07

## 背景

### 问题一：workflow agent 的 schema 结构化输出不可靠

workflow 扩展的 `agent()` 调用支持传入 `schema` 参数，期望 LLM 返回符合 schema 的 JSON。实现方式是在 prompt 中追加 "You MUST respond with ONLY valid JSON" 指令，然后 `extractJSON()` 解析 LLM 的纯文本输出。

实际运行中 LLM 经常忽略指令，返回包含 markdown 代码块、前后缀文本、甚至纯思考文本的输出。`extractJSON()` 能处理代码块包裹，但无法处理输出中完全没有 JSON 的情况（没有 `{` 就无法提取）。

### 问题二：Claude Code 的做法

通过逆向分析 claude-code-source-code（见调研），Claude Code 使用 **tool call 机制** 实现结构化输出：

1. 动态创建 `StructuredOutput` tool，其 `inputJSONSchema` 就是目标 schema
2. 通过 `before_agent_start` 注入 system prompt："你必须调用 StructuredOutput tool 返回结果"
3. 注册 function hook：当 agent 停止但未调用 StructuredOutput 时，自动注入 user message 提醒
4. LLM 调用 StructuredOutput tool → 参数天生就是 JSON → 可靠
5. Tool 返回 `terminate: true` → agent 结束，不需要额外 LLM turn

### 问题三：Pi 的能力支持

Pi 的 extension 机制完整支持 Claude Code 风格的实现：

| 能力 | Pi API | 用途 |
|------|--------|------|
| 注册自定义 tool | `pi.registerTool()` | 注册 `structured-output` tool |
| Tool 终止 agent | `terminate: true` | tool 调用后结束 agent |
| 修改 system prompt | `pi.on("before_agent_start")` | 注入调用指令 |
| 检测 turn 结束 | `pi.on("turn_end")` | 检查是否调用了 tool |
| 注入 user message | `pi.sendUserMessage()` | 未调用 tool 时强制提醒 |

## 决策

### 1. StructuredOutput 拆分为独立 extension

创建 `extensions/structured-output/`（`@zhushanwen/pi-structured-output`），不嵌在 workflow 内部。

**理由**：

- **复用性**：不止 workflow 需要 schema 结构化输出。任何需要 agent 返回结构化数据的场景都能用（subagent、coding-workflow 等）
- **关注点分离**：workflow 是 DAG 执行引擎，不应该内置 LLM 输出解析的特殊逻辑
- **独立演进**：StructuredOutput 的 schema 校验、enforcement 策略可以独立迭代，不影响 workflow 版本

### 2. Extension 依赖关系注册

在项目根目录新增 `extension-dependencies.json`，描述 extension 之间的依赖关系。所有新增/修改 extension 时必须同步更新此文件。

## StructuredOutput 扩展设计

### 目录结构

```
extensions/structured-output/
├── index.ts              # 入口
├── package.json
├── src/
│   ├── index.ts          # 扩展工厂函数
│   └── tool.ts           # structured-output tool 定义
└── vitest.config.ts
```

### 工作原理

```
agent-pool.ts (workflow):
  1. 设置环境变量 STRUCTURED_OUTPUT_SCHEMA=<schema JSON>
  2. 启动 pi --mode json -p --no-session 子进程

pi 子进程 (加载所有 extension，包括 structured-output):
  3. structured-output extension:
     - session_start: 检测环境变量 STRUCTURED_OUTPUT_SCHEMA
     - 有 schema → 注册 structured-output tool + 在 before_agent_start 注入 system prompt
     - turn_end hook: 检查是否调用了 structured-output tool
       - 未调用 + stopReason=end_turn → sendUserMessage("你必须调用 structured-output tool")
       - 最多重试 5 次
  4. LLM 调用 structured-output({ mustFix: true, ... })
     - tool execute 返回 terminate: true
     - agent 结束

agent-pool.ts:
  5. processJsonlEvent() 从 tool_execution_start 提取 args 作为 parsedOutput
```

### 依赖关系

```
@zhushanwen/pi-workflow
  → @zhushanwen/pi-structured-output  (runtime)
     原因：workflow 的 agent 子进程需要 structured-output tool 可用
     类型：runtime — pi 子进程自动加载 extension，无需 import 代码
```

## Extension 依赖管理规范

### 依赖类型

| 类型 | 标识 | 含义 | 示例 |
|------|------|------|------|
| **runtime** | `"runtime"` | 运行时需要对方 extension 已安装，但代码层面不 import | workflow 需要 structured-output 在子进程中可用 |
| **package** | `"package"` | npm 包级别依赖，代码中直接 import 对方的模块 | statusline import quota-providers |
| **optional** | `"optional"` | 功能增强，缺失时降级运行 | workflow → model-switch（有则按复杂度选模型，无则用默认） |

### extension-dependencies.json 格式

```json
{
  "$schema": "./extension-dependencies.schema.json",
  "extensions": [
    {
      "name": "@zhushanwen/pi-workflow",
      "directory": "extensions/workflow",
      "dependsOn": [
        {
          "package": "@zhushanwen/pi-structured-output",
          "type": "runtime",
          "reason": "workflow agent 子进程需要 structured-output tool 实现 schema 结构化输出"
        },
        {
          "package": "@zhushanwen/pi-model-switch",
          "type": "optional",
          "reason": "有则按复杂度选模型，无则用默认模型"
        }
      ]
    },
    {
      "name": "@zhushanwen/pi-statusline",
      "directory": "extensions/statusline",
      "dependsOn": [
        {
          "package": "@zhushanwen/pi-quota-providers",
          "type": "package",
          "reason": "直接 import quota-providers 的 provider 解析逻辑"
        }
      ]
    }
  ],
  "external": [
    {
      "package": "@zhushanwen/pi-structured-output",
      "source": "local",
      "directory": "extensions/structured-output"
    }
  ]
}
```

### 开发规范

1. **新增 extension 时**：在 `extension-dependencies.json` 中添加条目，声明所有依赖
2. **新增依赖时**：更新被依赖方的条目，声明依赖类型和原因
3. **删除 extension 时**：移除条目，检查是否有其他 extension 依赖它
4. **pre-commit hook**：验证 `extension-dependencies.json` 中声明的依赖与 `package.json` 的 `dependencies`/`peerDependencies` 一致

## 被认为可行的替代方案

### 方案 A：StructuredOutput 内嵌在 workflow 中

将 StructuredOutput tool 直接在 workflow extension 内注册。

**优点**：不需要新增 extension，改动最小。

**缺点**：
- 其他需要结构化输出的场景（subagent、coding-workflow）无法复用
- workflow 承担了不属于它的职责（LLM 输出规范化）
- 违反单一职责原则

### 方案 B：不用 tool call，改进 prompt + 重试

继续用 prompt 指令 + `extractJSON` + agent 级别重试。

**优点**：不需要新 extension。

**缺点**：
- 根本问题未解决：LLM 不保证返回 JSON
- Claude Code 的实践已经证明 tool call 是正确方案
- 每次重试浪费 token

### 方案 C：文件中转

agent 把结果写入文件，脚本从文件读取。

**优点**：不依赖 LLM 返回格式化文本。

**缺点**：
- 需要约定文件路径，多 agent 并发时有冲突风险
- 文件 I/O 增加了失败点
- 不如 tool call 优雅（Claude Code 的实践）

## 决策代价

1. **新增 extension 维护成本**：多一个包需要版本管理、测试、发布
2. **用户安装成本**：使用 workflow 的用户需要额外安装 structured-output
3. **runtime 依赖不可检测**：`runtime` 类型依赖不在 npm `package.json` 中体现，需要通过文档和 `extension-dependencies.json` 声明

## 未解决的问题

1. runtime 依赖的安装验证：如何在 `pi install` 时自动提示缺少的 runtime 依赖？
2. structured-output 的 schema 校验是否需要在 tool.execute 中做（当前设计是 passthrough，在 agent-pool 侧校验）
