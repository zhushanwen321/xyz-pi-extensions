---
verdict: pass
---

# E2E Test Plan — Ad-hoc Workflow Generation

## Test Scenarios

### TS1: 自然语言生成临时 workflow (AC1)
1. 准备空 `.pi/workflows/` 目录
2. 用户输入 `/workflow 批量审查 src/ 下的代码`
3. AI 收到包含 workflow 列表的 sendUserMessage
4. AI 调用 `workflow-generate(name="batch-review-src", script=<valid script>, description="review src files")`
5. 验证 `.pi/workflows/.tmp/batch-review-src.js` 文件存在
6. AI 展示路径，用户确认后执行
7. 验证 workflow 实例状态为 running/completed

### TS2: 匹配已有 workflow (AC2)
1. 准备 `.pi/workflows/batch-review.js`（固定 workflow）
2. 用户输入 `/workflow 批量审查代码`
3. AI 收到列表中包含 `[saved] batch-review`
4. AI 展示匹配项，用户选择复用
5. 验证 AI 调用 `workflow-run` 使用已有 name

### TS3: 保存临时 workflow (AC4, AC5)
1. 按 TS1 生成临时 workflow
2. 用户执行 `/workflow save batch-review-src`
3. 验证文件从 `.tmp/` 移到 `.pi/workflows/`
4. `/workflow list` 中显示为 `[saved]`
5. 测试 `--as` 参数: `/workflow save batch-review-src --as batch-review-v2`

### TS4: 语法校验拒绝 (AC7)
1. AI 调用 `workflow-generate(name="bad", script="invalid js {{{")`
2. 验证返回 isError，错误信息包含语法错误描述

### TS5: 名称冲突拒绝 (AC9)
1. 准备 `.pi/workflows/demo.js`
2. AI 调用 `workflow-generate(name="demo", script=<valid script>)`
3. 验证抛出错误，提示名称冲突

### TS6: .tmp 目录自动创建 (AC10)
1. 删除 `.pi/workflows/.tmp/` 目录（如果存在）
2. 调用 `workflow-generate(name="auto-dir", script=<valid script>)`
3. 验证 `.pi/workflows/.tmp/` 自动创建，脚本写入成功

### TS7: 运行中保存不影响 Worker (AC8)
1. 启动一个 workflow run
2. 在 running 状态时执行 `/workflow save <name>`
3. 验证 Worker 继续运行不受影响

### TS8: list 展示标签 (AC3, FR5.1)
1. 准备 1 个 saved + 1 个 tmp workflow
2. 执行 `/workflow list`
3. 验证输出包含 `[saved]` 和 `[tmp]` 标签

### TS9: 去重优先级 (FR4.5)
1. 在 `.pi/workflows/` 和 `.pi/workflows/.tmp/` 都放同名 workflow
2. `/workflow list` 中只显示一个，标记为 `[tmp]`

### TS10: 运行中拒绝删除 (FR6.3)
1. 启动一个 workflow run
2. 在 `/workflows` 面板中尝试 Delete
3. 验证拒绝删除，提示先 abort

## Test Environment

- Pi 进程内执行，使用实际扩展加载
- 项目目录下需要有 `.pi/workflows/` 目录（可自动创建）
- 准备最小合法 workflow 脚本用于测试:
  ```js
  const meta = { name: "test", description: "test workflow", phases: ["step1"] };
  module.exports = { meta };
  module.exports.step1 = async ({ agent }) => { return "done"; };
  ```
- 手动验证为主（AI 交互流程需要实际 Pi session）
- `workflow-generate` tool 的错误场景可自动化验证（直接调 tool）
