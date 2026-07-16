# Code Review — fix-workflow-ctxmodel-mapper

## 审查范围
- commit: 6150db43e（1 个 commit，3 文件改动）
  - `execute-options-mapper.ts`：核心修复（2 行）
  - `execute-options-mapper.test.ts`：测试断言更新（旧 bug 行为 → 新正确行为）
  - `subprocess-agent-runner.test.ts`：下游测试断言同步更新

## 修复内容

`mapToExecuteOptions` 原来把 `ctxModel?.id`（裸模型名，如 `mimo-v2.5-pro`）填入 `ExecuteOptions.model`。这导致 `resolveModel` 把主 agent 的模型误当 `paramOverride`（第 1 层），尝试 registry lookup，因裸名不含 `/` 分隔符而 throw "Model not found"。

修复后：`model: opts.model`（只传显式 override）+ `ctxModel`（完整 ModelInfo 对象透传到 `ExecuteOptions.ctxModel` 字段）。`resolveModel` 走第 3 层透明透传（不查 registry），与 subagent-actions.ts L160 的模式对齐。

## 发现的问题

无 must-fix / should-fix。

### 核对项

| 维度 | 结论 |
|------|------|
| 类型安全 | ExecuteOptions.ctxModel 已有 ModelInfo 类型定义（types.ts L415），无需类型扩展 |
| 错误处理 | 无新增错误路径——修复消除了错误的 throw 路径 |
| 边界条件 | opts.model 空 + ctxModel 空 → model/ctxModel 均 undefined → resolveModel 抛清晰的 "No available model" 错误（已测试 U3） |
| 测试覆盖 | 3 个新 mock 测试 + 1 个 e2e 回归 + 1 个下游测试更新。覆盖 model 优先/ctxModel 透传/双空 |
| plan 完成度 | W1 changes[0] 已落地 |

## plan 覆盖核对
- [x] W1 changes[0]: execute-options-mapper.ts L54 从 `ctxModel?.id` 改为 ctxModel 对象透传 — 已落地

## 结论
- must-fix: 0
- should-fix: 0
- nit: 0
