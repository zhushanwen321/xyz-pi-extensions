# Retrospect — fix-workflow-ctxmodel-mapper

## 概述

修复了 `mapToExecuteOptions` 把 `ctxModel.id`（裸模型名）填入 `ExecuteOptions.model` 的 bug。这个 bug 导致 workflow 的 `agent()` 调用在用户不显式指定 model 时，主 agent 的模型被误送进 resolveModel 的严格 paramOverride lookup 路径（因裸名不含 provider/ 前缀而 throw "Model not found"），而 subagent 工具直接调用走的是 ctxModel 对象透传路径（第 3 层透明传递），所以两者行为不一致。

## 做对了什么

1. **根因定位准确**：之前的分析虽然方向对了（model 相关），但给出的根因是"Worker 线程隔离"——这是错的。第二次分析通过代码逐行追踪精确定位到 `execute-options-mapper.ts:54` 的 `ctxModel?.id` 压扁问题。根因不在 Worker 线程，而在 mapper 把 ModelInfo 对象压成裸 id 字符串。

2. **修复方案选择长期方案**：用 `ctxModel` 对象透传（方案 A）而非 `provider/id` 字符串拼接（方案 B）。方案 A 与 subagent-actions.ts 的模式完全对齐，消除了"两条路径行为不一致"的根因。方案 B 虽然也能修但留下了设计异味。

3. **TDD 流程干净**：红灯 3 个 → 实现 2 行 → 绿灯。修改了 1 个下游测试（subprocess-agent-runner.test.ts）的旧断言——它断言的是 bug 行为（ctxModel.id 填底），改为断言正确行为（ctxModel 对象透传）。

## 教训

### 旧测试断言了 bug 行为

`subprocess-agent-runner.test.ts` L179 的旧断言 `expect(capturedOpts!.model).toBe("ctx-model")` 实际上是在验证 bug——它把 ctxModel.id 填底的行为当成了"D-008 model 填底"的正确实现。测试名 "T3.5 model 填底 (D-008)" 甚至把这个 bug 当成了设计意图。

**根因**：D-008 的设计意图是"model 填底"——让 resolveModel 走第 3 层透明传递。但 mapper 的实现把"填底"理解成了"把 ctxModel.id 塞进 opts.model"，导致主模型走了第 1 层 paramOverride lookup（本不该走）。测试忠实记录了错误实现的行为。

**防范**：mapper 的注释文档（D-008）和实现之间存在语义偏差。注释说"model 填底"但实现是"id 压扁填入 model 字段"。这种"注释 vs 实现偏差"是测试盲区的常见来源——测试跟着实现走，不跟注释走。

## 量化

- commit: 1（6150db43e）
- 文件改动: 3（1 实现 + 2 测试）
- 核心改动: 2 行
- 测试: 956 passed（含 5 个新增/修改的断言）
- 流程: plan→tdd_plan→dev→review→test→retrospect→closeout，零返工
