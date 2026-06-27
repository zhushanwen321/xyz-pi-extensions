# ADR-020: Coding-Workflow 依赖 Workflow Extension

## Status

Accepted

## Context

Coding-workflow 的 Review-Gate / Test-Fix Loop 需要多 agent 编排能力（循环审查、并行 reviewer、Fix Worker 分组修复）。原始实现用 `runSingleAgent`（spawn `pi --mode json`）逐个执行 agent，缺乏：

- 并行 agent 执行（5 个 reviewer 需要并行）
- 结构化结果解析（agent 返回 JSON 而非自由文本）
- callCache / budget 控制（Workflow Extension 成熟机制）

Workflow Extension 提供了 `agent()`/`parallel()`/`pipeline()` API，能解决这些问题。但 `WorkflowOrchestrator` 是 workflow extension 工厂函数的内部闭包变量，没有 export，不能通过 package import 直接使用。

## Decision

采用 `pi.__workflowRun` 交叉调用通道（与 `pi.__goalInit` 同模式）：

1. Workflow extension 在 `session_start` 时将 `orchestrator.runAndWait()` 暴露到 pi 对象上（`pi.__workflowRun`）
2. Coding-workflow 通过 `pi.__workflowRun(name, args, signal)` 启动 workflow 脚本
3. `runAndWait()` 在调用方线程同步等待 workflow 完成，返回 `scriptResult`
4. 每个内置降级：`pi.__workflowRun` 不可用时回退到 `runSingleAgent`

依赖关系在 `extension-dependencies.json` 中声明为 `optional`（缺失时降级运行）。

### 替代方案

| 方案 | 放弃原因 |
|------|---------|
| `import { WorkflowOrchestrator }` 直接 import | `WorkflowOrchestrator` 未 export，是闭包内部变量 |
| 在 coding-workflow 内部实现简化版 workflow 引擎 | 维护成本高、feature parity 困难 |
| 只用 `runSingleAgent` 串行执行 | 无并行能力，Phase 3 需要 5 reviewer 并行 |

## Consequences

- 正面：利用 Workflow Extension 成熟的编排能力（parallel/callCache/budget），开发成本降低
- 正面：降级策略保证 coding-workflow 在无 workflow extension 的环境也能工作
- 负面：coding-workflow 与 workflow 形成运行时依赖，workflow 缺失时 Review-Gate 退化为单 agent 串行审查
- 负面：`pi.__workflowRun` 是约定接口，非正式 Pi API，Pi 版本升级时可能有兼容性风险
