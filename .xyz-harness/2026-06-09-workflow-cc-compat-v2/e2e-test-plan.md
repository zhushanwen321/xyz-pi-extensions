---
verdict: pass
---

# E2E Test Plan — workflow-cc-compat-v2

## Test Scenarios

### TS-1: Structured Output 端到端可靠性
**覆盖 AC:** AC-1.1, AC-1.2, AC-1.3, AC-1.4

1. 创建一个 workflow 脚本，调用 `agent("review code", {schema: REVIEW_SCHEMA})`
2. 运行 workflow，验证：
   - 子进程 system prompt 中包含 structured-output 调用指令（检查临时文件内容）
   - 正常情况下 `parsedOutput` 非空且符合 schema
   - schema 含特殊字符（引号、换行、反斜杠）时注入不被破坏
3. 模拟首次失败场景（弱模型忽略 SO 指令）：
   - 第一次 agent 返回纯文本无 SO 调用
   - 验证自动重试一次
   - 第二次返回正确的 SO → 最终结果正确
4. 模拟有其他 tool call 但无 SO：
   - agent 调用了 read + bash 但未调用 structured-output，且进程退出
   - 验证返回失败（非静默忽略）

### TS-2: CC 格式脚本端到端运行
**覆盖 AC:** AC-2.1 ~ AC-2.9

1. 使用 `.claude/workflows/review-fix-loop.js` 作为测试脚本
2. 验证 config-loader 正确解析 `phases: [{title: 'Review'}, {title: 'Fix'}]`
3. 验证脚本中 `args.maxIterations` 可访问
4. 验证 `phase('Review')` 后 agent trace node 的 phase 字段为 'Review'
5. 验证 `agent(prompt, {phase: 'Fix', schema})` 中显式 phase 覆盖全局 phase
6. 验证 `parallel([() => agent("t1"), () => agent("t2")])` 两个 agent 并发执行
7. 验证 `pipeline([1,2,3], stage1, stage2)` 的笛卡尔积执行
8. 验证 pipeline 中单 item 失败不影响其他 item
9. 验证 `budget.spent()` 和 `budget.remaining()` 返回正确值

### TS-3: 向后兼容性
**覆盖 AC:** 所有 AC 的隐式约束

1. 使用现有 Pi 格式脚本（`const meta = {phases: ['name']}` + `$ARGS`）
2. 验证脚本在所有改动后仍能正确运行
3. 验证 `$ARGS` 仍然可用（`args` 别名不影响 `$ARGS`）

## Test Environment

- **Pi 版本：** 当前安装版本
- **模型：** 使用低成本模型（如 glm-5.1）进行 E2E 测试
- **项目：** 当前 xyz-pi-extensions 项目
- **前置条件：** `pi install` 完成所有扩展安装，`structured-output` 扩展已安装
